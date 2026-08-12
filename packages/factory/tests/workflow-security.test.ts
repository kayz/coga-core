import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const path = resolve(repositoryRoot, ".github/workflows/factory-evidence.yml");

describe("Factory remote evidence workflow", () => {
  it("attests successful same-repository Draft evidence without checkout or repository execution", () => {
    const source = readFileSync(path, "utf8");
    const workflow = parse(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, unknown>;
      jobs: Record<
        string,
        {
          if: string;
          permissions: Record<string, string>;
          steps: Array<{ if?: string; uses?: string; run?: string }>;
        }
      >;
    };
    expect(Object.keys(workflow.on)).toEqual(["workflow_run"]);
    expect(workflow.permissions).toEqual({});
    const job = workflow.jobs["attest-evidence"];
    if (!job) throw new Error("Missing attestation job.");
    expect(job.if).toContain("workflow_run.conclusion == 'success'");
    expect(job.if).toContain("head_repository.full_name == github.repository");
    expect(job.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
      "id-token": "write",
      attestations: "write",
      "artifact-metadata": "write",
    });
    expect(job.steps.some((step) => step.uses?.includes("checkout"))).toBe(
      false,
    );
    expect(job.steps.at(-1)?.uses).toBe(
      "actions/attest@c32b4b8b198b65d0bd9d63490e847ff7b53989d4",
    );
    expect(job.steps.at(-1)?.if).toBe(
      "steps.prepare.outputs.candidate == 'true'",
    );
    const script = job.steps.find((step) => step.run)?.run ?? "";
    expect(script).toContain(".draft");
    expect(script).toContain(".head.sha");
    expect(script).toContain(".coga/evidence/");
    expect(script).toContain("subject.proposalReceiptDigest");
    expect(script).toContain("candidate=false");
    expect(script).toContain("has no Factory Evidence Bundle");
    expect(script).toContain("Unable to read triggering workflow run");
    expect(script).toContain(".[].filename | explode[]");
    expect(script).toContain(". >= 32 and . != 92 and . != 127");
    expect(script).not.toContain("\\\\u0000");
    expect(script).not.toMatch(/\bnpm\b|\bnode\b|git checkout|git clone/iu);
  });
});
