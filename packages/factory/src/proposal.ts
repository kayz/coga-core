import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExactReference } from "@coga/core";
import { inspectPatchPaths } from "./git.js";
import { loadAgentProposalReceipt } from "./schema.js";
import type {
  AgentProposalReceipt,
  EvidenceFile,
  ProposalCompilationRequest,
  Sha256Digest,
} from "./types.js";
import {
  FACTORY_SCHEMA_VERSION,
  PATCH_NORMALIZATION_VERSION,
} from "./types.js";
import {
  canonicalJson,
  compareText,
  normalizeRelativePath,
  readBoundedFile,
  resolveWithin,
  sha256,
  verifyFileReference,
} from "./utils.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function exactKey(reference: ExactReference): string {
  return `${reference.id}@${reference.version}`;
}

function pathAllowed(path: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (entry) => path === entry || path.startsWith(`${entry}/`),
  );
}

export function normalizeProposalPatch(value: Buffer): Buffer {
  let source: string;
  try {
    source = utf8.decode(value);
  } catch {
    throw new Error("Agent proposal patch must be valid UTF-8.");
  }
  if (source.includes("\0"))
    throw new Error("Agent proposal patch contains NUL.");
  const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return Buffer.from(`${normalized.replace(/\n*$/u, "")}\n`, "utf8");
}

export function proposalReceiptDigest(
  receipt: AgentProposalReceipt,
): Sha256Digest {
  const { receiptDigest: _receiptDigest, ...metadata } = receipt.metadata;
  return sha256(canonicalJson({ ...receipt, metadata }));
}

function evidenceFile(workspace: string, relativePath: string): EvidenceFile {
  const path = normalizeRelativePath(relativePath, "proposal input path");
  const value = readBoundedFile(
    resolveWithin(workspace, path, "proposal input path"),
    `proposal input '${path}'`,
    5 * 1024 * 1024,
  );
  return { path, digest: sha256(value), bytes: value.byteLength };
}

export interface ProposalCompilerInput {
  id: string;
  createdAt: string;
  baseCommit: string;
  change: ExactReference;
  application: ExactReference;
  inputPaths: string[];
  adapter: ExactReference;
  model: AgentProposalReceipt["generator"]["model"];
  prompt: AgentProposalReceipt["generator"]["prompt"];
  tools: AgentProposalReceipt["generator"]["tools"];
  budget: AgentProposalReceipt["generator"]["budget"];
  patchPath: string;
  allowedPaths: string[];
}

export function compileAgentProposal(
  workspace: string,
  input: ProposalCompilerInput,
): AgentProposalReceipt {
  if (
    input.baseCommit !== "work-order-commit" &&
    !COMMIT_PATTERN.test(input.baseCommit)
  ) {
    throw new Error(
      "Agent proposal baseCommit must be 'work-order-commit' or 40 lowercase hex characters.",
    );
  }
  const patchPath = normalizeRelativePath(
    input.patchPath,
    "proposal patch path",
  );
  const absolutePatch = resolveWithin(
    workspace,
    patchPath,
    "proposal patch path",
  );
  const original = readBoundedFile(
    absolutePatch,
    "Agent proposal patch",
    MAX_PATCH_BYTES,
  );
  const normalized = normalizeProposalPatch(original);
  if (!original.equals(normalized)) {
    throw new Error(
      "Agent proposal patch is not normalized; use UTF-8, LF endings, and one final newline.",
    );
  }
  const changedPaths = inspectPatchPaths(normalized.toString("utf8"));
  const allowed = input.allowedPaths.map((entry) =>
    normalizeRelativePath(entry, "proposal allowed path"),
  );
  for (const path of changedPaths) {
    if (!pathAllowed(path, allowed)) {
      throw new Error(`Agent proposal changes disallowed path '${path}'.`);
    }
  }
  const uniqueInputs = [...new Set(input.inputPaths)].sort(compareText);
  if (uniqueInputs.length !== input.inputPaths.length) {
    throw new Error("Agent proposal input closure contains duplicate paths.");
  }
  const inputs = uniqueInputs.map((entry) => evidenceFile(workspace, entry));
  const promptPath = normalizeRelativePath(
    input.prompt.path,
    "proposal prompt template path",
  );
  const promptBytes = readBoundedFile(
    resolveWithin(workspace, promptPath, "proposal prompt template path"),
    "proposal prompt template",
    1024 * 1024,
  );
  if (sha256(promptBytes) !== input.prompt.digest) {
    throw new Error("Agent proposal prompt template digest mismatch.");
  }
  const draft: AgentProposalReceipt = {
    schemaVersion: FACTORY_SCHEMA_VERSION,
    kind: "AgentProposalReceipt",
    metadata: {
      id: input.id,
      createdAt: input.createdAt,
      receiptDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    subject: {
      baseCommit: input.baseCommit,
      change: input.change,
      application: input.application,
      inputs,
    },
    generator: {
      adapter: input.adapter,
      model: input.model,
      prompt: input.prompt,
      tools: input.tools,
      budget: input.budget,
    },
    output: {
      patch: { path: patchPath, digest: sha256(normalized) },
      normalization: PATCH_NORMALIZATION_VERSION,
      normalizedDigest: sha256(normalized),
      changedPaths,
    },
  };
  draft.metadata.receiptDigest = proposalReceiptDigest(draft);
  return draft;
}

export function writeAgentProposalReceipt(
  workspace: string,
  outputPath: string,
  receipt: AgentProposalReceipt,
): { path: string; digest: Sha256Digest } {
  const path = normalizeRelativePath(outputPath, "proposal receipt output");
  const absolute = resolveWithin(workspace, path, "proposal receipt output");
  const digest = proposalReceiptDigest(receipt);
  if (digest !== receipt.metadata.receiptDigest) {
    throw new Error(
      "Agent Proposal Receipt digest is inconsistent before write.",
    );
  }
  mkdirSync(dirname(absolute), { recursive: true });
  const bytes = canonicalJson(receipt);
  writeFileSync(absolute, bytes, {
    encoding: "utf8",
    flag: "wx",
  });
  return { path, digest: sha256(bytes) };
}

export function compileProposalRequest(
  workspace: string,
  request: ProposalCompilationRequest,
): { path: string; digest: Sha256Digest; receipt: AgentProposalReceipt } {
  const receipt = compileAgentProposal(workspace, {
    id: request.metadata.id,
    createdAt: request.metadata.createdAt,
    baseCommit: request.subject.baseCommit,
    change: request.subject.change,
    application: request.subject.application,
    inputPaths: request.subject.inputPaths,
    adapter: request.generator.adapter,
    model: request.generator.model,
    prompt: request.generator.prompt,
    tools: request.generator.tools,
    budget: request.generator.budget,
    patchPath: request.output.patchPath,
    allowedPaths: request.output.allowedPaths,
  });
  const written = writeAgentProposalReceipt(
    workspace,
    request.output.receiptPath,
    receipt,
  );
  return { ...written, receipt };
}

export function verifyAgentProposalReceipt(
  workspace: string,
  receiptPath: string,
  expected: {
    baseCommit: string;
    change: ExactReference;
    application: ExactReference;
    allowedPaths: string[];
  },
): AgentProposalReceipt {
  const path = resolveWithin(workspace, receiptPath, "proposal receipt path");
  const receipt = loadAgentProposalReceipt(path);
  const actualReceiptDigest = proposalReceiptDigest(receipt);
  if (actualReceiptDigest !== receipt.metadata.receiptDigest) {
    throw new Error(
      `Agent Proposal Receipt digest mismatch: declared ${receipt.metadata.receiptDigest}, received ${actualReceiptDigest}.`,
    );
  }
  if (
    receipt.subject.baseCommit !== "work-order-commit" &&
    receipt.subject.baseCommit !== expected.baseCommit
  ) {
    throw new Error(
      "Agent Proposal Receipt is bound to a different base commit.",
    );
  }
  if (exactKey(receipt.subject.change) !== exactKey(expected.change)) {
    throw new Error("Agent Proposal Receipt is bound to a different change.");
  }
  if (
    exactKey(receipt.subject.application) !== exactKey(expected.application)
  ) {
    throw new Error(
      "Agent Proposal Receipt is bound to a different Application.",
    );
  }
  for (const input of receipt.subject.inputs) {
    const inputPath = verifyFileReference(
      workspace,
      input,
      `proposal input '${input.path}'`,
      5 * 1024 * 1024,
    );
    const bytes = readBoundedFile(
      inputPath,
      `proposal input '${input.path}'`,
    ).byteLength;
    if (bytes !== input.bytes) {
      throw new Error(`Proposal input '${input.path}' byte length changed.`);
    }
  }
  verifyFileReference(
    workspace,
    {
      path: receipt.generator.prompt.path,
      digest: receipt.generator.prompt.digest,
    },
    "Agent proposal prompt template",
  );
  const patch = verifyFileReference(
    workspace,
    receipt.output.patch,
    "Agent proposal patch",
    MAX_PATCH_BYTES,
  );
  const raw = readBoundedFile(patch, "Agent proposal patch", MAX_PATCH_BYTES);
  const normalized = normalizeProposalPatch(raw);
  if (!raw.equals(normalized)) {
    throw new Error("Agent proposal patch is not normalized.");
  }
  const digest = sha256(normalized);
  if (digest !== receipt.output.normalizedDigest) {
    throw new Error("Agent proposal normalized digest mismatch.");
  }
  const actualPaths = inspectPatchPaths(normalized.toString("utf8"));
  if (
    canonicalJson(actualPaths) !== canonicalJson(receipt.output.changedPaths)
  ) {
    throw new Error(
      "Agent proposal declared changedPaths differ from the patch.",
    );
  }
  const allowed = expected.allowedPaths.map((entry) =>
    normalizeRelativePath(entry, "proposal allowed path"),
  );
  for (const changedPath of actualPaths) {
    if (!pathAllowed(changedPath, allowed)) {
      throw new Error(
        `Agent proposal changes disallowed path '${changedPath}'.`,
      );
    }
  }
  return receipt;
}
