import { valid as validSemver } from "semver";
import {
  exactKey,
  isApplication,
  isCogaInstance,
  isDomainArtifact,
  isHarnessPackage,
  isRecord,
  metadataOf,
} from "./guards.js";
import { load } from "./loader.js";
import { validateResourceSchema } from "./schema-validator.js";
import type {
  CanonicalResource,
  ExactReference,
  LoadedArtifact,
  LoadedCogaInstance,
  LoadedResource,
  LocatedReference,
  ValidationIssue,
  ValidationResult,
  Visibility,
} from "./types.js";

function createIssue(
  resource: LoadedResource,
  code: string,
  message: string,
): ValidationIssue {
  const metadata = metadataOf(resource.document);
  const result: ValidationIssue = {
    severity: "error",
    code,
    message,
    path: resource.path,
  };
  if (metadata) result.resourceId = metadata.id;
  return result;
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
  const visit = (value: unknown, pointer: string, key?: string): void => {
    if (
      pointer === "/spec/choices" ||
      pointer === "/spec/governance/extensions" ||
      pointer === "/spec/operations/settings"
    ) {
      return;
    }
    if (pointer === "/spec/operations" && isRecord(value)) {
      if ("runbooks" in value) {
        visit(value.runbooks, `${pointer}/runbooks`, "runbooks");
      }
      return;
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
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${pointer}/${index}`));
      return;
    }
    if (isRecord(value)) {
      for (const [childKey, entry] of Object.entries(value)) {
        visit(entry, `${pointer}/${childKey}`, childKey);
      }
    }
  };
  visit(resource.document, "");
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

function exactReferences(value: unknown): ExactReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ExactReference =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      typeof entry.version === "string",
  );
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
  byId: Map<string, LoadedArtifact[]>;
  byExact: Map<string, LoadedArtifact>;
} {
  const byId = new Map<string, LoadedArtifact[]>();
  const byExact = new Map<string, LoadedArtifact>();
  for (const artifact of artifacts) {
    const metadata = metadataOf(artifact.document);
    if (!metadata) continue;
    byExact.set(exactKey(metadata), artifact);
    const versions = byId.get(metadata.id) ?? [];
    versions.push(artifact);
    byId.set(metadata.id, versions);
  }
  return { byId, byExact };
}

function checkArtifactReferences(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  const { byId, byExact } = artifactIndexes(loaded.artifacts);
  const issues: ValidationIssue[] = [];

  for (const resource of loaded.artifacts) {
    if (!isDomainArtifact(resource.document)) continue;
    const relations = Array.isArray(resource.document.spec.relations)
      ? resource.document.spec.relations
      : [];
    for (const relation of relations) {
      const found = relation.version
        ? byExact.has(
            exactKey({ id: relation.target, version: relation.version }),
          )
        : byId.has(relation.target);
      if (!found) {
        const suffix = relation.version ? `@${relation.version}` : "";
        issues.push(
          createIssue(
            resource,
            "relation.dangling",
            `Artifact relation target '${relation.target}${suffix}' is not loaded by this instance.`,
          ),
        );
      }
    }

    const validation = Array.isArray(resource.document.spec.validation)
      ? resource.document.spec.validation
      : [];
    for (const record of validation) {
      if (record.type !== "scenario" || typeof record.target !== "string")
        continue;
      const candidates = byId.get(record.target) ?? [];
      if (candidates.length === 0) {
        issues.push(
          createIssue(
            resource,
            "validation.dangling-scenario",
            `Scenario validation target '${record.target}' is not loaded by this instance.`,
          ),
        );
      } else if (
        !candidates.some((candidate) => {
          const document = candidate.document;
          return (
            isDomainArtifact(document) &&
            document.spec.artifactType === "scenario"
          );
        })
      ) {
        issues.push(
          createIssue(
            resource,
            "validation.target-not-scenario",
            `Validation target '${record.target}' exists but is not a scenario artifact.`,
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
    const runbooks = isRecord(operations)
      ? exactReferences(operations.runbooks)
      : [];
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
        references: runbooks,
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
      !validation.some((record) => record.status === "passed")
    ) {
      issues.push(
        createIssue(
          resource,
          "publication.validation-required",
          "Published artifacts must include at least one passed validation record.",
        ),
      );
    }
    if (validation.some((record) => record.status === "failed")) {
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
          record.type === "scenario" &&
          record.status === "passed" &&
          typeof record.target === "string",
      )
    ) {
      issues.push(
        createIssue(
          resource,
          "publication.rule-scenario-required",
          "Published rule artifacts must include a passed scenario validation with a target.",
        ),
      );
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

const sensitiveKey =
  /(?:^|[-_])(password|passwd|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|client[-_]?secret)(?:$|[-_])/i;
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
  const visit = (value: unknown, pointer: string, parentKey?: string): void => {
    if (typeof value === "string") {
      if (isSecretReference(value)) return;
      if (
        parentKey &&
        sensitiveKey.test(parentKey) &&
        value.trim().length > 0
      ) {
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
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, `${pointer}/${index}`, parentKey),
      );
      return;
    }
    if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, `${pointer}/${key}`, key);
      }
    }
  };
  visit(resource.document, "");
  return issues;
}

function visibilityOf(
  resource: LoadedResource | undefined,
): Visibility | undefined {
  return metadataOf(resource?.document)?.visibility;
}

function publicBoundaryIssue(
  source: LoadedResource,
  target: LoadedResource,
  reference: string,
): ValidationIssue | undefined {
  if (visibilityOf(source) !== "public" || visibilityOf(target) === "public")
    return undefined;
  return createIssue(
    source,
    "visibility.public-to-non-public",
    `Public resource directly references non-public loaded resource '${reference}'.`,
  );
}

function checkVisibilityBoundary(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const packageMap = exactMap(loaded.packages);
  const applicationMap = exactMap(loaded.applications);
  const { byId: artifactsById, byExact: artifactsByExact } = artifactIndexes(
    loaded.artifacts,
  );

  if (isCogaInstance(loaded.instance.document)) {
    const locatedGroups = [
      { refs: loaded.instance.document.spec.packages, targets: packageMap },
      {
        refs: loaded.instance.document.spec.applications,
        targets: applicationMap,
      },
    ];
    for (const group of locatedGroups) {
      for (const reference of exactReferences(group.refs)) {
        const target = group.targets.get(exactKey(reference));
        if (!target) continue;
        const result = publicBoundaryIssue(
          loaded.instance,
          target,
          exactKey(reference),
        );
        if (result) issues.push(result);
      }
    }
  }

  for (const resource of loaded.packages) {
    if (!isHarnessPackage(resource.document)) continue;
    for (const dependency of exactReferences(
      resource.document.spec.dependencies,
    )) {
      const target = packageMap.get(exactKey(dependency));
      if (!target) continue;
      const result = publicBoundaryIssue(
        resource,
        target,
        exactKey(dependency),
      );
      if (result) issues.push(result);
    }
    for (const reference of exactReferences(resource.document.spec.artifacts)) {
      const target = artifactsByExact.get(exactKey(reference));
      if (!target) continue;
      const result = publicBoundaryIssue(resource, target, exactKey(reference));
      if (result) issues.push(result);
    }
  }

  for (const resource of loaded.artifacts) {
    if (!isDomainArtifact(resource.document)) continue;
    for (const relation of resource.document.spec.relations ?? []) {
      const targets = relation.version
        ? [
            artifactsByExact.get(
              exactKey({ id: relation.target, version: relation.version }),
            ),
          ].filter((entry): entry is LoadedArtifact => entry !== undefined)
        : (artifactsById.get(relation.target) ?? []);
      for (const target of targets) {
        const result = publicBoundaryIssue(resource, target, relation.target);
        if (result) issues.push(result);
      }
    }
    for (const record of resource.document.spec.validation ?? []) {
      if (!record.target) continue;
      for (const target of artifactsById.get(record.target) ?? []) {
        const result = publicBoundaryIssue(resource, target, record.target);
        if (result) issues.push(result);
      }
    }
  }

  for (const resource of loaded.applications) {
    if (!isApplication(resource.document)) continue;
    for (const dependency of exactReferences(
      resource.document.spec.harnessDependencies,
    )) {
      const target = packageMap.get(exactKey(dependency));
      if (!target) continue;
      const result = publicBoundaryIssue(
        resource,
        target,
        exactKey(dependency),
      );
      if (result) issues.push(result);
    }
    const operations = resource.document.spec.operations;
    const runbooks = isRecord(operations)
      ? exactReferences(operations.runbooks)
      : [];
    for (const reference of [
      ...exactReferences(resource.document.spec.scenarios),
      ...runbooks,
    ]) {
      const target = artifactsByExact.get(exactKey(reference));
      if (!target) continue;
      const result = publicBoundaryIssue(resource, target, exactKey(reference));
      if (result) issues.push(result);
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

/** Validate schema, identity, cross-reference, lifecycle, publication, and secret constraints. */
export function validate(input: string | LoadedCogaInstance): ValidationResult {
  const loaded = typeof input === "string" ? load(input) : input;
  const resources = allResources(loaded);
  const issues: ValidationIssue[] = [
    ...loaded.loadIssues,
    ...checkInstanceKind(loaded),
    ...resources.flatMap(validateResourceSchema),
    ...resources.flatMap(checkDeclaredIdentity),
    ...resources.flatMap(checkExactSemver),
    ...checkDuplicates(loaded.packages, "harness package"),
    ...checkDuplicates(loaded.artifacts, "domain artifact"),
    ...checkDuplicates(loaded.applications, "application"),
    ...checkPackageDependencies(loaded),
    ...checkApplicationDependencies(loaded),
    ...checkArtifactReferences(loaded),
    ...checkApplicationArtifactBindings(loaded),
    ...checkArtifactLifecycle(loaded),
    ...checkVisibilityBoundary(loaded),
    ...resources.flatMap(scanSecrets),
  ];

  return {
    valid: !issues.some((entry) => entry.severity === "error"),
    issues,
    loaded,
  };
}

export const validateInstance = validate;
