import type {
  ExactReference,
  Lifecycle,
  LocatedReference,
  ResourceMetadata,
} from "../types.js";

export const CONTROL_SCHEMA_VERSION = "coga.dev/control/v0.1" as const;

export const CONTROL_RESOURCE_KINDS = [
  "TaskContract",
  "EvidenceBundle",
  "RunRecord",
  "Observation",
  "Incident",
  "PromotionProposal",
] as const;

export type ControlResourceKind = (typeof CONTROL_RESOURCE_KINDS)[number];
export type Digest = `sha256:${string}`;
export type ActorKind = "human" | "agent" | "system";
export type AdapterKind =
  | "agent"
  | "tool"
  | "workspace"
  | "validator"
  | "policy"
  | "observation"
  | "preview";

export interface ActorRef {
  kind: ActorKind;
  id: string;
  roles: string[];
}

export interface AdapterRef extends ExactReference {
  kind: AdapterKind;
}

export interface ControlResource<K extends ControlResourceKind> {
  schemaVersion: typeof CONTROL_SCHEMA_VERSION;
  kind: K;
  metadata: ResourceMetadata;
}

export type TaskMode =
  | "calibrate"
  | "build"
  | "repair"
  | "upgrade"
  | "operate"
  | "release-harness";
export type Risk = "low" | "medium" | "high" | "critical";

export interface TaskIntent {
  goal: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  sources: string[];
}

export interface TaskBudget {
  maxDurationMs: number;
  maxAttempts: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface ApprovalRequirement {
  id: string;
  phase: "preflight" | "post-validation" | "release";
  roles: string[];
  minimumApprovals: number;
  separationOfDuties: boolean;
}

export interface PolicyCheck {
  policy: ExactReference;
  evaluator: AdapterRef & { kind: "policy" };
}

export interface TaskStep {
  id: string;
  phase:
    | "preflight"
    | "execute"
    | "validate"
    | "preview"
    | "release"
    | "operate"
    | "finalize";
  adapter: AdapterRef;
  action: string;
  input: Record<string, unknown>;
  validators: Array<AdapterRef & { kind: "validator" }>;
  requiredClaims: string[];
  maxAttempts: number;
}

export interface TaskContract extends ControlResource<"TaskContract"> {
  spec: {
    mode: TaskMode;
    risk: Risk;
    requestedBy: ActorRef;
    instance: ExactReference;
    application?: ExactReference;
    intent: TaskIntent;
    workspace: AdapterRef & { kind: "workspace" };
    steps: TaskStep[];
    policies: PolicyCheck[];
    approvals: ApprovalRequirement[];
    budget: TaskBudget;
  };
}

export interface MaterialRef {
  path: string;
  mediaType: string;
  digest: Digest;
}

export interface ClaimResult {
  claim: string;
  status: "passed" | "failed";
  validator: AdapterRef & { kind: "validator" };
  materialPaths: string[];
  message?: string;
}

export interface CommandMetadata {
  executable: string;
  args: string[];
  exitCode: number;
  stdoutDigest?: Digest;
  stderrDigest?: Digest;
}

export interface ModelMetadata {
  provider: string;
  model: string;
  responseId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
  promptDigest: Digest;
  outputDigest: Digest;
}

export interface EvidenceBundle extends ControlResource<"EvidenceBundle"> {
  spec: {
    task: ExactReference;
    runId: string;
    producedBy: ActorRef;
    disposition: "candidate";
    subject: MaterialRef;
    materials: MaterialRef[];
    claimResults: ClaimResult[];
    execution: {
      validator?: AdapterRef & { kind: "validator" };
      command?: CommandMetadata;
      model?: ModelMetadata;
    };
  };
}

export interface PolicyDecision {
  policy: ExactReference;
  evaluator: AdapterRef & { kind: "policy" };
  decision: "allow" | "deny" | "requireApproval";
  reason: string;
  taskDigest: Digest;
  evaluatedAt: string;
  approvalRequirementIds: string[];
}

export interface ApprovalDecision {
  requirementId: string;
  decision: "approve" | "reject";
  actor: ActorRef & { kind: "human" };
  decidedAt: string;
  reason: string;
  candidateDigest: Digest;
  taskDigest: Digest;
  evidenceDigest: Digest;
  impactDigest: Digest;
}

export interface AuditEvent {
  sequence: number;
  occurredAt: string;
  actor: ActorRef;
  type: string;
  payload: Record<string, unknown>;
  payloadDigest: Digest;
  previousHash: Digest;
  hash: Digest;
}

export type RunState =
  | "created"
  | "preflight"
  | "executing"
  | "validating"
  | "awaitingApproval"
  | "succeeded"
  | "denied"
  | "rejected"
  | "failed"
  | "cancelled";

export interface RunStepRecord {
  id: string;
  state: "pending" | "running" | "completed" | "failed";
  attempts: number;
  outputDigest?: Digest;
  claimDigest?: Digest;
  checkpoint?: Record<string, unknown>;
}

export interface BudgetUsage {
  elapsedMs: number;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunRecord extends ControlResource<"RunRecord"> {
  spec: {
    task: ExactReference;
    idempotencyKey: Digest;
    state: RunState;
    stateReason?: string;
    taskDigest: Digest;
    candidateDigest: Digest;
    evidenceDigest: Digest;
    impactDigest: Digest;
    requestedBy: ActorRef;
    steps: RunStepRecord[];
    policyDecisions: PolicyDecision[];
    approvalDecisions: ApprovalDecision[];
    evidence: LocatedReference[];
    audit: AuditEvent[];
    auditHead: Digest;
    budget: BudgetUsage;
    heartbeatAt?: string;
    checkpoint?: Record<string, unknown>;
    cancellation?: {
      requestedBy: ActorRef;
      reason: string;
      requestedAt: string;
    };
  };
}

export interface Observation extends ControlResource<"Observation"> {
  spec: {
    cloudEvent: {
      specversion: "1.0";
      id: string;
      source: string;
      type: string;
      subject?: string;
      time: string;
      datacontenttype: string;
      dataschema: string;
      data: unknown;
    };
    classification: "public" | "internal" | "restricted";
    retention: {
      class: "ephemeral" | "operational" | "record";
      retainUntil?: string;
    };
    schemaRef: ExactReference;
    application: ExactReference;
  };
}

export interface IncidentVerification {
  type:
    | "deploy"
    | "reproduction"
    | "monitoring"
    | "customer-confirmation"
    | "rollback";
  evidence: ExactReference;
}

export interface Incident extends ControlResource<"Incident"> {
  spec: {
    application: ExactReference;
    status: "open" | "mitigated" | "resolved" | "closed";
    summary: string;
    observations: ExactReference[];
    closure?: {
      cause: string;
      resolution: string;
      verification: IncidentVerification[];
      closedBy: ActorRef & { kind: "human" };
      closedAt: string;
    };
  };
}

export interface PromotionProposal
  extends ControlResource<"PromotionProposal"> {
  metadata: ResourceMetadata & { lifecycle: "candidate" };
  spec: {
    proposedBy: ActorRef;
    observations: ExactReference[];
    sourceApplications: ExactReference[];
    authoritativeSources: string[];
    targetPackage: ExactReference;
    proposedArtifactType:
      | "concept"
      | "rule"
      | "capability"
      | "scenario"
      | "policy"
      | "runbook";
    generalization: string;
    scenarioRefs: ExactReference[];
    candidateDigest: Digest;
  };
}

export type ControlResourceDocument =
  | TaskContract
  | EvidenceBundle
  | RunRecord
  | Observation
  | Incident
  | PromotionProposal;

export interface ControlValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface ControlValidationResult {
  valid: boolean;
  issues: ControlValidationIssue[];
}

export interface HarnessReleaseResource {
  id: string;
  version: string;
  kind: string;
  path: string;
  digest: Digest;
  lifecycle: Lifecycle;
  visibility?: "public" | "internal" | "restricted";
}

export interface HarnessReleasePlan {
  schemaVersion: "coga.dev/release/v0.1";
  target: ExactReference;
  packages: ExactReference[];
  resources: HarnessReleaseResource[];
  provenance: Array<{
    source: string;
    digest: Digest;
    visibility: "public" | "internal" | "restricted";
  }>;
  evidenceDigests: Digest[];
  releaseDigest: Digest;
}
