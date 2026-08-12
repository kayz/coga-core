import { basename } from "node:path";
import type { ExactReference } from "@coga/core";
import { verifyEvidenceBundle } from "./evidence.js";
import { expectedDeliveryAuthor } from "./identity.js";
import { loadRemoteEvidence } from "./schema.js";
import type {
  EvidenceBundle,
  GovernanceView,
  RemoteEvidence,
  WorkOrder,
} from "./types.js";
import { FACTORY_SCHEMA_VERSION } from "./types.js";
import {
  canonicalJson,
  compareText,
  readBoundedFile,
  sha256,
} from "./utils.js";
import { remoteEvidenceDigest } from "./remote.js";

function exactKey(reference: ExactReference): string {
  return `${reference.id}@${reference.version}`;
}

function uniqueByApplication<T>(
  values: T[],
  reference: (value: T) => ExactReference,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = exactKey(reference(value));
    if (result.has(key)) {
      throw new Error(`${label} contains duplicate Application '${key}'.`);
    }
    result.set(key, value);
  }
  return result;
}

export function createGovernanceView(parameters: {
  workOrder: WorkOrder;
  evidencePaths?: string[];
  remoteEvidencePaths?: string[];
}): GovernanceView {
  const localEntries = (parameters.evidencePaths ?? []).map((path) => {
    const bytes = readBoundedFile(
      path,
      `Evidence Bundle '${path}'`,
      5 * 1024 * 1024,
    );
    return {
      path,
      bytesDigest: sha256(bytes),
      document: verifyEvidenceBundle(path),
    };
  });
  const remoteEntries = (parameters.remoteEvidencePaths ?? []).map((path) => {
    const document = loadRemoteEvidence(path);
    if (
      remoteEvidenceDigest(document) !== document.metadata.remoteEvidenceDigest
    ) {
      throw new Error(`Remote Evidence '${path}' has a digest mismatch.`);
    }
    return { path, document };
  });
  const local = uniqueByApplication(
    localEntries,
    (entry) => entry.document.subject.application,
    "Evidence Bundle inputs",
  );
  const remote = uniqueByApplication(
    remoteEntries,
    (entry) => entry.document.subject.application,
    "Remote Evidence inputs",
  );
  const workOrderDigest = sha256(canonicalJson(parameters.workOrder));
  const requiredPolicies = [
    ...parameters.workOrder.spec.governance.requiredPolicies,
  ];
  return {
    schemaVersion: FACTORY_SCHEMA_VERSION,
    kind: "GovernanceView",
    workOrder: {
      id: parameters.workOrder.metadata.id,
      digest: workOrderDigest,
    },
    change: parameters.workOrder.spec.change.artifact,
    targets: parameters.workOrder.spec.targets
      .map((target) => {
        const key = exactKey(target.application);
        const localEntry = local.get(key);
        const remoteEntry = remote.get(key);
        if (
          localEntry &&
          (localEntry.document.metadata.workOrderId !==
            parameters.workOrder.metadata.id ||
            localEntry.document.subject.workOrderDigest !== workOrderDigest ||
            localEntry.document.subject.repository !==
              parameters.workOrder.spec.delivery.repository)
        ) {
          throw new Error(
            `Evidence Bundle for '${key}' is not bound to this Work Order and repository.`,
          );
        }
        if (
          remoteEntry &&
          (remoteEntry.document.subject.repository !==
            parameters.workOrder.spec.delivery.repository ||
            remoteEntry.document.subject.pullRequestAuthor.toLowerCase() !==
              expectedDeliveryAuthor(parameters.workOrder).toLowerCase() ||
            remoteEntry.document.subject.workOrder.id !==
              parameters.workOrder.metadata.id ||
            remoteEntry.document.subject.workOrder.digest !== workOrderDigest)
        ) {
          throw new Error(
            `Remote Evidence for '${key}' is bound to a different Work Order or repository.`,
          );
        }
        if (
          remoteEntry &&
          remoteEntry.document.attestation.subjectDigest !==
            remoteEntry.document.subject.evidenceBundle.digest
        ) {
          throw new Error(
            `Remote Evidence for '${key}' has inconsistent attestation and bundle digests.`,
          );
        }
        if (
          remoteEntry &&
          localEntry &&
          (basename(remoteEntry.document.subject.evidenceBundle.path) !==
            basename(localEntry.path) ||
            remoteEntry.document.subject.evidenceBundle.digest !==
              localEntry.bytesDigest)
        ) {
          throw new Error(
            `Remote Evidence for '${key}' does not reference the supplied local Evidence Bundle.`,
          );
        }
        const satisfiedPolicies = new Set([
          ...(localEntry?.document.governance.approvals ?? []).map((entry) =>
            exactKey(entry.policy),
          ),
          ...(remoteEntry?.document.approvals ?? []).map((entry) =>
            exactKey(entry.policy),
          ),
        ]);
        const pendingPolicies = requiredPolicies.filter(
          (entry) => !satisfiedPolicies.has(exactKey(entry)),
        );
        const blockers = remoteEntry
          ? [...remoteEntry.document.promotion.blockers]
          : ["Verified Remote Evidence has not been supplied."];
        if (!localEntry)
          blockers.unshift("Local Evidence Bundle has not been supplied.");
        return {
          application: target.application,
          proposalReceipt: target.proposal.receipt,
          ...(localEntry
            ? {
                localEvidence: {
                  path: basename(localEntry.path),
                  digest: localEntry.document.metadata.bundleDigest,
                },
              }
            : {}),
          ...(remoteEntry
            ? {
                remoteEvidence: {
                  path: basename(remoteEntry.path),
                  digest: remoteEntry.document.metadata.remoteEvidenceDigest,
                },
              }
            : {}),
          requiredPolicies,
          pendingPolicies,
          promotion: {
            eligible:
              Boolean(localEntry) &&
              Boolean(remoteEntry?.document.promotion.eligible) &&
              pendingPolicies.length === 0 &&
              blockers.length === 0,
            blockers,
          },
        };
      })
      .sort((left, right) =>
        compareText(exactKey(left.application), exactKey(right.application)),
      ),
  };
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function governanceViewMarkdown(view: GovernanceView): string {
  const rows = view.targets.map((target) => {
    const status = target.promotion.eligible ? "ready-for-review" : "draft";
    const blockers = target.promotion.blockers.length
      ? target.promotion.blockers.join("; ")
      : "none";
    return `| ${escapeCell(exactKey(target.application))} | ${status} | ${target.localEvidence ? "verified" : "missing"} | ${target.remoteEvidence ? "verified" : "missing"} | ${escapeCell(blockers)} |`;
  });
  return [
    `# Factory governance: ${view.workOrder.id}`,
    "",
    `- Work Order digest: \`${view.workOrder.digest}\``,
    `- Change: \`${exactKey(view.change)}\``,
    "",
    "| Application | Promotion | Local evidence | Remote evidence | Blockers |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export type { EvidenceBundle, RemoteEvidence };
