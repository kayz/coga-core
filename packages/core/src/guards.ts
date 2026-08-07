import type {
  Application,
  CanonicalResource,
  CogaInstance,
  DomainArtifact,
  HarnessPackage,
  ResourceMetadata,
} from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCanonicalResource(
  value: unknown,
): value is CanonicalResource {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === "coga.dev/v0.1" &&
    [
      "DomainArtifact",
      "HarnessPackage",
      "CogaInstance",
      "Application",
    ].includes(String(value.kind)) &&
    isRecord(value.metadata) &&
    isRecord(value.spec)
  );
}

export function metadataOf(value: unknown): ResourceMetadata | undefined {
  if (!isRecord(value) || !isRecord(value.metadata)) return undefined;
  const metadata = value.metadata;
  if (
    typeof metadata.id !== "string" ||
    typeof metadata.title !== "string" ||
    typeof metadata.version !== "string" ||
    typeof metadata.lifecycle !== "string"
  ) {
    return undefined;
  }
  return metadata as unknown as ResourceMetadata;
}

export function isDomainArtifact(value: unknown): value is DomainArtifact {
  return isCanonicalResource(value) && value.kind === "DomainArtifact";
}

export function isHarnessPackage(value: unknown): value is HarnessPackage {
  return isCanonicalResource(value) && value.kind === "HarnessPackage";
}

export function isCogaInstance(value: unknown): value is CogaInstance {
  return isCanonicalResource(value) && value.kind === "CogaInstance";
}

export function isApplication(value: unknown): value is Application {
  return isCanonicalResource(value) && value.kind === "Application";
}

export function exactKey(reference: { id: string; version: string }): string {
  return `${reference.id}@${reference.version}`;
}
