import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parse as parseYaml } from "yaml";
import type {
  GitHubCredentialLease,
  GitHubCredentialProvider,
  MergeAuthorization,
  MergeGateResult,
  MergeGateSnapshot,
  MergePromotionClient,
  TestEnvironmentAuthorization,
  TestEnvironmentGateResult,
  VersionTagSnapshot,
} from "./operations-types.js";
import { FACTORY_OPERATIONS_SCHEMA_VERSION } from "./operations-types.js";
import { remoteEvidenceDigest } from "./remote.js";
import { loadRemoteEvidence } from "./schema.js";
import type {
  GitHubReviewSnapshot,
  RemoteCheckEvidence,
  RemoteEvidence,
  Sha256Digest,
} from "./types.js";
import {
  canonicalJson,
  compareText,
  normalizeRelativePath,
  readBoundedFile,
  sha256,
  verifyFileReference,
} from "./utils.js";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_DOCUMENT_DEPTH = 32;
const MAX_DOCUMENT_NODES = 20_000;
const MAX_GATE_ENTRIES = 100;
const MAX_BLOCKERS = 64;
const MAX_AUTHORIZATION_WINDOW_MS = 24 * 60 * 60 * 1000;
const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const GIT_BRANCH =
  /^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[~^:?*\[\]\u0000-\u001f\u007f]))(?!.*[./]$).+$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const REQUIRED_MERGE_PERMISSIONS = Object.freeze({
  contents: "write",
  pull_requests: "write",
} as const);

function assertRepository(value: string, label: string): void {
  const segments = value.split("/");
  if (
    !REPOSITORY.test(value) ||
    segments.length !== 2 ||
    segments.some((entry) => entry === "." || entry === "..") ||
    value.toLowerCase().endsWith(".git")
  ) {
    throw new Error(`${label} must use an exact GitHub owner/name identity.`);
  }
}

function compiler(name: string): ValidateFunction {
  const document = JSON.parse(
    readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"),
  ) as object;
  const require = createRequire(import.meta.url);
  const addFormats = require("ajv-formats") as FormatsPlugin;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(document);
}

const validateMergeAuthorization = compiler("merge-authorization.schema.json");
const validateTestAuthorization = compiler(
  "test-environment-authorization.schema.json",
);
const validateRemoteEvidence = compiler("remote-evidence.schema.json");

function formatErrors(value: ErrorObject[] | null | undefined): string {
  return (value ?? [])
    .map(
      (entry) =>
        `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`,
    )
    .sort(compareText)
    .slice(0, 20)
    .join("; ");
}

function inspectJson(value: unknown, label: string): void {
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.exit) {
      active.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_DOCUMENT_NODES)
      throw new Error(`${label} exceeds its node budget.`);
    if (current.depth > MAX_DOCUMENT_DEPTH)
      throw new Error(`${label} exceeds its depth budget.`);
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      throw new Error(`${label} contains a non-JSON value.`);
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (
      !Array.isArray(current.value) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new Error(`${label} contains a special object.`);
    }
    if (active.has(current.value))
      throw new Error(`${label} contains a cycle.`);
    active.add(current.value);
    stack.push({ ...current, exit: true });
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

function readDocument(path: string, label: string): unknown {
  const extension = extname(path).toLowerCase();
  if (![".json", ".yaml", ".yml"].includes(extension)) {
    throw new Error(`${label} must use JSON or YAML.`);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(path, label, MAX_DOCUMENT_BYTES),
  );
  let value: unknown;
  try {
    if (extension === ".json") {
      value = JSON.parse(source) as unknown;
      parseYaml(source, { maxAliasCount: 0, uniqueKeys: true });
    } else {
      value = parseYaml(source, { maxAliasCount: 25, uniqueKeys: true });
    }
  } catch (error) {
    throw new Error(
      `${label} is not valid ${extension === ".json" ? "JSON" : "YAML"}: ${
        error instanceof Error ? error.message : "parse failure"
      }`,
    );
  }
  inspectJson(value, label);
  return value;
}

function authorizationPayload(
  value: MergeAuthorization | TestEnvironmentAuthorization,
): unknown {
  const { authorizationDigest: _digest, ...metadata } = value.metadata;
  return { ...value, metadata };
}

function timestamp(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result))
    throw new Error(`${label} is not a valid date-time.`);
  return result;
}

function now(options: { now?: () => Date }): number {
  const value = (options.now ?? (() => new Date()))();
  const result = value.getTime();
  if (!Number.isFinite(result))
    throw new Error("Promotion gate clock returned an invalid time.");
  return result;
}

function assertAuthorizationWindow(
  value: MergeAuthorization | TestEnvironmentAuthorization,
  label: string,
): void {
  const issuedAt = timestamp(
    value.metadata.issuedAt,
    `${label}.metadata.issuedAt`,
  );
  const expiresAt = timestamp(
    value.metadata.expiresAt,
    `${label}.metadata.expiresAt`,
  );
  if (issuedAt >= expiresAt)
    throw new Error(`${label} must expire after it is issued.`);
  if (expiresAt - issuedAt > MAX_AUTHORIZATION_WINDOW_MS) {
    throw new Error(`${label} cannot remain valid for more than 24 hours.`);
  }
  const normalizedApprovers = value.decision.authorizedApprovers.map((entry) =>
    entry.toLowerCase(),
  );
  if (new Set(normalizedApprovers).size !== normalizedApprovers.length) {
    throw new Error(`${label} contains case-insensitive duplicate approvers.`);
  }
  if (value.decision.approvalMarker.trim() !== value.decision.approvalMarker) {
    throw new Error(
      `${label} approvalMarker must not have surrounding whitespace.`,
    );
  }
  const expected = sha256(canonicalJson(authorizationPayload(value)));
  if (value.metadata.authorizationDigest !== expected) {
    throw new Error(`${label} authorizationDigest is inconsistent.`);
  }
}

function assertMergeAuthorization(
  value: unknown,
): asserts value is MergeAuthorization {
  inspectJson(value, "Merge Authorization");
  if (!validateMergeAuthorization(value)) {
    throw new Error(
      `Invalid Merge Authorization: ${formatErrors(validateMergeAuthorization.errors)}.`,
    );
  }
  const authorization = value as MergeAuthorization;
  assertRepository(
    authorization.subject.repository,
    "Merge Authorization repository",
  );
  normalizeRelativePath(
    authorization.subject.remoteEvidence.path,
    "Merge Authorization Remote Evidence path",
  );
  assertAuthorizationWindow(authorization, "Merge Authorization");
}

function assertTestAuthorization(
  value: unknown,
): asserts value is TestEnvironmentAuthorization {
  inspectJson(value, "Test Environment Authorization");
  if (!validateTestAuthorization(value)) {
    throw new Error(
      `Invalid Test Environment Authorization: ${formatErrors(validateTestAuthorization.errors)}.`,
    );
  }
  const authorization = value as TestEnvironmentAuthorization;
  assertRepository(
    authorization.subject.repository,
    "Test Environment Authorization repository",
  );
  normalizeRelativePath(
    authorization.subject.releaseManifest.path,
    "Test Environment Authorization release manifest path",
  );
  assertAuthorizationWindow(authorization, "Test Environment Authorization");
  if (
    !SEMVER.test(authorization.subject.version) ||
    authorization.subject.tag !== `v${authorization.subject.version}`
  ) {
    throw new Error(
      "Test Environment Authorization tag must exactly equal v<subject.version> SemVer.",
    );
  }
  if (!GIT_BRANCH.test(authorization.subject.defaultBranch)) {
    throw new Error(
      "Test Environment Authorization defaultBranch is not a safe Git branch.",
    );
  }
}

function assertRemoteEvidence(value: unknown): asserts value is RemoteEvidence {
  inspectJson(value, "Remote Evidence argument");
  if (!validateRemoteEvidence(value)) {
    throw new Error(
      `Invalid Remote Evidence argument: ${formatErrors(validateRemoteEvidence.errors)}.`,
    );
  }
  const evidence = value as RemoteEvidence;
  assertRepository(evidence.subject.repository, "Remote Evidence repository");
  normalizeRelativePath(
    evidence.subject.evidenceBundle.path,
    "Remote Evidence bundle path",
  );
  if (
    remoteEvidenceDigest(evidence) !== evidence.metadata.remoteEvidenceDigest
  ) {
    throw new Error("Remote Evidence argument logical digest is inconsistent.");
  }
}

export function loadMergeAuthorization(path: string): MergeAuthorization {
  const value = readDocument(path, "Merge Authorization");
  assertMergeAuthorization(value);
  return value;
}

export function loadTestEnvironmentAuthorization(
  path: string,
): TestEnvironmentAuthorization {
  const value = readDocument(path, "Test Environment Authorization");
  assertTestAuthorization(value);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: unknown,
  label: string,
  required: readonly string[],
): Record<string, unknown> {
  const result = object(value, label);
  const keys = Object.keys(result);
  if (
    keys.length !== required.length ||
    required.some((key) => !(key in result)) ||
    keys.some((key) => !required.includes(key))
  ) {
    throw new Error(`${label} has missing or unknown fields.`);
  }
  return result;
}

function boundedText(value: unknown, label: string, maximum = 500): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is not a bounded non-empty string.`);
  }
  return value;
}

function githubUrl(value: unknown, label: string): string {
  const text = boundedText(value, label, 2_000);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error(`${label} must be an HTTPS github.com URL.`);
  }
  return text;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function validateCheck(value: unknown, label: string): RemoteCheckEvidence {
  const check = exactKeys(value, label, [
    "name",
    "app",
    "conclusion",
    "completedAt",
    "url",
  ]);
  boundedText(check.name, `${label}.name`, 200);
  boundedText(check.app, `${label}.app`, 200);
  if (check.conclusion !== "success")
    throw new Error(`${label}.conclusion must be success.`);
  timestamp(
    boundedText(check.completedAt, `${label}.completedAt`, 100),
    `${label}.completedAt`,
  );
  githubUrl(check.url, `${label}.url`);
  return check as unknown as RemoteCheckEvidence;
}

function validateReview(value: unknown, label: string): GitHubReviewSnapshot {
  const review = exactKeys(value, label, [
    "id",
    "reviewer",
    "state",
    "body",
    "submittedAt",
    "commit",
    "url",
  ]);
  safeInteger(review.id, `${label}.id`);
  boundedText(review.reviewer, `${label}.reviewer`, 100);
  boundedText(review.state, `${label}.state`, 50);
  if (
    typeof review.body !== "string" ||
    review.body.length > 10_000 ||
    review.body.includes("\0")
  ) {
    throw new Error(`${label}.body is outside its bounds.`);
  }
  timestamp(
    boundedText(review.submittedAt, `${label}.submittedAt`, 100),
    `${label}.submittedAt`,
  );
  if (!COMMIT.test(String(review.commit)))
    throw new Error(`${label}.commit is malformed.`);
  githubUrl(review.url, `${label}.url`);
  return review as unknown as GitHubReviewSnapshot;
}

function validateMergeSnapshot(value: unknown): MergeGateSnapshot {
  inspectJson(value, "Merge Gate snapshot");
  const snapshot = exactKeys(value, "Merge Gate snapshot", [
    "pullRequest",
    "checks",
    "reviews",
  ]);
  const pullRequest = exactKeys(
    snapshot.pullRequest,
    "Merge Gate snapshot.pullRequest",
    [
      "number",
      "url",
      "state",
      "isDraft",
      "author",
      "baseBranch",
      "baseCommit",
      "headCommit",
      "changedFiles",
    ],
  );
  safeInteger(pullRequest.number, "Merge Gate snapshot.pullRequest.number");
  boundedText(pullRequest.url, "Merge Gate snapshot.pullRequest.url", 2_000);
  if (!["OPEN", "CLOSED", "MERGED"].includes(String(pullRequest.state))) {
    throw new Error("Merge Gate snapshot.pullRequest.state is invalid.");
  }
  if (typeof pullRequest.isDraft !== "boolean")
    throw new Error("Merge Gate snapshot draft state is invalid.");
  boundedText(
    pullRequest.author,
    "Merge Gate snapshot.pullRequest.author",
    100,
  );
  if (
    !GIT_BRANCH.test(
      boundedText(
        pullRequest.baseBranch,
        "Merge Gate snapshot.pullRequest.baseBranch",
        255,
      ),
    )
  ) {
    throw new Error("Merge Gate snapshot.pullRequest.baseBranch is invalid.");
  }
  if (
    !COMMIT.test(String(pullRequest.baseCommit)) ||
    !COMMIT.test(String(pullRequest.headCommit))
  ) {
    throw new Error("Merge Gate snapshot contains a malformed commit.");
  }
  safeInteger(
    pullRequest.changedFiles,
    "Merge Gate snapshot.pullRequest.changedFiles",
  );
  if (!Array.isArray(snapshot.checks) || !Array.isArray(snapshot.reviews)) {
    throw new Error("Merge Gate snapshot checks and reviews must be arrays.");
  }
  if (
    snapshot.checks.length > MAX_GATE_ENTRIES ||
    snapshot.reviews.length > MAX_GATE_ENTRIES
  ) {
    throw new Error("Merge Gate snapshot exceeds its entry budget.");
  }
  const checks = snapshot.checks.map((entry, index) =>
    validateCheck(entry, `Merge Gate snapshot.checks[${index}]`),
  );
  const reviews = snapshot.reviews.map((entry, index) =>
    validateReview(entry, `Merge Gate snapshot.reviews[${index}]`),
  );
  if (new Set(checks.map((entry) => entry.name)).size !== checks.length) {
    throw new Error("Merge Gate snapshot contains duplicate check names.");
  }
  if (new Set(reviews.map((entry) => entry.id)).size !== reviews.length) {
    throw new Error("Merge Gate snapshot contains duplicate review ids.");
  }
  return {
    pullRequest: pullRequest as unknown as MergeGateSnapshot["pullRequest"],
    checks,
    reviews,
  };
}

function markerLine(body: string, marker: string): boolean {
  return body.split(/\r?\n/u).some((line) => line === marker);
}

function human(login: string): boolean {
  const normalized = login.toLowerCase();
  return (
    !normalized.endsWith("[bot]") &&
    normalized !== "github-actions" &&
    normalized !== "github-actions[bot]"
  );
}

function approvedReview(parameters: {
  reviews: readonly GitHubReviewSnapshot[];
  authorizedApprovers: readonly string[];
  marker: string;
  commit: string;
  issuedAt: number;
  currentTime: number;
  excludedReviewer?: string;
}): GitHubReviewSnapshot | undefined {
  const authorized = new Set(
    parameters.authorizedApprovers.map((entry) => entry.toLowerCase()),
  );
  const latest = new Map<string, GitHubReviewSnapshot>();
  for (const review of [...parameters.reviews].sort((left, right) => {
    const byTime =
      timestamp(right.submittedAt, "Review submittedAt") -
      timestamp(left.submittedAt, "Review submittedAt");
    return byTime || right.id - left.id;
  })) {
    const login = review.reviewer.toLowerCase();
    if (!latest.has(login)) latest.set(login, review);
  }
  return [...latest.values()]
    .filter((review) => {
      const submittedAt = timestamp(review.submittedAt, "Review submittedAt");
      return (
        review.state === "APPROVED" &&
        review.commit === parameters.commit &&
        authorized.has(review.reviewer.toLowerCase()) &&
        human(review.reviewer) &&
        review.reviewer.toLowerCase() !==
          parameters.excludedReviewer?.toLowerCase() &&
        submittedAt >= parameters.issuedAt &&
        submittedAt <= parameters.currentTime &&
        markerLine(review.body, parameters.marker)
      );
    })
    .sort((left, right) =>
      compareText(left.reviewer.toLowerCase(), right.reviewer.toLowerCase()),
    )[0];
}

function blockerCollector(): {
  add: (value: string) => void;
  values: string[];
} {
  const values: string[] = [];
  const seen = new Set<string>();
  return {
    add(value: string) {
      if (seen.has(value)) return;
      if (values.length >= MAX_BLOCKERS)
        throw new Error("Promotion gate blocker budget exceeded.");
      seen.add(value);
      values.push(value);
    },
    values,
  };
}

function exactCheckNames(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_GATE_ENTRIES
  ) {
    throw new Error("Merge Gate requiredChecks must contain 1-100 entries.");
  }
  const names = value.map((entry, index) =>
    boundedText(entry, `Merge Gate requiredChecks[${index}]`, 200),
  );
  if (new Set(names).size !== names.length)
    throw new Error("Merge Gate requiredChecks contains duplicates.");
  return [...names].sort(compareText);
}

function sameCheck(
  left: RemoteCheckEvidence,
  right: RemoteCheckEvidence,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface MergeGateOptions {
  requiredChecks: readonly string[];
  now?: () => Date;
  maxEvidenceBytes?: number;
}

export function evaluateMergeGate(
  repositoryRoot: string,
  remoteValue: RemoteEvidence | unknown,
  authorizationValue: MergeAuthorization | unknown,
  snapshotValue: MergeGateSnapshot | unknown,
  options: MergeGateOptions,
): MergeGateResult {
  assertMergeAuthorization(authorizationValue);
  assertRemoteEvidence(remoteValue);
  const snapshot = validateMergeSnapshot(snapshotValue);
  const requiredChecks = exactCheckNames(options.requiredChecks);
  const currentTime = now(options);
  const blockers = blockerCollector();
  const authorization = authorizationValue;
  let remote = remoteValue;

  try {
    const remotePath = verifyFileReference(
      repositoryRoot,
      authorization.subject.remoteEvidence,
      "Merge Authorization Remote Evidence",
      options.maxEvidenceBytes ?? 1024 * 1024,
    );
    const loaded = loadRemoteEvidence(remotePath);
    if (canonicalJson(loaded) !== canonicalJson(remoteValue)) {
      blockers.add(
        "Remote Evidence argument does not exactly match its authorized file reference.",
      );
    }
    if (remoteEvidenceDigest(loaded) !== loaded.metadata.remoteEvidenceDigest) {
      blockers.add("Remote Evidence logical digest is inconsistent.");
    }
    remote = loaded;
    const bundlePath = verifyFileReference(
      repositoryRoot,
      remote.subject.evidenceBundle,
      "Remote Evidence bundle",
      options.maxEvidenceBytes ?? 1024 * 1024,
    );
    void bundlePath;
    if (
      remote.attestation.subjectDigest !== remote.subject.evidenceBundle.digest
    ) {
      blockers.add(
        "Remote Evidence attestation is not bound to its Evidence Bundle digest.",
      );
    }
  } catch {
    blockers.add("Remote Evidence content or digest verification failed.");
  }

  const issuedAt = timestamp(
    authorization.metadata.issuedAt,
    "Merge Authorization issuedAt",
  );
  const expiresAt = timestamp(
    authorization.metadata.expiresAt,
    "Merge Authorization expiresAt",
  );
  if (currentTime < issuedAt)
    blockers.add("Merge Authorization is not yet valid.");
  if (currentTime >= expiresAt)
    blockers.add("Merge Authorization has expired.");
  if (authorization.subject.repository !== remote.subject.repository)
    blockers.add(
      "Merge Authorization repository does not match Remote Evidence.",
    );
  if (authorization.subject.pullRequest !== remote.subject.pullRequest)
    blockers.add(
      "Merge Authorization pull request does not match Remote Evidence.",
    );
  if (authorization.subject.baseCommit !== remote.subject.baseCommit)
    blockers.add(
      "Merge Authorization base commit does not match Remote Evidence.",
    );
  if (authorization.subject.headCommit !== remote.subject.headCommit)
    blockers.add(
      "Merge Authorization head commit does not match Remote Evidence.",
    );
  const expectedUrl = `https://github.com/${authorization.subject.repository}/pull/${authorization.subject.pullRequest}`;
  if (
    remote.subject.pullRequestUrl.toLowerCase() !== expectedUrl.toLowerCase()
  ) {
    blockers.add(
      "Remote Evidence pull request URL does not bind the authorized repository.",
    );
  }
  if (!remote.promotion.eligible || remote.promotion.blockers.length > 0)
    blockers.add("Remote Evidence is not promotion-eligible.");

  if (snapshot.pullRequest.state !== "OPEN" || snapshot.pullRequest.isDraft)
    blockers.add("Pull request must be ready and OPEN.");
  if (snapshot.pullRequest.number !== authorization.subject.pullRequest)
    blockers.add("Live pull request number changed.");
  if (snapshot.pullRequest.baseBranch !== authorization.subject.baseBranch)
    blockers.add("Live pull request base branch changed.");
  if (snapshot.pullRequest.baseCommit !== authorization.subject.baseCommit)
    blockers.add("Live pull request base commit changed.");
  if (snapshot.pullRequest.headCommit !== authorization.subject.headCommit)
    blockers.add("Live pull request head commit changed.");
  if (
    snapshot.pullRequest.author.toLowerCase() !==
    remote.subject.pullRequestAuthor.toLowerCase()
  ) {
    blockers.add("Live pull request author differs from Remote Evidence.");
  }
  if (snapshot.pullRequest.url.toLowerCase() !== expectedUrl.toLowerCase())
    blockers.add(
      "Live pull request URL does not bind the authorized repository.",
    );

  const liveNames = snapshot.checks
    .map((entry) => entry.name)
    .sort(compareText);
  const remoteNames = remote.checks
    .map((entry) => entry.name)
    .sort(compareText);
  if (canonicalJson(liveNames) !== canonicalJson(requiredChecks))
    blockers.add("Live checks are not the exact required check set.");
  if (canonicalJson(remoteNames) !== canonicalJson(requiredChecks))
    blockers.add(
      "Remote Evidence checks are not the exact required check set.",
    );
  for (const name of requiredChecks) {
    const live = snapshot.checks.find((entry) => entry.name === name);
    const recorded = remote.checks.find((entry) => entry.name === name);
    if (!live || !recorded || !sameCheck(live, recorded)) {
      blockers.add(
        `Required check '${name}' is missing or differs from Remote Evidence.`,
      );
    }
  }

  const approval = approvedReview({
    reviews: snapshot.reviews,
    authorizedApprovers: authorization.decision.authorizedApprovers,
    marker: authorization.decision.approvalMarker,
    commit: authorization.subject.headCommit,
    issuedAt,
    currentTime,
    excludedReviewer: snapshot.pullRequest.author,
  });
  if (!approval)
    blockers.add(
      "No distinct authorized human supplied the exact-head APPROVED merge marker.",
    );
  if (
    approval &&
    approval.url.toLowerCase() !==
      `${expectedUrl.toLowerCase()}#pullrequestreview-${approval.id}`
  ) {
    blockers.add(
      "Merge approval review URL does not bind the authorized pull request.",
    );
  }
  return {
    eligible: blockers.values.length === 0,
    blockers: blockers.values,
    ...(approval
      ? {
          approval: {
            reviewer: approval.reviewer,
            reviewId: approval.id,
            submittedAt: approval.submittedAt,
            commit: approval.commit,
            url: approval.url,
          },
        }
      : {}),
  };
}

export interface ExecuteAuthorizedMergeDependencies {
  client: MergePromotionClient;
  credentialProvider: GitHubCredentialProvider;
}

export interface ExecuteAuthorizedMergeOptions extends MergeGateOptions {
  appSlug: string;
  minimumCredentialTtlMs?: number;
  maximumCredentialTtlMs?: number;
}

function assertCredentialLease(
  lease: GitHubCredentialLease,
  repository: string,
  acquiredAt: number,
  minimumTtlMs: number,
  maximumTtlMs: number,
): void {
  if (
    lease.kind !== "github-app-installation" ||
    !lease.id ||
    !lease.provider ||
    lease.repository !== repository ||
    typeof lease.token !== "string" ||
    lease.token.length < 20 ||
    lease.token.length > 1_024 ||
    /[\u0000-\u0020\u007f]/u.test(lease.token)
  ) {
    throw new Error(
      "Authorized merge credential lease has an invalid identity or token.",
    );
  }
  const issuedAt = timestamp(
    lease.issuedAt,
    "Authorized merge credential issuedAt",
  );
  const expiresAt = timestamp(
    lease.expiresAt,
    "Authorized merge credential expiresAt",
  );
  if (
    issuedAt > acquiredAt ||
    expiresAt - acquiredAt < minimumTtlMs ||
    expiresAt - issuedAt > maximumTtlMs ||
    canonicalJson(lease.permissions) !==
      canonicalJson(REQUIRED_MERGE_PERMISSIONS)
  ) {
    throw new Error(
      "Authorized merge credential lease violates the exact scope or TTL policy.",
    );
  }
}

export async function executeAuthorizedMerge(
  repositoryRoot: string,
  remoteEvidence: RemoteEvidence,
  authorization: MergeAuthorization,
  dependencies: ExecuteAuthorizedMergeDependencies,
  options: ExecuteAuthorizedMergeOptions,
): Promise<{ mergeCommit: string }> {
  assertMergeAuthorization(authorization);
  assertRemoteEvidence(remoteEvidence);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(options.appSlug)) {
    throw new Error("Authorized merge GitHub App slug is invalid.");
  }
  const minimumTtlMs = options.minimumCredentialTtlMs ?? 60_000;
  const maximumTtlMs = options.maximumCredentialTtlMs ?? 65 * 60_000;
  if (
    !Number.isSafeInteger(minimumTtlMs) ||
    !Number.isSafeInteger(maximumTtlMs) ||
    minimumTtlMs < 1 ||
    maximumTtlMs < minimumTtlMs ||
    maximumTtlMs > 2 * 60 * 60_000
  ) {
    throw new Error("Authorized merge credential TTL bounds are invalid.");
  }

  const initial = await dependencies.client.snapshot(
    authorization.subject.repository,
    authorization.subject.pullRequest,
  );
  const initialGate = evaluateMergeGate(
    repositoryRoot,
    remoteEvidence,
    authorization,
    initial,
    options,
  );
  if (!initialGate.eligible) {
    throw new Error(
      `Authorized merge gate failed: ${initialGate.blockers.join(" ")}`,
    );
  }

  const acquiredAt = now(options);
  const lease = await dependencies.credentialProvider.acquire({
    purpose: "authorized-merge",
    repository: authorization.subject.repository,
    appSlug: options.appSlug,
    permissions: REQUIRED_MERGE_PERMISSIONS,
    minimumTtlMs,
  });
  try {
    assertCredentialLease(
      lease,
      authorization.subject.repository,
      acquiredAt,
      minimumTtlMs,
      maximumTtlMs,
    );
    const fresh = await dependencies.client.snapshot(
      authorization.subject.repository,
      authorization.subject.pullRequest,
    );
    const freshGate = evaluateMergeGate(
      repositoryRoot,
      remoteEvidence,
      authorization,
      fresh,
      options,
    );
    if (
      !freshGate.eligible ||
      fresh.pullRequest.headCommit !== initial.pullRequest.headCommit
    ) {
      throw new Error(
        `Authorized merge TOCTOU gate failed: ${freshGate.blockers.join(" ") || "head changed"}`,
      );
    }
    assertCredentialLease(
      lease,
      authorization.subject.repository,
      now(options),
      minimumTtlMs,
      maximumTtlMs,
    );
    const result = await dependencies.client.merge(
      authorization.subject.repository,
      authorization.subject.pullRequest,
      authorization.subject.headCommit,
      "squash",
      lease.token,
    );
    if (!result || !COMMIT.test(result.mergeCommit)) {
      throw new Error(
        "Authorized merge client returned an invalid merge commit.",
      );
    }
    return result;
  } finally {
    await dependencies.credentialProvider.revoke(lease);
  }
}

function validateVersionTagSnapshot(value: unknown): VersionTagSnapshot {
  inspectJson(value, "Test Environment tag snapshot");
  const snapshot = exactKeys(value, "Test Environment tag snapshot", [
    "repository",
    "tag",
    "version",
    "commit",
    "defaultBranch",
    "defaultBranchTip",
    "annotated",
    "signatureVerified",
    "signatureReason",
    "approvals",
  ]);
  if (!REPOSITORY.test(String(snapshot.repository)))
    throw new Error("Test Environment tag snapshot repository is invalid.");
  boundedText(snapshot.tag, "Test Environment tag snapshot.tag", 101);
  if (!SEMVER.test(String(snapshot.version)))
    throw new Error("Test Environment tag snapshot version is invalid SemVer.");
  if (
    !COMMIT.test(String(snapshot.commit)) ||
    !COMMIT.test(String(snapshot.defaultBranchTip))
  ) {
    throw new Error("Test Environment tag snapshot commit is malformed.");
  }
  if (
    !GIT_BRANCH.test(
      boundedText(
        snapshot.defaultBranch,
        "Test Environment tag snapshot.defaultBranch",
        255,
      ),
    )
  ) {
    throw new Error(
      "Test Environment tag snapshot.defaultBranch is not a safe Git branch.",
    );
  }
  if (
    typeof snapshot.annotated !== "boolean" ||
    typeof snapshot.signatureVerified !== "boolean"
  ) {
    throw new Error(
      "Test Environment tag snapshot verification flags are invalid.",
    );
  }
  boundedText(
    snapshot.signatureReason,
    "Test Environment tag snapshot.signatureReason",
    100,
  );
  if (
    !Array.isArray(snapshot.approvals) ||
    snapshot.approvals.length > MAX_GATE_ENTRIES
  ) {
    throw new Error(
      "Test Environment tag snapshot approvals exceed their entry budget.",
    );
  }
  const approvals = snapshot.approvals.map((entry, index) =>
    validateReview(entry, `Test Environment tag snapshot.approvals[${index}]`),
  );
  if (new Set(approvals.map((entry) => entry.id)).size !== approvals.length) {
    throw new Error(
      "Test Environment tag snapshot contains duplicate approval ids.",
    );
  }
  return {
    ...(snapshot as unknown as Omit<VersionTagSnapshot, "approvals">),
    approvals,
  };
}

export interface TestEnvironmentGateOptions {
  now?: () => Date;
  expectedEnvironment: string;
  maxManifestBytes?: number;
}

export function evaluateTestEnvironmentGate(
  repositoryRoot: string,
  authorizationValue: TestEnvironmentAuthorization | unknown,
  snapshotValue: VersionTagSnapshot | unknown,
  options: TestEnvironmentGateOptions,
): TestEnvironmentGateResult {
  assertTestAuthorization(authorizationValue);
  const authorization = authorizationValue;
  const snapshot = validateVersionTagSnapshot(snapshotValue);
  const currentTime = now(options);
  const blockers = blockerCollector();
  const issuedAt = timestamp(
    authorization.metadata.issuedAt,
    "Test Environment Authorization issuedAt",
  );
  const expiresAt = timestamp(
    authorization.metadata.expiresAt,
    "Test Environment Authorization expiresAt",
  );
  if (currentTime < issuedAt)
    blockers.add("Test Environment Authorization is not yet valid.");
  if (currentTime >= expiresAt)
    blockers.add("Test Environment Authorization has expired.");
  try {
    verifyFileReference(
      repositoryRoot,
      authorization.subject.releaseManifest,
      "Test Environment release manifest",
      options.maxManifestBytes ?? 1024 * 1024,
    );
  } catch {
    blockers.add(
      "Test Environment release manifest content or digest verification failed.",
    );
  }
  if (
    typeof options.expectedEnvironment !== "string" ||
    options.expectedEnvironment.length < 1 ||
    options.expectedEnvironment.length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(options.expectedEnvironment)
  ) {
    throw new Error("Test Environment gate expectedEnvironment is invalid.");
  }
  if (authorization.subject.environment !== options.expectedEnvironment) {
    blockers.add(
      "Test Environment Authorization targets a different environment.",
    );
  }
  if (snapshot.repository !== authorization.subject.repository)
    blockers.add(
      "Tag repository does not match Test Environment Authorization.",
    );
  if (snapshot.version !== authorization.subject.version)
    blockers.add("Tag version does not match Test Environment Authorization.");
  if (
    snapshot.tag !== authorization.subject.tag ||
    snapshot.tag !== `v${snapshot.version}`
  )
    blockers.add("Tag does not exactly bind its SemVer version.");
  if (snapshot.commit !== authorization.subject.commit)
    blockers.add("Tag commit does not match Test Environment Authorization.");
  if (snapshot.defaultBranch !== authorization.subject.defaultBranch)
    blockers.add(
      "Default branch does not match Test Environment Authorization.",
    );
  if (
    snapshot.defaultBranchTip !== authorization.subject.commit ||
    snapshot.defaultBranchTip !== snapshot.commit
  ) {
    blockers.add(
      "Authorized commit is not the exact default-branch tip and tag target.",
    );
  }
  if (!snapshot.annotated)
    blockers.add("Test Environment tag is not annotated.");
  if (!snapshot.signatureVerified || snapshot.signatureReason !== "valid")
    blockers.add(
      "Test Environment tag signature is not verified with reason 'valid'.",
    );
  const approval = approvedReview({
    reviews: snapshot.approvals,
    authorizedApprovers: authorization.decision.authorizedApprovers,
    marker: authorization.decision.approvalMarker,
    commit: authorization.subject.commit,
    issuedAt,
    currentTime,
  });
  if (!approval)
    blockers.add(
      "No authorized human supplied the exact-commit APPROVED test-environment marker.",
    );
  if (
    approval &&
    (!approval.url
      .toLowerCase()
      .startsWith(
        `https://github.com/${authorization.subject.repository.toLowerCase()}/`,
      ) ||
      !approval.url.toLowerCase().endsWith(`#pullrequestreview-${approval.id}`))
  ) {
    blockers.add(
      "Test Environment approval URL does not bind the authorized repository.",
    );
  }
  return { eligible: blockers.values.length === 0, blockers: blockers.values };
}

export function mergeAuthorizationDigest(
  value: MergeAuthorization,
): Sha256Digest {
  if (value.schemaVersion !== FACTORY_OPERATIONS_SCHEMA_VERSION) {
    throw new Error("Merge Authorization schema version is unsupported.");
  }
  return sha256(canonicalJson(authorizationPayload(value)));
}

export function testEnvironmentAuthorizationDigest(
  value: TestEnvironmentAuthorization,
): Sha256Digest {
  if (value.schemaVersion !== FACTORY_OPERATIONS_SCHEMA_VERSION) {
    throw new Error(
      "Test Environment Authorization schema version is unsupported.",
    );
  }
  return sha256(canonicalJson(authorizationPayload(value)));
}
