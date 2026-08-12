import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEvidenceBundle,
  evidenceDigest,
  verifyEvidenceBundle,
} from "../src/evidence.js";
import {
  loadAgentProposalReceipt,
  loadApplicationFactory,
  loadWorkOrder,
} from "../src/schema.js";
import type { ExecutionPlan, WorkOrder } from "../src/types.js";
import { canonicalJson } from "../src/utils.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workOrderPath = resolve(
  repositoryRoot,
  ".coga/work-orders/cedar-status/work-order.yaml",
);
const definitionPath = resolve(
  repositoryRoot,
  "examples/broker-digital-channel/applications/cedar-insight-h5/factory/application.factory.yaml",
);

describe("Factory schemas", () => {
  it("loads the governed example Work Order and typed Application definition", () => {
    expect(loadWorkOrder(workOrderPath).metadata.id).toBe(
      "example.cedar.live-status",
    );
    expect(
      loadApplicationFactory(definitionPath).spec.verification,
    ).toHaveLength(2);
  });

  it("rejects injected commands and escaping paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "coga-factory-schema-"));
    const valid = loadWorkOrder(workOrderPath) as WorkOrder & {
      spec: WorkOrder["spec"] & { shell?: string };
    };
    valid.spec.shell = "rm -rf /";
    const injected = join(directory, "injected.json");
    writeFileSync(injected, JSON.stringify(valid));
    expect(() => loadWorkOrder(injected)).toThrow(
      /unsupported|additional|Invalid Work Order/iu,
    );

    delete valid.spec.shell;
    const firstTarget = valid.spec.targets[0];
    if (!firstTarget) throw new Error("Expected an example target.");
    firstTarget.proposal.receipt.path = "../outside.json";
    const escaping = join(directory, "escaping.json");
    writeFileSync(escaping, JSON.stringify(valid));
    expect(() => loadWorkOrder(escaping)).toThrow(/Invalid Work Order/iu);
  });

  it("rejects a machine delivery identity authorized as its own human approver", () => {
    const directory = mkdtempSync(join(tmpdir(), "coga-factory-identity-"));
    const workOrder = structuredClone(loadWorkOrder(workOrderPath));
    workOrder.spec.governance.promotion.authorizedApprovers = [
      workOrder.spec.delivery.identity.appSlug,
    ];
    const path = join(directory, "self-approval.json");
    writeFileSync(path, JSON.stringify(workOrder));
    expect(() => loadWorkOrder(path)).toThrow(
      /cannot be used as a human approver/iu,
    );
  });

  it("rejects a machine identity recorded as a local Policy approval", () => {
    const directory = mkdtempSync(join(tmpdir(), "coga-factory-approval-"));
    const workOrder = structuredClone(loadWorkOrder(workOrderPath));
    const policy = workOrder.spec.governance.requiredPolicies[0];
    if (!policy) throw new Error("Expected a required Policy.");
    workOrder.spec.governance.approvals = [
      {
        policy,
        approver: workOrder.spec.delivery.identity.appSlug,
        approvedAt: "2026-08-12T12:00:00.000Z",
        evidence: [
          {
            path: "evidence/approval.md",
            digest: `sha256:${"1".repeat(64)}`,
          },
        ],
      },
    ];
    const path = join(directory, "machine-approval.json");
    writeFileSync(path, JSON.stringify(workOrder));
    expect(() => loadWorkOrder(path)).toThrow(
      /cannot be used as a human approver/iu,
    );
  });
});

describe("Evidence Bundle", () => {
  it("is content-addressed and rejects payload tampering", () => {
    const directory = mkdtempSync(join(tmpdir(), "coga-factory-evidence-"));
    const workOrder = loadWorkOrder(workOrderPath);
    const target = workOrder.spec.targets.find(
      (entry) => entry.application.id === "application.cedar.insight.h5",
    );
    if (!target) throw new Error("Expected Cedar target.");
    const proposalReceipt = loadAgentProposalReceipt(
      resolve(repositoryRoot, target.proposal.receipt.path),
    );
    const plan = {
      schemaVersion: workOrder.schemaVersion,
      kind: "TargetExecutionPlan",
      workOrder: {
        id: workOrder.metadata.id,
        digest:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        path: ".coga/work-orders/cedar-status/work-order.yaml",
      },
      baseCommit: "1".repeat(40),
      instanceManifest: workOrder.spec.instance.manifest,
      change: workOrder.spec.change.artifact,
      impact: {
        artifact: workOrder.spec.change.artifact,
        found: true,
        packages: [],
        affectedApplications: [
          {
            id: "application.cedar.insight.h5",
            title: "Cedar Insight H5",
            version: "0.2.0",
            path: "examples/broker-digital-channel/applications/cedar-insight-h5/application.yaml",
            reasons: [
              {
                type: "direct",
                path: [
                  {
                    ...workOrder.spec.change.artifact,
                    kind: "artifact",
                  },
                  {
                    id: "application.cedar.insight.h5",
                    version: "0.2.0",
                    kind: "application",
                  },
                ],
              },
            ],
            rerunScenarios: [],
            rerunRunbooks: [],
          },
        ],
      },
      target: {
        application: target.application,
        factoryDefinitionPath: target.factoryDefinition,
        definition: loadApplicationFactory(definitionPath),
        proposalReceiptPath: target.proposal.receipt.path,
        proposalReceipt,
        delivery: target.delivery,
      },
      steps: [],
      planDigest:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    } satisfies ExecutionPlan;
    const bundle = createEvidenceBundle({
      workOrder,
      plan,
      subjectTree: "2".repeat(40),
      changedFiles: [
        {
          path: "example.txt",
          digest:
            "sha256:3333333333333333333333333333333333333333333333333333333333333333",
          bytes: 7,
        },
      ],
      receipts: [
        {
          stepId: "change.apply",
          adapter: { id: "coga.domain.patch", version: "1" },
          status: "passed",
          startedAt: "2026-08-12T08:59:58.000Z",
          finishedAt: "2026-08-12T08:59:59.000Z",
          exitCode: 0,
          stdoutDigest:
            "sha256:4444444444444444444444444444444444444444444444444444444444444444",
          stderrDigest:
            "sha256:5555555555555555555555555555555555555555555555555555555555555555",
        },
      ],
      generatedAt: "2026-08-12T09:00:00.000Z",
    });
    expect(bundle.metadata.bundleDigest).toBe(evidenceDigest(bundle));
    const path = join(directory, "bundle.json");
    writeFileSync(path, canonicalJson(bundle));
    expect(verifyEvidenceBundle(path).metadata.bundleDigest).toBe(
      bundle.metadata.bundleDigest,
    );

    const tampered = JSON.parse(readFileSync(path, "utf8")) as typeof bundle;
    tampered.subject.baseCommit = "4".repeat(40);
    writeFileSync(path, canonicalJson(tampered));
    expect(() => verifyEvidenceBundle(path)).toThrow(/digest mismatch/iu);

    const structurallyInvalid = structuredClone(bundle) as typeof bundle;
    structurallyInvalid.steps = [
      { unexpected: true },
    ] as unknown as typeof structurallyInvalid.steps;
    structurallyInvalid.metadata.bundleDigest =
      evidenceDigest(structurallyInvalid);
    writeFileSync(path, canonicalJson(structurallyInvalid));
    expect(() => verifyEvidenceBundle(path)).toThrow(
      /Invalid Evidence Bundle/iu,
    );

    const semanticallyInvalid = structuredClone(bundle);
    semanticallyInvalid.governance.pendingPolicies = [];
    semanticallyInvalid.metadata.bundleDigest =
      evidenceDigest(semanticallyInvalid);
    writeFileSync(path, canonicalJson(semanticallyInvalid));
    expect(() => verifyEvidenceBundle(path)).toThrow(
      /exactly partition requiredPolicies/iu,
    );
  });
});
