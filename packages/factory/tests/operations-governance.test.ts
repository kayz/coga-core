import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FactorySloPolicy,
  FactoryTaskEvent,
  FactoryTaskRecord,
  GitHubCredentialLease,
  GitHubCredentialProvider,
  MergeAuthorization,
  MergeGateSnapshot,
  MergePromotionClient,
  PlatformEvidence,
  TestEnvironmentAuthorization,
  VersionTagSnapshot,
} from "../src/operations-types.js";
import { FACTORY_OPERATIONS_SCHEMA_VERSION } from "../src/operations-types.js";
import {
  evaluatePlatformEvidence,
  loadPlatformEvidence,
  platformEvidenceDigest,
} from "../src/platform-gate.js";
import { FactoryTaskQueue } from "../src/queue.js";
import {
  evaluateMergeGate,
  evaluateTestEnvironmentGate,
  executeAuthorizedMerge,
  loadMergeAuthorization,
  loadTestEnvironmentAuthorization,
  mergeAuthorizationDigest,
  testEnvironmentAuthorizationDigest,
} from "../src/promotion.js";
import { createFactorySloReport, loadFactorySloPolicy } from "../src/slo.js";
import { remoteEvidenceDigest } from "../src/remote.js";
import type {
  FileReference,
  RemoteCheckEvidence,
  RemoteEvidence,
  Sha256Digest,
} from "../src/types.js";
import { canonicalJson, sha256 } from "../src/utils.js";

const roots: string[] = [];
const baseCommit = "1".repeat(40);
const headCommit = "2".repeat(40);
const mergeCommit = "3".repeat(40);
const repository = "kayz/coga-core";
const nowText = "2026-08-13T12:30:00.000Z";
const marker = "[coga-merge:factory-0.5]";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `coga-${name}-`));
  roots.push(root);
  return root;
}

function write(
  root: string,
  path: string,
  bytes: string | Buffer,
): FileReference {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  writeFileSync(absolute, buffer);
  return { path, digest: sha256(buffer) };
}

function taskEvent(
  sequence: number,
  type: FactoryTaskEvent["type"],
  at: string,
  previousDigest?: Sha256Digest,
  binding: { workerId?: string; leaseId?: string; detail?: string } = {},
): FactoryTaskEvent {
  const payload = {
    sequence,
    type,
    at,
    ...(previousDigest === undefined ? {} : { previousDigest }),
    ...binding,
  };
  return { ...payload, digest: sha256(canonicalJson(payload)) };
}

function task(parameters: {
  suffix: string;
  phase: "queued" | "succeeded" | "failed";
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  failureKind?: "transient" | "permanent" | "isolation";
}): FactoryTaskRecord {
  const spec = {
    repositoryRoot: `C:/fixture/${parameters.suffix}`,
    workOrderPath: `.coga/work-orders/${parameters.suffix}.yaml`,
    workOrderDigest: sha256(parameters.suffix),
    baseCommit,
    delivery: "local" as const,
    keepWorkspace: false,
    maxAttempts: 3,
  };
  const enqueued = taskEvent(1, "enqueued", parameters.enqueuedAt);
  const events: FactoryTaskEvent[] = [enqueued];
  if (parameters.startedAt) {
    events.push(
      taskEvent(2, "leased", parameters.startedAt, enqueued.digest, {
        workerId: "worker-1",
        leaseId: "lease-1",
      }),
    );
  }
  if (parameters.finishedAt) {
    const prior = events.at(-1);
    if (!prior) throw new Error("Missing prior event.");
    events.push(
      taskEvent(
        events.length + 1,
        parameters.phase === "succeeded" ? "succeeded" : "failed",
        parameters.finishedAt,
        prior.digest,
        { workerId: "worker-1", leaseId: "lease-1" },
      ),
    );
  }
  const draft: FactoryTaskRecord = {
    schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
    kind: "FactoryTask",
    metadata: {
      id: sha256(canonicalJson(spec)),
      createdAt: parameters.enqueuedAt,
      updatedAt: events.at(-1)?.at ?? parameters.enqueuedAt,
      recordDigest: `sha256:${"0".repeat(64)}`,
    },
    spec,
    phase: parameters.phase,
    attempts: parameters.startedAt ? 1 : 0,
    recoveryCount: 0,
    timing: {
      enqueuedAt: parameters.enqueuedAt,
      ...(parameters.startedAt ? { startedAt: parameters.startedAt } : {}),
      ...(parameters.finishedAt
        ? {
            finishedAt: parameters.finishedAt,
            runDurationMs:
              Date.parse(parameters.finishedAt) -
              Date.parse(parameters.startedAt as string),
          }
        : {}),
    },
    ...(parameters.phase === "succeeded"
      ? {
          result: {
            status: "completed" as const,
            workOrderId: parameters.suffix,
            baseCommit,
            targets: [],
          },
        }
      : {}),
    ...(parameters.phase === "failed"
      ? {
          failure: {
            kind: parameters.failureKind ?? "permanent",
            message: "bounded fixture failure",
            occurredAt: parameters.finishedAt as string,
          },
        }
      : {}),
    events,
  };
  const { recordDigest: _digest, ...metadata } = draft.metadata;
  draft.metadata.recordDigest = sha256(canonicalJson({ ...draft, metadata }));
  return draft;
}

function policy(): FactorySloPolicy {
  return {
    schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
    kind: "FactorySloPolicy",
    metadata: { id: "factory.daily" },
    window: {
      from: "2026-08-13T12:00:00.000Z",
      to: "2026-08-13T12:10:00.000Z",
    },
    objectives: {
      minimumSuccessRate: 0.5,
      maximumP95QueueLatencyMs: 2_000,
      maximumP95RunDurationMs: 4_000,
      maximumIsolationFailureRate: 0.5,
      maximumQueueDepth: 2,
      maximumEstimatedCostMicros: 100,
    },
    costModel: { computeMicrosPerSecond: 10 },
  };
}

function checks(): RemoteCheckEvidence[] {
  return ["factory", "core"].map((name) => ({
    name,
    app: "GitHub Actions",
    conclusion: "success" as const,
    completedAt: "2026-08-13T12:05:00.000Z",
    url: `https://github.com/kayz/coga-core/actions/runs/1#${name}`,
  }));
}

function remoteFixture(root: string): {
  remote: RemoteEvidence;
  authorization: MergeAuthorization;
  snapshot: MergeGateSnapshot;
} {
  const bundle = write(root, ".coga/evidence/bundle.json", "evidence-bundle\n");
  const remote: RemoteEvidence = {
    schemaVersion: "coga.dev/factory/v0.3",
    kind: "RemoteEvidence",
    metadata: {
      collectedAt: "2026-08-13T12:06:00.000Z",
      remoteEvidenceDigest: `sha256:${"0".repeat(64)}`,
    },
    subject: {
      evidenceBundle: bundle,
      repository,
      pullRequest: 42,
      pullRequestUrl: "https://github.com/kayz/coga-core/pull/42",
      pullRequestAuthor: "coga-factory-kayz[bot]",
      baseCommit,
      headCommit,
      application: { id: "application.wechat", version: "0.5.0" },
      workOrder: {
        id: "factory.work-order",
        digest: `sha256:${"4".repeat(64)}`,
      },
    },
    checks: checks(),
    attestation: {
      verified: true,
      subjectDigest: bundle.digest,
      verifier: "gh-attestation",
    },
    approvals: [],
    promotion: { eligible: true, blockers: [] },
  };
  remote.metadata.remoteEvidenceDigest = remoteEvidenceDigest(remote);
  const remoteReference = write(
    root,
    ".coga/remote-evidence/merge.json",
    canonicalJson(remote),
  );
  const authorization: MergeAuthorization = {
    schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
    kind: "MergeAuthorization",
    metadata: {
      id: "merge.factory-0.5",
      issuedAt: "2026-08-13T12:10:00.000Z",
      expiresAt: "2026-08-13T13:10:00.000Z",
      authorizationDigest: `sha256:${"0".repeat(64)}`,
    },
    subject: {
      repository,
      pullRequest: 42,
      baseBranch: "main",
      baseCommit,
      headCommit,
      remoteEvidence: remoteReference,
    },
    decision: {
      method: "squash",
      policy: { id: "policy.factory.merge", version: "0.5.0" },
      authorizedApprovers: ["human-reviewer"],
      approvalMarker: marker,
    },
  };
  authorization.metadata.authorizationDigest =
    mergeAuthorizationDigest(authorization);
  const snapshot: MergeGateSnapshot = {
    pullRequest: {
      number: 42,
      url: "https://github.com/kayz/coga-core/pull/42",
      state: "OPEN",
      isDraft: false,
      author: "coga-factory-kayz[bot]",
      baseBranch: "main",
      baseCommit,
      headCommit,
      changedFiles: 3,
    },
    checks: checks(),
    reviews: [
      {
        id: 7,
        reviewer: "human-reviewer",
        state: "APPROVED",
        body: marker,
        submittedAt: "2026-08-13T12:20:00.000Z",
        commit: headCommit,
        url: "https://github.com/kayz/coga-core/pull/42#pullrequestreview-7",
      },
    ],
  };
  return { remote, authorization, snapshot };
}

function testAuthorization(root: string): {
  authorization: TestEnvironmentAuthorization;
  snapshot: VersionTagSnapshot;
} {
  const manifest = write(
    root,
    "release/manifest.json",
    '{"version":"0.5.0"}\n',
  );
  const authorization: TestEnvironmentAuthorization = {
    schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
    kind: "TestEnvironmentAuthorization",
    metadata: {
      id: "test.factory-0.5",
      issuedAt: "2026-08-13T12:10:00.000Z",
      expiresAt: "2026-08-13T13:10:00.000Z",
      authorizationDigest: `sha256:${"0".repeat(64)}`,
    },
    subject: {
      repository,
      version: "0.5.0",
      tag: "v0.5.0",
      commit: headCommit,
      defaultBranch: "main",
      environment: "test",
      releaseManifest: manifest,
    },
    decision: {
      policy: { id: "policy.factory.test", version: "0.5.0" },
      authorizedApprovers: ["release-manager"],
      approvalMarker: "[coga-test-environment:v0.5.0]",
      requireSignedAnnotatedTag: true,
      requireDefaultBranchTip: true,
    },
  };
  authorization.metadata.authorizationDigest =
    testEnvironmentAuthorizationDigest(authorization);
  const snapshot: VersionTagSnapshot = {
    repository,
    tag: "v0.5.0",
    version: "0.5.0",
    commit: headCommit,
    defaultBranch: "main",
    defaultBranchTip: headCommit,
    annotated: true,
    signatureVerified: true,
    signatureReason: "valid",
    approvals: [
      {
        id: 8,
        reviewer: "release-manager",
        state: "APPROVED",
        body: "[coga-test-environment:v0.5.0]",
        submittedAt: "2026-08-13T12:20:00.000Z",
        commit: headCommit,
        url: "https://github.com/kayz/coga-core/pull/42#pullrequestreview-8",
      },
    ],
  };
  return { authorization, snapshot };
}

function platformFixture(root: string): PlatformEvidence {
  const buildArtifact = write(root, "evidence/build.zip", "build-artifact\n");
  const checks = [
    "devtools-compile",
    "simulator",
    "physical-device",
    "screen-reader",
  ].map((kind, index) => ({
    kind: kind as PlatformEvidence["checks"][number]["kind"],
    status: "passed" as const,
    operator: `operator-${index + 1}`,
    observedAt: `2026-08-13T12:0${index + 1}:00.000Z`,
    evidence: [write(root, `evidence/${kind}.json`, `${kind}-${index}\n`)],
  }));
  const evidence: PlatformEvidence = {
    schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
    kind: "PlatformEvidence",
    metadata: {
      generatedAt: "2026-08-13T12:10:00.000Z",
      evidenceDigest: `sha256:${"0".repeat(64)}`,
    },
    subject: {
      application: { id: "application.wechat", version: "0.5.0" },
      candidateCommit: headCommit,
      platform: "wechat-miniprogram",
      buildArtifact,
    },
    checks,
  };
  evidence.metadata.evidenceDigest = platformEvidenceDigest(evidence);
  return evidence;
}

describe("Factory operations governance", () => {
  it("computes an exact-window SLO report with stable p95, queue depth, rates, and cost", () => {
    const records = [
      task({
        suffix: "success",
        phase: "succeeded",
        enqueuedAt: "2026-08-13T11:59:59.000Z",
        startedAt: "2026-08-13T12:00:01.000Z",
        finishedAt: "2026-08-13T12:00:03.000Z",
      }),
      task({
        suffix: "failure",
        phase: "failed",
        failureKind: "isolation",
        enqueuedAt: "2026-08-13T12:00:00.000Z",
        startedAt: "2026-08-13T12:00:02.000Z",
        finishedAt: "2026-08-13T12:00:06.000Z",
      }),
      task({
        suffix: "queued",
        phase: "queued",
        enqueuedAt: "2026-08-13T12:01:00.000Z",
      }),
    ];
    const report = createFactorySloReport(policy(), records, {
      measuredAt: nowText,
      minimumSamples: 2,
    });
    expect(report.metrics).toMatchObject({
      queueDepth: 2,
      terminalTasks: 2,
      succeededTasks: 1,
      failedTasks: 1,
      successRate: 0.5,
      p95QueueLatencyMs: 2_000,
      p95RunDurationMs: 4_000,
      isolationFailureRate: 0.5,
      estimatedCostMicros: 60,
    });
    expect(report.objectives.every((entry) => entry.status === "passed")).toBe(
      true,
    );
    expect(report.compliant).toBe(true);
    expect(report.metadata.reportDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed on insufficient samples and tampered task audit chains", () => {
    const empty = createFactorySloReport(policy(), [], {
      measuredAt: nowText,
      minimumSamples: 2,
    });
    expect(empty.compliant).toBe(false);
    expect(
      empty.objectives.filter((entry) => entry.status === "insufficient-data"),
    ).toHaveLength(4);

    const record = task({
      suffix: "tamper",
      phase: "succeeded",
      enqueuedAt: "2026-08-13T12:00:00.000Z",
      startedAt: "2026-08-13T12:00:01.000Z",
      finishedAt: "2026-08-13T12:00:02.000Z",
    });
    record.events[1]!.at = "2026-08-13T12:00:01.500Z";
    expect(() =>
      createFactorySloReport(policy(), [record], { measuredAt: nowText }),
    ).toThrow(/digest is inconsistent/iu);
  });

  it("accepts a terminal lease-recovery record from the durable queue", () => {
    const repositoryRoot = temporaryRoot("slo-recovery");
    const workOrderPath = "work-order.yaml";
    const workOrder = "schemaVersion: coga.dev/factory/v0.3\n";
    writeFileSync(join(repositoryRoot, workOrderPath), workOrder);
    let current = Date.parse("2026-08-13T12:00:00.000Z");
    const queue = new FactoryTaskQueue({
      root: join(repositoryRoot, "queue"),
      now: () => new Date(current),
      randomId: () => "lease-id",
    });
    queue.enqueue({
      repositoryRoot,
      workOrderPath,
      workOrderDigest: sha256(workOrder),
      baseCommit,
      delivery: "local",
      keepWorkspace: false,
      maxAttempts: 1,
    });
    queue.claim("worker", 1_000);
    current += 2_000;
    queue.claim("recovery-worker", 1_000);
    const report = createFactorySloReport(policy(), queue.list(), {
      measuredAt: nowText,
    });
    expect(report.metrics).toMatchObject({
      terminalTasks: 1,
      failedTasks: 1,
      recoveredTasks: 1,
    });
    expect(report.objectives.some((entry) => entry.status === "failed")).toBe(
      true,
    );
  });

  it("loads bounded JSON/YAML policies and rejects duplicate or unknown fields", () => {
    const root = temporaryRoot("slo-loader");
    const yamlPath = join(root, "slo.yaml");
    const value = policy();
    writeFileSync(
      yamlPath,
      [
        `schemaVersion: ${value.schemaVersion}`,
        "kind: FactorySloPolicy",
        "metadata:",
        "  id: factory.daily",
        "window:",
        `  from: ${value.window.from}`,
        `  to: ${value.window.to}`,
        "objectives:",
        "  minimumSuccessRate: 0.5",
        "  maximumP95QueueLatencyMs: 2000",
        "  maximumP95RunDurationMs: 4000",
        "  maximumIsolationFailureRate: 0.5",
        "  maximumQueueDepth: 2",
        "  maximumEstimatedCostMicros: 100",
        "costModel:",
        "  computeMicrosPerSecond: 10",
        "",
      ].join("\n"),
    );
    expect(loadFactorySloPolicy(yamlPath)).toEqual(value);
    const badPath = join(root, "bad.json");
    writeFileSync(
      badPath,
      '{"schemaVersion":"coga.dev/factory/operations/v0.1","schemaVersion":"coga.dev/factory/operations/v0.1"}',
    );
    expect(() => loadFactorySloPolicy(badPath)).toThrow(/duplicate|map keys/iu);
  });

  it("accepts only the exact ready PR, exact Remote Evidence, checks, and human marker", () => {
    const root = temporaryRoot("merge-gate");
    const fixture = remoteFixture(root);
    expect(
      evaluateMergeGate(
        root,
        fixture.remote,
        fixture.authorization,
        fixture.snapshot,
        {
          requiredChecks: ["factory", "core"],
          now: () => new Date(nowText),
        },
      ),
    ).toMatchObject({
      eligible: true,
      blockers: [],
      approval: { reviewer: "human-reviewer" },
    });

    const wrongReviewUrl = structuredClone(fixture.snapshot);
    wrongReviewUrl.reviews[0]!.url =
      "https://github.com/kayz/coga-core/pull/42#pullrequestreview-999";
    expect(
      evaluateMergeGate(
        root,
        fixture.remote,
        fixture.authorization,
        wrongReviewUrl,
        {
          requiredChecks: ["factory", "core"],
          now: () => new Date(nowText),
        },
      ).blockers,
    ).toContain(
      "Merge approval review URL does not bind the authorized pull request.",
    );

    const hostile = structuredClone(fixture.snapshot);
    hostile.pullRequest.isDraft = true;
    hostile.pullRequest.baseBranch = "release-preview";
    hostile.pullRequest.author = "different-app[bot]";
    hostile.reviews[0]!.body = `prefix ${marker} suffix`;
    hostile.reviews[0]!.url =
      "https://github.com/other/repository/pull/42#pullrequestreview-7";
    hostile.checks.push({ ...hostile.checks[0]!, name: "unbound" });
    const blocked = evaluateMergeGate(
      root,
      fixture.remote,
      fixture.authorization,
      hostile,
      { requiredChecks: ["factory", "core"], now: () => new Date(nowText) },
    );
    expect(blocked.eligible).toBe(false);
    expect(blocked.blockers).toEqual(
      expect.arrayContaining([
        "Pull request must be ready and OPEN.",
        "Live pull request base branch changed.",
        "Live pull request author differs from Remote Evidence.",
        "Live checks are not the exact required check set.",
        "No distinct authorized human supplied the exact-head APPROVED merge marker.",
      ]),
    );
  });

  it("rejects expired or byte-tampered merge authorization and strict loader input", () => {
    const root = temporaryRoot("merge-hostile");
    const fixture = remoteFixture(root);
    const longLived = structuredClone(fixture.authorization);
    longLived.metadata.expiresAt = "2026-08-15T12:10:00.000Z";
    longLived.metadata.authorizationDigest =
      mergeAuthorizationDigest(longLived);
    expect(() =>
      evaluateMergeGate(root, fixture.remote, longLived, fixture.snapshot, {
        requiredChecks: ["factory", "core"],
        now: () => new Date(nowText),
      }),
    ).toThrow(/24 hours/iu);

    writeFileSync(
      join(root, fixture.authorization.subject.remoteEvidence.path),
      "tampered\n",
    );
    const expired = evaluateMergeGate(
      root,
      fixture.remote,
      fixture.authorization,
      fixture.snapshot,
      {
        requiredChecks: ["factory", "core"],
        now: () => new Date("2026-08-13T13:10:00.000Z"),
      },
    );
    expect(expired.eligible).toBe(false);
    expect(expired.blockers).toEqual(
      expect.arrayContaining([
        "Remote Evidence content or digest verification failed.",
        "Merge Authorization has expired.",
      ]),
    );

    const authPath = join(root, "merge.json");
    writeFileSync(
      authPath,
      canonicalJson({ ...fixture.authorization, extra: true }),
    );
    expect(() => loadMergeAuthorization(authPath)).toThrow(
      /additional properties/iu,
    );
  });

  it("merges only through injected dependencies after a fresh exact-head snapshot", async () => {
    const root = temporaryRoot("merge-execute");
    const fixture = remoteFixture(root);
    const snapshots = [fixture.snapshot, structuredClone(fixture.snapshot)];
    let merges = 0;
    let revocations = 0;
    const client: MergePromotionClient = {
      snapshot: async () => snapshots.shift() as MergeGateSnapshot,
      merge: async (repo, pullRequest, expectedHead, method, token) => {
        expect([repo, pullRequest, expectedHead, method, token]).toEqual([
          repository,
          42,
          headCommit,
          "squash",
          "short-lived-installation-token",
        ]);
        merges += 1;
        return { mergeCommit };
      },
    };
    const provider: GitHubCredentialProvider = {
      acquire: async (request) => {
        expect(request).toMatchObject({
          purpose: "authorized-merge",
          repository,
          permissions: { contents: "write", pull_requests: "write" },
        });
        return {
          kind: "github-app-installation",
          id: "lease-1",
          provider: "github-app:coga-factory:1",
          token: "short-lived-installation-token",
          issuedAt: "2026-08-13T12:29:00.000Z",
          expiresAt: "2026-08-13T12:40:00.000Z",
          repository,
          permissions: { contents: "write", pull_requests: "write" },
        } satisfies GitHubCredentialLease;
      },
      revoke: async () => {
        revocations += 1;
      },
    };
    await expect(
      executeAuthorizedMerge(
        root,
        fixture.remote,
        fixture.authorization,
        { client, credentialProvider: provider },
        {
          requiredChecks: ["factory", "core"],
          appSlug: "coga-factory",
          now: () => new Date(nowText),
        },
      ),
    ).resolves.toEqual({ mergeCommit });
    expect({ merges, revocations }).toEqual({ merges: 1, revocations: 1 });
  });

  it("rechecks TOCTOU state, never merges a changed head, and always revokes", async () => {
    const root = temporaryRoot("merge-race");
    const fixture = remoteFixture(root);
    const changed = structuredClone(fixture.snapshot);
    changed.pullRequest.headCommit = "9".repeat(40);
    const snapshots = [fixture.snapshot, changed];
    let merges = 0;
    let revocations = 0;
    const client: MergePromotionClient = {
      snapshot: async () => snapshots.shift() as MergeGateSnapshot,
      merge: async () => {
        merges += 1;
        return { mergeCommit };
      },
    };
    const provider: GitHubCredentialProvider = {
      acquire: async () => ({
        kind: "github-app-installation",
        id: "lease-2",
        provider: "github-app:coga-factory:1",
        token: "short-lived-installation-token",
        issuedAt: "2026-08-13T12:29:00.000Z",
        expiresAt: "2026-08-13T12:40:00.000Z",
        repository,
        permissions: { contents: "write", pull_requests: "write" },
      }),
      revoke: async () => {
        revocations += 1;
      },
    };
    await expect(
      executeAuthorizedMerge(
        root,
        fixture.remote,
        fixture.authorization,
        { client, credentialProvider: provider },
        {
          requiredChecks: ["factory", "core"],
          appSlug: "coga-factory",
          now: () => new Date(nowText),
        },
      ),
    ).rejects.toThrow(/TOCTOU/iu);
    expect({ merges, revocations }).toEqual({ merges: 0, revocations: 1 });
  });

  it("keeps test-environment authorization separate and requires exact signed default-tip tag evidence", () => {
    const root = temporaryRoot("test-gate");
    const fixture = testAuthorization(root);
    expect(
      evaluateTestEnvironmentGate(
        root,
        fixture.authorization,
        fixture.snapshot,
        {
          now: () => new Date(nowText),
          expectedEnvironment: "test",
        },
      ),
    ).toEqual({ eligible: true, blockers: [] });

    const wrongApprovalUrl = structuredClone(fixture.snapshot);
    wrongApprovalUrl.approvals[0]!.url =
      "https://github.com/kayz/coga-core/pull/42#pullrequestreview-999";
    expect(
      evaluateTestEnvironmentGate(
        root,
        fixture.authorization,
        wrongApprovalUrl,
        { now: () => new Date(nowText), expectedEnvironment: "test" },
      ).blockers,
    ).toContain(
      "Test Environment approval URL does not bind the authorized repository.",
    );

    const hostile = structuredClone(fixture.snapshot);
    hostile.annotated = false;
    hostile.signatureVerified = false;
    hostile.signatureReason = "unsigned";
    hostile.defaultBranchTip = baseCommit;
    hostile.approvals[0]!.body = "merge was authorized";
    const blocked = evaluateTestEnvironmentGate(
      root,
      fixture.authorization,
      hostile,
      { now: () => new Date(nowText), expectedEnvironment: "test" },
    );
    expect(blocked.eligible).toBe(false);
    expect(blocked.blockers.join(" ")).toMatch(
      /default-branch tip.*annotated.*signature.*test-environment marker/iu,
    );

    const authPath = join(root, "test-auth.yaml");
    writeFileSync(authPath, canonicalJson(fixture.authorization));
    expect(loadTestEnvironmentAuthorization(authPath)).toEqual(
      fixture.authorization,
    );
    const unsafeBranch = structuredClone(fixture.authorization);
    unsafeBranch.subject.defaultBranch = "../main";
    unsafeBranch.metadata.authorizationDigest =
      testEnvironmentAuthorizationDigest(unsafeBranch);
    writeFileSync(authPath, canonicalJson(unsafeBranch));
    expect(() => loadTestEnvironmentAuthorization(authPath)).toThrow(
      /defaultBranch|pattern/iu,
    );
  });

  it("accepts exactly four distinct WeChat checks with distinct verified evidence files", () => {
    const root = temporaryRoot("platform-gate");
    const evidence = platformFixture(root);
    const expected = {
      application: evidence.subject.application,
      candidateCommit: headCommit,
    };
    expect(evaluatePlatformEvidence(root, evidence, expected)).toEqual({
      eligible: true,
      blockers: [],
      application: evidence.subject.application,
      candidateCommit: headCommit,
    });
    const path = join(root, "platform.json");
    writeFileSync(path, canonicalJson(evidence));
    expect(loadPlatformEvidence(path)).toEqual(evidence);
  });

  it("rejects duplicate checks/evidence and reports bounded missing-file or identity blockers", () => {
    const root = temporaryRoot("platform-hostile");
    const evidence = platformFixture(root);
    const duplicate = structuredClone(evidence);
    duplicate.checks[3]!.kind = duplicate.checks[0]!.kind;
    duplicate.metadata.evidenceDigest = platformEvidenceDigest(duplicate);
    expect(() =>
      evaluatePlatformEvidence(root, duplicate, {
        application: evidence.subject.application,
        candidateCommit: headCommit,
      }),
    ).toThrow(/four unique/iu);

    const future = structuredClone(evidence);
    future.checks[0]!.observedAt = "2026-08-13T12:11:00.000Z";
    future.metadata.evidenceDigest = platformEvidenceDigest(future);
    expect(() =>
      evaluatePlatformEvidence(root, future, {
        application: evidence.subject.application,
        candidateCommit: headCommit,
      }),
    ).toThrow(/postdate/iu);

    rmSync(join(root, evidence.checks[0]!.evidence[0]!.path));
    const blocked = evaluatePlatformEvidence(root, evidence, {
      application: { id: "application.other", version: "0.5.0" },
      candidateCommit: "9".repeat(40),
    });
    expect(blocked.eligible).toBe(false);
    expect(blocked.blockers).toHaveLength(3);
    expect(blocked.blockers.join(" ")).toMatch(
      /application.*candidate commit.*verification failed/iu,
    );

    const duplicateFile = structuredClone(evidence);
    duplicateFile.checks[1]!.evidence[0] =
      duplicateFile.checks[0]!.evidence[0]!;
    duplicateFile.metadata.evidenceDigest =
      platformEvidenceDigest(duplicateFile);
    write(root, "duplicate.json", canonicalJson(duplicateFile));
    expect(() => loadPlatformEvidence(join(root, "duplicate.json"))).toThrow(
      /duplicate evidence file paths/iu,
    );
  });
});
