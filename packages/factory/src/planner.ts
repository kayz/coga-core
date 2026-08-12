import { relative, resolve } from "node:path";
import {
  impact,
  validate,
  type ExactReference,
  type ImpactResult,
  type LoadedCogaInstance,
} from "@coga/core";
import { loadApplicationFactory } from "./schema.js";
import type {
  ApplicationFactoryDefinition,
  ExecutionPlan,
  ExecutionPlanStep,
  PlannedTarget,
  WorkOrder,
} from "./types.js";
import {
  canonicalJson,
  normalizeRelativePath,
  resolveWithin,
  sha256,
  verifyFileReference,
} from "./utils.js";

function exactKey(reference: ExactReference): string {
  return `${reference.id}@${reference.version}`;
}

function repositoryPath(root: string, path: string): string {
  const value = relative(root, resolve(path)).replaceAll("\\", "/");
  return normalizeRelativePath(value, "loaded resource path");
}

function portableImpact(root: string, result: ImpactResult): ImpactResult {
  return {
    ...result,
    packages: result.packages.map((entry) => ({
      ...entry,
      path: repositoryPath(root, entry.path),
    })),
    affectedApplications: result.affectedApplications.map((entry) => ({
      ...entry,
      path: repositoryPath(root, entry.path),
    })),
  };
}

function metadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || !("metadata" in value))
    return undefined;
  const candidate = value.metadata;
  return candidate && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function artifactType(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("spec" in value))
    return undefined;
  const spec = value.spec;
  if (!spec || typeof spec !== "object" || !("artifactType" in spec))
    return undefined;
  return typeof spec.artifactType === "string" ? spec.artifactType : undefined;
}

function assertGovernance(
  loaded: LoadedCogaInstance,
  workOrder: WorkOrder,
  workspace: string,
): void {
  const policies = new Set<string>();
  for (const artifact of loaded.artifacts) {
    const details = metadata(artifact.document);
    if (
      details &&
      typeof details.id === "string" &&
      typeof details.version === "string" &&
      artifactType(artifact.document) === "policy"
    ) {
      policies.add(`${details.id}@${details.version}`);
    }
  }
  for (const policy of workOrder.spec.governance.requiredPolicies) {
    if (!policies.has(exactKey(policy))) {
      throw new Error(
        `Work Order governance policy '${exactKey(policy)}' is not a registered policy Artifact.`,
      );
    }
  }
  const required = new Set(
    workOrder.spec.governance.requiredPolicies.map(exactKey),
  );
  const seen = new Set<string>();
  for (const approval of workOrder.spec.governance.approvals) {
    const key = exactKey(approval.policy);
    if (!required.has(key))
      throw new Error(`Approval references non-required policy '${key}'.`);
    if (seen.has(key))
      throw new Error(`Work Order contains duplicate approval for '${key}'.`);
    seen.add(key);
    for (const [index, evidence] of approval.evidence.entries()) {
      verifyFileReference(
        workspace,
        evidence,
        `approval evidence ${key}[${index}]`,
        2 * 1024 * 1024,
      );
    }
  }
}

function assertDefinitionPaths(
  root: string,
  definition: ApplicationFactoryDefinition,
): void {
  const sourceRoot = normalizeRelativePath(
    definition.spec.sourceRoot,
    "Application sourceRoot",
  );
  resolveWithin(root, sourceRoot, "Application sourceRoot");
  resolveWithin(root, definition.spec.manifest, "Application manifest");
  for (const path of definition.spec.changePaths) {
    const normalized = normalizeRelativePath(path, "Application change path");
    if (normalized !== sourceRoot && !normalized.startsWith(`${sourceRoot}/`)) {
      throw new Error(
        `Application change path '${normalized}' is outside sourceRoot '${sourceRoot}'.`,
      );
    }
    resolveWithin(root, normalized, "Application change path");
  }
  for (const adapter of definition.spec.verification) {
    const paths =
      adapter.adapter === "coga.node.test/v1"
        ? adapter.files
        : [adapter.entrypoint];
    for (const path of paths) {
      const normalized = normalizeRelativePath(path, `${adapter.adapter} path`);
      if (!normalized.startsWith(`${sourceRoot}/`)) {
        throw new Error(
          `${adapter.adapter} path '${normalized}' is outside sourceRoot '${sourceRoot}'.`,
        );
      }
      resolveWithin(root, normalized, `${adapter.adapter} path`);
    }
  }
}

function steps(targets: PlannedTarget[]): ExecutionPlanStep[] {
  const result: ExecutionPlanStep[] = [
    {
      id: "change.apply",
      kind: "apply-domain-change",
      adapter: "coga.domain.patch/v1",
    },
    {
      id: "proposal.apply",
      kind: "apply-agent-proposal",
      adapter: "coga.agent.patch/v1",
    },
    {
      id: "instance.validate",
      kind: "validate-instance",
      adapter: "coga.core.validate/v1",
    },
  ];
  for (const target of targets) {
    for (const [
      index,
      adapter,
    ] of target.definition.spec.verification.entries()) {
      result.push({
        id: `${target.application.id}.${adapter.adapter === "coga.node.test/v1" ? "test" : "build"}.${index + 1}`,
        kind:
          adapter.adapter === "coga.node.test/v1"
            ? "test-application"
            : "build-application",
        adapter: adapter.adapter,
        application: target.application,
      });
    }
  }
  result.push(
    {
      id: "evidence.create",
      kind: "create-evidence",
      adapter: "coga.evidence.bundle/v1",
    },
    {
      id: "delivery.draft-pr",
      kind: "deliver-draft-pr",
      adapter: "github.draft-pr/v1",
    },
  );
  return result;
}

export function createExecutionPlan(
  workspace: string,
  workOrderPath: string,
  workOrder: WorkOrder,
  baseCommit: string,
): ExecutionPlan {
  const manifestPath = resolveWithin(
    workspace,
    workOrder.spec.instance.manifest,
    "Instance manifest",
  );
  const validated = validate(manifestPath, {
    profile: workOrder.spec.instance.profile,
    rootDir: resolve(manifestPath, ".."),
  });
  if (!validated.valid) {
    const detail = validated.issues
      .filter((entry) => entry.severity === "error")
      .slice(0, 20)
      .map((entry) => `${entry.code}: ${entry.message}`)
      .join("; ");
    throw new Error(`Base COGA Instance is invalid: ${detail}`);
  }
  const rawImpact = impact(validated.loaded, workOrder.spec.change.artifact);
  if (!rawImpact.found) {
    throw new Error(
      `Changed Artifact '${exactKey(workOrder.spec.change.artifact)}' is not registered.`,
    );
  }
  const result = portableImpact(workspace, rawImpact);
  const expectedTargets = result.affectedApplications
    .map((entry) => `${entry.id}@${entry.version}`)
    .sort();
  const requestedTargets = workOrder.spec.targets
    .map((entry) => exactKey(entry.application))
    .sort();
  if (new Set(requestedTargets).size !== requestedTargets.length) {
    throw new Error("Work Order contains duplicate target Applications.");
  }
  if (canonicalJson(expectedTargets) !== canonicalJson(requestedTargets)) {
    throw new Error(
      `Work Order targets must exactly cover impact. Expected [${expectedTargets.join(", ")}], received [${requestedTargets.join(", ")}].`,
    );
  }

  const changedArtifact = validated.loaded.artifacts.find((entry) => {
    const details = metadata(entry.document);
    return (
      details?.id === workOrder.spec.change.artifact.id &&
      details.version === workOrder.spec.change.artifact.version
    );
  });
  if (!changedArtifact)
    throw new Error("Unable to locate changed Artifact file.");
  const artifactPath = repositoryPath(workspace, changedArtifact.path);
  const authorized = workOrder.spec.change.allowedPaths.some(
    (entry) => artifactPath === entry || artifactPath.startsWith(`${entry}/`),
  );
  if (!authorized)
    throw new Error(
      `Domain change does not authorize its Artifact file '${artifactPath}'.`,
    );

  verifyFileReference(
    workspace,
    workOrder.spec.change.patch,
    "domain change patch",
  );
  verifyFileReference(
    workspace,
    workOrder.spec.proposal.patch,
    "Agent proposal patch",
  );
  assertGovernance(validated.loaded, workOrder, workspace);

  const targets: PlannedTarget[] = workOrder.spec.targets
    .map((target) => {
      const definitionPath = normalizeRelativePath(
        target.factoryDefinition,
        "factoryDefinition",
      );
      const definition = loadApplicationFactory(
        resolveWithin(workspace, definitionPath, "factoryDefinition"),
      );
      if (
        exactKey(definition.spec.application) !== exactKey(target.application)
      ) {
        throw new Error(
          `Factory definition '${definitionPath}' targets '${exactKey(definition.spec.application)}', not '${exactKey(target.application)}'.`,
        );
      }
      const impacted = result.affectedApplications.find(
        (entry) =>
          `${entry.id}@${entry.version}` === exactKey(target.application),
      );
      if (!impacted || impacted.path !== definition.spec.manifest) {
        throw new Error(
          `Factory definition '${definitionPath}' does not bind the registered Application manifest.`,
        );
      }
      assertDefinitionPaths(workspace, definition);
      return {
        application: target.application,
        factoryDefinitionPath: definitionPath,
        definition,
      };
    })
    .sort((left, right) =>
      exactKey(left.application).localeCompare(exactKey(right.application)),
    );

  const workOrderDigest = sha256(canonicalJson(workOrder));
  const workOrderRepositoryPath = repositoryPath(workspace, workOrderPath);
  const withoutDigest = {
    schemaVersion: workOrder.schemaVersion,
    kind: "ExecutionPlan" as const,
    workOrder: {
      id: workOrder.metadata.id,
      digest: workOrderDigest,
      path: workOrderRepositoryPath,
    },
    baseCommit,
    instanceManifest: workOrder.spec.instance.manifest,
    change: workOrder.spec.change.artifact,
    impact: result,
    targets,
    steps: steps(targets),
  };
  return { ...withoutDigest, planDigest: sha256(canonicalJson(withoutDigest)) };
}
