import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  isCogaInstance,
  isHarnessPackage,
  isRecord,
  metadataOf,
} from "./guards.js";
import { normalizeOptions } from "./options.js";
import type {
  CogaOptions,
  ExactReference,
  LoadContext,
  LoadedArtifact,
  LoadedCogaInstance,
  LoadedResource,
  LocatedReference,
  ValidationIssue,
} from "./types.js";

function issue(path: string, code: string, message: string): ValidationIssue {
  return { severity: "error", code, message, path };
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function comparablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithinRoot(rootDir: string, candidate: string): boolean {
  const difference = relative(
    comparablePath(rootDir),
    comparablePath(candidate),
  );
  return (
    difference === "" ||
    (!difference.startsWith("..") && !isAbsolute(difference))
  );
}

function readBounded(
  path: string,
  limit: number,
): {
  raw?: Buffer;
  size: number;
} {
  const descriptor = openSync(path, "r");
  try {
    const information = fstatSync(descriptor);
    if (!information.isFile()) {
      throw new Error("path is not a regular file");
    }
    if (information.size > limit) return { size: information.size };
    let raw = Buffer.allocUnsafe(
      Math.min(limit + 1, Math.max(1, information.size + 1)),
    );
    let offset = 0;
    while (offset <= limit) {
      if (offset === raw.length) {
        const expanded = Buffer.allocUnsafe(
          Math.min(limit + 1, Math.max(raw.length * 2, offset + 1)),
        );
        raw.copy(expanded, 0, 0, offset);
        raw = expanded;
      }
      const bytesRead = readSync(
        descriptor,
        raw,
        offset,
        raw.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > limit
      ? { size: offset }
      : { raw: raw.subarray(0, offset), size: offset };
  } finally {
    closeSync(descriptor);
  }
}

function inspectJsonLike(
  value: unknown,
  path: string,
  context: LoadContext,
  issues: ValidationIssue[],
): boolean {
  const stack: Array<{
    value: unknown;
    pointer: string;
    depth: number;
    exiting?: boolean;
  }> = [{ value, pointer: "", depth: 0 }];
  const active = new WeakMap<object, string>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.exiting) {
      if (typeof current.value === "object" && current.value !== null) {
        active.delete(current.value);
      }
      continue;
    }
    nodes += 1;
    if (nodes > context.limits.maxNodes) {
      issues.push(
        issue(
          path,
          "load.node-limit",
          `Canonical resource exceeds the ${context.limits.maxNodes} logical-node limit.`,
        ),
      );
      return false;
    }
    if (current.depth > context.limits.maxDepth) {
      issues.push(
        issue(
          path,
          "load.depth-limit",
          `Canonical resource exceeds the maximum depth of ${context.limits.maxDepth} at '${current.pointer || "/"}'.`,
        ),
      );
      return false;
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "number" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value !== "object") {
      issues.push(
        issue(
          path,
          "load.non-json-value",
          `Canonical resource contains a non-JSON value at '${current.pointer || "/"}'.`,
        ),
      );
      return false;
    }

    const object = current.value;
    const previous = active.get(object);
    if (previous !== undefined) {
      issues.push(
        issue(
          path,
          "load.circular-reference",
          `Canonical resource contains a circular object reference between '${previous || "/"}' and '${current.pointer || "/"}'.`,
        ),
      );
      return false;
    }
    active.set(object, current.pointer);
    stack.push({ ...current, exiting: true });

    if (Array.isArray(object)) {
      for (let index = object.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: object[index],
          pointer: `${current.pointer}/${index}`,
          depth: current.depth + 1,
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      issues.push(
        issue(
          path,
          "load.special-object",
          `Canonical resource contains a non-plain object at '${current.pointer || "/"}'.`,
        ),
      );
      return false;
    }
    const entries = Object.entries(object as Record<string, unknown>);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      const [key, child] = entry;
      const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
      stack.push({
        value: child,
        pointer: `${current.pointer}/${escaped}`,
        depth: current.depth + 1,
      });
    }
  }
  return true;
}

function readCanonical(
  path: string,
  context: LoadContext,
  issues: ValidationIssue[],
): unknown {
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
    const bounded = readBounded(path, context.limits.canonicalFileBytes);
    if (!bounded.raw) {
      issues.push(
        issue(
          path,
          "load.file-too-large",
          `Canonical resource is at least ${bounded.size} bytes; the limit is ${context.limits.canonicalFileBytes} bytes.`,
        ),
      );
      return null;
    }
    let source: string;
    try {
      source = utf8Decoder.decode(bounded.raw);
    } catch {
      issues.push(
        issue(
          path,
          "load.invalid-utf8",
          "Canonical resource is not valid UTF-8.",
        ),
      );
      return null;
    }
    const document =
      extension === ".json"
        ? (JSON.parse(source) as unknown)
        : parseYaml(source, {
            maxAliasCount: context.limits.maxAliases,
            uniqueKeys: true,
          });
    return inspectJsonLike(document, path, context, issues) ? document : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const aliasLimit = /excessive alias count/iu.test(detail);
    issues.push(
      issue(
        path,
        aliasLimit ? "load.alias-limit" : "load.failed",
        aliasLimit
          ? `Canonical resource exceeds the YAML alias limit of ${context.limits.maxAliases}.`
          : `Unable to load canonical resource: ${detail}`,
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
  context: LoadContext,
  issues: ValidationIssue[],
): LoadedResource {
  const path = resolve(dirname(referringPath), reference.path);
  if (context.profile !== "local" && !isWithinRoot(context.rootDir, path)) {
    issues.push(
      issue(
        path,
        "load.path-outside-root",
        `Profile '${context.profile}' forbids a resource path outside '${context.rootDir}'.`,
      ),
    );
    return { path, document: null, declaredRef: reference };
  }
  return {
    path,
    document: readCanonical(path, context, issues),
    declaredRef: reference,
  };
}

/** Load an instance manifest and every package, artifact, and application it registers. */
export function load(
  instanceManifestPath: string,
  options: CogaOptions = {},
): LoadedCogaInstance {
  const manifestPath = resolve(instanceManifestPath);
  const context = normalizeOptions(manifestPath, options);
  const loadIssues: ValidationIssue[] = [];
  const manifestOutsideRoot =
    context.profile !== "local" && !isWithinRoot(context.rootDir, manifestPath);
  if (manifestOutsideRoot) {
    loadIssues.push(
      issue(
        manifestPath,
        "load.path-outside-root",
        `Profile '${context.profile}' forbids the instance manifest outside '${context.rootDir}'.`,
      ),
    );
  }
  const instance: LoadedResource = {
    path: manifestPath,
    document: manifestOutsideRoot
      ? null
      : readCanonical(manifestPath, context, loadIssues),
  };
  const packages: LoadedResource[] = [];
  const artifacts: LoadedArtifact[] = [];
  const applications: LoadedResource[] = [];

  if (isCogaInstance(instance.document)) {
    for (const reference of looseLocatedReferences(
      instance.document,
      "packages",
    )) {
      const loadedPackage = loadLocated(
        reference,
        manifestPath,
        context,
        loadIssues,
      );
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
            context,
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
      applications.push(
        loadLocated(reference, manifestPath, context, loadIssues),
      );
    }
  }

  return {
    manifestPath,
    context,
    instance,
    packages,
    artifacts,
    applications,
    loadIssues,
  };
}
