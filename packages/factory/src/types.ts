export const FACTORY_SCHEMA_VERSION = "coga.dev/factory/v0.1" as const;

export type AdapterKind =
  | "agent"
  | "tool"
  | "workspace"
  | "validator"
  | "policy"
  | "observation"
  | "preview";

export interface AdapterReference {
  kind: AdapterKind;
  id: string;
  version: string;
}

export interface AdapterDescriptor {
  ref: AdapterReference;
  runtime: "builtin" | "process" | "deepseek";
  actions: string[];
  config?: {
    cwd?: string;
    executable?: string;
    args?: string[];
    timeoutMs?: number;
    outputLimitBytes?: number;
    envAllowlist?: string[];
    baseUrl?: string;
    model?: string;
    secretRef?: string;
    maxTokens?: number;
    allowRestrictedInput?: false;
    /** Runtime-only anchor injected from an explicitly attached private binding. */
    workspaceRoot?: string;
  };
}

export interface FactoryProfile {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "FactoryProfile";
  metadata: {
    id: string;
    title: string;
    version: string;
  };
  spec: {
    workspaceRoot: "." | "..";
    instanceManifest: string;
    stateDirectory: string;
    candidateDirectory: string;
    applicationBindings?: string[];
    evaluationProfiles?: string[];
    recipes?: string[];
    adapters: AdapterDescriptor[];
    policies: {
      maxAutonomousRisk: "low" | "medium";
      promotionRequiresHuman: true;
      releaseRequiresHuman: true;
      separationOfDuties: true;
      publishedMutation: "deny";
      requiredRoles?: Record<string, string[]>;
    };
    sourceAllowlist?: string[];
    workbench?: {
      host?: "127.0.0.1";
      port?: number;
      locale?: "zh-CN" | "en";
    };
  };
}

export interface LoadedFactoryProfile {
  path: string;
  root: string;
  document: FactoryProfile;
}

export interface ApplicationRecipe {
  schemaVersion: typeof FACTORY_SCHEMA_VERSION;
  kind: "ApplicationRecipe";
  metadata: {
    id: string;
    title: string;
    version: string;
  };
  spec: {
    deliveryTarget: string;
    templateRoot: string;
    parameters: Array<{
      name: string;
      pattern: string;
      required: boolean;
      default?: string;
    }>;
    harnessDependencies: Array<{ id: string; version: string }>;
    outputs: string[];
    validators: Array<{ id: string; version: string }>;
  };
}

export interface Actor {
  id: string;
  type: "human" | "agent" | "system";
  roles: string[];
}

export interface CommandResult {
  executable: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutDigest: string;
  stderrDigest: string;
  truncated: boolean;
}

export interface AssetAssessment {
  summary: string;
  changeClasses: Array<
    | "authority-changed"
    | "scope-expanded"
    | "scope-narrowed"
    | "permission-expanded"
    | "permission-narrowed"
    | "failure-behavior-changed"
    | "contract-changed"
    | "provenance-changed"
    | "editorial"
    | "uncertain"
  >;
  risks: Array<{
    severity: "low" | "medium" | "high" | "critical";
    description: string;
    mitigation: string;
  }>;
  questions: string[];
  recommendedScenarios: string[];
  recommendation: "ready" | "revise" | "reject";
  confidence: number;
}

export interface AssessmentRequest {
  taskId: string;
  prompt: string;
  sourceMaterial: string;
  sourceVisibility: "public" | "internal" | "restricted";
  candidateDigest: string;
  timeoutMs?: number;
}

export interface AssessmentResult {
  assessment: AssetAssessment;
  provider: "deterministic" | "deepseek";
  model: string;
  responseId: string;
  promptDigest: string;
  outputDigest: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface AuditEvent {
  sequence: number;
  timestamp: string;
  runId: string;
  type: string;
  actor: Actor;
  payloadDigest: string;
  previousHash: string;
  hash: string;
}

export type StoreCollection =
  | "tasks"
  | "runs"
  | "evidence"
  | "assessment-results"
  | "policy-decisions"
  | "approvals"
  | "observations"
  | "incidents"
  | "incident-controls"
  | "promotions"
  | "candidates"
  | "metrics";

export interface FactorySnapshot {
  generatedAt: string;
  tasks: unknown[];
  runs: unknown[];
  evidence: unknown[];
  assessmentResults: unknown[];
  policyDecisions: unknown[];
  approvals: unknown[];
  observations: unknown[];
  incidents: unknown[];
  promotions: unknown[];
  candidates: unknown[];
  metrics: unknown[];
  audit: AuditEvent[];
  auditValid: boolean;
}

export interface LoadedApplicationBinding {
  path: string;
  root: string;
  document: {
    schemaVersion: string;
    kind: "ApplicationFactoryBinding";
    metadata: {
      id: string;
      version: string;
      lifecycle?: string;
      visibility?: string;
    };
    spec: {
      application: { id: string; version: string; manifest: string };
      harnessLocks?: Array<{ id: string; version: string }>;
      validators?: Array<{
        id: string;
        executable: string;
        args: string[];
        cwd: string;
        timeoutMs?: number;
        outputLimitBytes?: number;
        envAllowlist?: string[];
        shell: false;
      }>;
      preview?: Record<string, unknown>;
      criticalJourneys?: unknown[];
      operations?: {
        telemetryRegistry?: string;
        observationFixtures?: string[];
        incidentFixtures?: string[];
        runbookRefs?: Array<{ id: string; version: string }>;
        scenarioRefs?: Array<{ id: string; version: string }>;
        networkTransport?: string;
        publicationPolicy?: string;
      };
    };
  };
}
