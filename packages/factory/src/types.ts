import type {
  ExactReference,
  ImpactResult,
  ValidationProfile,
} from "@coga/core";

export const FACTORY_SCHEMA_VERSION = "coga.dev/factory/v0.3" as const;
export const PATCH_NORMALIZATION_VERSION =
  "coga.patch.normalization/v1" as const;

export const FACTORY_STATES = [
  "requested",
  "planned",
  "executing",
  "verifying",
  "review",
  "completed",
  "failed",
  "cancelled",
] as const;

export const DEFAULT_NODE_IMAGE =
  "node@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d";

export type FactoryState = (typeof FACTORY_STATES)[number];
export type Sha256Digest = `sha256:${string}`;

export interface FileReference {
  path: string;
  digest: Sha256Digest;
}

export interface EvidenceFile extends FileReference {
  bytes: number;
}

export interface FactoryApproval {
  policy: ExactReference;
  approver: string;
  approvedAt: string;
  evidence: FileReference[];
}

export interface TargetDelivery {
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
}

export interface WorkOrderTarget {
  application: ExactReference;
  factoryDefinition: string;
  proposal: {
    adapter: "coga.agent.proposal/v2";
    receipt: FileReference;
  };
  delivery: TargetDelivery;
}

export interface WorkOrder {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "WorkOrder";
  metadata: {
    id: string;
    title: string;
    requestedBy: string;
    createdAt: string;
  };
  spec: {
    repository: {
      baseCommit: string;
      remote: string;
      baseBranch: string;
    };
    instance: {
      manifest: string;
      profile: Extract<ValidationProfile, "local" | "public">;
    };
    change: {
      artifact: ExactReference;
      patch: FileReference;
      allowedPaths: string[];
    };
    targets: WorkOrderTarget[];
    governance: {
      requiredPolicies: ExactReference[];
      approvals: FactoryApproval[];
      promotion: {
        requiredChecks: string[];
        authorizedApprovers: string[];
        requireArtifactAttestation: true;
      };
    };
    delivery: {
      adapter: "github.app-draft-pr/v3";
      repository: string;
      draft: true;
      identity: {
        kind: "github-app";
        appSlug: string;
        tokenEnvironment: "COGA_FACTORY_GITHUB_TOKEN";
      };
    };
  };
}

export interface AgentProposalReceipt {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "AgentProposalReceipt";
  metadata: {
    id: string;
    createdAt: string;
    receiptDigest: Sha256Digest;
  };
  subject: {
    baseCommit: string;
    change: ExactReference;
    application: ExactReference;
    inputs: EvidenceFile[];
  };
  generator: {
    adapter: ExactReference;
    model: {
      provider: string;
      id: string;
      version: string;
    };
    prompt: {
      template: ExactReference;
      path: string;
      digest: Sha256Digest;
    };
    tools: {
      allowed: string[];
      network: "none" | "model-provider-only";
      filesystem: "read-only";
    };
    budget: {
      maxInputTokens: number;
      maxOutputTokens: number;
      maxToolCalls: number;
      timeoutMs: number;
    };
  };
  output: {
    patch: FileReference;
    normalization: typeof PATCH_NORMALIZATION_VERSION;
    normalizedDigest: Sha256Digest;
    changedPaths: string[];
  };
}

export interface ProposalCompilationRequest {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "ProposalCompilation";
  metadata: {
    id: string;
    createdAt: string;
  };
  subject: {
    baseCommit: string;
    change: ExactReference;
    application: ExactReference;
    inputPaths: string[];
  };
  generator: AgentProposalReceipt["generator"];
  output: {
    patchPath: string;
    receiptPath: string;
    allowedPaths: string[];
  };
}

export interface NodeTestAdapterDefinition {
  adapter: "coga.node.test/v1";
  files: string[];
}

export interface NodeBuildAdapterDefinition {
  adapter: "coga.node.build/v1";
  entrypoint: string;
}

export type VerificationAdapterDefinition =
  | NodeTestAdapterDefinition
  | NodeBuildAdapterDefinition;

export interface ApplicationFactoryDefinition {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "ApplicationFactory";
  metadata: ExactReference;
  spec: {
    application: ExactReference;
    manifest: string;
    sourceRoot: string;
    changePaths: string[];
    verification: VerificationAdapterDefinition[];
  };
}

export type FactoryStepKind =
  | "apply-domain-change"
  | "apply-agent-proposal"
  | "validate-instance"
  | "test-application"
  | "build-application"
  | "create-evidence"
  | "deliver-draft-pr";

export interface ExecutionPlanStep {
  id: string;
  kind: FactoryStepKind;
  adapter: string;
  application?: ExactReference;
}

export interface PlannedTarget {
  application: ExactReference;
  factoryDefinitionPath: string;
  definition: ApplicationFactoryDefinition;
  proposalReceiptPath: string;
  proposalReceipt: AgentProposalReceipt;
  delivery: TargetDelivery;
}

export interface FanOutExecutionPlan {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "FanOutExecutionPlan";
  workOrder: {
    id: string;
    digest: Sha256Digest;
    path: string;
  };
  baseCommit: string;
  instanceManifest: string;
  change: ExactReference;
  impact: ImpactResult;
  targets: PlannedTarget[];
  planningFailures: FactoryTargetFailure[];
  planDigest: Sha256Digest;
}

export interface TargetExecutionPlan {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "TargetExecutionPlan";
  workOrder: FanOutExecutionPlan["workOrder"];
  baseCommit: string;
  instanceManifest: string;
  change: ExactReference;
  impact: ImpactResult;
  target: PlannedTarget;
  steps: ExecutionPlanStep[];
  planDigest: Sha256Digest;
}

export type ExecutionPlan = TargetExecutionPlan;

export interface AdapterManifest {
  id: string;
  version: string;
  kind: FactoryStepKind;
  network: "none" | "github-only";
  mutatesWorkspace: boolean;
  credentialAccess: "none" | "github";
}

export interface AdapterReceipt {
  stepId: string;
  adapter: ExactReference;
  status: "passed" | "failed";
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdoutDigest: Sha256Digest;
  stderrDigest: Sha256Digest;
  sandbox?: SandboxEvidence;
  outputFiles?: EvidenceFile[];
  detail?: string;
}

export interface SandboxEvidence {
  runner: ExactReference;
  image: string;
  isolation: "docker" | "test-double";
  network: "none";
  rootFilesystem: "read-only" | "simulated";
  repositoryMount: "read-only" | "simulated";
  credentialAccess: "none";
  user: string;
  limits: {
    pids: number;
    memoryBytes: number;
    cpus: number;
  };
}

export interface EvidenceBundle {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "EvidenceBundle";
  metadata: {
    workOrderId: string;
    generatedAt: string;
    bundleDigest: Sha256Digest;
  };
  subject: {
    repository: string;
    baseCommit: string;
    subjectTree: string;
    application: ExactReference;
    workOrderDigest: Sha256Digest;
    planDigest: Sha256Digest;
    proposalReceiptDigest: Sha256Digest;
    changedFiles: EvidenceFile[];
  };
  governance: {
    requiredPolicies: ExactReference[];
    approvals: FactoryApproval[];
    pendingPolicies: ExactReference[];
    draftOnly: true;
  };
  impact: ImpactResult;
  steps: AdapterReceipt[];
}

export interface FactoryStepState {
  id: string;
  status: "pending" | "running" | "passed" | "failed";
  attempts: number;
  receipt?: AdapterReceipt;
}

export interface FactoryTargetRunResult {
  status: "completed";
  application: ExactReference;
  baseCommit: string;
  resultCommit: string;
  branch: string;
  evidencePath: string;
  evidenceDigest: Sha256Digest;
  pullRequest?: {
    number: number;
    url: string;
    state: string;
    draft: boolean;
    author: string;
  };
}

export interface FactoryTargetFailure {
  status: "failed";
  application: ExactReference;
  branch: string;
  failure: string;
}

export type FactoryTargetOutcome =
  | FactoryTargetRunResult
  | FactoryTargetFailure;

export interface FactoryRunResult {
  status: "completed" | "partial" | "failed";
  workOrderId: string;
  baseCommit: string;
  targets: FactoryTargetOutcome[];
}

export interface FactoryRunState {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  workOrderId: string;
  workOrderDigest: Sha256Digest;
  application: ExactReference;
  status: FactoryState;
  baseCommit: string;
  workspacePath: string;
  branch: string;
  plan?: TargetExecutionPlan;
  steps: FactoryStepState[];
  evidence?: {
    path: string;
    digest: Sha256Digest;
  };
  resultCommit?: string;
  result?: FactoryTargetRunResult;
  failure?: string;
  updatedAt: string;
}

export interface FactoryControllerOptions {
  repositoryRoot?: string;
  stateRoot?: string;
  workspaceRoot?: string;
  nodeImage?: string;
  delivery?: "github" | "local";
  keepWorkspace?: boolean;
  now?: () => Date;
  commandTimeoutMs?: number;
  maxOutputBytes?: number;
  stopAfterStep?: string;
}

export interface FactoryControllerDependencies {
  sandbox?: SandboxRunner;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded?: boolean;
}

export interface SandboxRequest {
  name: string;
  workspacePath: string;
  outputPath?: string;
  image: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SandboxRunner {
  evidence(image: string): SandboxEvidence;
  run(request: SandboxRequest): Promise<ProcessResult>;
}

export interface RemoteCheckEvidence {
  name: string;
  app: string;
  conclusion: "success";
  completedAt: string;
  url: string;
}

export interface RemotePolicyApproval {
  policy: ExactReference;
  reviewer: string;
  reviewId: number;
  submittedAt: string;
  commit: string;
  url: string;
}

export interface RemoteEvidence {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "RemoteEvidence";
  metadata: {
    collectedAt: string;
    remoteEvidenceDigest: Sha256Digest;
  };
  subject: {
    evidenceBundle: FileReference;
    repository: string;
    pullRequest: number;
    pullRequestUrl: string;
    pullRequestAuthor: string;
    baseCommit: string;
    headCommit: string;
    application: ExactReference;
    workOrder: {
      id: string;
      digest: Sha256Digest;
    };
  };
  checks: RemoteCheckEvidence[];
  attestation: {
    verified: true;
    subjectDigest: Sha256Digest;
    verifier: "gh-attestation";
  };
  approvals: RemotePolicyApproval[];
  promotion: {
    eligible: boolean;
    blockers: string[];
  };
}

export interface GovernanceTargetView {
  application: ExactReference;
  proposalReceipt: FileReference;
  localEvidence?: FileReference;
  remoteEvidence?: FileReference;
  requiredPolicies: ExactReference[];
  pendingPolicies: ExactReference[];
  promotion: {
    eligible: boolean;
    blockers: string[];
  };
}

export interface GovernanceView {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "GovernanceView";
  workOrder: {
    id: string;
    digest: Sha256Digest;
  };
  change: ExactReference;
  targets: GovernanceTargetView[];
}

export interface GitHubPullRequestSnapshot {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  author: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: number;
}

export interface GitHubReviewSnapshot {
  id: number;
  reviewer: string;
  state: string;
  body: string;
  submittedAt: string;
  commit: string;
  url: string;
}

export interface GitHubEvidenceClient {
  pullRequest(
    repository: string,
    number: number,
  ): Promise<GitHubPullRequestSnapshot>;
  evidenceFile(
    repository: string,
    commit: string,
    path: string,
  ): Promise<Buffer>;
  pullRequestFiles(repository: string, number: number): Promise<string[]>;
  checks(repository: string, commit: string): Promise<RemoteCheckEvidence[]>;
  reviews(repository: string, number: number): Promise<GitHubReviewSnapshot[]>;
  verifyAttestation(repository: string, evidencePath: string): Promise<void>;
  markReady(repository: string, number: number): Promise<void>;
}
