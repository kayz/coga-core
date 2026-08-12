import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parse as parseYaml } from "yaml";
import type { ExactReference } from "@coga/core";
import type {
  PlatformEvidence,
  PlatformGateResult,
  WechatPlatformCheckKind,
} from "./operations-types.js";
import { WECHAT_PLATFORM_CHECKS } from "./operations-types.js";
import type { Sha256Digest } from "./types.js";
import {
  canonicalJson,
  compareText,
  normalizeRelativePath,
  readBoundedFile,
  sha256,
  verifyFileReference,
} from "./utils.js";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_DOCUMENT_DEPTH = 32;
const MAX_DOCUMENT_NODES = 20_000;
const MAX_BLOCKERS = 64;

function compiler(): ValidateFunction {
  const document = JSON.parse(
    readFileSync(
      new URL("../schemas/platform-evidence.schema.json", import.meta.url),
      "utf8",
    ),
  ) as object;
  const require = createRequire(import.meta.url);
  const addFormats = require("ajv-formats") as FormatsPlugin;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(document);
}

const validatePlatformEvidence = compiler();

function formatErrors(value: ErrorObject[] | null | undefined): string {
  return (value ?? [])
    .map(
      (entry) =>
        `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`,
    )
    .sort(compareText)
    .slice(0, 20)
    .join("; ");
}

function inspectJson(value: unknown, label: string): void {
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.exit) {
      active.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_DOCUMENT_NODES)
      throw new Error(`${label} exceeds its node budget.`);
    if (current.depth > MAX_DOCUMENT_DEPTH)
      throw new Error(`${label} exceeds its depth budget.`);
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean" ||
      (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      throw new Error(`${label} contains a non-JSON value.`);
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (
      !Array.isArray(current.value) &&
      prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw new Error(`${label} contains a special object.`);
    }
    if (active.has(current.value))
      throw new Error(`${label} contains a cycle.`);
    active.add(current.value);
    stack.push({ ...current, exit: true });
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

function readDocument(path: string): unknown {
  const extension = extname(path).toLowerCase();
  if (![".json", ".yaml", ".yml"].includes(extension)) {
    throw new Error("Platform Evidence must use JSON or YAML.");
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(path, "Platform Evidence", MAX_DOCUMENT_BYTES),
  );
  let value: unknown;
  try {
    if (extension === ".json") {
      value = JSON.parse(source) as unknown;
      parseYaml(source, { maxAliasCount: 0, uniqueKeys: true });
    } else {
      value = parseYaml(source, { maxAliasCount: 25, uniqueKeys: true });
    }
  } catch (error) {
    throw new Error(
      `Platform Evidence is not valid ${extension === ".json" ? "JSON" : "YAML"}: ${
        error instanceof Error ? error.message : "parse failure"
      }`,
    );
  }
  inspectJson(value, "Platform Evidence");
  return value;
}

function evidencePayload(value: PlatformEvidence): unknown {
  const { evidenceDigest: _digest, ...metadata } = value.metadata;
  return { ...value, metadata };
}

export function platformEvidenceDigest(value: PlatformEvidence): Sha256Digest {
  return sha256(canonicalJson(evidencePayload(value)));
}

function assertPlatformEvidence(
  value: unknown,
): asserts value is PlatformEvidence {
  inspectJson(value, "Platform Evidence");
  if (!validatePlatformEvidence(value)) {
    throw new Error(
      `Invalid Platform Evidence: ${formatErrors(validatePlatformEvidence.errors)}.`,
    );
  }
  const evidence = value as PlatformEvidence;
  if (platformEvidenceDigest(evidence) !== evidence.metadata.evidenceDigest) {
    throw new Error("Platform Evidence logical digest is inconsistent.");
  }
  const generatedAt = Date.parse(evidence.metadata.generatedAt);
  if (!Number.isFinite(generatedAt)) {
    throw new Error("Platform Evidence generatedAt is invalid.");
  }
  const kinds = evidence.checks.map((entry) => entry.kind);
  if (new Set(kinds).size !== WECHAT_PLATFORM_CHECKS.length) {
    throw new Error(
      "Platform Evidence checks must be four unique check kinds.",
    );
  }
  for (const kind of WECHAT_PLATFORM_CHECKS) {
    if (!kinds.includes(kind)) {
      throw new Error(`Platform Evidence is missing '${kind}'.`);
    }
  }
  for (const check of evidence.checks) {
    const observedAt = Date.parse(check.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > generatedAt) {
      throw new Error(
        `Platform Evidence '${check.kind}' observation must not postdate generatedAt.`,
      );
    }
  }
  const paths = new Set<string>();
  const digests = new Set<string>();
  const references = [
    evidence.subject.buildArtifact,
    ...evidence.checks.flatMap((entry) => entry.evidence),
  ];
  for (const reference of references) {
    normalizeRelativePath(reference.path, "Platform Evidence file path");
    if (paths.has(reference.path)) {
      throw new Error(
        "Platform Evidence contains duplicate evidence file paths.",
      );
    }
    if (digests.has(reference.digest)) {
      throw new Error(
        "Platform Evidence contains duplicate evidence file digests.",
      );
    }
    paths.add(reference.path);
    digests.add(reference.digest);
  }
}

export function loadPlatformEvidence(path: string): PlatformEvidence {
  const value = readDocument(path);
  assertPlatformEvidence(value);
  return value;
}

export interface PlatformEvidenceExpected {
  application: ExactReference;
  candidateCommit: string;
}

export interface PlatformGateOptions {
  maxFileBytes?: number;
}

function exactReference(reference: ExactReference): string {
  return `${reference.id}@${reference.version}`;
}

function addBlocker(
  blockers: string[],
  seen: Set<string>,
  value: string,
): void {
  if (seen.has(value)) return;
  if (blockers.length >= MAX_BLOCKERS) {
    throw new Error("Platform Evidence blocker budget exceeded.");
  }
  seen.add(value);
  blockers.push(value);
}

export function evaluatePlatformEvidence(
  repositoryRoot: string,
  evidenceValue: PlatformEvidence | unknown,
  expected: PlatformEvidenceExpected,
  options: PlatformGateOptions = {},
): PlatformGateResult {
  assertPlatformEvidence(evidenceValue);
  if (
    !expected ||
    typeof expected !== "object" ||
    Object.keys(expected).length !== 2 ||
    !expected.application ||
    typeof expected.application !== "object" ||
    Object.keys(expected.application).length !== 2 ||
    typeof expected.application?.id !== "string" ||
    expected.application.id.length < 1 ||
    expected.application.id.length > 200 ||
    typeof expected.application.version !== "string" ||
    expected.application.version.length < 1 ||
    expected.application.version.length > 100 ||
    !/^[0-9a-f]{40}$/u.test(expected.candidateCommit)
  ) {
    throw new Error("Platform Evidence expected identity is malformed.");
  }
  const blockers: string[] = [];
  const seen = new Set<string>();
  const evidence = evidenceValue;
  if (
    exactReference(evidence.subject.application) !==
    exactReference(expected.application)
  ) {
    addBlocker(
      blockers,
      seen,
      "Platform Evidence application does not match the expected Application.",
    );
  }
  if (evidence.subject.candidateCommit !== expected.candidateCommit) {
    addBlocker(
      blockers,
      seen,
      "Platform Evidence candidate commit does not match the expected candidate.",
    );
  }

  const limit = options.maxFileBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 * 1024 * 1024) {
    throw new Error("Platform Evidence file byte limit is invalid.");
  }
  const references: Array<{ label: string; path: string; digest: string }> = [
    { label: "build artifact", ...evidence.subject.buildArtifact },
    ...[...evidence.checks]
      .sort((left, right) => compareText(left.kind, right.kind))
      .flatMap((check) =>
        check.evidence.map((reference, index) => ({
          label: `${check.kind} evidence[${index}]`,
          ...reference,
        })),
      ),
  ];
  for (const reference of references) {
    try {
      verifyFileReference(
        repositoryRoot,
        reference,
        `Platform Evidence ${reference.label}`,
        limit,
      );
    } catch {
      addBlocker(
        blockers,
        seen,
        `Platform Evidence ${reference.label} content or digest verification failed.`,
      );
    }
  }
  return {
    eligible: blockers.length === 0,
    blockers,
    application: evidence.subject.application,
    candidateCommit: evidence.subject.candidateCommit,
  };
}

export function wechatPlatformCheckOrder(): readonly WechatPlatformCheckKind[] {
  return WECHAT_PLATFORM_CHECKS;
}
