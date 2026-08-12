import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectRemoteEvidenceWithCredential,
  FactoryOperationsExecutor,
} from "../src/operations-controller.js";
import { loadWorkOrder } from "../src/schema.js";
import type {
  FactoryTaskRecord,
  GitHubCredentialLease,
  GitHubCredentialProvider,
  GitHubCredentialRequest,
} from "../src/operations-types.js";
import type { FactoryRunResult } from "../src/types.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

const result: FactoryRunResult = {
  status: "completed",
  workOrderId: "example.work-order",
  baseCommit: "3".repeat(40),
  targets: [],
};

function task(delivery: "local" | "github"): FactoryTaskRecord {
  return {
    schemaVersion: "coga.dev/factory/operations/v0.1",
    kind: "FactoryTask",
    metadata: {
      id: `sha256:${"1".repeat(64)}`,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      recordDigest: `sha256:${"2".repeat(64)}`,
    },
    spec: {
      repositoryRoot,
      workOrderPath: ".coga/work-orders/cedar-status/work-order.yaml",
      workOrderDigest: `sha256:${"4".repeat(64)}`,
      baseCommit: "3".repeat(40),
      delivery,
      keepWorkspace: false,
      maxAttempts: 2,
    },
    phase: "leased",
    attempts: 1,
    recoveryCount: 0,
    timing: {
      enqueuedAt: "2026-08-13T00:00:00.000Z",
      startedAt: "2026-08-13T00:00:01.000Z",
    },
    events: [],
  };
}

function credentialProvider(options?: { acquireError?: Error }) {
  const requests: GitHubCredentialRequest[] = [];
  const revoked: GitHubCredentialLease[] = [];
  const lease: GitHubCredentialLease = {
    kind: "github-app-installation",
    id: "lease-1",
    provider: "test-provider",
    token: `ghs_${"secret".repeat(20)}`,
    issuedAt: "2026-08-13T00:00:00.000Z",
    expiresAt: "2026-08-13T01:00:00.000Z",
    repository: "kayz/coga-core",
    permissions: { contents: "write", pull_requests: "write" },
  };
  const provider: GitHubCredentialProvider = {
    acquire: async (request) => {
      requests.push(request);
      if (options?.acquireError) throw options.acquireError;
      return lease;
    },
    revoke: async (candidate) => {
      revoked.push(candidate);
    },
  };
  return { lease, provider, requests, revoked };
}

describe("Factory Operations executor", () => {
  it("runs local work without acquiring any GitHub credential", async () => {
    const factory = credentialProvider();
    const observed: Array<string | undefined> = [];
    const execute = new FactoryOperationsExecutor({
      credentialProvider: factory.provider,
      createController: (_task, token) => ({
        run: async () => {
          observed.push(token);
          return result;
        },
      }),
    });
    await expect(execute.execute(task("local"))).resolves.toEqual(result);
    expect(observed).toEqual([undefined]);
    expect(factory.requests).toEqual([]);
    expect(factory.revoked).toEqual([]);
  });

  it("leases exact minimal GitHub permissions in memory and always revokes", async () => {
    const factory = credentialProvider();
    let observedToken = "";
    const execute = new FactoryOperationsExecutor({
      credentialProvider: factory.provider,
      appSlug: "coga-factory-kayz",
      repository: "kayz/coga-core",
      minimumCredentialTtlMs: 600_000,
      createController: (_task, token) => ({
        run: async () => {
          observedToken = token ?? "";
          return result;
        },
      }),
    });
    const persisted = task("github");
    await expect(execute.execute(persisted)).resolves.toEqual(result);
    expect(factory.requests).toEqual([
      {
        purpose: "draft-delivery",
        repository: "kayz/coga-core",
        appSlug: "coga-factory-kayz",
        permissions: { contents: "write", pull_requests: "write" },
        minimumTtlMs: 600_000,
      },
    ]);
    expect(observedToken).toBe(factory.lease.token);
    expect(factory.revoked).toEqual([factory.lease]);
    expect(JSON.stringify(persisted)).not.toContain(factory.lease.token);
  });

  it("revokes the lease when controlled execution fails", async () => {
    const factory = credentialProvider();
    const execute = new FactoryOperationsExecutor({
      credentialProvider: factory.provider,
      appSlug: "coga-factory-kayz",
      repository: "kayz/coga-core",
      createController: () => ({
        run: async () => {
          throw new Error("sandbox failed");
        },
      }),
    });
    await expect(execute.execute(task("github"))).rejects.toThrow(
      "sandbox failed",
    );
    expect(factory.revoked).toEqual([factory.lease]);
  });

  it("fails closed without a provider and never starts the controller", async () => {
    const run = vi.fn(async () => result);
    const execute = new FactoryOperationsExecutor({
      createController: () => ({ run }),
    });
    await expect(execute.execute(task("github"))).rejects.toThrow(
      /explicit short-lived credential provider/iu,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("collects remote evidence with a purpose-bound lease and revokes it", async () => {
    const factory = credentialProvider();
    const workOrder = loadWorkOrder(
      resolve(repositoryRoot, ".coga/work-orders/cedar-status/work-order.yaml"),
    );
    const target = workOrder.spec.targets[0];
    if (!target) throw new Error("Expected a Work Order target.");
    let clientToken = "";
    const expected = {
      path: `.coga/remote-evidence/${"5".repeat(64)}.json`,
      evidence: {
        schemaVersion: "coga.dev/factory/v0.3",
        kind: "RemoteEvidence",
        metadata: {
          collectedAt: "2026-08-13T00:00:00.000Z",
          remoteEvidenceDigest: `sha256:${"5".repeat(64)}`,
        },
        subject: {
          evidenceBundle: {
            path: `.coga/evidence/${"6".repeat(64)}.json`,
            digest: `sha256:${"7".repeat(64)}`,
          },
          repository: "kayz/coga-core",
          pullRequest: 42,
          pullRequestUrl: "https://github.com/kayz/coga-core/pull/42",
          pullRequestAuthor: "coga-factory-kayz[bot]",
          baseCommit: "3".repeat(40),
          headCommit: "4".repeat(40),
          application: target.application,
          workOrder: {
            id: workOrder.metadata.id,
            digest: `sha256:${"8".repeat(64)}`,
          },
        },
        checks: [],
        attestation: {
          verified: true,
          subjectDigest: `sha256:${"7".repeat(64)}`,
          verifier: "gh-attestation",
        },
        approvals: [],
        promotion: { eligible: false, blockers: ["approval missing"] },
      },
      promoted: false,
    } as const;
    const collected = await collectRemoteEvidenceWithCredential(
      {
        workOrder,
        baseCommit: "3".repeat(40),
        application: target.application,
        pullRequest: 42,
        evidencePath: expected.evidence.subject.evidenceBundle.path,
        outputRoot: repositoryRoot,
        collectedAt: "2026-08-13T00:00:00.000Z",
      },
      factory.provider,
      {
        clientFactory: (token) => {
          clientToken = token;
          return {} as never;
        },
        collect: async () => expected,
      },
    );
    expect(collected).toEqual(expected);
    expect(clientToken).toBe(factory.lease.token);
    expect(factory.requests).toEqual([
      {
        purpose: "remote-evidence",
        repository: "kayz/coga-core",
        appSlug: "coga-factory-kayz",
        permissions: {
          actions: "read",
          checks: "read",
          contents: "read",
          pull_requests: "write",
        },
        minimumTtlMs: 300_000,
      },
    ]);
    expect(factory.revoked).toEqual([factory.lease]);
  });
});
