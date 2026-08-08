import { dirname, relative, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  exactKey,
  isDomainArtifact,
  isHarnessPackage,
  metadataOf,
} from "../guards.js";
import type {
  ExactReference,
  LoadedCogaInstance,
  LoadedResource,
} from "../types.js";
import { validate } from "../validation.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { verifyEvidenceBundle } from "./evidence.js";
import { resolvePackageClosure } from "./graph.js";
import { validateControlDocument } from "./validation.js";
import type {
  Digest,
  EvidenceBundle,
  HarnessReleasePlan,
  HarnessReleaseResource,
} from "./types.js";

export interface ProvenanceMaterial {
  bytes: Uint8Array;
  visibility: "public" | "internal" | "restricted";
}

export interface HarnessReleaseOptions {
  visibility?: "public" | "internal" | "restricted";
  evidence: EvidenceBundle[];
  readFile?: (path: string) => Uint8Array;
  resolveProvenance?: (
    source: string,
    referringPath: string,
  ) => ProvenanceMaterial;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resourceEntry(
  loaded: LoadedCogaInstance,
  resource: LoadedResource,
  readFile: (path: string) => Uint8Array,
): HarnessReleaseResource {
  const metadata = metadataOf(resource.document);
  if (
    !metadata ||
    !resource.document ||
    typeof resource.document !== "object" ||
    !("kind" in resource.document)
  )
    throw new Error(`Invalid release resource '${resource.path}'.`);
  return {
    id: metadata.id,
    version: metadata.version,
    kind: String(resource.document.kind),
    path: relative(dirname(loaded.manifestPath), resource.path).replaceAll(
      "\\",
      "/",
    ),
    digest: sha256(readFile(resource.path)),
    lifecycle: metadata.lifecycle,
    ...(metadata.visibility ? { visibility: metadata.visibility } : {}),
  };
}

function assertReleaseGate(
  resource: HarnessReleaseResource,
  visibility: "public" | "internal" | "restricted",
): void {
  if (resource.lifecycle !== "published")
    throw new Error(
      `Release resource '${resource.id}@${resource.version}' is not published.`,
    );
  if (resource.visibility !== visibility)
    throw new Error(
      `Release resource '${resource.id}@${resource.version}' does not have visibility '${visibility}'.`,
    );
}

/** Build a deterministic, hash-addressed release plan without publishing anything. */
export function planHarnessRelease(
  loaded: LoadedCogaInstance,
  target: ExactReference,
  options: HarnessReleaseOptions,
): HarnessReleasePlan {
  const validation = validate(loaded);
  if (!validation.valid)
    throw new Error(
      `Cannot release an invalid instance: ${validation.issues[0]?.message ?? "unknown"}`,
    );
  const visibility = options.visibility ?? "public";
  const readFile = options.readFile ?? ((path: string) => readFileSync(path));
  const resolveProvenance =
    options.resolveProvenance ??
    ((source: string, referringPath: string) => ({
      bytes: readFile(resolve(dirname(referringPath), source)),
      visibility,
    }));
  const closure = resolvePackageClosure(loaded, target);
  const closureKeys = new Set(closure.order.map(exactKey));
  const packageResources = loaded.packages.filter((resource) => {
    const metadata = metadataOf(resource.document);
    return metadata && closureKeys.has(exactKey(metadata));
  });
  const artifactResources = loaded.artifacts.filter(
    (resource) =>
      resource.ownerPackage && closureKeys.has(exactKey(resource.ownerPackage)),
  );
  const resources = [...packageResources, ...artifactResources]
    .map((resource) => resourceEntry(loaded, resource, readFile))
    .sort((left, right) =>
      compareText(
        `${left.kind}:${left.id}@${left.version}`,
        `${right.kind}:${right.id}@${right.version}`,
      ),
    );
  resources.forEach((resource) => assertReleaseGate(resource, visibility));

  const evidenceMaterials = new Set<Digest>();
  for (const bundle of options.evidence) {
    const evidenceValidation = validateControlDocument(bundle);
    if (!evidenceValidation.valid)
      throw new Error(
        `Evidence bundle '${bundle.metadata.id}' is invalid: ${evidenceValidation.issues[0]?.message ?? "unknown"}`,
      );
    const evidenceFiles = verifyEvidenceBundle(bundle, {
      baseDir: dirname(loaded.manifestPath),
      readFile,
    });
    if (evidenceFiles.length > 0)
      throw new Error(
        `Evidence bundle '${bundle.metadata.id}' failed material verification: ${evidenceFiles[0]!.code}`,
      );
    if (bundle.spec.claimResults.some((claim) => claim.status === "failed"))
      throw new Error(
        `Evidence bundle '${bundle.metadata.id}' contains failed claims.`,
      );
    evidenceMaterials.add(bundle.spec.subject.digest);
    bundle.spec.materials.forEach((material) =>
      evidenceMaterials.add(material.digest),
    );
  }
  for (const resource of resources.filter(
    (entry) => entry.kind === "DomainArtifact",
  )) {
    if (!evidenceMaterials.has(resource.digest))
      throw new Error(
        `Published artifact '${resource.id}@${resource.version}' lacks digest-bound evidence.`,
      );
  }

  const provenance = new Map<
    string,
    {
      source: string;
      digest: Digest;
      visibility: "public" | "internal" | "restricted";
    }
  >();
  const provenanceDigests = new Map<string, Digest>();
  for (const artifact of artifactResources) {
    if (!isDomainArtifact(artifact.document)) continue;
    for (const record of artifact.document.spec.provenance) {
      const material = resolveProvenance(record.source, artifact.path);
      if (material.visibility !== visibility)
        throw new Error(
          `Provenance source '${record.source}' is not '${visibility}'.`,
        );
      const entry = {
        source: record.source,
        digest: sha256(material.bytes),
        visibility: material.visibility,
      };
      const priorDigest = provenanceDigests.get(entry.source);
      if (priorDigest !== undefined && priorDigest !== entry.digest)
        throw new Error(
          `Provenance source '${record.source}' resolved to inconsistent digests.`,
        );
      provenanceDigests.set(entry.source, entry.digest);
      provenance.set(canonicalJson([entry.source, entry.digest]), entry);
    }
  }
  const base = {
    schemaVersion: "coga.dev/release/v0.1" as const,
    target: { ...target },
    packages: closure.order,
    resources,
    provenance: [...provenance.values()].sort(
      (left, right) =>
        compareText(left.source, right.source) ||
        compareText(left.digest, right.digest),
    ),
    evidenceDigests: [
      ...new Set(options.evidence.map((bundle) => sha256(bundle))),
    ].sort() as Digest[],
  };
  return { ...base, releaseDigest: sha256(canonicalJson(base)) };
}

export function verifyHarnessRelease(
  plan: HarnessReleasePlan,
  loaded: LoadedCogaInstance,
  options: HarnessReleaseOptions,
): { valid: boolean; reason?: string } {
  try {
    const rebuilt = planHarnessRelease(loaded, plan.target, options);
    if (canonicalJson(rebuilt) !== canonicalJson(plan))
      return { valid: false, reason: "release plan or source digest drift" };
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
