export const SCHEMA_VERSION = "coga.dev/v0.2" as const;

export const RESOURCE_KINDS = [
  "DomainArtifact",
  "HarnessPackage",
  "CogaInstance",
  "Application",
] as const;

export const LIFECYCLES = [
  "draft",
  "candidate",
  "approved",
  "published",
  "deprecated",
] as const;

export const HARNESS_LAYERS = [
  "domain",
  "platform",
  "engineering",
  "organization",
  "operations",
] as const;

export const ARTIFACT_TYPES = [
  "concept",
  "rule",
  "capability",
  "scenario",
  "policy",
  "runbook",
] as const;

export const VALIDATION_PROFILES = ["local", "public", "release"] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type Lifecycle = (typeof LIFECYCLES)[number];
export type HarnessLayer = (typeof HARNESS_LAYERS)[number];
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export type ValidationProfile = (typeof VALIDATION_PROFILES)[number];
export type OwnershipScope = "core" | "instance" | "application";
export type Visibility = "public" | "internal" | "restricted";
export type ContractFormat = "json-schema-2020-12" | "openapi-3.1";

export interface ExactReference {
  id: string;
  version: string;
}

export interface LocatedReference extends ExactReference {
  path: string;
}

export interface ApprovalAttestation {
  type: "approval";
  policy: ExactReference;
  approver: string;
  approvedAt: string;
  evidence: string[];
}

export interface ResourceMetadata {
  id: string;
  title: string;
  version: string;
  lifecycle: Lifecycle;
  scope: OwnershipScope;
  visibility: Visibility;
  attestations: ApprovalAttestation[];
  owners?: string[];
  tags?: string[];
}

export interface BaseResource<K extends ResourceKind> {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: K;
  metadata: ResourceMetadata;
}

export interface ProvenanceRecord {
  source: string;
  sourceType: "document" | "standard" | "expert" | "system" | "observation";
  locator?: string;
  capturedAt?: string;
  note?: string;
}

export interface ArtifactRelation {
  type:
    | "depends-on"
    | "refines"
    | "conflicts-with"
    | "supersedes"
    | "implements"
    | "verifies"
    | "applies-to";
  target: ExactReference;
  note?: string;
}

export interface ValidationRecord {
  type: "scenario" | "schema" | "test" | "review";
  status: "pending" | "passed" | "failed";
  target?: ExactReference;
  checkedAt?: string;
  validator?: string;
  evidence?: string[];
}

export interface ContractReference {
  id: string;
  version: string;
  path: string;
  format: ContractFormat;
  digest?: string;
}

export interface DomainArtifact extends BaseResource<"DomainArtifact"> {
  spec: {
    artifactType: ArtifactType;
    summary: string;
    statement?: string;
    scope?: string;
    provenance: ProvenanceRecord[];
    relations: ArtifactRelation[];
    validation: ValidationRecord[];
    contractRefs: ContractReference[];
  };
}

export interface HarnessPackage extends BaseResource<"HarnessPackage"> {
  spec: {
    layer: HarnessLayer;
    description: string;
    dependencies: ExactReference[];
    artifacts: LocatedReference[];
  };
}

export interface ApprovalRule {
  lifecycle: Lifecycle;
  policies: ExactReference[];
}

export interface ReleaseEvidenceRule {
  lifecycle: Lifecycle;
  evidence: string[];
}

export interface CogaInstance extends BaseResource<"CogaInstance"> {
  spec: {
    domain: {
      name: string;
      boundary: string;
      nonGoals: string[];
    };
    packages: LocatedReference[];
    applications: LocatedReference[];
    governance: {
      approvalRules: ApprovalRule[];
      releaseEvidence?: ReleaseEvidenceRule[];
      extensions?: Record<string, unknown>;
    };
  };
}

export interface Application extends BaseResource<"Application"> {
  spec: {
    deliveryTargets: string[];
    harnessDependencies: ExactReference[];
    contracts: ContractReference[];
    scenarios: ExactReference[];
    operations: {
      runbooks?: ExactReference[];
      settings?: Record<string, unknown>;
      [key: string]: unknown;
    };
    choices?: Record<string, unknown>;
  };
}

export type CanonicalResource =
  | DomainArtifact
  | HarnessPackage
  | CogaInstance
  | Application;

export interface ResourceLimits {
  canonicalFileBytes: number;
  contractFileBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxAliases: number;
}

export interface CogaOptions {
  profile?: ValidationProfile;
  rootDir?: string;
  limits?: Partial<ResourceLimits>;
}

export interface LoadContext {
  profile: ValidationProfile;
  rootDir: string;
  limits: ResourceLimits;
}

export type ValidationIssueSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationIssueSeverity;
  code: string;
  message: string;
  path: string;
  resourceId?: string;
}

export interface LoadedResource<T = unknown> {
  path: string;
  document: T;
  declaredRef?: LocatedReference;
}

export interface LoadedArtifact extends LoadedResource {
  ownerPackage?: ExactReference;
}

export interface LoadedCogaInstance {
  manifestPath: string;
  context: LoadContext;
  instance: LoadedResource;
  packages: LoadedResource[];
  artifacts: LoadedArtifact[];
  applications: LoadedResource[];
  loadIssues: ValidationIssue[];
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  loaded: LoadedCogaInstance;
}

export interface CatalogArtifact {
  id: string;
  title: string;
  version: string;
  lifecycle: Lifecycle;
  artifactType: ArtifactType;
  summary: string;
  visibility: Visibility;
}

export interface CatalogPackage {
  id: string;
  title: string;
  version: string;
  lifecycle: Lifecycle;
  layer: HarnessLayer;
  description: string;
  dependencies: ExactReference[];
  artifacts: CatalogArtifact[];
  visibility: Visibility;
}

export interface CatalogApplication {
  id: string;
  title: string;
  version: string;
  lifecycle: Lifecycle;
  deliveryTargets: string[];
  harnessDependencies: ExactReference[];
  visibility: Visibility;
}

export interface CogaCatalog {
  schemaVersion: typeof SCHEMA_VERSION;
  instance: {
    id: string;
    title: string;
    version: string;
    lifecycle: Lifecycle;
    domainName: string;
    boundary: string;
    nonGoals: string[];
    visibility: Visibility;
  };
  packages: CatalogPackage[];
  applications: CatalogApplication[];
}

export interface ImpactPathNode extends ExactReference {
  kind: "artifact" | "package" | "application";
}

export interface ImpactReason {
  type: "direct" | "transitive" | "older-pin";
  path: ImpactPathNode[];
}

export interface ImpactApplication {
  id: string;
  title: string;
  version: string;
  path: string;
  reasons: ImpactReason[];
  rerunScenarios: ExactReference[];
  rerunRunbooks: ExactReference[];
}

export interface ImpactResult {
  artifact: ExactReference;
  found: boolean;
  packages: Array<ExactReference & { layer: HarnessLayer; path: string }>;
  affectedApplications: ImpactApplication[];
}

export interface LifecycleTransitionResult {
  allowed: boolean;
  from: Lifecycle;
  to: Lifecycle;
  reason: string;
}
