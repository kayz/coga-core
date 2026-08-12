import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import type {
  AdapterReceipt,
  EvidenceBundle,
  EvidenceFile,
  ExecutionPlan,
  Sha256Digest,
  WorkOrder,
} from "./types.js";
import {
  canonicalJson,
  normalizeRelativePath,
  readBoundedFile,
  resolveWithin,
  sha256,
} from "./utils.js";

function schema(): object {
  return JSON.parse(
    readFileSync(
      new URL("../schemas/evidence-bundle.schema.json", import.meta.url),
      "utf8",
    ),
  ) as object;
}

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateEvidence = ajv.compile(schema());

function exactKey(value: { id: string; version: string }): string {
  return `${value.id}@${value.version}`;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Invalid Evidence Bundle: ${label} contains duplicates.`);
  }
}

function assertSemanticIntegrity(bundle: EvidenceBundle): void {
  for (const file of bundle.subject.changedFiles) {
    normalizeRelativePath(file.path, "Evidence Bundle changed file path");
  }
  assertUnique(
    bundle.subject.changedFiles.map((entry) => entry.path),
    "subject.changedFiles",
  );
  assertUnique(bundle.impact.packages.map(exactKey), "impact.packages");
  assertUnique(
    bundle.impact.affectedApplications.map(exactKey),
    "impact.affectedApplications",
  );
  assertUnique(
    bundle.steps.map((entry) => entry.stepId),
    "steps",
  );

  for (const receipt of bundle.steps) {
    if (Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)) {
      throw new Error(
        `Invalid Evidence Bundle: step '${receipt.stepId}' finishes before it starts.`,
      );
    }
    if (receipt.outputFiles) {
      for (const file of receipt.outputFiles) {
        normalizeRelativePath(file.path, "Evidence Bundle output file path");
      }
      assertUnique(
        receipt.outputFiles.map((entry) => entry.path),
        `step '${receipt.stepId}' outputFiles`,
      );
    }
    const sandboxed =
      receipt.adapter.id === "coga.node.test" ||
      receipt.adapter.id === "coga.node.build";
    if (sandboxed && !receipt.sandbox) {
      throw new Error(
        `Invalid Evidence Bundle: step '${receipt.stepId}' has no sandbox evidence.`,
      );
    }
    if (!sandboxed && receipt.sandbox) {
      throw new Error(
        `Invalid Evidence Bundle: step '${receipt.stepId}' has unexpected sandbox evidence.`,
      );
    }
    if (
      receipt.sandbox?.isolation === "docker" &&
      (receipt.sandbox.rootFilesystem !== "read-only" ||
        receipt.sandbox.repositoryMount !== "read-only" ||
        receipt.sandbox.limits.pids < 1 ||
        receipt.sandbox.limits.memoryBytes < 1 ||
        receipt.sandbox.limits.cpus <= 0)
    ) {
      throw new Error(
        `Invalid Evidence Bundle: step '${receipt.stepId}' has incomplete Docker isolation evidence.`,
      );
    }
  }

  const requiredKeys = bundle.governance.requiredPolicies.map(exactKey);
  const approvalKeys = bundle.governance.approvals.map((entry) =>
    exactKey(entry.policy),
  );
  const pendingKeys = bundle.governance.pendingPolicies.map(exactKey);
  assertUnique(requiredKeys, "governance.requiredPolicies");
  assertUnique(approvalKeys, "governance.approvals");
  assertUnique(pendingKeys, "governance.pendingPolicies");
  for (const approval of bundle.governance.approvals) {
    for (const evidence of approval.evidence) {
      normalizeRelativePath(
        evidence.path,
        "Evidence Bundle approval evidence path",
      );
    }
  }
  for (const packageEntry of bundle.impact.packages) {
    normalizeRelativePath(packageEntry.path, "Evidence Bundle Package path");
  }
  for (const application of bundle.impact.affectedApplications) {
    normalizeRelativePath(application.path, "Evidence Bundle Application path");
  }
  const resolved = new Set([...approvalKeys, ...pendingKeys]);
  if (
    resolved.size !== requiredKeys.length ||
    requiredKeys.some((key) => !resolved.has(key)) ||
    approvalKeys.some((key) => pendingKeys.includes(key))
  ) {
    throw new Error(
      "Invalid Evidence Bundle: approvals and pendingPolicies must exactly partition requiredPolicies.",
    );
  }
}

function assertEvidenceDocument(document: unknown): EvidenceBundle {
  if (!validateEvidence(document)) {
    const detail = (validateEvidence.errors ?? [])
      .map(
        (entry: ErrorObject) =>
          `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`,
      )
      .join("; ");
    throw new Error(`Invalid Evidence Bundle: ${detail}.`);
  }
  const bundle = document as EvidenceBundle;
  assertSemanticIntegrity(bundle);
  return bundle;
}

function payload(bundle: EvidenceBundle): unknown {
  const { bundleDigest: _bundleDigest, ...metadata } = bundle.metadata;
  return { ...bundle, metadata };
}

export function evidenceDigest(bundle: EvidenceBundle): Sha256Digest {
  return sha256(canonicalJson(payload(bundle)));
}

export function createEvidenceBundle(parameters: {
  workOrder: WorkOrder;
  plan: ExecutionPlan;
  subjectTree: string;
  changedFiles: EvidenceFile[];
  receipts: AdapterReceipt[];
  generatedAt: string;
}): EvidenceBundle {
  const approved = new Set(
    parameters.workOrder.spec.governance.approvals.map(
      (entry) => `${entry.policy.id}@${entry.policy.version}`,
    ),
  );
  const pendingPolicies =
    parameters.workOrder.spec.governance.requiredPolicies.filter(
      (entry) => !approved.has(`${entry.id}@${entry.version}`),
    );
  const draft: EvidenceBundle = {
    schemaVersion: parameters.workOrder.schemaVersion,
    kind: "EvidenceBundle",
    metadata: {
      workOrderId: parameters.workOrder.metadata.id,
      generatedAt: parameters.generatedAt,
      bundleDigest:
        "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
    subject: {
      repository: parameters.workOrder.spec.delivery.repository,
      baseCommit: parameters.plan.baseCommit,
      subjectTree: parameters.subjectTree,
      application: parameters.plan.target.application,
      workOrderDigest: parameters.plan.workOrder.digest,
      planDigest: parameters.plan.planDigest,
      proposalReceiptDigest:
        parameters.plan.target.proposalReceipt.metadata.receiptDigest,
      changedFiles: parameters.changedFiles,
    },
    governance: {
      requiredPolicies: parameters.workOrder.spec.governance.requiredPolicies,
      approvals: parameters.workOrder.spec.governance.approvals,
      pendingPolicies,
      draftOnly: true,
    },
    impact: parameters.plan.impact,
    steps: parameters.receipts,
  };
  draft.metadata.bundleDigest = evidenceDigest(draft);
  return draft;
}

export function writeEvidenceBundle(
  workspace: string,
  bundle: EvidenceBundle,
): { path: string; digest: Sha256Digest } {
  assertEvidenceDocument(bundle);
  const digest = evidenceDigest(bundle);
  if (digest !== bundle.metadata.bundleDigest) {
    throw new Error("Evidence Bundle digest is inconsistent before write.");
  }
  const path = `.coga/evidence/${digest.slice("sha256:".length)}.json`;
  const absolute = resolveWithin(workspace, path, "Evidence Bundle path");
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, canonicalJson(bundle), {
    encoding: "utf8",
    flag: "wx",
  });
  return { path, digest };
}

export function verifyEvidenceBundle(path: string): EvidenceBundle {
  const raw = readBoundedFile(path, "Evidence Bundle", 5 * 1024 * 1024);
  const document = JSON.parse(raw.toString("utf8")) as unknown;
  const bundle = assertEvidenceDocument(document);
  const actual = evidenceDigest(bundle);
  if (actual !== bundle.metadata.bundleDigest) {
    throw new Error(
      `Evidence Bundle digest mismatch: declared ${bundle.metadata.bundleDigest}, received ${actual}.`,
    );
  }
  return bundle;
}
