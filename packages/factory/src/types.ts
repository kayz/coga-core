import type {
  ExactReference,
  ImpactResult,
  ValidationProfile,
} from "@coga/core";

export const FACTORY_SCHEMA_VERSION = "coga.dev/factory/v0.1" as const;

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

export interface FactoryApproval {
  policy: ExactReference;
  approver: string;
  approvedAt: string;
  evidence: FileReference[];
}

export interface WorkOrderTarget {
  application: ExactReference;
  factoryDefinition: string;
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
    };
    proposal: {
      adapter: "coga.agent.patch/v1";
      patch: FileReference;
    };
    delivery: {
      adapter: "github.draft-pr/v1";
      repository: string;
      branch: string;
      title: string;
      body: string;
      commitMessage: string;
      draft: true;
    };
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
}

export interface ExecutionPlan {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "ExecutionPlan";
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
  steps: ExecutionPlanStep[];
  planDigest: Sha256Digest;
}

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

export interface EvidenceFile {
  path: string;
  digest: Sha256Digest;
  bytes: number;
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
    workOrderDigest: Sha256Digest;
    planDigest: Sha256Digest;
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

export interface FactoryRunState {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  workOrderId: string;
  workOrderDigest: Sha256Digest;
  status: FactoryState;
  baseCommit: string;
  workspacePath: string;
  branch: string;
  plan?: ExecutionPlan;
  steps: FactoryStepState[];
  evidence?: {
    path: string;
    digest: Sha256Digest;
  };
  resultCommit?: string;
  result?: FactoryRunResult;
  failure?: string;
  updatedAt: string;
}

export interface FactoryRunResult {
  status: "completed";
  workOrderId: string;
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
  };
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
