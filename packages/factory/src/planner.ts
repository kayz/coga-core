import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  impact,
  validate,
  type ExactReference,
  type ImpactResult,
  type LoadedCogaInstance,
} from "@coga/core";
import { verifyAgentProposalReceipt } from "./proposal.js";
import { loadApplicationFactory } from "./schema.js";
import type {
  ApplicationFactoryDefinition,
  ExecutionPlanStep,
  FanOutExecutionPlan,
  PlannedTarget,
  TargetExecutionPlan,
  WorkOrder,
  WorkOrderTarget,
} from "./types.js";
import {
  canonicalJson,
  compareText,
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
  if (!value || typeof value !== "object" || !("metadata" in value)) {
    return undefined;
  }
  const candidate = value.metadata;
  return candidate && typeof candidate === "object"
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function artifactType(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("spec" in value)) {
    return undefined;
  }
  const spec = value.spec;
  if (!spec || typeof spec !== "object" || !("artifactType" in spec)) {
    return undefined;
  }
  return typeof spec.artifactType === "string" ? spec.artifactType : undefined;
}

function contractPaths(document: unknown): string[] {
  if (!document || typeof document !== "object" || !("spec" in document)) {
    return [];
  }
  const spec = document.spec;
  if (!spec || typeof spec !== "object" || !("contracts" in spec)) return [];
  const contracts = spec.contracts;
  if (!Array.isArray(contracts)) return [];
  return contracts.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("path" in entry)) return [];
    const path = entry.path;
    return typeof path === "string" ? [path] : [];
  });
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
    if (!required.has(key)) {
      throw new Error(`Approval references non-required policy '${key}'.`);
    }
    if (seen.has(key)) {
      throw new Error(`Work Order contains duplicate approval for '${key}'.`);
    }
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

function sourceFiles(workspace: string, sourceRoot: string): string[] {
  const normalizedRoot = normalizeRelativePath(
    sourceRoot,
    "Application sourceRoot",
  );
  const output = execFileSync(
    "git",
    [
      "-C",
      workspace,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      normalizedRoot,
    ],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    },
  );
  const result = output
    .split("\0")
    .filter(Boolean)
    .map((entry) => normalizeRelativePath(entry, "Application source file"))
    .sort(compareText);
  if (result.length === 0) {
    throw new Error(
      `Application sourceRoot '${normalizedRoot}' has no versionable files.`,
    );
  }
  if (result.length > 10_000) {
    throw new Error("Application source closure exceeds 10,000 files.");
  }
  for (const current of result) {
    if (
      current !== normalizedRoot &&
      !current.startsWith(`${normalizedRoot}/`)
    ) {
      throw new Error(
        `Application source file '${current}' escaped sourceRoot '${normalizedRoot}'.`,
      );
    }
    const absolute = resolveWithin(
      workspace,
      current,
      "Application source closure",
    );
    const info = lstatSync(absolute);
    if (info.isSymbolicLink()) {
      throw new Error(`Application source closure contains link '${current}'.`);
    }
    if (!info.isFile()) {
      throw new Error(
        `Application source closure contains special file '${current}'.`,
      );
    }
  }
  return result;
}

function contextClosure(
  workspace: string,
  loaded: LoadedCogaInstance,
  workOrder: WorkOrder,
  definitionPath: string,
  definition: ApplicationFactoryDefinition,
  promptPath: string,
): string[] {
  const resources = [
    loaded.instance,
    ...loaded.packages,
    ...loaded.artifacts,
    ...loaded.applications,
  ];
  const paths = new Set<string>([
    ...resources.map((entry) => repositoryPath(workspace, entry.path)),
    ...resources.flatMap((entry) =>
      contractPaths(entry.document).map((path) =>
        repositoryPath(workspace, resolve(dirname(entry.path), path)),
      ),
    ),
    workOrder.spec.change.patch.path,
    definitionPath,
    promptPath,
    ...sourceFiles(workspace, definition.spec.sourceRoot),
  ]);
  return [...paths]
    .map((entry) => normalizeRelativePath(entry, "proposal context path"))
    .sort(compareText);
}

function assertInputClosure(
  receiptPaths: readonly string[],
  expectedPaths: readonly string[],
  application: ExactReference,
): void {
  const actual = [...receiptPaths].sort(compareText);
  if (canonicalJson(actual) !== canonicalJson(expectedPaths)) {
    const expected = new Set(expectedPaths);
    const received = new Set(actual);
    const missing = expectedPaths.filter((entry) => !received.has(entry));
    const extra = actual.filter((entry) => !expected.has(entry));
    throw new Error(
      `Agent Proposal Receipt for '${exactKey(application)}' does not exactly bind the Harness context closure; missing [${missing.join(", ")}], extra [${extra.join(", ")}].`,
    );
  }
}

function targetSteps(target: PlannedTarget): ExecutionPlanStep[] {
  const result: ExecutionPlanStep[] = [
    {
      id: "change.apply",
      kind: "apply-domain-change",
      adapter: "coga.domain.patch/v1",
    },
    {
      id: "proposal.apply",
      kind: "apply-agent-proposal",
      adapter: "coga.agent.proposal/v2",
      application: target.application,
    },
    {
      id: "instance.validate",
      kind: "validate-instance",
      adapter: "coga.core.validate/v1",
    },
  ];
  for (const [
    index,
    adapter,
  ] of target.definition.spec.verification.entries()) {
    result.push({
      id: `${adapter.adapter === "coga.node.test/v1" ? "application.test" : "application.build"}.${index + 1}`,
      kind:
        adapter.adapter === "coga.node.test/v1"
          ? "test-application"
          : "build-application",
      adapter: adapter.adapter,
      application: target.application,
    });
  }
  result.push(
    {
      id: "evidence.create",
      kind: "create-evidence",
      adapter: "coga.evidence.bundle/v2",
      application: target.application,
    },
    {
      id: "delivery.draft-pr",
      kind: "deliver-draft-pr",
      adapter: "github.draft-pr/v2",
      application: target.application,
    },
  );
  return result;
}

function loadTarget(parameters: {
  workspace: string;
  loaded: LoadedCogaInstance;
  workOrder: WorkOrder;
  baseCommit: string;
  impact: ImpactResult;
  target: WorkOrderTarget;
}): PlannedTarget {
  const definitionPath = normalizeRelativePath(
    parameters.target.factoryDefinition,
    "factoryDefinition",
  );
  const definition = loadApplicationFactory(
    resolveWithin(parameters.workspace, definitionPath, "factoryDefinition"),
  );
  if (
    exactKey(definition.spec.application) !==
    exactKey(parameters.target.application)
  ) {
    throw new Error(
      `Factory definition '${definitionPath}' targets '${exactKey(definition.spec.application)}', not '${exactKey(parameters.target.application)}'.`,
    );
  }
  const impacted = parameters.impact.affectedApplications.find(
    (entry) =>
      `${entry.id}@${entry.version}` ===
      exactKey(parameters.target.application),
  );
  if (!impacted || impacted.path !== definition.spec.manifest) {
    throw new Error(
      `Factory definition '${definitionPath}' does not bind the registered Application manifest.`,
    );
  }
  assertDefinitionPaths(parameters.workspace, definition);
  const receiptPath = normalizeRelativePath(
    parameters.target.proposal.receipt.path,
    "proposal receipt path",
  );
  verifyFileReference(
    parameters.workspace,
    parameters.target.proposal.receipt,
    `proposal receipt for ${exactKey(parameters.target.application)}`,
    2 * 1024 * 1024,
  );
  const proposalReceipt = verifyAgentProposalReceipt(
    parameters.workspace,
    receiptPath,
    {
      baseCommit: parameters.baseCommit,
      change: parameters.workOrder.spec.change.artifact,
      application: parameters.target.application,
      allowedPaths: definition.spec.changePaths,
    },
  );
  const expectedInputs = contextClosure(
    parameters.workspace,
    parameters.loaded,
    parameters.workOrder,
    definitionPath,
    definition,
    proposalReceipt.generator.prompt.path,
  );
  assertInputClosure(
    proposalReceipt.subject.inputs.map((entry) => entry.path),
    expectedInputs,
    parameters.target.application,
  );
  return {
    application: parameters.target.application,
    factoryDefinitionPath: definitionPath,
    definition,
    proposalReceiptPath: receiptPath,
    proposalReceipt,
    delivery: parameters.target.delivery,
  };
}

export function createFanOutExecutionPlan(
  workspace: string,
  workOrderPath: string,
  workOrder: WorkOrder,
  baseCommit: string,
): FanOutExecutionPlan {
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
    .sort(compareText);
  const requestedTargets = workOrder.spec.targets
    .map((entry) => exactKey(entry.application))
    .sort(compareText);
  if (new Set(requestedTargets).size !== requestedTargets.length) {
    throw new Error("Work Order contains duplicate target Applications.");
  }
  const branches = workOrder.spec.targets.map((entry) => entry.delivery.branch);
  if (new Set(branches).size !== branches.length) {
    throw new Error("Work Order contains duplicate target delivery branches.");
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
  if (!authorized) {
    throw new Error(
      `Domain change does not authorize its Artifact file '${artifactPath}'.`,
    );
  }

  verifyFileReference(
    workspace,
    workOrder.spec.change.patch,
    "domain change patch",
  );
  assertGovernance(validated.loaded, workOrder, workspace);

  const targets: PlannedTarget[] = [];
  const planningFailures: FanOutExecutionPlan["planningFailures"] = [];
  for (const target of workOrder.spec.targets) {
    try {
      targets.push(
        loadTarget({
          workspace,
          loaded: validated.loaded,
          workOrder,
          baseCommit,
          impact: result,
          target,
        }),
      );
    } catch (error) {
      planningFailures.push({
        status: "failed",
        application: target.application,
        branch: target.delivery.branch,
        failure: `Target planning failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  targets.sort((left, right) =>
    compareText(exactKey(left.application), exactKey(right.application)),
  );
  planningFailures.sort((left, right) =>
    compareText(exactKey(left.application), exactKey(right.application)),
  );

  const workOrderDigest = sha256(canonicalJson(workOrder));
  const workOrderRepositoryPath = repositoryPath(workspace, workOrderPath);
  const withoutDigest = {
    schemaVersion: workOrder.schemaVersion,
    kind: "FanOutExecutionPlan" as const,
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
    planningFailures,
  };
  return { ...withoutDigest, planDigest: sha256(canonicalJson(withoutDigest)) };
}

export function createTargetExecutionPlan(
  plan: FanOutExecutionPlan,
  target: PlannedTarget,
): TargetExecutionPlan {
  const withoutDigest = {
    schemaVersion: plan.schemaVersion,
    kind: "TargetExecutionPlan" as const,
    workOrder: plan.workOrder,
    baseCommit: plan.baseCommit,
    instanceManifest: plan.instanceManifest,
    change: plan.change,
    impact: plan.impact,
    target,
    steps: targetSteps(target),
  };
  return { ...withoutDigest, planDigest: sha256(canonicalJson(withoutDigest)) };
}

export const createExecutionPlan = createFanOutExecutionPlan;
