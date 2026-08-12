import { lt as semverLessThan, valid as validSemver } from "semver";
import {
  exactKey,
  isApplication,
  isDomainArtifact,
  isHarnessPackage,
  isRecord,
  metadataOf,
} from "./guards.js";
import {
  buildResourceGraph,
  exactReferences,
  type ResourceGraph,
  type ResourceGraphNode,
} from "./graph.js";
import { load } from "./loader.js";
import { assertCompatibleOptions } from "./options.js";
import type {
  CogaOptions,
  ExactReference,
  HarnessLayer,
  ImpactApplication,
  ImpactPathNode,
  ImpactReason,
  ImpactResult,
  LoadedCogaInstance,
} from "./types.js";

interface PackagePath {
  nodes: string[];
  direct: boolean;
}

function pathKey(path: readonly string[]): string {
  return path.join("\u0000");
}

function preferPath(candidate: PackagePath, current: PackagePath): boolean {
  return (
    candidate.nodes.length < current.nodes.length ||
    (candidate.nodes.length === current.nodes.length &&
      pathKey(candidate.nodes).localeCompare(pathKey(current.nodes)) < 0)
  );
}

function reverseArtifactPaths(
  graph: ResourceGraph,
  changedNode: string,
): Map<string, string[]> {
  const paths = new Map<string, string[]>([[changedNode, [changedNode]]]);
  const queue = [changedNode];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    const currentPath = paths.get(current);
    if (!currentPath) continue;
    const dependents = (graph.incoming.get(current) ?? [])
      .filter(
        (edge) =>
          edge.kind === "artifact-relation" ||
          edge.kind === "artifact-validation",
      )
      .map((edge) => edge.from)
      .sort();
    for (const dependent of dependents) {
      const candidate = [...currentPath, dependent];
      const previous = paths.get(dependent);
      if (
        previous &&
        (previous.length < candidate.length ||
          (previous.length === candidate.length &&
            pathKey(previous).localeCompare(pathKey(candidate)) <= 0))
      ) {
        continue;
      }
      paths.set(dependent, candidate);
      queue.push(dependent);
    }
  }
  return paths;
}

function reversePackagePaths(
  graph: ResourceGraph,
  seeds: Map<string, PackagePath>,
): Map<string, PackagePath> {
  const paths = new Map(seeds);
  const queue = [...seeds.keys()].sort();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current) continue;
    const currentPath = paths.get(current);
    if (!currentPath) continue;
    const consumers = (graph.incoming.get(current) ?? [])
      .filter((edge) => edge.kind === "package-dependency")
      .map((edge) => edge.from)
      .sort();
    for (const consumer of consumers) {
      const candidate: PackagePath = {
        nodes: [...currentPath.nodes, consumer],
        direct: false,
      };
      const previous = paths.get(consumer);
      if (previous && !preferPath(candidate, previous)) continue;
      paths.set(consumer, candidate);
      queue.push(consumer);
    }
  }
  return paths;
}

function graphPathNode(
  graph: ResourceGraph,
  key: string,
): ImpactPathNode | undefined {
  const node = graph.nodes.get(key);
  if (!node || node.kind === "contract" || node.kind === "instance") {
    return undefined;
  }
  const kind: ImpactPathNode["kind"] =
    node.kind === "package"
      ? "package"
      : node.kind === "application"
        ? "application"
        : "artifact";
  return { kind, id: node.id, version: node.version };
}

function toImpactPath(
  graph: ResourceGraph,
  keys: readonly string[],
): ImpactPathNode[] {
  const result: ImpactPathNode[] = [];
  for (const key of keys) {
    const node = graphPathNode(graph, key);
    if (!node) continue;
    const previous = result.at(-1);
    if (
      previous &&
      previous.kind === node.kind &&
      exactKey(previous) === exactKey(node)
    ) {
      continue;
    }
    result.push(node);
  }
  return result;
}

function exactReferenceSort(
  left: ExactReference,
  right: ExactReference,
): number {
  return exactKey(left).localeCompare(exactKey(right));
}

function applicationReruns(application: unknown): {
  scenarios: ExactReference[];
  runbooks: ExactReference[];
} {
  if (!isApplication(application)) return { scenarios: [], runbooks: [] };
  const operations = application.spec.operations;
  return {
    scenarios: exactReferences(application.spec.scenarios).sort(
      exactReferenceSort,
    ),
    runbooks: exactReferences(
      isRecord(operations) ? operations.runbooks : undefined,
    ).sort(exactReferenceSort),
  };
}

function reasonKey(reason: ImpactReason): string {
  return `${reason.type}:${reason.path
    .map((entry) => `${entry.kind}:${exactKey(entry)}`)
    .join("->")}`;
}

function sortReasons(reasons: ImpactReason[]): ImpactReason[] {
  const rank: Record<ImpactReason["type"], number> = {
    direct: 0,
    transitive: 1,
    "older-pin": 2,
  };
  return reasons.sort(
    (left, right) =>
      rank[left.type] - rank[right.type] ||
      reasonKey(left).localeCompare(reasonKey(right)),
  );
}

function addReason(
  reasons: Map<string, ImpactReason>,
  type: ImpactReason["type"],
  graph: ResourceGraph,
  graphPath: string[],
): void {
  const reason: ImpactReason = { type, path: toImpactPath(graph, graphPath) };
  reasons.set(reasonKey(reason), reason);
}

function currentPackagePaths(
  graph: ResourceGraph,
  changedNode: string,
): Map<string, PackagePath> {
  const artifactPaths = reverseArtifactPaths(graph, changedNode);
  const changedOwner = graph.artifactOwners.get(changedNode);
  const seeds = new Map<string, PackagePath>();
  for (const [artifactNode, artifactPath] of [...artifactPaths.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const owner = graph.artifactOwners.get(artifactNode);
    if (!owner) continue;
    const prefix = changedOwner ? [changedNode, changedOwner] : [changedNode];
    const candidate: PackagePath = {
      nodes:
        artifactNode === changedNode
          ? [...prefix]
          : [...prefix, ...artifactPath.slice(1), owner],
      direct: artifactNode === changedNode,
    };
    const previous = seeds.get(owner);
    if (!previous || preferPath(candidate, previous))
      seeds.set(owner, candidate);
  }
  return reversePackagePaths(graph, seeds);
}

function olderPackagePaths(
  loaded: LoadedCogaInstance,
  graph: ResourceGraph,
  changed: ExactReference,
  changedNode: string,
  currentOwner: string,
): Map<string, PackagePath> {
  const currentOwnerNode = graph.nodes.get(currentOwner);
  if (
    !currentOwnerNode ||
    validSemver(currentOwnerNode.version) === null ||
    validSemver(changed.version) === null
  ) {
    return new Map();
  }
  const seeds = new Map<string, PackagePath>();
  for (const artifact of loaded.artifacts) {
    if (!isDomainArtifact(artifact.document) || !artifact.ownerPackage)
      continue;
    const metadata = metadataOf(artifact.document);
    if (
      !metadata ||
      metadata.id !== changed.id ||
      exactKey(metadata) === exactKey(changed) ||
      validSemver(metadata.version) === null ||
      !semverLessThan(metadata.version, changed.version)
    ) {
      continue;
    }
    const oldOwner = graph.packagesByExact.get(exactKey(artifact.ownerPackage));
    const oldOwnerNode = oldOwner ? graph.nodes.get(oldOwner) : undefined;
    const oldArtifactNode = graph.artifactsByExact.get(exactKey(metadata));
    if (
      !oldOwner ||
      !oldOwnerNode ||
      !oldArtifactNode ||
      oldOwnerNode.id !== currentOwnerNode.id ||
      validSemver(oldOwnerNode.version) === null ||
      !semverLessThan(oldOwnerNode.version, currentOwnerNode.version)
    ) {
      continue;
    }
    const candidate: PackagePath = {
      nodes: [changedNode, currentOwner, oldArtifactNode, oldOwner],
      direct: false,
    };
    const previous = seeds.get(oldOwner);
    if (!previous || preferPath(candidate, previous)) {
      seeds.set(oldOwner, candidate);
    }
  }
  return reversePackagePaths(graph, seeds);
}

function ownerPackages(
  loaded: LoadedCogaInstance,
  graph: ResourceGraph,
  changedNode: string,
): ImpactResult["packages"] {
  const ownerKey = graph.artifactOwners.get(changedNode);
  const ownerNode = ownerKey ? graph.nodes.get(ownerKey) : undefined;
  if (!ownerNode?.resource || !isHarnessPackage(ownerNode.resource.document)) {
    return [];
  }
  return [
    {
      id: ownerNode.id,
      version: ownerNode.version,
      layer: ownerNode.resource.document.spec.layer as HarnessLayer,
      path: ownerNode.resource.path,
    },
  ];
}

/** Analyze exact, versioned direct, transitive, and registered older-pin impact. */
export function impact(
  input: string | LoadedCogaInstance,
  artifact: ExactReference,
  options?: CogaOptions,
): ImpactResult {
  if (typeof input !== "string") assertCompatibleOptions(input, options);
  const loaded = typeof input === "string" ? load(input, options) : input;
  const graph = buildResourceGraph(loaded);
  const changedNode = graph.artifactsByExact.get(exactKey(artifact));
  if (!changedNode) {
    return {
      artifact,
      found: false,
      packages: [],
      affectedApplications: [],
    };
  }

  const currentPaths = currentPackagePaths(graph, changedNode);
  const currentOwner = graph.artifactOwners.get(changedNode);
  const olderPaths = currentOwner
    ? olderPackagePaths(loaded, graph, artifact, changedNode, currentOwner)
    : new Map<string, PackagePath>();
  const affectedApplications: ImpactApplication[] = [];

  for (const application of loaded.applications) {
    if (!isApplication(application.document)) continue;
    const metadata = metadataOf(application.document);
    if (!metadata) continue;
    const applicationNode = graph.applicationsByExact.get(exactKey(metadata));
    if (!applicationNode) continue;
    const reasons = new Map<string, ImpactReason>();
    for (const dependency of application.document.spec.harnessDependencies) {
      const packageNode = graph.packagesByExact.get(exactKey(dependency));
      if (!packageNode) continue;
      const current = currentPaths.get(packageNode);
      if (current) {
        addReason(reasons, current.direct ? "direct" : "transitive", graph, [
          ...current.nodes,
          applicationNode,
        ]);
      }
      const older = olderPaths.get(packageNode);
      if (older) {
        addReason(reasons, "older-pin", graph, [
          ...older.nodes,
          applicationNode,
        ]);
      }
    }
    if (reasons.size === 0) continue;
    const reruns = applicationReruns(application.document);
    affectedApplications.push({
      id: metadata.id,
      title: metadata.title,
      version: metadata.version,
      path: application.path,
      reasons: sortReasons([...reasons.values()]),
      rerunScenarios: reruns.scenarios,
      rerunRunbooks: reruns.runbooks,
    });
  }

  affectedApplications.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.version.localeCompare(right.version),
  );
  return {
    artifact,
    found: true,
    packages: ownerPackages(loaded, graph, changedNode),
    affectedApplications,
  };
}

export const analyzeImpact = impact;
