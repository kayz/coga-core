import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parse as parseYaml } from "yaml";
import {
  isApplication,
  isDomainArtifact,
  isRecord,
  metadataOf,
} from "./guards.js";
import type {
  ContractReference,
  LoadedCogaInstance,
  LoadedResource,
  ValidationIssue,
} from "./types.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const { openapiV31 } = require("@apidevtools/openapi-schemas") as {
  openapiV31: object;
};
const openapiV31Base =
  require("@apidevtools/openapi-schemas/schemas/v3.1/schema-base.json") as object;
const openapiV31Dialect =
  require("@apidevtools/openapi-schemas/schemas/v3.1/dialect/base.schema.json") as object;
const openapiV31Meta =
  require("@apidevtools/openapi-schemas/schemas/v3.1/meta/base.schema.json") as object;

const contractAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(contractAjv);
contractAjv.addFormat("media-range", true);
contractAjv.addSchema(openapiV31Meta);
contractAjv.addSchema(openapiV31Dialect);
contractAjv.addSchema(openapiV31);
// The package's base schema supplies the dynamic JSON Schema dialect anchor
// expected by the official OpenAPI 3.1 schema. Compiling the inner schema
// directly makes Ajv resolve Schema Objects against their surrounding OAS
// object instead of that anchor.
const validateOpenApi = contractAjv.compile(openapiV31Base) as ValidateFunction;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

interface ContractSource {
  owner: LoadedResource;
  reference: ContractReference;
}

interface ParsedContract {
  document: unknown;
  raw: Buffer;
  references: string[];
}

interface ClosureState {
  bytes: number;
  nodes: number;
  documents: Map<string, ParsedContract>;
  failed: Set<string>;
  validated: Set<string>;
}

interface DocumentInspection {
  references: string[];
  safe: boolean;
}

function issue(
  path: string,
  code: string,
  message: string,
  resourceId?: string,
): ValidationIssue {
  const result: ValidationIssue = { severity: "error", code, message, path };
  if (resourceId) result.resourceId = resourceId;
  return result;
}

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

function inspectDocument(
  document: unknown,
  path: string,
  loaded: LoadedCogaInstance,
  state: ClosureState,
  issues: ValidationIssue[],
  resourceId: string | undefined,
): DocumentInspection {
  const references: string[] = [];
  const active = new WeakMap<object, string>();
  const stack: Array<{
    value: unknown;
    pointer: string;
    depth: number;
    exiting?: boolean;
  }> = [{ value: document, pointer: "", depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.exiting) {
      if (typeof current.value === "object" && current.value !== null) {
        active.delete(current.value);
      }
      continue;
    }
    state.nodes += 1;
    if (state.nodes > loaded.context.limits.maxNodes) {
      issues.push(
        issue(
          path,
          "contract.node-limit",
          `Contract closure exceeds ${loaded.context.limits.maxNodes} logical nodes.`,
          resourceId,
        ),
      );
      return { references, safe: false };
    }
    if (current.depth > loaded.context.limits.maxDepth) {
      issues.push(
        issue(
          path,
          "contract.depth-limit",
          `Contract exceeds depth ${loaded.context.limits.maxDepth} at '${current.pointer || "/"}'.`,
          resourceId,
        ),
      );
      return { references, safe: false };
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
          "contract.non-json-value",
          `Contract contains a non-JSON value at '${current.pointer || "/"}'.`,
          resourceId,
        ),
      );
      return { references, safe: false };
    }
    const object = current.value;
    const previous = active.get(object);
    if (previous !== undefined) {
      issues.push(
        issue(
          path,
          "contract.circular-value",
          `Contract contains a circular parsed value between '${previous || "/"}' and '${current.pointer || "/"}'.`,
          resourceId,
        ),
      );
      return { references, safe: false };
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
          "contract.special-object",
          `Contract contains a non-plain object at '${current.pointer || "/"}'.`,
          resourceId,
        ),
      );
      return { references, safe: false };
    }
    const record = object as Record<string, unknown>;
    if (typeof record.$ref === "string") references.push(record.$ref);
    const entries = Object.entries(record);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      const [key, child] = entry;
      stack.push({
        value: child,
        pointer: `${current.pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        depth: current.depth + 1,
      });
    }
  }
  return { references, safe: true };
}

function parseContractFile(
  path: string,
  loaded: LoadedCogaInstance,
  state: ClosureState,
  issues: ValidationIssue[],
  resourceId: string | undefined,
): ParsedContract | undefined {
  const existing = state.documents.get(path);
  if (existing) return existing;
  if (state.failed.has(path)) return undefined;
  try {
    const bounded = readBounded(path, loaded.context.limits.contractFileBytes);
    if (!bounded.raw) {
      issues.push(
        issue(
          path,
          "contract.file-too-large",
          `Contract file is at least ${bounded.size} bytes; the per-file limit is ${loaded.context.limits.contractFileBytes} bytes.`,
          resourceId,
        ),
      );
      state.failed.add(path);
      return undefined;
    }
    state.bytes += bounded.size;
    if (state.bytes > loaded.context.limits.contractFileBytes) {
      issues.push(
        issue(
          path,
          "contract.closure-too-large",
          `Contract closure exceeds ${loaded.context.limits.contractFileBytes} bytes.`,
          resourceId,
        ),
      );
      state.failed.add(path);
      return undefined;
    }
    const extension = extname(path).toLowerCase();
    if (![".json", ".yaml", ".yml"].includes(extension)) {
      issues.push(
        issue(
          path,
          "contract.unsupported-extension",
          "Contracts and local references must use .json, .yaml, or .yml.",
          resourceId,
        ),
      );
      state.failed.add(path);
      return undefined;
    }
    const raw = bounded.raw;
    let text: string;
    try {
      text = utf8Decoder.decode(raw);
    } catch {
      issues.push(
        issue(
          path,
          "contract.invalid-utf8",
          "Contract is not valid UTF-8.",
          resourceId,
        ),
      );
      state.failed.add(path);
      return undefined;
    }
    const document =
      extension === ".json"
        ? (JSON.parse(text) as unknown)
        : parseYaml(text, {
            maxAliasCount: loaded.context.limits.maxAliases,
            uniqueKeys: true,
          });
    const inspection = inspectDocument(
      document,
      path,
      loaded,
      state,
      issues,
      resourceId,
    );
    if (!inspection.safe) {
      state.failed.add(path);
      return undefined;
    }
    const parsed = { document, raw, references: inspection.references };
    state.documents.set(path, parsed);
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const aliasLimit = /excessive alias count/iu.test(detail);
    issues.push(
      issue(
        path,
        aliasLimit ? "contract.alias-limit" : "contract.load-failed",
        aliasLimit
          ? `Contract exceeds the YAML alias limit of ${loaded.context.limits.maxAliases}.`
          : `Unable to load contract: ${detail}`,
        resourceId,
      ),
    );
    state.failed.add(path);
    return undefined;
  }
}

function decodePointerToken(value: string): string {
  return decodeURIComponent(value).replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvesFragment(document: unknown, fragment: string): boolean {
  try {
    if (fragment === "" || fragment === "#") return true;
    const value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
    if (value.startsWith("/")) {
      let current: unknown = document;
      for (const token of value.slice(1).split("/").map(decodePointerToken)) {
        if (Array.isArray(current)) {
          const index = Number(token);
          if (!Number.isInteger(index) || index < 0 || index >= current.length)
            return false;
          current = current[index];
        } else if (isRecord(current) && Object.hasOwn(current, token)) {
          current = current[token];
        } else {
          return false;
        }
      }
      return true;
    }
    const anchor = decodeURIComponent(value);
    const stack: unknown[] = [document];
    const seen = new WeakSet<object>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (typeof current !== "object" || current === null) continue;
      if (seen.has(current)) continue;
      seen.add(current);
      if (
        !Array.isArray(current) &&
        (current as Record<string, unknown>).$anchor === anchor
      ) {
        return true;
      }
      stack.push(
        ...(Array.isArray(current) ? current : Object.values(current)),
      );
    }
    return false;
  } catch {
    return false;
  }
}

function validateReferenceClosure(
  rootPath: string,
  contractRoot: string,
  loaded: LoadedCogaInstance,
  state: ClosureState,
  issues: ValidationIssue[],
  resourceId: string | undefined,
): void {
  const queued = new Set<string>([rootPath]);
  const queue: Array<{ path: string; depth: number }> = [
    { path: rootPath, depth: 0 },
  ];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (!current || state.validated.has(current.path)) continue;
    const parsed = state.documents.get(current.path);
    if (!parsed) continue;
    for (const reference of parsed.references) {
      const hashIndex = reference.indexOf("#");
      const filePart =
        hashIndex >= 0 ? reference.slice(0, hashIndex) : reference;
      const fragment = hashIndex >= 0 ? reference.slice(hashIndex) : "";
      if (/^[a-z][a-z0-9+.-]*:/iu.test(filePart)) {
        issues.push(
          issue(
            current.path,
            "contract.remote-ref",
            `Remote or URI contract reference '${reference}' is forbidden.`,
            resourceId,
          ),
        );
        continue;
      }
      const targetPath = filePart
        ? comparablePath(resolve(dirname(current.path), filePart))
        : current.path;
      if (!isWithinRoot(contractRoot, targetPath)) {
        issues.push(
          issue(
            current.path,
            "contract.ref-outside-root",
            `Contract reference '${reference}' resolves outside '${contractRoot}'.`,
            resourceId,
          ),
        );
        continue;
      }
      const targetDepth = filePart ? current.depth + 1 : current.depth;
      if (targetDepth > loaded.context.limits.maxDepth) {
        issues.push(
          issue(
            current.path,
            "contract.ref-depth-limit",
            `Contract reference closure exceeds depth ${loaded.context.limits.maxDepth} at '${reference}'.`,
            resourceId,
          ),
        );
        continue;
      }
      const target = filePart
        ? parseContractFile(targetPath, loaded, state, issues, resourceId)
        : parsed;
      if (!target) continue;
      if (!resolvesFragment(target.document, fragment)) {
        issues.push(
          issue(
            current.path,
            "contract.dangling-ref",
            `Contract reference '${reference}' does not resolve.`,
            resourceId,
          ),
        );
      }
      if (filePart && !queued.has(targetPath)) {
        queued.add(targetPath);
        queue.push({ path: targetPath, depth: targetDepth });
      }
    }
    state.validated.add(current.path);
  }
}

function contractIdentity(
  document: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(document) || !isRecord(document["x-coga-contract"])) {
    return undefined;
  }
  return document["x-coga-contract"];
}

function validateRootFormat(
  path: string,
  parsed: ParsedContract,
  reference: ContractReference,
  issues: ValidationIssue[],
  resourceId: string | undefined,
): void {
  const identity = contractIdentity(parsed.document);
  if (!identity) {
    issues.push(
      issue(
        path,
        "contract.identity-required",
        "Contract root must declare x-coga-contract with id and version.",
        resourceId,
      ),
    );
  } else {
    if (identity.id !== reference.id) {
      issues.push(
        issue(
          path,
          "contract.identity-mismatch",
          `Contract declares id '${String(identity.id ?? "")}', expected '${reference.id}'.`,
          resourceId,
        ),
      );
    }
    if (identity.version !== reference.version) {
      issues.push(
        issue(
          path,
          "contract.version-mismatch",
          `Contract declares version '${String(identity.version ?? "")}', expected '${reference.version}'.`,
          resourceId,
        ),
      );
    }
  }

  if (reference.format === "json-schema-2020-12") {
    if (
      !isRecord(parsed.document) ||
      parsed.document.$schema !==
        "https://json-schema.org/draft/2020-12/schema" ||
      !contractAjv.validateSchema(parsed.document)
    ) {
      const details = (contractAjv.errors ?? [])
        .map(
          (entry) =>
            `${entry.instancePath || "/"} ${entry.message ?? "invalid"}`,
        )
        .join("; ");
      issues.push(
        issue(
          path,
          "contract.json-schema-invalid",
          `Contract must be a valid JSON Schema Draft 2020-12 document${details ? `: ${details}` : "."}`,
          resourceId,
        ),
      );
    }
    return;
  }

  const openapiVersion =
    isRecord(parsed.document) && typeof parsed.document.openapi === "string"
      ? parsed.document.openapi
      : "";
  const info = isRecord(parsed.document) ? parsed.document.info : undefined;
  const infoVersion = isRecord(info) ? info.version : undefined;
  if (
    !/^3\.1\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(openapiVersion) ||
    infoVersion !== reference.version ||
    !validateOpenApi(parsed.document)
  ) {
    const details = (validateOpenApi.errors ?? [])
      .slice(0, 10)
      .map(
        (entry) => `${entry.instancePath || "/"} ${entry.message ?? "invalid"}`,
      )
      .join("; ");
    issues.push(
      issue(
        path,
        "contract.openapi-invalid",
        `Contract must be valid OpenAPI 3.1 and info.version must equal '${reference.version}'${details ? `: ${details}` : "."}`,
        resourceId,
      ),
    );
  }
}

function isContractReference(value: unknown): value is ContractReference {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.version === "string" &&
    typeof value.path === "string" &&
    (value.format === "json-schema-2020-12" || value.format === "openapi-3.1")
  );
}

function contractSources(loaded: LoadedCogaInstance): ContractSource[] {
  const sources: ContractSource[] = [];
  for (const owner of loaded.artifacts) {
    if (!isDomainArtifact(owner.document)) continue;
    const references = Array.isArray(owner.document.spec.contractRefs)
      ? owner.document.spec.contractRefs
      : [];
    for (const reference of references) {
      if (!isContractReference(reference)) continue;
      sources.push({ owner, reference });
    }
  }
  for (const owner of loaded.applications) {
    if (!isApplication(owner.document)) continue;
    const references = Array.isArray(owner.document.spec.contracts)
      ? owner.document.spec.contracts
      : [];
    for (const reference of references) {
      if (!isContractReference(reference)) continue;
      sources.push({ owner, reference });
    }
  }
  return sources;
}

export function validateContracts(
  loaded: LoadedCogaInstance,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const source of contractSources(loaded)) {
    const resourceId = metadataOf(source.owner.document)?.id;
    const path = comparablePath(
      resolve(dirname(source.owner.path), source.reference.path),
    );
    const contractRoot = comparablePath(loaded.context.rootDir);
    if (
      loaded.context.profile !== "local" &&
      !isWithinRoot(contractRoot, path)
    ) {
      issues.push(
        issue(
          path,
          "contract.path-outside-root",
          `Contract path resolves outside '${contractRoot}'.`,
          resourceId,
        ),
      );
      continue;
    }
    const state: ClosureState = {
      bytes: 0,
      nodes: 0,
      documents: new Map(),
      failed: new Set(),
      validated: new Set(),
    };
    const parsed = parseContractFile(path, loaded, state, issues, resourceId);
    if (!parsed) continue;
    validateRootFormat(path, parsed, source.reference, issues, resourceId);
    validateReferenceClosure(
      path,
      contractRoot,
      loaded,
      state,
      issues,
      resourceId,
    );
    const digest = `sha256:${createHash("sha256").update(parsed.raw).digest("hex")}`;
    if (loaded.context.profile === "release" && !source.reference.digest) {
      issues.push(
        issue(
          path,
          "contract.digest-required",
          "Release profile requires a sha256 contract digest.",
          resourceId,
        ),
      );
    } else if (source.reference.digest && source.reference.digest !== digest) {
      issues.push(
        issue(
          path,
          "contract.digest-mismatch",
          `Contract digest '${source.reference.digest}' does not match '${digest}'.`,
          resourceId,
        ),
      );
    }
  }
  return issues;
}
