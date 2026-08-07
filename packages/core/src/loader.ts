import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  isCogaInstance,
  isHarnessPackage,
  isRecord,
  metadataOf,
} from "./guards.js";
import type {
  ExactReference,
  LoadedArtifact,
  LoadedCogaInstance,
  LoadedResource,
  LocatedReference,
  ValidationIssue,
} from "./types.js";

function issue(path: string, code: string, message: string): ValidationIssue {
  return { severity: "error", code, message, path };
}

function readCanonical(path: string, issues: ValidationIssue[]): unknown {
  const extension = extname(path).toLowerCase();
  if (![".yaml", ".yml", ".json"].includes(extension)) {
    issues.push(
      issue(
        path,
        "load.unsupported-extension",
        "Canonical resources must use a .yaml, .yml, or .json extension.",
      ),
    );
    return null;
  }

  try {
    const source = readFileSync(path, "utf8");
    return extension === ".json"
      ? (JSON.parse(source) as unknown)
      : parseYaml(source, { maxAliasCount: 50, uniqueKeys: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    issues.push(
      issue(
        path,
        "load.failed",
        `Unable to load canonical resource: ${detail}`,
      ),
    );
    return null;
  }
}

function looseLocatedReferences(
  value: unknown,
  property: string,
): LocatedReference[] {
  if (!isRecord(value) || !isRecord(value.spec)) return [];
  const candidate = value.spec[property];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (entry): entry is LocatedReference =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      typeof entry.version === "string" &&
      typeof entry.path === "string",
  );
}

function loadLocated(
  reference: LocatedReference,
  referringPath: string,
  issues: ValidationIssue[],
): LoadedResource {
  const path = resolve(dirname(referringPath), reference.path);
  return {
    path,
    document: readCanonical(path, issues),
    declaredRef: reference,
  };
}

/** Load an instance manifest and every package, artifact, and application it registers. */
export function load(instanceManifestPath: string): LoadedCogaInstance {
  const manifestPath = resolve(instanceManifestPath);
  const loadIssues: ValidationIssue[] = [];
  const instance: LoadedResource = {
    path: manifestPath,
    document: readCanonical(manifestPath, loadIssues),
  };
  const packages: LoadedResource[] = [];
  const artifacts: LoadedArtifact[] = [];
  const applications: LoadedResource[] = [];

  if (isCogaInstance(instance.document)) {
    for (const reference of looseLocatedReferences(
      instance.document,
      "packages",
    )) {
      const loadedPackage = loadLocated(reference, manifestPath, loadIssues);
      packages.push(loadedPackage);

      if (isHarnessPackage(loadedPackage.document)) {
        const ownerMetadata = metadataOf(loadedPackage.document);
        const ownerPackage: ExactReference | undefined = ownerMetadata
          ? { id: ownerMetadata.id, version: ownerMetadata.version }
          : undefined;
        for (const artifactReference of looseLocatedReferences(
          loadedPackage.document,
          "artifacts",
        )) {
          const loadedArtifact = loadLocated(
            artifactReference,
            loadedPackage.path,
            loadIssues,
          );
          artifacts.push(
            ownerPackage
              ? { ...loadedArtifact, ownerPackage }
              : { ...loadedArtifact },
          );
        }
      }
    }

    for (const reference of looseLocatedReferences(
      instance.document,
      "applications",
    )) {
      applications.push(loadLocated(reference, manifestPath, loadIssues));
    }
  }

  return {
    manifestPath,
    instance,
    packages,
    artifacts,
    applications,
    loadIssues,
  };
}
