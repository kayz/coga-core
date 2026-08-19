import type { ExactReference } from "@coga/core";
import type {
  FactoryRunResult,
  FileReference,
  GitHubPullRequestSnapshot,
  GitHubReviewSnapshot,
  RemoteCheckEvidence,
  RemoteEvidence,
  Sha256Digest,
} from "./types.js";

export const FACTORY_OPERATIONS_SCHEMA_VERSION =
  "coga.dev/factory/operations/v0.1" as const;

export const FACTORY_TASK_PHASES = [
  "queued",
  "leased",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type FactoryTaskPhase = (typeof FACTORY_TASK_PHASES)[number];
export type FactoryTaskFailureKind = "transient" | "permanent" | "isolation";

export type FactoryTaskEventType =
  | "enqueued"
  | "leased"
  | "heartbeat"
  | "recovered"
  | "retry-scheduled"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface FactoryTaskRequest {
  repositoryRoot: string;
  workOrderPath: string;
  workOrderDigest: Sha256Digest;
  baseCommit: string;
  delivery: "local" | "github";
  keepWorkspace: boolean;
  maxAttempts: number;
}

export interface FactoryTaskLease {
  id: string;
  workerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface FactoryTaskFailure {
  kind: FactoryTaskFailureKind;
  message: string;
  occurredAt: string;
}

export interface FactoryTaskEvent {
  sequence: number;
  type: FactoryTaskEventType;
  at: string;
  previousDigest?: Sha256Digest;
  digest: Sha256Digest;
  workerId?: string;
  leaseId?: string;
  detail?: string;
}

export interface FactoryTaskTiming {
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  runDurationMs?: number;
}

export interface FactoryTaskRecord {
  schemaVersion: typeof FACTORY_OPERATIONS_SCHEMA_VERSION;
  kind: "FactoryTask";
  metadata: {
    id: Sha256Digest;
    createdAt: string;
    updatedAt: string;
    recordDigest: Sha256Digest;
  };
  spec: FactoryTaskRequest;
  phase: FactoryTaskPhase;
  attempts: number;
  recoveryCount: number;
  nextAttemptAt?: string;
  lease?: FactoryTaskLease;
  timing: FactoryTaskTiming;
  result?: FactoryRunResult;
  failure?: FactoryTaskFailure;
  events: FactoryTaskEvent[];
}

export interface FactoryTaskQueueOptions {
  root: string;
  now?: () => Date;
  randomId?: () => string;
  maxTasks?: number;
  maxRecordBytes?: number;
}

export interface FactoryTaskQueueContract {
  enqueue(request: FactoryTaskRequest): FactoryTaskRecord;
  get(id: Sha256Digest): FactoryTaskRecord | undefined;
  list(): FactoryTaskRecord[];
  claim(workerId: string, leaseMs: number): FactoryTaskRecord | undefined;
  heartbeat(
    id: Sha256Digest,
    leaseId: string,
    workerId: string,
    leaseMs: number,
  ): FactoryTaskRecord;
  succeed(
    id: Sha256Digest,
    leaseId: string,
    workerId: string,
    result: FactoryRunResult,
  ): FactoryTaskRecord;
  fail(
    id: Sha256Digest,
    leaseId: string,
    workerId: string,
    failure: Omit<FactoryTaskFailure, "occurredAt">,
    retryDelayMs: number,
  ): FactoryTaskRecord;
  cancel(id: Sha256Digest, detail: string): FactoryTaskRecord;
}

export interface FactoryTaskExecutor {
  execute(task: FactoryTaskRecord): Promise<FactoryRunResult>;
}

export interface FactoryWorkerOptions {
  queue: FactoryTaskQueueContract;
  executor: FactoryTaskExecutor;
  workerId: string;
  leaseMs: number;
  retryDelayMs: number;
  now?: () => Date;
}

export interface FactoryWorkerResult {
  status: "idle" | "succeeded" | "retry-scheduled" | "failed" | "cancelled";
  task?: FactoryTaskRecord;
}

export type GitHubCredentialPurpose =
  | "draft-delivery"
  | "remote-evidence"
  | "authorized-merge"
  | "test-environment";

export interface GitHubCredentialRequest {
  purpose: GitHubCredentialPurpose;
  repository: string;
  appSlug: string;
  permissions: Readonly<Record<string, "read" | "write">>;
  minimumTtlMs: number;
}

export interface GitHubCredentialLease {
  kind: "github-app-installation";
  id: string;
  provider: string;
  token: string;
  issuedAt: string;
  expiresAt: string;
  repository: string;
  permissions: Readonly<Record<string, "read" | "write">>;
}

export interface GitHubCredentialProvider {
  acquire(request: GitHubCredentialRequest): Promise<GitHubCredentialLease>;
  revoke(lease: GitHubCredentialLease): Promise<void>;
}

export interface SecretSource {
  read(name: string): Promise<string>;
}

export type ArchivedEvidenceKind =
  | "EvidenceBundle"
  | "RemoteEvidence"
  | "PlatformEvidence";

export interface EvidenceArchiveReceipt {
  schemaVersion: typeof FACTORY_OPERATIONS_SCHEMA_VERSION;
  kind: "EvidenceArchiveReceipt";
  metadata: {
    archivedAt: string;
    receiptDigest: Sha256Digest;
  };
  subject: {
    kind: ArchivedEvidenceKind;
    logicalDigest: Sha256Digest;
    byteDigest: Sha256Digest;
    bytes: number;
    objectPath: string;
    sourceName: string;
  };
  retention: {
    immutable: true;
    policy: string;
    retainUntil: string;
  };
}

export interface EvidenceArchiveRequest {
  path: string;
  kind?: ArchivedEvidenceKind;
  retentionPolicy: string;
  retainUntil: string;
}

export interface ImmutableEvidenceStore {
  archive(request: EvidenceArchiveRequest): EvidenceArchiveReceipt;
  verify(receiptPath: string): EvidenceArchiveReceipt;
}

export interface FactorySloPolicy {
  schemaVersion: typeof FACTORY_OPERATIONS_SCHEMA_VERSION;
  kind: "FactorySloPolicy";
  metadata: {
    id: string;
  };
  window: {
    from: string;
    to: string;
  };
  objectives: {
    minimumSuccessRate: number;
    maximumP95QueueLatencyMs: number;
    maximumP95RunDurationMs: number;
    maximumIsolationFailureRate: number;
    maximumQueueDepth: number;
    maximumEstimatedCostMicros: number;
  };
  costModel: {
    computeMicrosPerSecond: number;
  };
}

export type SloObjectiveStatus = "passed" | "failed" | "insufficient-data";

export interface FactorySloObjectiveResult {
  metric: string;
  observed?: number;
  operator: ">=" | "<=";
  target: number;
  status: SloObjectiveStatus;
}

export interface FactorySloReport {
  schemaVersion: typeof FACTORY_OPERATIONS_SCHEMA_VERSION;
  kind: "FactorySloReport";
  metadata: {
    measuredAt: string;
    reportDigest: Sha256Digest;
  };
  policy: {
    id: string;
    digest: Sha256Digest;
  };
  metrics: {
    queueDepth: number;
    terminalTasks: number;
    succeededTasks: number;
    failedTasks: number;
    recoveredTasks: number;
    successRate?: number;
    p95QueueLatencyMs?: number;
    p95RunDurationMs?: number;
    isolationFailureRate?: number;
    estimatedCostMicros: number;
  };
  objectives: FactorySloObjectiveResult[];
  compliant: boolean;
}

export interface MergeAuthorization {
  schemaVersion: typeof FACTORY_OPERATIONS_SCHEMA_VERSION;
  kind: "MergeAuthorization";
  metadata: {
    id: string;
    issuedAt: string;
    expiresAt: string;
    authorizationDigest: Sha256Digest;
  };
  subject: {
    repository: string;
    pullRequest: number;
    baseBranch: string;
    baseCommit: string;
    headCommit: string;
    remoteEvidence: FileReference;
  };
  decision: {
    method: "squash";
    policy: ExactReference;
    authorizedApprovers: string[];
    approvalMarker: string;
  };
}

export interface TestEnvironmentAuthorization {
  schemaVersion: typeof FACTORY_OPERATIONS_SCHEMA_VERSION;
  kind: "TestEnvironmentAuthorization";
  metadata: {
    id: string;
    issuedAt: string;
    expiresAt: string;
    authorizationDigest: Sha256Digest;
  };
  subject: {
    repository: string;
    version: string;
    tag: string;
    commit: string;
    defaultBranch: string;
    environment: string;
    releaseManifest: FileReference;
  };
  decision: {
    policy: ExactReference;
    authorizedApprovers: string[];
    approvalMarker: string;
    requireSignedAnnotatedTag: true;
    requireDefaultBranchTip: true;
  };
}

export interface MergeGateSnapshot {
  pullRequest: GitHubPullRequestSnapshot & { baseBranch: string };
  checks: RemoteCheckEvidence[];
  reviews: GitHubReviewSnapshot[];
}

export interface MergeGateResult {
  eligible: boolean;
  blockers: string[];
  approval?: {
    reviewer: string;
    reviewId: number;
    submittedAt: string;
    commit: string;
    url: string;
  };
}

export interface MergePromotionClient {
  snapshot(repository: string, pullRequest: number): Promise<MergeGateSnapshot>;
  merge(
    repository: string,
    pullRequest: number,
    headCommit: string,
    method: "squash",
    token: string,
  ): Promise<{ mergeCommit: string }>;
}

export interface VersionTagSnapshot {
  repository: string;
  tag: string;
  version: string;
  commit: string;
  defaultBranch: string;
  defaultBranchTip: string;
  annotated: boolean;
  signatureVerified: boolean;
  signatureReason: string;
  approvals: GitHubReviewSnapshot[];
}

export interface TestEnvironmentGateResult {
  eligible: boolean;
  blockers: string[];
}

export const WECHAT_PLATFORM_CHECKS = [
  "devtools-compile",
  "simulator",
  "physical-device",
  "screen-reader",
] as const;

export type WechatPlatformCheckKind = (typeof WECHAT_PLATFORM_CHECKS)[number];

export interface PlatformEvidence {
  schemaVersion: typeof FACTORY_OPERATIONS_SCHEMA_VERSION;
  kind: "PlatformEvidence";
  metadata: {
    generatedAt: string;
    evidenceDigest: Sha256Digest;
  };
  subject: {
    application: ExactReference;
    candidateCommit: string;
    platform: "wechat-miniprogram";
    buildArtifact: FileReference;
  };
  checks: Array<{
    kind: WechatPlatformCheckKind;
    status: "passed";
    operator: string;
    observedAt: string;
    evidence: FileReference[];
  }>;
}

export interface PlatformGateResult {
  eligible: boolean;
  blockers: string[];
  application?: ExactReference;
  candidateCommit?: string;
}

export interface PromotionEvidence {
  remote: RemoteEvidence;
  authorization: MergeAuthorization;
}
