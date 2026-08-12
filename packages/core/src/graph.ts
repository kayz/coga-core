import {
  exactKey,
  isApplication,
  isCogaInstance,
  isDomainArtifact,
  isHarnessPackage,
  isRecord,
  metadataOf,
} from "./guards.js";
import type {
  ExactReference,
  Lifecycle,
  LoadedCogaInstance,
  LoadedResource,
  OwnershipScope,
  Visibility,
} from "./types.js";

export type ResourceGraphNodeKind =
  | "instance"
  | "package"
  | "application"
  | "artifact"
  | "policy"
  | "contract";

export type ResourceGraphEdgeKind =
  | "instance-package"
  | "instance-application"
  | "package-dependency"
  | "package-artifact"
  | "application-package"
  | "application-scenario"
  | "application-runbook"
  | "artifact-relation"
  | "artifact-validation"
  | "artifact-contract"
  | "application-contract"
  | "governance-policy";

export interface ResourceGraphNode {
  key: string;
  kind: ResourceGraphNodeKind;
  id: string;
  version: string;
  resource?: LoadedResource;
  lifecycle?: Lifecycle;
  scope?: OwnershipScope;
  visibility?: Visibility;
}

export interface ResourceGraphEdge {
  kind: ResourceGraphEdgeKind;
  from: string;
  to: string;
  pointer: string;
}

export interface ResourceGraph {
  nodes: Map<string, ResourceGraphNode>;
  edges: ResourceGraphEdge[];
  outgoing: Map<string, ResourceGraphEdge[]>;
  incoming: Map<string, ResourceGraphEdge[]>;
  instanceKey?: string;
  packagesByExact: Map<string, string>;
  applicationsByExact: Map<string, string>;
  artifactsByExact: Map<string, string>;
  artifactOwners: Map<string, string>;
}

export function graphNodeKey(
  kind: ResourceGraphNodeKind,
  reference: ExactReference,
): string {
  return `${kind}:${exactKey(reference)}`;
}

export function exactReference(value: unknown): ExactReference | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.version !== "string"
  ) {
    return undefined;
  }
  return { id: value.id, version: value.version };
}

export function exactReferences(value: unknown): ExactReference[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => exactReference(entry))
    .filter((entry): entry is ExactReference => entry !== undefined);
}

function addNode(
  graph: ResourceGraph,
  kind: ResourceGraphNodeKind,
  reference: ExactReference,
  resource?: LoadedResource,
): string {
  const key = graphNodeKey(kind, reference);
  if (!graph.nodes.has(key)) {
    const metadata = metadataOf(resource?.document);
    const node: ResourceGraphNode = {
      key,
      kind,
      id: reference.id,
      version: reference.version,
    };
    if (resource) node.resource = resource;
    if (metadata?.lifecycle) node.lifecycle = metadata.lifecycle;
    if (metadata?.scope) node.scope = metadata.scope;
    if (metadata?.visibility) node.visibility = metadata.visibility;
    graph.nodes.set(key, node);
  }
  return key;
}

function addEdge(
  graph: ResourceGraph,
  kind: ResourceGraphEdgeKind,
  from: string | undefined,
  to: string | undefined,
  pointer: string,
): void {
  if (!from || !to || !graph.nodes.has(from) || !graph.nodes.has(to)) return;
  graph.edges.push({ kind, from, to, pointer });
}

function metadataReference(
  resource: LoadedResource,
): ExactReference | undefined {
  const metadata = metadataOf(resource.document);
  return metadata ? { id: metadata.id, version: metadata.version } : undefined;
}

function contractReferences(value: unknown): ExactReference[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => exactReference(entry))
    .filter((entry): entry is ExactReference => entry !== undefined);
}

/** Build the exact, versioned resource graph used by validation and impact. */
export function buildResourceGraph(loaded: LoadedCogaInstance): ResourceGraph {
  const graph: ResourceGraph = {
    nodes: new Map(),
    edges: [],
    outgoing: new Map(),
    incoming: new Map(),
    packagesByExact: new Map(),
    applicationsByExact: new Map(),
    artifactsByExact: new Map(),
    artifactOwners: new Map(),
  };

  const instanceReference = metadataReference(loaded.instance);
  if (instanceReference) {
    graph.instanceKey = addNode(
      graph,
      "instance",
      instanceReference,
      loaded.instance,
    );
  }

  for (const resource of loaded.packages) {
    const reference = metadataReference(resource);
    if (!reference || !isHarnessPackage(resource.document)) continue;
    const key = addNode(graph, "package", reference, resource);
    graph.packagesByExact.set(exactKey(reference), key);
  }

  for (const resource of loaded.applications) {
    const reference = metadataReference(resource);
    if (!reference || !isApplication(resource.document)) continue;
    const key = addNode(graph, "application", reference, resource);
    graph.applicationsByExact.set(exactKey(reference), key);
  }

  for (const resource of loaded.artifacts) {
    const reference = metadataReference(resource);
    if (!reference || !isDomainArtifact(resource.document)) continue;
    const kind =
      resource.document.spec.artifactType === "policy" ? "policy" : "artifact";
    const key = addNode(graph, kind, reference, resource);
    graph.artifactsByExact.set(exactKey(reference), key);
    if (resource.ownerPackage) {
      const owner = graph.packagesByExact.get(exactKey(resource.ownerPackage));
      if (owner) graph.artifactOwners.set(key, owner);
    }
  }

  if (isCogaInstance(loaded.instance.document)) {
    for (const [index, reference] of exactReferences(
      loaded.instance.document.spec.packages,
    ).entries()) {
      addEdge(
        graph,
        "instance-package",
        graph.instanceKey,
        graph.packagesByExact.get(exactKey(reference)),
        `/spec/packages/${index}`,
      );
    }
    for (const [index, reference] of exactReferences(
      loaded.instance.document.spec.applications,
    ).entries()) {
      addEdge(
        graph,
        "instance-application",
        graph.instanceKey,
        graph.applicationsByExact.get(exactKey(reference)),
        `/spec/applications/${index}`,
      );
    }
  }

  for (const resource of loaded.packages) {
    if (!isHarnessPackage(resource.document)) continue;
    const reference = metadataReference(resource);
    if (!reference) continue;
    const source = graph.packagesByExact.get(exactKey(reference));
    for (const [index, dependency] of exactReferences(
      resource.document.spec.dependencies,
    ).entries()) {
      addEdge(
        graph,
        "package-dependency",
        source,
        graph.packagesByExact.get(exactKey(dependency)),
        `/spec/dependencies/${index}`,
      );
    }
    for (const [index, artifact] of exactReferences(
      resource.document.spec.artifacts,
    ).entries()) {
      addEdge(
        graph,
        "package-artifact",
        source,
        graph.artifactsByExact.get(exactKey(artifact)),
        `/spec/artifacts/${index}`,
      );
    }
  }

  for (const resource of loaded.artifacts) {
    if (!isDomainArtifact(resource.document)) continue;
    const reference = metadataReference(resource);
    if (!reference) continue;
    const source = graph.artifactsByExact.get(exactKey(reference));
    const relations = Array.isArray(resource.document.spec.relations)
      ? resource.document.spec.relations
      : [];
    for (const [index, relation] of relations.entries()) {
      const target = exactReference(
        isRecord(relation) ? relation.target : undefined,
      );
      if (!target) continue;
      addEdge(
        graph,
        "artifact-relation",
        source,
        graph.artifactsByExact.get(exactKey(target)),
        `/spec/relations/${index}/target`,
      );
    }
    const validation = Array.isArray(resource.document.spec.validation)
      ? resource.document.spec.validation
      : [];
    for (const [index, record] of validation.entries()) {
      if (!isRecord(record) || record.type !== "scenario") continue;
      const target = exactReference(record.target);
      if (!target) continue;
      addEdge(
        graph,
        "artifact-validation",
        source,
        graph.artifactsByExact.get(exactKey(target)),
        `/spec/validation/${index}/target`,
      );
    }
    for (const [index, contract] of contractReferences(
      resource.document.spec.contractRefs,
    ).entries()) {
      const target = addNode(graph, "contract", contract);
      addEdge(
        graph,
        "artifact-contract",
        source,
        target,
        `/spec/contractRefs/${index}`,
      );
    }
  }

  for (const resource of loaded.applications) {
    if (!isApplication(resource.document)) continue;
    const reference = metadataReference(resource);
    if (!reference) continue;
    const source = graph.applicationsByExact.get(exactKey(reference));
    for (const [index, dependency] of exactReferences(
      resource.document.spec.harnessDependencies,
    ).entries()) {
      addEdge(
        graph,
        "application-package",
        source,
        graph.packagesByExact.get(exactKey(dependency)),
        `/spec/harnessDependencies/${index}`,
      );
    }
    for (const [index, scenario] of exactReferences(
      resource.document.spec.scenarios,
    ).entries()) {
      addEdge(
        graph,
        "application-scenario",
        source,
        graph.artifactsByExact.get(exactKey(scenario)),
        `/spec/scenarios/${index}`,
      );
    }
    const operations = resource.document.spec.operations;
    for (const [index, runbook] of exactReferences(
      isRecord(operations) ? operations.runbooks : undefined,
    ).entries()) {
      addEdge(
        graph,
        "application-runbook",
        source,
        graph.artifactsByExact.get(exactKey(runbook)),
        `/spec/operations/runbooks/${index}`,
      );
    }
    for (const [index, contract] of contractReferences(
      resource.document.spec.contracts,
    ).entries()) {
      const target = addNode(graph, "contract", contract);
      addEdge(
        graph,
        "application-contract",
        source,
        target,
        `/spec/contracts/${index}`,
      );
    }
  }

  if (isCogaInstance(loaded.instance.document)) {
    const governance = loaded.instance.document.spec.governance;
    const rules =
      isRecord(governance) && Array.isArray(governance.approvalRules)
        ? governance.approvalRules
        : [];
    for (const [ruleIndex, rule] of rules.entries()) {
      if (!isRecord(rule)) continue;
      for (const [policyIndex, policy] of exactReferences(
        rule.policies,
      ).entries()) {
        addEdge(
          graph,
          "governance-policy",
          graph.instanceKey,
          graph.artifactsByExact.get(exactKey(policy)),
          `/spec/governance/approvalRules/${ruleIndex}/policies/${policyIndex}`,
        );
      }
    }
  }

  graph.edges.sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind) ||
      left.pointer.localeCompare(right.pointer),
  );
  for (const edge of graph.edges) {
    const outgoing = graph.outgoing.get(edge.from) ?? [];
    outgoing.push(edge);
    graph.outgoing.set(edge.from, outgoing);
    const incoming = graph.incoming.get(edge.to) ?? [];
    incoming.push(edge);
    graph.incoming.set(edge.to, incoming);
  }
  return graph;
}

export function packageClosure(
  graph: ResourceGraph,
  roots: Iterable<string>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [...roots].filter((entry) => graph.nodes.has(entry)).sort();
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const targets = (graph.outgoing.get(current) ?? [])
      .filter((edge) => edge.kind === "package-dependency")
      .map((edge) => edge.to)
      .sort();
    for (const target of targets) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return visited;
}

/** Return a deterministic dependency-direction package path, inclusive. */
export function findPackagePath(
  graph: ResourceGraph,
  from: string,
  to: string,
): string[] | undefined {
  if (from === to) return [from];
  const queue: string[][] = [[from]];
  const visited = new Set<string>([from]);
  for (let index = 0; index < queue.length; index += 1) {
    const path = queue[index];
    const current = path?.at(-1);
    if (!path || !current) continue;
    const targets = (graph.outgoing.get(current) ?? [])
      .filter((edge) => edge.kind === "package-dependency")
      .map((edge) => edge.to)
      .sort();
    for (const target of targets) {
      if (target === to) return [...path, target];
      if (visited.has(target)) continue;
      visited.add(target);
      queue.push([...path, target]);
    }
  }
  return undefined;
}
