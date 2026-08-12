import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExactReference } from "@coga/core";
import { verifyEvidenceBundle } from "./evidence.js";
import { inspectPatchPaths } from "./git.js";
import { normalizeProposalPatch, proposalReceiptDigest } from "./proposal.js";
import { loadAgentProposalReceipt, loadRemoteEvidence } from "./schema.js";
import type {
  GitHubEvidenceClient,
  GitHubPullRequestSnapshot,
  GitHubReviewSnapshot,
  RemoteCheckEvidence,
  RemoteEvidence,
  RemotePolicyApproval,
  Sha256Digest,
  WorkOrder,
} from "./types.js";
import { FACTORY_SCHEMA_VERSION } from "./types.js";
import {
  canonicalJson,
  compareText,
  normalizeRelativePath,
  readBoundedFile,
  resolveWithin,
  runChecked,
  runCheckedBinary,
  sha256,
} from "./utils.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const EVIDENCE_PATH_PATTERN = /^\.coga\/evidence\/([0-9a-f]{64})\.json$/u;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function exactKey(reference: ExactReference): string {
  return `${reference.id}@${reference.version}`;
}

function pathAllowed(path: string, allowed: readonly string[]): boolean {
  return allowed.some(
    (entry) => path === entry || path.startsWith(`${entry}/`),
  );
}

function remoteEvidencePayload(evidence: RemoteEvidence): unknown {
  const { remoteEvidenceDigest: _digest, ...metadata } = evidence.metadata;
  return { ...evidence, metadata };
}

export function remoteEvidenceDigest(evidence: RemoteEvidence): Sha256Digest {
  return sha256(canonicalJson(remoteEvidencePayload(evidence)));
}

function parseJson<T>(source: string, label: string): T {
  try {
    return JSON.parse(source) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

interface GhPullRequest {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  baseRefOid: string;
  headRefOid: string;
  changedFiles: number;
}

interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at: string | null;
  details_url: string | null;
  app?: { name?: string };
}

interface GhCheckRuns {
  total_count: number;
  check_runs: GhCheckRun[];
}

interface GhReview {
  id: number;
  state: string;
  body: string | null;
  submitted_at: string | null;
  commit_id: string;
  html_url: string;
  user?: { login?: string };
}

interface GhPullRequestFile {
  filename: string;
}

export class GhEvidenceClient implements GitHubEvidenceClient {
  async pullRequest(
    repository: string,
    number: number,
  ): Promise<GitHubPullRequestSnapshot> {
    const result = await runChecked(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        repository,
        "--json",
        "number,url,state,isDraft,baseRefOid,headRefOid,changedFiles",
      ],
      { cwd: process.cwd(), timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 },
      "GitHub PR lookup",
    );
    const value = parseJson<GhPullRequest>(result.stdout, "GitHub PR lookup");
    if (
      value.number !== number ||
      !COMMIT_PATTERN.test(value.baseRefOid) ||
      !COMMIT_PATTERN.test(value.headRefOid) ||
      !Number.isSafeInteger(value.changedFiles) ||
      value.changedFiles < 1 ||
      value.changedFiles > 100
    ) {
      throw new Error(
        "GitHub PR lookup returned inconsistent commit bindings.",
      );
    }
    return {
      number: value.number,
      url: value.url,
      state: value.state,
      isDraft: value.isDraft,
      baseCommit: value.baseRefOid,
      headCommit: value.headRefOid,
      changedFiles: value.changedFiles,
    };
  }

  async pullRequestFiles(
    repository: string,
    number: number,
  ): Promise<string[]> {
    const result = await runChecked(
      "gh",
      ["api", `repos/${repository}/pulls/${number}/files?per_page=100`],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        maxOutputBytes: 20 * 1024 * 1024,
      },
      "GitHub PR file lookup",
    );
    const values = parseJson<GhPullRequestFile[]>(
      result.stdout,
      "GitHub PR file lookup",
    );
    if (values.length > 100) {
      throw new Error("GitHub PR file count exceeds 100.");
    }
    const paths = values.map((entry) =>
      normalizeRelativePath(entry.filename, "remote PR file path"),
    );
    if (new Set(paths).size !== paths.length) {
      throw new Error("GitHub PR file list contains duplicates.");
    }
    return paths.sort(compareText);
  }

  async evidenceFile(
    repository: string,
    commit: string,
    path: string,
  ): Promise<Buffer> {
    if (!COMMIT_PATTERN.test(commit))
      throw new Error("Remote head is malformed.");
    const normalized = normalizeRelativePath(path, "remote evidence path");
    const result = await runCheckedBinary(
      "gh",
      [
        "api",
        "-H",
        "Accept: application/vnd.github.raw+json",
        `repos/${repository}/contents/${normalized
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}?ref=${commit}`,
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        maxOutputBytes: 20 * 1024 * 1024,
      },
      "GitHub evidence download",
    );
    return result.stdout;
  }

  async checks(
    repository: string,
    commit: string,
  ): Promise<RemoteCheckEvidence[]> {
    if (!COMMIT_PATTERN.test(commit))
      throw new Error("Remote head is malformed.");
    const result = await runChecked(
      "gh",
      [
        "api",
        `repos/${repository}/commits/${commit}/check-runs?filter=latest&per_page=100`,
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        maxOutputBytes: 5 * 1024 * 1024,
      },
      "GitHub checks lookup",
    );
    const value = parseJson<GhCheckRuns>(result.stdout, "GitHub checks lookup");
    if (value.total_count > 100 || value.check_runs.length > 100) {
      throw new Error("GitHub check run count exceeds the 100-entry budget.");
    }
    return value.check_runs
      .filter(
        (entry) =>
          entry.status === "completed" &&
          entry.conclusion === "success" &&
          typeof entry.completed_at === "string" &&
          typeof entry.details_url === "string",
      )
      .map((entry) => ({
        name: entry.name,
        app: entry.app?.name ?? "unknown",
        conclusion: "success" as const,
        completedAt: entry.completed_at ?? "",
        url: entry.details_url ?? "",
      }))
      .sort((left, right) =>
        compareText(`${left.name}\0${left.app}`, `${right.name}\0${right.app}`),
      );
  }

  async reviews(
    repository: string,
    number: number,
  ): Promise<GitHubReviewSnapshot[]> {
    const result = await runChecked(
      "gh",
      ["api", `repos/${repository}/pulls/${number}/reviews?per_page=100`],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        maxOutputBytes: 5 * 1024 * 1024,
      },
      "GitHub reviews lookup",
    );
    const values = parseJson<GhReview[]>(
      result.stdout,
      "GitHub reviews lookup",
    );
    if (values.length > 100)
      throw new Error("GitHub review count exceeds 100.");
    const overflow = await runChecked(
      "gh",
      [
        "api",
        `repos/${repository}/pulls/${number}/reviews?per_page=100&page=2`,
      ],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        maxOutputBytes: 5 * 1024 * 1024,
      },
      "GitHub review overflow lookup",
    );
    if (
      parseJson<GhReview[]>(overflow.stdout, "GitHub review overflow lookup")
        .length > 0
    ) {
      throw new Error("GitHub review count exceeds 100.");
    }
    return values.flatMap((entry) => {
      const reviewer = entry.user?.login;
      if (!reviewer || !entry.submitted_at) return [];
      return [
        {
          id: entry.id,
          reviewer,
          state: entry.state,
          body: entry.body ?? "",
          submittedAt: entry.submitted_at,
          commit: entry.commit_id,
          url: entry.html_url,
        },
      ];
    });
  }

  async verifyAttestation(
    repository: string,
    evidencePath: string,
  ): Promise<void> {
    await runChecked(
      "gh",
      ["attestation", "verify", evidencePath, "--repo", repository],
      {
        cwd: process.cwd(),
        timeoutMs: 60_000,
        maxOutputBytes: 2 * 1024 * 1024,
      },
      "GitHub artifact attestation verification",
    );
  }

  async markReady(repository: string, number: number): Promise<void> {
    await runChecked(
      "gh",
      ["pr", "ready", String(number), "--repo", repository],
      { cwd: process.cwd(), timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 },
      "GitHub ready-for-review promotion",
    );
  }
}

function approvedPolicies(
  workOrder: WorkOrder,
  reviews: GitHubReviewSnapshot[],
  headCommit: string,
): RemotePolicyApproval[] {
  const authorized = new Set(
    workOrder.spec.governance.promotion.authorizedApprovers.map((entry) =>
      entry.toLowerCase(),
    ),
  );
  const approvals: RemotePolicyApproval[] = [];
  const latestByReviewer = new Map<string, GitHubReviewSnapshot>();
  for (const review of [...reviews].sort((left, right) => right.id - left.id)) {
    const reviewer = review.reviewer.toLowerCase();
    if (
      review.commit === headCommit &&
      authorized.has(reviewer) &&
      !latestByReviewer.has(reviewer)
    ) {
      latestByReviewer.set(reviewer, review);
    }
  }
  for (const policy of workOrder.spec.governance.requiredPolicies) {
    const marker = `[coga-policy:${exactKey(policy)}]`;
    const review = [...latestByReviewer.values()]
      .filter(
        (entry) => entry.state === "APPROVED" && entry.body.includes(marker),
      )
      .sort((left, right) => right.id - left.id)[0];
    if (review) {
      approvals.push({
        policy,
        reviewer: review.reviewer,
        reviewId: review.id,
        submittedAt: review.submittedAt,
        commit: review.commit,
        url: review.url,
      });
    }
  }
  return approvals;
}

export async function collectRemoteEvidence(parameters: {
  workOrder: WorkOrder;
  baseCommit: string;
  application: ExactReference;
  pullRequest: number;
  evidencePath: string;
  outputRoot: string;
  collectedAt: string;
  promote?: boolean;
  client?: GitHubEvidenceClient;
}): Promise<{ path: string; evidence: RemoteEvidence; promoted: boolean }> {
  const target = parameters.workOrder.spec.targets.find(
    (entry) => exactKey(entry.application) === exactKey(parameters.application),
  );
  if (!target) {
    throw new Error(
      `Application '${exactKey(parameters.application)}' is not a Work Order target.`,
    );
  }
  const domainAllowedPaths = parameters.workOrder.spec.change.allowedPaths.map(
    (entry) => normalizeRelativePath(entry, "Work Order domain allowed path"),
  );
  const client = parameters.client ?? new GhEvidenceClient();
  if (!COMMIT_PATTERN.test(parameters.baseCommit)) {
    throw new Error("Resolved Work Order base commit is malformed.");
  }
  if (
    parameters.workOrder.spec.repository.baseCommit !== "work-order-commit" &&
    parameters.workOrder.spec.repository.baseCommit !== parameters.baseCommit
  ) {
    throw new Error(
      "Resolved Work Order base commit disagrees with its declaration.",
    );
  }
  const repository = parameters.workOrder.spec.delivery.repository;
  const pullRequest = await client.pullRequest(
    repository,
    parameters.pullRequest,
  );
  if (pullRequest.state !== "OPEN") {
    throw new Error("Remote evidence can only be collected from an open PR.");
  }
  if (pullRequest.baseCommit === pullRequest.headCommit) {
    throw new Error("Remote PR head does not contain a candidate change.");
  }
  if (pullRequest.baseCommit !== parameters.baseCommit) {
    throw new Error(
      "Remote PR base does not match the resolved Work Order base.",
    );
  }
  const path = normalizeRelativePath(
    parameters.evidencePath,
    "remote Evidence Bundle path",
  );
  const pathMatch = EVIDENCE_PATH_PATTERN.exec(path);
  if (!pathMatch?.[1]) {
    throw new Error("Remote Evidence Bundle path is not content-addressed.");
  }
  const bytes = await client.evidenceFile(
    repository,
    pullRequest.headCommit,
    path,
  );
  if (bytes.byteLength > 5 * 1024 * 1024) {
    throw new Error("Remote Evidence Bundle exceeds the 5 MiB budget.");
  }
  const temporary = mkdtempSync(join(tmpdir(), "coga-remote-evidence-"));
  const temporaryBundle = join(temporary, "bundle.json");
  const temporaryReceipt = join(temporary, "proposal-receipt.json");
  try {
    writeFileSync(temporaryBundle, bytes, { flag: "wx" });
    const bundle = verifyEvidenceBundle(temporaryBundle);
    if (bundle.metadata.bundleDigest.slice("sha256:".length) !== pathMatch[1]) {
      throw new Error(
        "Remote Evidence Bundle path and semantic digest disagree.",
      );
    }
    if (bundle.subject.repository !== repository) {
      throw new Error("Remote Evidence Bundle repository binding disagrees.");
    }
    if (bundle.subject.baseCommit !== pullRequest.baseCommit) {
      throw new Error(
        "Remote Evidence Bundle base commit disagrees with the PR.",
      );
    }
    if (
      exactKey(bundle.subject.application) !== exactKey(parameters.application)
    ) {
      throw new Error("Remote Evidence Bundle Application binding disagrees.");
    }
    if (
      bundle.metadata.workOrderId !== parameters.workOrder.metadata.id ||
      bundle.subject.workOrderDigest !==
        sha256(canonicalJson(parameters.workOrder))
    ) {
      throw new Error("Remote Evidence Bundle Work Order binding disagrees.");
    }
    const actualFiles = await client.pullRequestFiles(
      repository,
      pullRequest.number,
    );
    if (actualFiles.length !== pullRequest.changedFiles) {
      throw new Error(
        "Remote PR file count changed during evidence collection.",
      );
    }
    const expectedFiles = [
      ...bundle.subject.changedFiles.map((entry) => entry.path),
      path,
    ].sort(compareText);
    if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) {
      throw new Error(
        "Remote PR files do not exactly match the Evidence Bundle declaration.",
      );
    }
    const proposalBytes = await client.evidenceFile(
      repository,
      pullRequest.headCommit,
      target.proposal.receipt.path,
    );
    if (proposalBytes.byteLength > 2 * 1024 * 1024) {
      throw new Error(
        "Remote Agent Proposal Receipt exceeds the 2 MiB budget.",
      );
    }
    if (sha256(proposalBytes) !== target.proposal.receipt.digest) {
      throw new Error("Remote Agent Proposal Receipt file digest disagrees.");
    }
    writeFileSync(temporaryReceipt, proposalBytes, { flag: "wx" });
    const proposal = loadAgentProposalReceipt(temporaryReceipt);
    const semanticProposalDigest = proposalReceiptDigest(proposal);
    if (
      semanticProposalDigest !== proposal.metadata.receiptDigest ||
      semanticProposalDigest !== bundle.subject.proposalReceiptDigest ||
      exactKey(proposal.subject.application) !==
        exactKey(parameters.application) ||
      exactKey(proposal.subject.change) !==
        exactKey(parameters.workOrder.spec.change.artifact)
    ) {
      throw new Error(
        "Remote Agent Proposal Receipt semantic binding disagrees.",
      );
    }
    const domainPatchBytes = await client.evidenceFile(
      repository,
      pullRequest.headCommit,
      parameters.workOrder.spec.change.patch.path,
    );
    if (
      domainPatchBytes.byteLength > 2 * 1024 * 1024 ||
      sha256(domainPatchBytes) !== parameters.workOrder.spec.change.patch.digest
    ) {
      throw new Error("Remote domain Patch file binding disagrees.");
    }
    let domainPatchSource: string;
    try {
      domainPatchSource = utf8.decode(domainPatchBytes);
    } catch {
      throw new Error("Remote domain Patch is not valid UTF-8.");
    }
    const domainPaths = inspectPatchPaths(domainPatchSource);
    for (const domainPath of domainPaths) {
      if (!pathAllowed(domainPath, domainAllowedPaths)) {
        throw new Error(
          `Remote domain Patch changes unauthorized path '${domainPath}'.`,
        );
      }
    }

    const proposalPatchBytes = await client.evidenceFile(
      repository,
      pullRequest.headCommit,
      proposal.output.patch.path,
    );
    if (
      proposalPatchBytes.byteLength > 2 * 1024 * 1024 ||
      sha256(proposalPatchBytes) !== proposal.output.patch.digest
    ) {
      throw new Error("Remote Agent proposal Patch file binding disagrees.");
    }
    const normalizedProposalPatch = normalizeProposalPatch(proposalPatchBytes);
    if (!proposalPatchBytes.equals(normalizedProposalPatch)) {
      throw new Error("Remote Agent proposal Patch is not normalized.");
    }
    const proposalPaths = inspectPatchPaths(
      normalizedProposalPatch.toString("utf8"),
    );
    if (
      canonicalJson(proposalPaths) !==
      canonicalJson(proposal.output.changedPaths)
    ) {
      throw new Error(
        "Remote Agent proposal Patch paths disagree with its Receipt.",
      );
    }
    const expectedChangedPaths = [
      ...new Set([...domainPaths, ...proposalPaths]),
    ].sort(compareText);
    const declaredChangedPaths = bundle.subject.changedFiles
      .map((entry) => entry.path)
      .sort(compareText);
    if (
      canonicalJson(declaredChangedPaths) !==
      canonicalJson(expectedChangedPaths)
    ) {
      throw new Error(
        "Remote Evidence Bundle changed files do not exactly match the governed Patch closure.",
      );
    }
    const changedBytes = bundle.subject.changedFiles.reduce(
      (total, file) => total + file.bytes,
      0,
    );
    if (changedBytes > 50 * 1024 * 1024) {
      throw new Error(
        "Remote PR changed-file evidence exceeds the 50 MiB aggregate budget.",
      );
    }
    for (const file of bundle.subject.changedFiles) {
      const remoteBytes = await client.evidenceFile(
        repository,
        pullRequest.headCommit,
        file.path,
      );
      if (
        remoteBytes.byteLength !== file.bytes ||
        sha256(remoteBytes) !== file.digest
      ) {
        throw new Error(
          `Remote PR file '${file.path}' disagrees with the Evidence Bundle.`,
        );
      }
    }
    await client.verifyAttestation(repository, temporaryBundle);
    const checks = await client.checks(repository, pullRequest.headCommit);
    const successfulNames = new Set(
      checks
        .filter((entry) => entry.app === "GitHub Actions")
        .map((entry) => entry.name),
    );
    const blockers =
      parameters.workOrder.spec.governance.promotion.requiredChecks
        .filter((entry) => !successfulNames.has(entry))
        .map((entry) => `Required check '${entry}' is not successful.`);
    const reviews = await client.reviews(repository, pullRequest.number);
    const approvals = approvedPolicies(
      parameters.workOrder,
      reviews,
      pullRequest.headCommit,
    );
    const remoteApprovals = new Set(
      approvals.map((entry) => exactKey(entry.policy)),
    );
    for (const policy of parameters.workOrder.spec.governance
      .requiredPolicies) {
      const key = exactKey(policy);
      if (!remoteApprovals.has(key)) {
        blockers.push(
          `Policy '${key}' has no authorized approval on this head.`,
        );
      }
    }
    const draft: RemoteEvidence = {
      schemaVersion: FACTORY_SCHEMA_VERSION,
      kind: "RemoteEvidence",
      metadata: {
        collectedAt: parameters.collectedAt,
        remoteEvidenceDigest:
          "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      subject: {
        evidenceBundle: { path, digest: sha256(bytes) },
        repository,
        pullRequest: pullRequest.number,
        pullRequestUrl: pullRequest.url,
        baseCommit: pullRequest.baseCommit,
        headCommit: pullRequest.headCommit,
        application: parameters.application,
        workOrder: {
          id: parameters.workOrder.metadata.id,
          digest: sha256(canonicalJson(parameters.workOrder)),
        },
      },
      checks,
      attestation: {
        verified: true,
        subjectDigest: sha256(bytes),
        verifier: "gh-attestation",
      },
      approvals,
      promotion: { eligible: blockers.length === 0, blockers },
    };
    draft.metadata.remoteEvidenceDigest = remoteEvidenceDigest(draft);
    const outputPath = `.coga/remote-evidence/${draft.metadata.remoteEvidenceDigest.slice("sha256:".length)}.json`;
    const absolute = resolveWithin(
      parameters.outputRoot,
      outputPath,
      "Remote Evidence output",
    );
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, canonicalJson(draft), {
      encoding: "utf8",
      flag: "wx",
    });
    const verified = loadRemoteEvidence(absolute);
    if (
      remoteEvidenceDigest(verified) !== verified.metadata.remoteEvidenceDigest
    ) {
      throw new Error("Written Remote Evidence digest is inconsistent.");
    }
    let promoted = false;
    if (parameters.promote) {
      if (!verified.promotion.eligible) {
        throw new Error(
          `PR is not eligible for ready-for-review: ${verified.promotion.blockers.join(" ")}`,
        );
      }
      if (!pullRequest.isDraft) {
        throw new Error("Promotion requested for a PR that is not a Draft.");
      }
      const current = await client.pullRequest(repository, pullRequest.number);
      if (
        current.state !== "OPEN" ||
        !current.isDraft ||
        current.headCommit !== pullRequest.headCommit ||
        current.baseCommit !== pullRequest.baseCommit ||
        current.changedFiles !== pullRequest.changedFiles
      ) {
        throw new Error(
          "PR identity changed before ready-for-review promotion.",
        );
      }
      await client.markReady(repository, pullRequest.number);
      const promotedSnapshot = await client.pullRequest(
        repository,
        pullRequest.number,
      );
      if (
        promotedSnapshot.state !== "OPEN" ||
        promotedSnapshot.isDraft ||
        promotedSnapshot.headCommit !== pullRequest.headCommit ||
        promotedSnapshot.baseCommit !== pullRequest.baseCommit ||
        promotedSnapshot.changedFiles !== pullRequest.changedFiles
      ) {
        throw new Error("GitHub did not confirm ready-for-review promotion.");
      }
      promoted = true;
    }
    return { path: outputPath, evidence: verified, promoted };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
