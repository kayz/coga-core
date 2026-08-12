import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileAgentProposal,
  normalizeProposalPatch,
  proposalReceiptDigest,
  verifyAgentProposalReceipt,
  writeAgentProposalReceipt,
} from "../src/proposal.js";
import type { ProposalCompilerInput } from "../src/proposal.js";
import { canonicalJson, sha256 } from "../src/utils.js";

const baseCommit = "1".repeat(40);
const change = { id: "example.domain.change", version: "1.0.0" };
const application = { id: "application.example.web", version: "1.0.0" };

function fixture(): { root: string; input: ProposalCompilerInput } {
  const root = mkdtempSync(join(tmpdir(), "coga-proposal-receipt-"));
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "app", "file.txt"), "before\n");
  writeFileSync(join(root, "context-a.txt"), "alpha\n");
  writeFileSync(join(root, "context-b.txt"), "beta\n");
  writeFileSync(join(root, "prompt.md"), "Return a patch only.\n");
  const patch = [
    "diff --git a/app/file.txt b/app/file.txt",
    "--- a/app/file.txt",
    "+++ b/app/file.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n");
  writeFileSync(join(root, "proposal.patch"), patch);
  return {
    root,
    input: {
      id: "example.agent.proposal",
      createdAt: "2026-08-12T12:00:00.000Z",
      baseCommit,
      change,
      application,
      inputPaths: [
        "app/file.txt",
        "context-a.txt",
        "context-b.txt",
        "prompt.md",
      ],
      adapter: { id: "coga.test.proposer", version: "1.0.0" },
      model: { provider: "test", id: "model", version: "2026-08-12" },
      prompt: {
        template: { id: "coga.prompt.test", version: "1.0.0" },
        path: "prompt.md",
        digest: sha256("Return a patch only.\n"),
      },
      tools: {
        allowed: ["repository-context-read", "unified-diff-output"],
        network: "none",
        filesystem: "read-only",
      },
      budget: {
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
        maxToolCalls: 2,
        timeoutMs: 10_000,
      },
      patchPath: "proposal.patch",
      allowedPaths: ["app/file.txt"],
    },
  };
}

describe("Agent Proposal Receipt", () => {
  it("normalizes patch bytes and binds model, prompt, tools, budget, inputs, and output", () => {
    expect(normalizeProposalPatch(Buffer.from("line\r\n\r\n"))).toEqual(
      Buffer.from("line\n"),
    );
    const { root, input } = fixture();
    const receipt = compileAgentProposal(root, input);
    expect(receipt.metadata.receiptDigest).toBe(proposalReceiptDigest(receipt));
    expect(receipt.subject.inputs).toHaveLength(4);
    expect(receipt.output.changedPaths).toEqual(["app/file.txt"]);
    expect(receipt.generator).toMatchObject({
      model: input.model,
      prompt: input.prompt,
      tools: input.tools,
      budget: input.budget,
    });

    const written = writeAgentProposalReceipt(
      root,
      "proposal-receipt.json",
      receipt,
    );
    expect(written.digest).toBe(sha256(canonicalJson(receipt)));
    expect(
      verifyAgentProposalReceipt(root, written.path, {
        baseCommit,
        change,
        application,
        allowedPaths: ["app/file.txt"],
      }).metadata.receiptDigest,
    ).toBe(receipt.metadata.receiptDigest);
  });

  it("rejects changed inputs, receipt tampering, and disallowed output paths", () => {
    const { root, input } = fixture();
    const receipt = compileAgentProposal(root, input);
    writeAgentProposalReceipt(root, "proposal-receipt.json", receipt);
    writeFileSync(join(root, "context-a.txt"), "tampered\n");
    expect(() =>
      verifyAgentProposalReceipt(root, "proposal-receipt.json", {
        baseCommit,
        change,
        application,
        allowedPaths: ["app/file.txt"],
      }),
    ).toThrow(/digest mismatch/iu);

    const altered = structuredClone(receipt);
    altered.generator.model.version = "different";
    writeFileSync(join(root, "altered.json"), canonicalJson(altered));
    expect(() =>
      verifyAgentProposalReceipt(root, "altered.json", {
        baseCommit,
        change,
        application,
        allowedPaths: ["app/file.txt"],
      }),
    ).toThrow(/Receipt digest mismatch/iu);

    expect(() =>
      compileAgentProposal(root, {
        ...input,
        allowedPaths: ["app/other.txt"],
      }),
    ).toThrow(/disallowed path/iu);
  });
});
