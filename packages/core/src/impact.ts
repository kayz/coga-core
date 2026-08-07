import {
  exactKey,
  isApplication,
  isDomainArtifact,
  isHarnessPackage,
  metadataOf,
} from "./guards.js";
import { load } from "./loader.js";
import type {
  ExactReference,
  HarnessLayer,
  ImpactApplication,
  ImpactResult,
  LoadedCogaInstance,
} from "./types.js";

/**
 * Find registered applications affected by an artifact through exact harness
 * package dependencies. Unversioned artifact IDs may occur in more than one
 * registered package version; all exact owners are considered.
 */
export function impact(
  input: string | LoadedCogaInstance,
  artifactId: string,
): ImpactResult {
  const loaded = typeof input === "string" ? load(input) : input;
  const ownerKeys = new Set<string>();
  const packages: ImpactResult["packages"] = [];

  for (const artifact of loaded.artifacts) {
    if (!isDomainArtifact(artifact.document)) continue;
    const artifactMetadata = metadataOf(artifact.document);
    if (
      !artifactMetadata ||
      artifactMetadata.id !== artifactId ||
      !artifact.ownerPackage
    )
      continue;
    const key = exactKey(artifact.ownerPackage);
    if (ownerKeys.has(key)) continue;
    ownerKeys.add(key);
    const owner = loaded.packages.find((candidate) => {
      const metadata = metadataOf(candidate.document);
      return metadata !== undefined && exactKey(metadata) === key;
    });
    if (!owner || !isHarnessPackage(owner.document)) continue;
    const ownerMetadata = metadataOf(owner.document);
    if (!ownerMetadata) continue;
    packages.push({
      id: ownerMetadata.id,
      version: ownerMetadata.version,
      layer: owner.document.spec.layer as HarnessLayer,
      path: owner.path,
    });
  }

  const affectedApplications: ImpactApplication[] = [];
  for (const application of loaded.applications) {
    if (!isApplication(application.document)) continue;
    const metadata = metadataOf(application.document);
    if (!metadata) continue;
    const matchedDependencies: ExactReference[] =
      application.document.spec.harnessDependencies.filter((dependency) =>
        ownerKeys.has(exactKey(dependency)),
      );
    if (matchedDependencies.length === 0) continue;
    affectedApplications.push({
      id: metadata.id,
      title: metadata.title,
      version: metadata.version,
      path: application.path,
      matchedDependencies,
    });
  }

  packages.sort((left, right) => exactKey(left).localeCompare(exactKey(right)));
  affectedApplications.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.version.localeCompare(right.version),
  );
  return {
    artifactId,
    found: ownerKeys.size > 0,
    packages,
    affectedApplications,
  };
}

export const analyzeImpact = impact;
