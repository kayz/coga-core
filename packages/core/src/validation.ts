import { valid as validSemver } from "semver";
import { validateContracts } from "./contract-validator.js";
import {
  exactKey,
  isApplication,
  isCogaInstance,
  isDomainArtifact,
  isHarnessPackage,
  isRecord,
  metadataOf,
} from "./guards.js";
import {
  buildResourceGraph,
  exactReference,
  exactReferences,
  findPackagePath,
  packageClosure,
  type ResourceGraph,
  type ResourceGraphEdge,
  type ResourceGraphNode,
} from "./graph.js";
import { load } from "./loader.js";
import { assertCompatibleOptions } from "./options.js";
import { validateResourceSchema } from "./schema-validator.js";
import type {
  CogaOptions,
  ExactReference,
  Lifecycle,
  LoadedArtifact,
  LoadedCogaInstance,
  LoadedResource,
  ValidationIssue,
  ValidationIssueSeverity,
  ValidationResult,
} from "./types.js";

function createIssue(
  resource: LoadedResource,
  code: string,
  message: string,
  severity: ValidationIssueSeverity = "error",
): ValidationIssue {
  const metadata = metadataOf(resource.document);
  const result: ValidationIssue = {
    severity,
    code,
    message,
    path: resource.path,
  };
  if (metadata) result.resourceId = metadata.id;
  return result;
}

function graphIssue(
  node: ResourceGraphNode,
  code: string,
  message: string,
  severity: ValidationIssueSeverity = "error",
): ValidationIssue | undefined {
  return node.resource
    ? createIssue(node.resource, code, message, severity)
    : undefined;
}

function allResources(loaded: LoadedCogaInstance): LoadedResource[] {
  return [
    loaded.instance,
    ...loaded.packages,
    ...loaded.artifacts,
    ...loaded.applications,
  ];
}

function checkDeclaredIdentity(resource: LoadedResource): ValidationIssue[] {
  if (!resource.declaredRef) return [];
  const metadata = metadataOf(resource.document);
  if (!metadata) return [];
  const issues: ValidationIssue[] = [];
  if (metadata.id !== resource.declaredRef.id) {
    issues.push(
      createIssue(
        resource,
        "reference.identity-mismatch",
        `Reference declares ID '${resource.declaredRef.id}', but the loaded resource is '${metadata.id}'.`,
      ),
    );
  }
  if (metadata.version !== resource.declaredRef.version) {
    issues.push(
      createIssue(
        resource,
        "reference.version-mismatch",
        `Reference declares version '${resource.declaredRef.version}', but the loaded resource is '${metadata.version}'.`,
      ),
    );
  }
  return issues;
}

function checkExactSemver(resource: LoadedResource): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visited = new WeakSet<object>();
  const stack: Array<{ value: unknown; pointer: string; key?: string }> = [
    { value: resource.document, pointer: "" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { value, pointer, key } = current;
    if (
      pointer === "/spec/choices" ||
      pointer === "/spec/governance/extensions" ||
      pointer === "/spec/operations/settings"
    ) {
      continue;
    }
    if (pointer === "/spec/operations" && isRecord(value)) {
      if ("runbooks" in value) {
        stack.push({
          value: value.runbooks,
          pointer: `${pointer}/runbooks`,
          key: "runbooks",
        });
      }
      continue;
    }
    if (key === "version" && typeof value === "string") {
      if (validSemver(value, { loose: false }) === null) {
        issues.push(
          createIssue(
            resource,
            "version.not-exact-semver",
            `Version '${value}' at ${pointer} is not an exact SemVer value.`,
          ),
        );
      }
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: value[index],
          pointer: `${pointer}/${index}`,
          ...(key === undefined ? {} : { key }),
        });
      }
      continue;
    }
    if (isRecord(value)) {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!entry) continue;
        const [childKey, childValue] = entry;
        stack.push({
          value: childValue,
          pointer: `${pointer}/${childKey}`,
          key: childKey,
        });
      }
    }
  }
  return issues;
}

function checkDuplicates(
  resources: LoadedResource[],
  type: string,
): ValidationIssue[] {
  const seen = new Map<string, LoadedResource>();
  const issues: ValidationIssue[] = [];
  for (const resource of resources) {
    const metadata = metadataOf(resource.document);
    if (!metadata) continue;
    const key = exactKey(metadata);
    const previous = seen.get(key);
    if (previous) {
      issues.push(
        createIssue(
          resource,
          "resource.duplicate",
          `Duplicate ${type} '${key}' is also loaded from '${previous.path}'.`,
        ),
      );
    } else {
      seen.set(key, resource);
    }
  }
  return issues;
}

function exactMap(resources: LoadedResource[]): Map<string, LoadedResource> {
  const result = new Map<string, LoadedResource>();
  for (const resource of resources) {
    const metadata = metadataOf(resource.document);
    if (metadata) result.set(exactKey(metadata), resource);
  }
  return result;
}

function checkPackageDependencies(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  const packageMap = exactMap(loaded.packages);
  const issues: ValidationIssue[] = [];
  for (const resource of loaded.packages) {
    if (!isHarnessPackage(resource.document)) continue;
    for (const dependency of exactReferences(
      resource.document.spec.dependencies,
    )) {
      if (!packageMap.has(exactKey(dependency))) {
        issues.push(
          createIssue(
            resource,
            "dependency.dangling-package",
            `Harness dependency '${exactKey(dependency)}' is not registered by this COGA instance.`,
          ),
        );
      }
    }
  }
  return issues;
}

function checkApplicationDependencies(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  const packageMap = exactMap(loaded.packages);
  const issues: ValidationIssue[] = [];
  for (const resource of loaded.applications) {
    if (!isApplication(resource.document)) continue;
    for (const dependency of exactReferences(
      resource.document.spec.harnessDependencies,
    )) {
      if (!packageMap.has(exactKey(dependency))) {
        issues.push(
          createIssue(
            resource,
            "dependency.dangling-application-harness",
            `Application harness dependency '${exactKey(dependency)}' is not registered by this COGA instance.`,
          ),
        );
      }
    }
  }
  return issues;
}

function artifactIndexes(artifacts: LoadedArtifact[]): {
  byExact: Map<string, LoadedArtifact>;
} {
  const byExact = new Map<string, LoadedArtifact>();
  for (const artifact of artifacts) {
    const metadata = metadataOf(artifact.document);
    if (metadata) byExact.set(exactKey(metadata), artifact);
  }
  return { byExact };
}

function checkArtifactReferences(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  const { byExact } = artifactIndexes(loaded.artifacts);
  const issues: ValidationIssue[] = [];

  for (const resource of loaded.artifacts) {
    if (!isDomainArtifact(resource.document)) continue;
    const relations = Array.isArray(resource.document.spec.relations)
      ? resource.document.spec.relations
      : [];
    for (const relation of relations) {
      if (!isRecord(relation)) continue;
      const target = exactReference(relation.target);
      if (target && !byExact.has(exactKey(target))) {
        issues.push(
          createIssue(
            resource,
            "relation.dangling",
            `Artifact relation target '${exactKey(target)}' is not loaded by this instance.`,
          ),
        );
      }
    }

    const validation = Array.isArray(resource.document.spec.validation)
      ? resource.document.spec.validation
      : [];
    for (const record of validation) {
      if (!isRecord(record)) continue;
      if (record.type !== "scenario") continue;
      const reference = exactReference(record.target);
      if (!reference) continue;
      const target = byExact.get(exactKey(reference));
      if (!target) {
        issues.push(
          createIssue(
            resource,
            "validation.dangling-scenario",
            `Scenario validation target '${exactKey(reference)}' is not loaded by this instance.`,
          ),
        );
      } else if (
        !isDomainArtifact(target.document) ||
        target.document.spec.artifactType !== "scenario"
      ) {
        issues.push(
          createIssue(
            resource,
            "validation.target-not-scenario",
            `Validation target '${exactKey(reference)}' exists but is not a scenario artifact.`,
          ),
        );
      }
    }
  }
  return issues;
}

function checkApplicationArtifactBindings(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  const { byExact } = artifactIndexes(loaded.artifacts);
  const issues: ValidationIssue[] = [];
  for (const resource of loaded.applications) {
    if (!isApplication(resource.document)) continue;
    const operations = resource.document.spec.operations;
    const bindings: Array<{
      field: "scenarios" | "operations.runbooks";
      expectedType: "scenario" | "runbook";
      references: ExactReference[];
    }> = [
      {
        field: "scenarios",
        expectedType: "scenario",
        references: exactReferences(resource.document.spec.scenarios),
      },
      {
        field: "operations.runbooks",
        expectedType: "runbook",
        references: exactReferences(
          isRecord(operations) ? operations.runbooks : undefined,
        ),
      },
    ];
    for (const binding of bindings) {
      for (const reference of binding.references) {
        const target = byExact.get(exactKey(reference));
        if (!target) {
          issues.push(
            createIssue(
              resource,
              "dependency.dangling-application-artifact",
              `Application ${binding.field} reference '${exactKey(reference)}' is not loaded by this instance.`,
            ),
          );
          continue;
        }
        if (
          !isDomainArtifact(target.document) ||
          target.document.spec.artifactType !== binding.expectedType
        ) {
          issues.push(
            createIssue(
              resource,
              "dependency.application-artifact-type",
              `Application ${binding.field} reference '${exactKey(reference)}' must target a ${binding.expectedType} artifact.`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

function checkValidationEvidence(resource: LoadedArtifact): ValidationIssue[] {
  if (!isDomainArtifact(resource.document)) return [];
  const issues: ValidationIssue[] = [];
  const records = Array.isArray(resource.document.spec.validation)
    ? resource.document.spec.validation
    : [];
  for (const [index, record] of records.entries()) {
    if (!isRecord(record)) continue;
    const hasEvidence =
      Array.isArray(record.evidence) &&
      record.evidence.length > 0 &&
      record.evidence.every(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      );
    const hasCompletedFields =
      typeof record.checkedAt === "string" &&
      record.checkedAt.trim().length > 0 &&
      typeof record.validator === "string" &&
      record.validator.trim().length > 0 &&
      hasEvidence;
    if (record.status !== "pending" && !hasCompletedFields) {
      issues.push(
        createIssue(
          resource,
          "validation.completed-evidence-required",
          `Completed validation record at /spec/validation/${index} requires checkedAt, validator, and non-empty evidence.`,
        ),
      );
    }
    if (
      record.status === "pending" &&
      (record.checkedAt !== undefined ||
        record.validator !== undefined ||
        record.evidence !== undefined)
    ) {
      issues.push(
        createIssue(
          resource,
          "validation.pending-evidence-forbidden",
          `Pending validation record at /spec/validation/${index} cannot carry completion evidence.`,
        ),
      );
    }
  }
  return issues;
}

function checkArtifactLifecycle(loaded: LoadedCogaInstance): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const resource of loaded.artifacts) {
    if (!isDomainArtifact(resource.document)) continue;
    const artifact = resource.document;
    const provenance = Array.isArray(artifact.spec.provenance)
      ? artifact.spec.provenance
      : [];
    const validation = Array.isArray(artifact.spec.validation)
      ? artifact.spec.validation
      : [];
    const contractRefs = Array.isArray(artifact.spec.contractRefs)
      ? artifact.spec.contractRefs
      : [];
    if (
      artifact.spec.artifactType === "capability" &&
      contractRefs.length === 0
    ) {
      issues.push(
        createIssue(
          resource,
          "capability.contract-required",
          "Capability artifacts must declare at least one contractRef.",
        ),
      );
    }
    if (artifact.metadata.lifecycle !== "published") continue;
    if (provenance.length === 0) {
      issues.push(
        createIssue(
          resource,
          "publication.provenance-required",
          "Published artifacts must include at least one provenance record.",
        ),
      );
    }
    if (
      validation.length === 0 ||
      !validation.some(
        (record) => isRecord(record) && record.status === "passed",
      )
    ) {
      issues.push(
        createIssue(
          resource,
          "publication.validation-required",
          "Published artifacts must include at least one passed validation record.",
        ),
      );
    }
    if (
      validation.some(
        (record) => isRecord(record) && record.status === "failed",
      )
    ) {
      issues.push(
        createIssue(
          resource,
          "publication.failed-validation",
          "Published artifacts cannot retain a failed validation record.",
        ),
      );
    }
    if (
      artifact.spec.artifactType === "rule" &&
      !validation.some(
        (record) =>
          isRecord(record) &&
          record.type === "scenario" &&
          record.status === "passed" &&
          exactReference(record.target) !== undefined,
      )
    ) {
      issues.push(
        createIssue(
          resource,
          "publication.rule-scenario-required",
          "Published rule artifacts must include a passed scenario validation with an exact target.",
        ),
      );
    }
  }
  return issues;
}

function checkPackageCycles(graph: ResourceGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const edge of graph.edges.filter(
    (entry) => entry.kind === "package-dependency",
  )) {
    if (!findPackagePath(graph, edge.to, edge.from)) continue;
    const source = graph.nodes.get(edge.from);
    const target = graph.nodes.get(edge.to);
    if (!source || !target) continue;
    const issue = graphIssue(
      source,
      "dependency.package-cycle",
      `Package dependency at ${edge.pointer} from '${source.id}@${source.version}' to '${target.id}@${target.version}' participates in a cycle.`,
    );
    if (issue) issues.push(issue);
  }
  return issues;
}

function checkArtifactRelationReachability(
  graph: ResourceGraph,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const edge of graph.edges.filter(
    (entry) => entry.kind === "artifact-relation",
  )) {
    const sourceOwner = graph.artifactOwners.get(edge.from);
    const targetOwner = graph.artifactOwners.get(edge.to);
    if (
      !sourceOwner ||
      !targetOwner ||
      sourceOwner === targetOwner ||
      findPackagePath(graph, sourceOwner, targetOwner)
    ) {
      continue;
    }
    const source = graph.nodes.get(edge.from);
    const target = graph.nodes.get(edge.to);
    if (!source || !target) continue;
    const issue = graphIssue(
      source,
      "dependency.artifact-relation-unreachable",
      `Artifact relation at ${edge.pointer} targets '${target.id}@${target.version}' outside the source package dependency closure.`,
    );
    if (issue) issues.push(issue);
  }
  return issues;
}

function checkApplicationArtifactReachability(
  graph: ResourceGraph,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const application of [...graph.nodes.values()]
    .filter((node) => node.kind === "application")
    .sort((left, right) => left.key.localeCompare(right.key))) {
    const roots = (graph.outgoing.get(application.key) ?? [])
      .filter((edge) => edge.kind === "application-package")
      .map((edge) => edge.to);
    const reachable = packageClosure(graph, roots);
    for (const edge of graph.outgoing.get(application.key) ?? []) {
      if (
        edge.kind !== "application-scenario" &&
        edge.kind !== "application-runbook"
      ) {
        continue;
      }
      const owner = graph.artifactOwners.get(edge.to);
      if (!owner || reachable.has(owner)) continue;
      const target = graph.nodes.get(edge.to);
      if (!target) continue;
      const issue = graphIssue(
        application,
        "dependency.application-artifact-unreachable",
        `Application binding at ${edge.pointer} targets '${target.id}@${target.version}' outside its Harness dependency closure.`,
      );
      if (issue) issues.push(issue);
    }
  }
  return issues;
}

function checkGovernancePolicies(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  if (!isCogaInstance(loaded.instance.document)) return [];
  const artifacts = exactMap(loaded.artifacts);
  const issues: ValidationIssue[] = [];
  const check = (source: LoadedResource, policy: ExactReference): void => {
    const target = artifacts.get(exactKey(policy));
    if (!target) {
      issues.push(
        createIssue(
          source,
          "governance.policy-dangling",
          `Approval policy '${exactKey(policy)}' is not loaded by this instance.`,
        ),
      );
    } else if (
      !isDomainArtifact(target.document) ||
      target.document.spec.artifactType !== "policy"
    ) {
      issues.push(
        createIssue(
          source,
          "governance.policy-type",
          `Approval policy '${exactKey(policy)}' must target a policy artifact.`,
        ),
      );
    }
  };
  const governance = loaded.instance.document.spec.governance;
  const rules =
    isRecord(governance) && Array.isArray(governance.approvalRules)
      ? governance.approvalRules
      : [];
  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    for (const policy of exactReferences(rule.policies)) {
      check(loaded.instance, policy);
    }
  }
  for (const resource of allResources(loaded)) {
    const metadata = metadataOf(resource.document);
    const attestations =
      metadata && Array.isArray(metadata.attestations)
        ? metadata.attestations
        : [];
    for (const attestation of attestations) {
      if (!isRecord(attestation)) continue;
      const policy = exactReference(attestation.policy);
      if (policy) check(resource, policy);
    }
  }
  return issues;
}

function checkScopes(loaded: LoadedCogaInstance): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const check = (
    resource: LoadedResource,
    allowed: readonly string[],
    description: string,
  ): void => {
    const metadata = metadataOf(resource.document);
    if (metadata && !allowed.includes(metadata.scope)) {
      issues.push(
        createIssue(
          resource,
          "scope.invalid-for-kind",
          `${description} scope at /metadata/scope must be ${allowed.map((entry) => `'${entry}'`).join(" or ")}; received '${metadata.scope}'.`,
        ),
      );
    }
  };
  check(loaded.instance, ["instance"], "CogaInstance");
  for (const resource of loaded.packages) {
    check(resource, ["core", "instance"], "HarnessPackage");
  }
  for (const resource of loaded.applications) {
    check(resource, ["application"], "Application");
  }
  const packages = exactMap(loaded.packages);
  for (const artifact of loaded.artifacts) {
    const artifactMetadata = metadataOf(artifact.document);
    const owner = artifact.ownerPackage
      ? packages.get(exactKey(artifact.ownerPackage))
      : undefined;
    const ownerMetadata = metadataOf(owner?.document);
    if (
      artifactMetadata &&
      ownerMetadata &&
      artifactMetadata.scope !== ownerMetadata.scope
    ) {
      issues.push(
        createIssue(
          artifact,
          "scope.invalid-for-kind",
          `DomainArtifact scope at /metadata/scope ('${artifactMetadata.scope}') must match owner package scope '${ownerMetadata.scope}'.`,
        ),
      );
    }
  }
  return issues;
}

const lifecycleRank: Record<Lifecycle, number> = {
  draft: 0,
  candidate: 1,
  approved: 2,
  published: 3,
  deprecated: 3,
};

const lifecycleEdges = new Set<ResourceGraphEdge["kind"]>([
  "instance-package",
  "instance-application",
  "package-dependency",
  "application-package",
  "application-scenario",
  "application-runbook",
  "artifact-relation",
  "artifact-validation",
  "governance-policy",
]);

function checkLifecycleClosure(graph: ResourceGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const packageArtifact = edge.kind === "package-artifact";
    if (!packageArtifact && !lifecycleEdges.has(edge.kind)) continue;
    const source = graph.nodes.get(edge.from);
    const target = graph.nodes.get(edge.to);
    if (!source?.lifecycle || !target?.lifecycle) continue;
    const pair = `${source.key}->${target.key}`;
    if (target.lifecycle === "deprecated") {
      const warningKey = `warning:${pair}`;
      if (!seen.has(warningKey)) {
        seen.add(warningKey);
        const issue = graphIssue(
          source,
          "lifecycle.deprecated-dependency",
          `Reference at ${edge.pointer} depends on deprecated '${target.id}@${target.version}'.`,
          "warning",
        );
        if (issue) issues.push(issue);
      }
      continue;
    }
    if (packageArtifact) {
      if (
        source.lifecycle !== "published" ||
        lifecycleRank[target.lifecycle] >= lifecycleRank.approved
      ) {
        continue;
      }
      const errorKey = `package-artifact:${pair}`;
      if (seen.has(errorKey)) continue;
      seen.add(errorKey);
      const issue = graphIssue(
        source,
        "lifecycle.dependency-too-early",
        `Published package '${source.id}@${source.version}' contains ${target.lifecycle} artifact '${target.id}@${target.version}' at ${edge.pointer}; artifacts must be approved or more mature.`,
      );
      if (issue) issues.push(issue);
      continue;
    }
    if (lifecycleRank[source.lifecycle] <= lifecycleRank[target.lifecycle]) {
      continue;
    }
    const errorKey = `error:${pair}`;
    if (seen.has(errorKey)) continue;
    seen.add(errorKey);
    const issue = graphIssue(
      source,
      "lifecycle.dependency-too-early",
      `${source.lifecycle} resource '${source.id}@${source.version}' references less mature ${target.lifecycle} resource '${target.id}@${target.version}' at ${edge.pointer}.`,
    );
    if (issue) issues.push(issue);
  }
  return issues;
}

function checkVisibilityClosure(
  loaded: LoadedCogaInstance,
  graph: ResourceGraph,
): ValidationIssue[] {
  if (loaded.context.profile === "local") return [];
  const issues: ValidationIssue[] = [];
  for (const resource of allResources(loaded)) {
    const metadata = metadataOf(resource.document);
    if (metadata && metadata.visibility !== "public") {
      issues.push(
        createIssue(
          resource,
          "visibility.profile-requires-public",
          `${loaded.context.profile} profile requires every canonical resource to declare public visibility.`,
        ),
      );
    }
  }

  const seen = new Set<string>();
  const starts = [...graph.nodes.values()]
    .filter((node) => node.resource && node.visibility === "public")
    .sort((left, right) => left.key.localeCompare(right.key));
  for (const start of starts) {
    const visited = new Set<string>([start.key]);
    const queue = [start.key];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!current) continue;
      for (const edge of graph.outgoing.get(current) ?? []) {
        const target = graph.nodes.get(edge.to);
        if (!target?.resource || visited.has(target.key)) continue;
        visited.add(target.key);
        queue.push(target.key);
        if (target.visibility === "public") continue;
        const pair = `${start.key}->${target.key}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const issue = graphIssue(
          start,
          "visibility.public-to-non-public",
          `Public resource transitively references non-public loaded resource '${target.id}@${target.version}'.`,
        );
        if (issue) issues.push(issue);
      }
    }
  }
  return issues;
}

function checkReleaseApprovals(loaded: LoadedCogaInstance): ValidationIssue[] {
  if (
    loaded.context.profile !== "release" ||
    !isCogaInstance(loaded.instance.document)
  ) {
    return [];
  }
  const issues: ValidationIssue[] = [];
  const governance = loaded.instance.document.spec.governance;
  const rules =
    isRecord(governance) && Array.isArray(governance.approvalRules)
      ? governance.approvalRules.filter(isRecord)
      : [];
  const releaseEvidence =
    isRecord(governance) && Array.isArray(governance.releaseEvidence)
      ? governance.releaseEvidence.filter(isRecord)
      : [];
  for (const rule of rules) {
    if (typeof rule.lifecycle !== "string") continue;
    const evidenceRule = releaseEvidence.find(
      (candidate) => candidate.lifecycle === rule.lifecycle,
    );
    const evidence =
      evidenceRule && Array.isArray(evidenceRule.evidence)
        ? evidenceRule.evidence
        : [];
    if (
      !evidenceRule ||
      evidence.length === 0 ||
      evidence.some(
        (entry) => typeof entry !== "string" || entry.trim().length === 0,
      )
    ) {
      issues.push(
        createIssue(
          loaded.instance,
          "governance.release-evidence-required",
          `Release profile requires non-empty release evidence for controlled lifecycle '${rule.lifecycle}'.`,
        ),
      );
    }
  }
  for (const resource of allResources(loaded)) {
    const metadata = metadataOf(resource.document);
    if (!metadata) continue;
    const attestations = Array.isArray(metadata.attestations)
      ? metadata.attestations
      : [];
    for (const rule of rules) {
      if (rule.lifecycle !== metadata.lifecycle) continue;
      for (const policy of exactReferences(rule.policies)) {
        const approved = attestations.some((attestation) => {
          if (!isRecord(attestation)) return false;
          const attestedPolicy = exactReference(attestation.policy);
          const evidence = Array.isArray(attestation.evidence)
            ? attestation.evidence
            : [];
          return (
            attestation.type === "approval" &&
            attestedPolicy !== undefined &&
            exactKey(attestedPolicy) === exactKey(policy) &&
            typeof attestation.approver === "string" &&
            attestation.approver.trim().length > 0 &&
            typeof attestation.approvedAt === "string" &&
            attestation.approvedAt.trim().length > 0 &&
            evidence.length > 0 &&
            evidence.every(
              (entry) => typeof entry === "string" && entry.trim().length > 0,
            )
          );
        });
        if (!approved) {
          issues.push(
            createIssue(
              resource,
              "governance.approval-required",
              `${metadata.lifecycle} resource requires approval attestation for policy '${exactKey(policy)}'.`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

function isSecretReference(value: string): boolean {
  return (
    /^(?:env|vault|secret|keychain):\/\//i.test(value) ||
    /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value) ||
    /^\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}$/i.test(value)
  );
}

const sensitiveSingleTerms = new Set<string>([
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "credential",
  "credentials",
]);

const sensitiveCompoundTerms = new Set<string>([
  "apikey",
  "privatekey",
  "accesskey",
  "clientsecret",
]);

function isSensitiveKey(key: string): boolean {
  const tokens = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((entry) => entry.length > 0);
  if (tokens.some((entry) => sensitiveSingleTerms.has(entry))) return true;
  if (tokens.length === 1 && sensitiveCompoundTerms.has(tokens[0]!)) {
    return true;
  }
  return tokens.some((entry, index) => {
    const next = tokens[index + 1];
    return next ? sensitiveCompoundTerms.has(`${entry}${next}`) : false;
  });
}

const secretValuePatterns: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  {
    name: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
];

function scanSecrets(resource: LoadedResource): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const visited = new WeakMap<object, number>();
  const stack: Array<{
    value: unknown;
    pointer: string;
    sensitiveContext: boolean;
  }> = [{ value: resource.document, pointer: "", sensitiveContext: false }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { value, pointer, sensitiveContext } = current;
    if (typeof value === "string") {
      if (isSecretReference(value)) continue;
      if (sensitiveContext && value.trim().length > 0) {
        issues.push(
          createIssue(
            resource,
            "secret.literal-sensitive-field",
            `Possible literal secret found at ${pointer}; store only a secret reference in canonical resources.`,
          ),
        );
      }
      for (const detector of secretValuePatterns) {
        if (detector.pattern.test(value)) {
          issues.push(
            createIssue(
              resource,
              "secret.detected",
              `Possible ${detector.name} value found at ${pointer}; secret values are forbidden.`,
            ),
          );
        }
      }
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const contextBit = sensitiveContext ? 2 : 1;
    const seen = visited.get(value) ?? 0;
    if ((seen & contextBit) !== 0) continue;
    visited.set(value, seen | contextBit);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: value[index],
          pointer: `${pointer}/${index}`,
          sensitiveContext,
        });
      }
      continue;
    }
    if (isRecord(value)) {
      const entries = Object.entries(value);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!entry) continue;
        const [key, child] = entry;
        stack.push({
          value: child,
          pointer: `${pointer}/${key}`,
          sensitiveContext: sensitiveContext || isSensitiveKey(key),
        });
      }
    }
  }
  return issues;
}

function checkInstanceKind(loaded: LoadedCogaInstance): ValidationIssue[] {
  if (isCogaInstance(loaded.instance.document)) return [];
  return [
    createIssue(
      loaded.instance,
      "instance.kind-required",
      "The validation entry point must be a CogaInstance manifest.",
    ),
  ];
}

function safeSchemaValidation(resource: LoadedResource): ValidationIssue[] {
  try {
    return validateResourceSchema(resource);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      createIssue(
        resource,
        "load.unsafe-object-graph",
        `Resource schema validation could not safely traverse the object graph: ${detail}`,
      ),
    ];
  }
}

function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.code.localeCompare(right.code) ||
      left.message.localeCompare(right.message) ||
      left.severity.localeCompare(right.severity),
  );
}

/** Validate schema, contracts, exact graph closure, governance, and secrets. */
export function validate(
  input: string | LoadedCogaInstance,
  options?: CogaOptions,
): ValidationResult {
  if (typeof input !== "string") assertCompatibleOptions(input, options);
  const loaded = typeof input === "string" ? load(input, options) : input;
  const resources = allResources(loaded);
  const graph = buildResourceGraph(loaded);
  const issues = sortIssues([
    ...loaded.loadIssues,
    ...checkInstanceKind(loaded),
    ...resources.flatMap(safeSchemaValidation),
    ...resources.flatMap(checkDeclaredIdentity),
    ...resources.flatMap(checkExactSemver),
    ...validateContracts(loaded),
    ...checkDuplicates(loaded.packages, "harness package"),
    ...checkDuplicates(loaded.artifacts, "domain artifact"),
    ...checkDuplicates(loaded.applications, "application"),
    ...checkPackageDependencies(loaded),
    ...checkApplicationDependencies(loaded),
    ...checkArtifactReferences(loaded),
    ...checkApplicationArtifactBindings(loaded),
    ...checkPackageCycles(graph),
    ...checkArtifactRelationReachability(graph),
    ...checkApplicationArtifactReachability(graph),
    ...checkGovernancePolicies(loaded),
    ...checkScopes(loaded),
    ...checkLifecycleClosure(graph),
    ...loaded.artifacts.flatMap(checkValidationEvidence),
    ...checkArtifactLifecycle(loaded),
    ...checkVisibilityClosure(loaded, graph),
    ...checkReleaseApprovals(loaded),
    ...resources.flatMap(scanSecrets),
  ]);
  return {
    valid: !issues.some((entry) => entry.severity === "error"),
    issues,
    loaded,
  };
}

export const validateInstance = validate;
