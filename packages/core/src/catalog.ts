import {
  exactKey,
  isApplication,
  isCogaInstance,
  isDomainArtifact,
  isHarnessPackage,
  metadataOf,
} from "./guards.js";
import { load } from "./loader.js";
import type {
  CatalogApplication,
  CatalogArtifact,
  CatalogPackage,
  CogaCatalog,
  LoadedCogaInstance,
} from "./types.js";

function requireMetadata(document: unknown, label: string) {
  const metadata = metadataOf(document);
  if (!metadata) throw new Error(`${label} has invalid or missing metadata.`);
  return metadata;
}

/** Build a deterministic, content-light catalog from a loaded instance. */
export function catalog(input: string | LoadedCogaInstance): CogaCatalog {
  const loaded = typeof input === "string" ? load(input) : input;
  if (!isCogaInstance(loaded.instance.document)) {
    throw new Error(
      "Catalog entry point must be a valid CogaInstance resource.",
    );
  }
  const instanceMetadata = requireMetadata(
    loaded.instance.document,
    "COGA instance",
  );

  const packages: CatalogPackage[] = loaded.packages
    .filter((resource) => isHarnessPackage(resource.document))
    .map((resource) => {
      if (!isHarnessPackage(resource.document))
        throw new Error("Unreachable package guard.");
      const packageMetadata = requireMetadata(
        resource.document,
        "Harness package",
      );
      const ownedKey = exactKey(packageMetadata);
      const artifacts: CatalogArtifact[] = loaded.artifacts
        .filter(
          (artifact) =>
            artifact.ownerPackage !== undefined &&
            exactKey(artifact.ownerPackage) === ownedKey,
        )
        .filter((artifact) => isDomainArtifact(artifact.document))
        .map((artifact) => {
          if (!isDomainArtifact(artifact.document))
            throw new Error("Unreachable artifact guard.");
          const metadata = requireMetadata(
            artifact.document,
            "Domain artifact",
          );
          return {
            id: metadata.id,
            title: metadata.title,
            version: metadata.version,
            lifecycle: metadata.lifecycle,
            artifactType: artifact.document.spec.artifactType,
            summary: artifact.document.spec.summary,
            ...(metadata.visibility ? { visibility: metadata.visibility } : {}),
          };
        })
        .sort(
          (left, right) =>
            left.id.localeCompare(right.id) ||
            left.version.localeCompare(right.version),
        );

      return {
        id: packageMetadata.id,
        title: packageMetadata.title,
        version: packageMetadata.version,
        lifecycle: packageMetadata.lifecycle,
        layer: resource.document.spec.layer,
        description: resource.document.spec.description,
        dependencies: [...resource.document.spec.dependencies],
        artifacts,
        ...(packageMetadata.visibility
          ? { visibility: packageMetadata.visibility }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        left.layer.localeCompare(right.layer) ||
        left.id.localeCompare(right.id) ||
        left.version.localeCompare(right.version),
    );

  const applications: CatalogApplication[] = loaded.applications
    .filter((resource) => isApplication(resource.document))
    .map((resource) => {
      if (!isApplication(resource.document))
        throw new Error("Unreachable application guard.");
      const metadata = requireMetadata(resource.document, "Application");
      return {
        id: metadata.id,
        title: metadata.title,
        version: metadata.version,
        lifecycle: metadata.lifecycle,
        deliveryTargets: [...resource.document.spec.deliveryTargets],
        harnessDependencies: [...resource.document.spec.harnessDependencies],
        ...(metadata.visibility ? { visibility: metadata.visibility } : {}),
      };
    })
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        left.version.localeCompare(right.version),
    );

  return {
    schemaVersion: "coga.dev/v0.1",
    instance: {
      id: instanceMetadata.id,
      title: instanceMetadata.title,
      version: instanceMetadata.version,
      lifecycle: instanceMetadata.lifecycle,
      domainName: loaded.instance.document.spec.domain.name,
      boundary: loaded.instance.document.spec.domain.boundary,
      nonGoals: [...loaded.instance.document.spec.domain.nonGoals],
      ...(instanceMetadata.visibility
        ? { visibility: instanceMetadata.visibility }
        : {}),
    },
    packages,
    applications,
  };
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Render a catalog for human review without changing the canonical source files. */
export function renderCatalogMarkdown(value: CogaCatalog): string {
  const lines = [
    `# ${value.instance.title}`,
    "",
    `- ID: \`${value.instance.id}\``,
    `- Version: \`${value.instance.version}\``,
    `- Lifecycle: \`${value.instance.lifecycle}\``,
    `- Domain: ${value.instance.domainName}`,
    "",
    value.instance.boundary,
    "",
  ];

  if (value.instance.nonGoals.length > 0) {
    lines.push(
      "## Non-goals",
      "",
      ...value.instance.nonGoals.map((item) => `- ${item}`),
      "",
    );
  }

  lines.push("## Harness packages", "");
  if (value.packages.length === 0) {
    lines.push("_No harness packages are registered._", "");
  } else {
    lines.push(
      "| Layer | Package | Version | Lifecycle | Artifacts |",
      "| --- | --- | --- | --- | ---: |",
      ...value.packages.map(
        (entry) =>
          `| ${entry.layer} | \`${entry.id}\` | \`${entry.version}\` | ${entry.lifecycle} | ${entry.artifacts.length} |`,
      ),
      "",
    );
    for (const packageEntry of value.packages) {
      lines.push(
        `### ${packageEntry.title}`,
        "",
        packageEntry.description,
        "",
        "| Type | Artifact | Version | Lifecycle | Summary |",
        "| --- | --- | --- | --- | --- |",
      );
      if (packageEntry.artifacts.length === 0) {
        lines.push("| — | _No artifacts_ | — | — | — |");
      } else {
        lines.push(
          ...packageEntry.artifacts.map(
            (artifact) =>
              `| ${artifact.artifactType} | \`${artifact.id}\` | \`${artifact.version}\` | ${artifact.lifecycle} | ${escapeTable(artifact.summary)} |`,
          ),
        );
      }
      lines.push("");
    }
  }

  lines.push("## Applications", "");
  if (value.applications.length === 0) {
    lines.push("_No applications are registered._", "");
  } else {
    lines.push(
      "| Application | Version | Lifecycle | Delivery targets | Harness dependencies |",
      "| --- | --- | --- | --- | --- |",
      ...value.applications.map(
        (entry) =>
          `| \`${entry.id}\` | \`${entry.version}\` | ${entry.lifecycle} | ${entry.deliveryTargets.join(", ")} | ${entry.harnessDependencies
            .map(exactKey)
            .map((item) => `\`${item}\``)
            .join(", ")} |`,
      ),
      "",
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export const buildCatalog = catalog;
