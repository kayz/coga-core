import {
  exactKey,
  isApplication,
  isDomainArtifact,
  isHarnessPackage,
  isRecord,
  metadataOf,
} from "../guards.js";
import type { ExactReference, LoadedCogaInstance } from "../types.js";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRefs(references: ExactReference[]): ExactReference[] {
  return [...references].sort((left, right) =>
    compareText(exactKey(left), exactKey(right)),
  );
}

export interface PackageClosure {
  target: ExactReference;
  order: ExactReference[];
}

/** Resolve dependencies before dependents and report the exact cycle path. */
export function resolvePackageClosure(
  loaded: LoadedCogaInstance,
  target: ExactReference,
): PackageClosure {
  const packages = new Map<string, (typeof loaded.packages)[number]>();
  for (const resource of loaded.packages) {
    const metadata = metadataOf(resource.document);
    if (metadata && isHarnessPackage(resource.document)) {
      const key = exactKey(metadata);
      if (packages.has(key)) throw new Error(`Duplicate package '${key}'.`);
      packages.set(key, resource);
    }
  }
  if (!packages.has(exactKey(target)))
    throw new Error(`Unknown package '${exactKey(target)}'.`);
  const visiting: string[] = [];
  const visited = new Set<string>();
  const order: ExactReference[] = [];
  const visit = (reference: ExactReference): void => {
    const key = exactKey(reference);
    const cycleAt = visiting.indexOf(key);
    if (cycleAt >= 0)
      throw new Error(
        `Package dependency cycle: ${[...visiting.slice(cycleAt), key].join(" -> ")}`,
      );
    if (visited.has(key)) return;
    const resource = packages.get(key);
    if (!resource || !isHarnessPackage(resource.document))
      throw new Error(`Dangling package dependency '${key}'.`);
    visiting.push(key);
    for (const dependency of sortedRefs(resource.document.spec.dependencies))
      visit(dependency);
    visiting.pop();
    visited.add(key);
    order.push({
      id: resource.document.metadata.id,
      version: resource.document.metadata.version,
    });
  };
  visit(target);
  return { target: { ...target }, order };
}

export interface ImpactReason {
  application: ExactReference;
  path: string[];
}

export interface TransitiveImpactResult {
  artifactId: string;
  found: boolean;
  affectedPackages: ExactReference[];
  affectedApplications: ExactReference[];
  reasons: ImpactReason[];
  rerun: { scenarios: ExactReference[]; runbooks: ExactReference[] };
}

/** Reverse package dependencies to explain the complete application blast radius. */
export function impactWithReasons(
  loaded: LoadedCogaInstance,
  artifactId: string,
): TransitiveImpactResult {
  const packageResources = new Map<string, (typeof loaded.packages)[number]>();
  for (const resource of loaded.packages) {
    const metadata = metadataOf(resource.document);
    if (metadata && isHarnessPackage(resource.document)) {
      const key = exactKey(metadata);
      if (packageResources.has(key))
        throw new Error(`Duplicate package '${key}'.`);
      packageResources.set(key, resource);
    }
  }
  const owners = new Set<string>();
  for (const artifact of loaded.artifacts) {
    if (
      isDomainArtifact(artifact.document) &&
      artifact.document.metadata.id === artifactId &&
      artifact.ownerPackage
    )
      owners.add(exactKey(artifact.ownerPackage));
  }
  const reverse = new Map<string, string[]>();
  for (const [packageKey, resource] of packageResources) {
    if (!isHarnessPackage(resource.document)) continue;
    for (const dependency of resource.document.spec.dependencies) {
      const key = exactKey(dependency);
      reverse.set(
        key,
        [...(reverse.get(key) ?? []), packageKey].sort(compareText),
      );
    }
  }
  const packagePaths = new Map<string, string[]>();
  const queue = [...owners]
    .sort()
    .map((key) => ({ key, path: [artifactId, key] }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (packagePaths.has(current.key)) continue;
    packagePaths.set(current.key, current.path);
    for (const dependent of reverse.get(current.key) ?? [])
      queue.push({ key: dependent, path: [...current.path, dependent] });
  }
  const applications: ExactReference[] = [];
  const reasons: ImpactReason[] = [];
  const scenarios = new Map<string, ExactReference>();
  const runbooks = new Map<string, ExactReference>();
  for (const resource of loaded.applications) {
    if (!isApplication(resource.document)) continue;
    const dependencies = sortedRefs(
      resource.document.spec.harnessDependencies,
    ).filter((entry) => packagePaths.has(exactKey(entry)));
    if (dependencies.length === 0) continue;
    const application = {
      id: resource.document.metadata.id,
      version: resource.document.metadata.version,
    };
    applications.push(application);
    for (const dependency of dependencies)
      reasons.push({
        application,
        path: [
          ...packagePaths.get(exactKey(dependency))!,
          exactKey(application),
        ],
      });
    for (const scenario of resource.document.spec.scenarios)
      scenarios.set(exactKey(scenario), scenario);
    const operations = resource.document.spec.operations;
    if (isRecord(operations) && Array.isArray(operations.runbooks)) {
      for (const runbook of operations.runbooks as ExactReference[])
        runbooks.set(exactKey(runbook), runbook);
    }
  }
  const affectedPackages = [...packagePaths.keys()].sort().map((key) => {
    const metadata = metadataOf(packageResources.get(key)?.document);
    if (!metadata) throw new Error(`Affected package '${key}' disappeared.`);
    return { id: metadata.id, version: metadata.version };
  });
  applications.sort((left, right) =>
    compareText(exactKey(left), exactKey(right)),
  );
  reasons.sort(
    (left, right) =>
      compareText(exactKey(left.application), exactKey(right.application)) ||
      compareText(left.path.join(" -> "), right.path.join(" -> ")),
  );
  return {
    artifactId,
    found: owners.size > 0,
    affectedPackages,
    affectedApplications: applications,
    reasons,
    rerun: {
      scenarios: [...scenarios.values()].sort((left, right) =>
        compareText(exactKey(left), exactKey(right)),
      ),
      runbooks: [...runbooks.values()].sort((left, right) =>
        compareText(exactKey(left), exactKey(right)),
      ),
    },
  };
}
