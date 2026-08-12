import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEvidenceBundle, evidenceDigest } from "../src/evidence.js";
import { inspectPatchPaths } from "../src/git.js";
import {
  createGovernanceView,
  governanceViewMarkdown,
} from "../src/governance.js";
import { collectRemoteEvidence, githubCliEnvironment } from "../src/remote.js";
import {
  loadAgentProposalReceipt,
  loadApplicationFactory,
  loadWorkOrder,
} from "../src/schema.js";
import type {
  GitHubEvidenceClient,
  GitHubPullRequestSnapshot,
  GitHubReviewSnapshot,
  RemoteCheckEvidence,
  TargetExecutionPlan,
} from "../src/types.js";
import {
  canonicalJson,
  compareText,
  runCheckedBinary,
  sha256,
} from "../src/utils.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workOrderPath = resolve(
  repositoryRoot,
  ".coga/work-orders/cedar-status/work-order.yaml",
);
const baseCommit = "1".repeat(40);
const headCommit = "2".repeat(40);

function targetFixture() {
  const workOrder = loadWorkOrder(workOrderPath);
  const target = workOrder.spec.targets.find(
    (entry) => entry.application.id === "application.cedar.insight.h5",
  );
  if (!target) throw new Error("Expected Cedar target.");
  const proposalReceipt = loadAgentProposalReceipt(
    resolve(repositoryRoot, target.proposal.receipt.path),
  );
  const definition = loadApplicationFactory(
    resolve(repositoryRoot, target.factoryDefinition),
  );
  const plan = {
    schemaVersion: workOrder.schemaVersion,
    kind: "TargetExecutionPlan",
    workOrder: {
      id: workOrder.metadata.id,
      digest: sha256(canonicalJson(workOrder)),
      path: ".coga/work-orders/cedar-status/work-order.yaml",
    },
    baseCommit,
    instanceManifest: workOrder.spec.instance.manifest,
    change: workOrder.spec.change.artifact,
    impact: {
      artifact: workOrder.spec.change.artifact,
      found: true,
      packages: [],
      affectedApplications: [
        {
          id: target.application.id,
          title: "Cedar Insight H5",
          version: target.application.version,
          path: definition.spec.manifest,
          reasons: [
            {
              type: "direct",
              path: [
                { ...workOrder.spec.change.artifact, kind: "artifact" },
                { ...target.application, kind: "application" },
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
      definition,
      proposalReceiptPath: target.proposal.receipt.path,
      proposalReceipt,
      delivery: target.delivery,
    },
    steps: [],
    planDigest: `sha256:${"3".repeat(64)}`,
  } satisfies TargetExecutionPlan;
  const domainPatchBytes = readFileSync(
    resolve(repositoryRoot, workOrder.spec.change.patch.path),
  );
  const proposalPatchBytes = readFileSync(
    resolve(repositoryRoot, proposalReceipt.output.patch.path),
  );
  const changedPaths = [
    ...new Set([
      ...inspectPatchPaths(domainPatchBytes.toString("utf8")),
      ...inspectPatchPaths(proposalPatchBytes.toString("utf8")),
    ]),
  ].sort();
  const changedFiles = new Map(
    changedPaths.map((path) => [path, Buffer.from(`changed:${path}\n`)]),
  );
  const bundle = createEvidenceBundle({
    workOrder,
    plan,
    subjectTree: "4".repeat(40),
    changedFiles: [...changedFiles].map(([path, bytes]) => ({
      path,
      digest: sha256(bytes),
      bytes: bytes.byteLength,
    })),
    receipts: [
      {
        stepId: "change.apply",
        adapter: { id: "coga.domain.patch", version: "1" },
        status: "passed",
        startedAt: "2026-08-12T11:59:58.000Z",
        finishedAt: "2026-08-12T11:59:59.000Z",
        exitCode: 0,
        stdoutDigest: `sha256:${"6".repeat(64)}`,
        stderrDigest: `sha256:${"7".repeat(64)}`,
      },
    ],
    generatedAt: "2026-08-12T12:00:00.000Z",
  });
  const bundleBytes = Buffer.from(canonicalJson(bundle));
  const bundlePath = `.coga/evidence/${bundle.metadata.bundleDigest.slice("sha256:".length)}.json`;
  const proposalBytes = readFileSync(
    resolve(repositoryRoot, target.proposal.receipt.path),
  );
  const remoteFiles = new Map<string, Buffer>([
    ...changedFiles,
    [bundlePath, bundleBytes],
    [target.proposal.receipt.path, proposalBytes],
    [workOrder.spec.change.patch.path, domainPatchBytes],
    [proposalReceipt.output.patch.path, proposalPatchBytes],
  ]);
  return {
    workOrder,
    target,
    bundle,
    bundleBytes,
    bundlePath,
    remoteFiles,
    prFiles: [bundlePath, ...changedPaths].sort(),
  };
}

class FakeGitHubClient implements GitHubEvidenceClient {
  readonly checksResult: RemoteCheckEvidence[];
  readonly reviewsResult: GitHubReviewSnapshot[];
  readonly snapshots: GitHubPullRequestSnapshot[];
  readonly remoteFiles: Map<string, Buffer>;
  readonly filesResult: string[];
  readyCalls = 0;
  attestationCalls = 0;
  private pullRequestCalls = 0;

  constructor(parameters: {
    remoteFiles: Map<string, Buffer>;
    prFiles: string[];
    checks: RemoteCheckEvidence[];
    reviews: GitHubReviewSnapshot[];
    snapshots?: GitHubPullRequestSnapshot[];
    files?: string[];
  }) {
    this.remoteFiles = parameters.remoteFiles;
    this.filesResult = parameters.files ?? parameters.prFiles;
    this.checksResult = parameters.checks;
    this.reviewsResult = parameters.reviews;
    this.snapshots = parameters.snapshots ?? [
      { ...snapshot(true), changedFiles: this.filesResult.length },
    ];
  }

  async pullRequest(): Promise<GitHubPullRequestSnapshot> {
    const index = Math.min(this.pullRequestCalls, this.snapshots.length - 1);
    this.pullRequestCalls += 1;
    const value = this.snapshots[index];
    if (!value) throw new Error("Missing fake PR snapshot.");
    return value;
  }

  async evidenceFile(
    _repository: string,
    _commit: string,
    path: string,
  ): Promise<Buffer> {
    const bytes = this.remoteFiles.get(path);
    if (bytes) return bytes;
    throw new Error(`Unexpected remote file '${path}'.`);
  }

  async pullRequestFiles(): Promise<string[]> {
    return [...this.filesResult].sort();
  }

  async checks(): Promise<RemoteCheckEvidence[]> {
    return this.checksResult;
  }

  async reviews(): Promise<GitHubReviewSnapshot[]> {
    return this.reviewsResult;
  }

  async verifyAttestation(): Promise<void> {
    this.attestationCalls += 1;
  }

  async markReady(): Promise<void> {
    this.readyCalls += 1;
  }
}

function snapshot(
  isDraft: boolean,
  head = headCommit,
  base = baseCommit,
): GitHubPullRequestSnapshot {
  return {
    number: 42,
    url: "https://github.com/kayz/coga-core/pull/42",
    state: "OPEN",
    isDraft,
    author: "coga-factory-kayz[bot]",
    baseCommit: base,
    headCommit: head,
    changedFiles: 2,
  };
}

function checks(names: string[]): RemoteCheckEvidence[] {
  return names.map((name) => ({
    name,
    app: "GitHub Actions",
    conclusion: "success",
    completedAt: "2026-08-12T12:00:00.000Z",
    url: `https://github.com/kayz/coga-core/actions/runs/1#${encodeURIComponent(name)}`,
  }));
}

function approval(policy: {
  id: string;
  version: string;
}): GitHubReviewSnapshot {
  return {
    id: 7,
    reviewer: "kayz",
    state: "APPROVED",
    body: `[coga-policy:${policy.id}@${policy.version}]`,
    submittedAt: "2026-08-12T12:01:00.000Z",
    commit: headCommit,
    url: "https://github.com/kayz/coga-core/pull/42#pullrequestreview-7",
  };
}

describe("remote evidence and governance", () => {
  it("pins remote evidence commands to github.com without inheriting gh routing or debug state", () => {
    const environment = githubCliEnvironment({
      GH_TOKEN: "human-token",
      GH_HOST: "attacker.invalid",
      GH_CONFIG_DIR: "/attacker/config",
      GH_DEBUG: "api",
      GITHUB_API_URL: "https://attacker.invalid/api",
      GITHUB_GRAPHQL_URL: "https://attacker.invalid/graphql",
      PATH: "trusted-path",
    });
    expect(environment).toMatchObject({
      GH_TOKEN: "human-token",
      GH_HOST: "github.com",
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      PATH: "trusted-path",
    });
    expect(environment.GH_CONFIG_DIR).toBeUndefined();
    expect(environment.GH_DEBUG).toBeUndefined();
    expect(environment.GITHUB_API_URL).toBeUndefined();
    expect(environment.GITHUB_GRAPHQL_URL).toBeUndefined();
  });

  it("preserves non-UTF-8 bytes returned by a remote command", async () => {
    const result = await runCheckedBinary(
      process.execPath,
      [
        "-e",
        "process.stdout.write(Buffer.from([0, 255, 128, 10])); process.stderr.write(Buffer.from([254]));",
      ],
      { cwd: repositoryRoot, timeoutMs: 10_000, maxOutputBytes: 1024 },
      "binary fixture",
    );
    expect([...result.stdout]).toEqual([0, 255, 128, 10]);
    expect([...result.stderr]).toEqual([254]);
    await expect(
      runCheckedBinary(
        process.execPath,
        ["-e", "process.stdout.write(Buffer.alloc(2048, 1));"],
        { cwd: repositoryRoot, timeoutMs: 10_000, maxOutputBytes: 64 },
        "oversized binary fixture",
      ),
    ).rejects.toThrow(/exit 137/iu);
  });

  it("promotes only an exact attested head with all checks and authorized Policy reviews", async () => {
    const fixture = targetFixture();
    const root = mkdtempSync(join(tmpdir(), "coga-remote-success-"));
    const client = new FakeGitHubClient({
      remoteFiles: fixture.remoteFiles,
      prFiles: fixture.prFiles,
      checks: checks(
        fixture.workOrder.spec.governance.promotion.requiredChecks,
      ),
      reviews: fixture.workOrder.spec.governance.requiredPolicies.map(approval),
      snapshots: [snapshot(true), snapshot(true), snapshot(false)].map(
        (entry) => ({ ...entry, changedFiles: fixture.prFiles.length }),
      ),
    });
    const result = await collectRemoteEvidence({
      workOrder: fixture.workOrder,
      baseCommit,
      application: fixture.target.application,
      pullRequest: 42,
      evidencePath: fixture.bundlePath,
      outputRoot: root,
      collectedAt: "2026-08-12T12:02:00.000Z",
      promote: true,
      client,
    });
    expect(result.promoted).toBe(true);
    expect(result.evidence.promotion).toEqual({ eligible: true, blockers: [] });
    expect(client.attestationCalls).toBe(1);
    expect(client.readyCalls).toBe(1);

    const localPath = join(root, fixture.bundlePath);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, fixture.bundleBytes);
    const view = createGovernanceView({
      workOrder: fixture.workOrder,
      evidencePaths: [localPath],
      remoteEvidencePaths: [join(root, result.path)],
    });
    const cedar = view.targets.find(
      (entry) => entry.application.id === fixture.target.application.id,
    );
    const birch = view.targets.find(
      (entry) => entry.application.id === "application.birch.insight.h5",
    );
    expect(cedar?.promotion).toEqual({ eligible: true, blockers: [] });
    expect(cedar?.pendingPolicies).toEqual([]);
    expect(birch?.promotion.eligible).toBe(false);
    expect(governanceViewMarkdown(view)).toContain("ready-for-review");
  });

  it("keeps a PR draft when a required check or exact-head Policy approval is missing", async () => {
    const fixture = targetFixture();
    const root = mkdtempSync(join(tmpdir(), "coga-remote-blocked-"));
    const client = new FakeGitHubClient({
      remoteFiles: fixture.remoteFiles,
      prFiles: fixture.prFiles,
      checks: checks(
        fixture.workOrder.spec.governance.promotion.requiredChecks.slice(1),
      ),
      reviews: [
        {
          ...approval(fixture.workOrder.spec.governance.requiredPolicies[0]!),
          commit: "9".repeat(40),
        },
      ],
    });
    const result = await collectRemoteEvidence({
      workOrder: fixture.workOrder,
      baseCommit,
      application: fixture.target.application,
      pullRequest: 42,
      evidencePath: fixture.bundlePath,
      outputRoot: root,
      collectedAt: "2026-08-12T12:02:00.000Z",
      client,
    });
    expect(result.promoted).toBe(false);
    expect(result.evidence.promotion.eligible).toBe(false);
    expect(result.evidence.promotion.blockers).toHaveLength(2);
    expect(client.readyCalls).toBe(0);
  });

  it("rejects a PR that was not created by the declared GitHub App", async () => {
    const fixture = targetFixture();
    const root = mkdtempSync(join(tmpdir(), "coga-remote-human-author-"));
    const client = new FakeGitHubClient({
      remoteFiles: fixture.remoteFiles,
      prFiles: fixture.prFiles,
      checks: checks(
        fixture.workOrder.spec.governance.promotion.requiredChecks,
      ),
      reviews: fixture.workOrder.spec.governance.requiredPolicies.map(approval),
      snapshots: [
        {
          ...snapshot(true),
          author: "kayz",
          changedFiles: fixture.prFiles.length,
        },
      ],
    });
    await expect(
      collectRemoteEvidence({
        workOrder: fixture.workOrder,
        baseCommit,
        application: fixture.target.application,
        pullRequest: 42,
        evidencePath: fixture.bundlePath,
        outputRoot: root,
        collectedAt: "2026-08-12T12:02:00.000Z",
        client,
      }),
    ).rejects.toThrow(/author.*declared delivery identity/iu);
    expect(client.attestationCalls).toBe(0);
    expect(client.readyCalls).toBe(0);
  });

  it("rejects a changed PR identity immediately before ready-for-review", async () => {
    const fixture = targetFixture();
    const root = mkdtempSync(join(tmpdir(), "coga-remote-race-"));
    const client = new FakeGitHubClient({
      remoteFiles: fixture.remoteFiles,
      prFiles: fixture.prFiles,
      checks: checks(
        fixture.workOrder.spec.governance.promotion.requiredChecks,
      ),
      reviews: fixture.workOrder.spec.governance.requiredPolicies.map(approval),
      snapshots: [snapshot(true), snapshot(true, "8".repeat(40))].map(
        (entry) => ({ ...entry, changedFiles: fixture.prFiles.length }),
      ),
    });
    await expect(
      collectRemoteEvidence({
        workOrder: fixture.workOrder,
        baseCommit,
        application: fixture.target.application,
        pullRequest: 42,
        evidencePath: fixture.bundlePath,
        outputRoot: root,
        collectedAt: "2026-08-12T12:02:00.000Z",
        promote: true,
        client,
      }),
    ).rejects.toThrow(/identity changed/iu);
    expect(client.readyCalls).toBe(0);
  });

  it("rejects a PR that contains a file outside its Evidence Bundle", async () => {
    const fixture = targetFixture();
    const root = mkdtempSync(join(tmpdir(), "coga-remote-extra-file-"));
    const client = new FakeGitHubClient({
      remoteFiles: fixture.remoteFiles,
      prFiles: fixture.prFiles,
      checks: checks(
        fixture.workOrder.spec.governance.promotion.requiredChecks,
      ),
      reviews: fixture.workOrder.spec.governance.requiredPolicies.map(approval),
      files: [...fixture.prFiles, "unbound.txt"],
      snapshots: [
        { ...snapshot(true), changedFiles: fixture.prFiles.length + 1 },
      ],
    });
    await expect(
      collectRemoteEvidence({
        workOrder: fixture.workOrder,
        baseCommit,
        application: fixture.target.application,
        pullRequest: 42,
        evidencePath: fixture.bundlePath,
        outputRoot: root,
        collectedAt: "2026-08-12T12:02:00.000Z",
        client,
      }),
    ).rejects.toThrow(/do not exactly match/iu);
    expect(client.attestationCalls).toBe(0);
    expect(client.readyCalls).toBe(0);
  });

  it("rejects a file declared by the bundle but outside the governed Patch closure", async () => {
    const fixture = targetFixture();
    const root = mkdtempSync(join(tmpdir(), "coga-remote-declared-extra-"));
    const unboundPath = ".github/workflows/unbound.yml";
    const unboundBytes = Buffer.from("name: unbound\n");
    const bundle = structuredClone(fixture.bundle);
    bundle.subject.changedFiles.push({
      path: unboundPath,
      digest: sha256(unboundBytes),
      bytes: unboundBytes.byteLength,
    });
    bundle.subject.changedFiles.sort((left, right) =>
      compareText(left.path, right.path),
    );
    bundle.metadata.bundleDigest = evidenceDigest(bundle);
    const bundleBytes = Buffer.from(canonicalJson(bundle));
    const bundlePath = `.coga/evidence/${bundle.metadata.bundleDigest.slice("sha256:".length)}.json`;
    const remoteFiles = new Map(fixture.remoteFiles);
    remoteFiles.set(bundlePath, bundleBytes);
    remoteFiles.set(unboundPath, unboundBytes);
    const prFiles = [
      ...fixture.prFiles.filter((entry) => entry !== fixture.bundlePath),
      bundlePath,
      unboundPath,
    ].sort();
    const client = new FakeGitHubClient({
      remoteFiles,
      prFiles,
      checks: checks(
        fixture.workOrder.spec.governance.promotion.requiredChecks,
      ),
      reviews: fixture.workOrder.spec.governance.requiredPolicies.map(approval),
    });
    await expect(
      collectRemoteEvidence({
        workOrder: fixture.workOrder,
        baseCommit,
        application: fixture.target.application,
        pullRequest: 42,
        evidencePath: bundlePath,
        outputRoot: root,
        collectedAt: "2026-08-12T12:02:30.000Z",
        client,
      }),
    ).rejects.toThrow(/governed Patch closure/iu);
    expect(client.attestationCalls).toBe(0);
    expect(client.readyCalls).toBe(0);
  });

  it("rejects a PR whose base differs from the resolved Work Order", async () => {
    const fixture = targetFixture();
    const root = mkdtempSync(join(tmpdir(), "coga-remote-wrong-base-"));
    const client = new FakeGitHubClient({
      remoteFiles: fixture.remoteFiles,
      prFiles: fixture.prFiles,
      checks: checks(
        fixture.workOrder.spec.governance.promotion.requiredChecks,
      ),
      reviews: fixture.workOrder.spec.governance.requiredPolicies.map(approval),
      snapshots: [
        {
          ...snapshot(true, headCommit, "9".repeat(40)),
          changedFiles: fixture.prFiles.length,
        },
      ],
    });
    await expect(
      collectRemoteEvidence({
        workOrder: fixture.workOrder,
        baseCommit,
        application: fixture.target.application,
        pullRequest: 42,
        evidencePath: fixture.bundlePath,
        outputRoot: root,
        collectedAt: "2026-08-12T12:03:00.000Z",
        client,
      }),
    ).rejects.toThrow(/resolved Work Order base/iu);
    expect(client.attestationCalls).toBe(0);
    expect(client.readyCalls).toBe(0);
  });
});
