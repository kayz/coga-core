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
      workOrderDigest: parameters.plan.workOrder.digest,
      planDigest: parameters.plan.planDigest,
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
  const actual = evidenceDigest(bundle);
  if (actual !== bundle.metadata.bundleDigest) {
    throw new Error(
      `Evidence Bundle digest mismatch: declared ${bundle.metadata.bundleDigest}, received ${actual}.`,
    );
  }
  return bundle;
}
