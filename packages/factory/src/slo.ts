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
import type {
  FactorySloObjectiveResult,
  FactorySloPolicy,
  FactorySloReport,
  FactoryTaskEvent,
  FactoryTaskRecord,
} from "./operations-types.js";
import {
  FACTORY_OPERATIONS_SCHEMA_VERSION,
  FACTORY_TASK_PHASES,
} from "./operations-types.js";
import type { Sha256Digest } from "./types.js";
import {
  canonicalJson,
  compareText,
  normalizeRelativePath,
  readBoundedFile,
  sha256,
} from "./utils.js";

const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_DOCUMENT_DEPTH = 32;
const MAX_DOCUMENT_NODES = 20_000;
const DEFAULT_MAX_RECORDS = 100_000;
const MAX_EVENTS_PER_RECORD = 10_000;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CREDENTIAL_MATERIAL =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:token|password|client_secret|api_key)\s*[=:]\s*\S+|\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,})/iu;

function compiler(name: string): ValidateFunction {
  const document = JSON.parse(
    readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"),
  ) as object;
  const require = createRequire(import.meta.url);
  const addFormats = require("ajv-formats") as FormatsPlugin;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(document);
}

const validateSloPolicy = compiler("slo-policy.schema.json");

function errors(value: ErrorObject[] | null | undefined): string {
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
    if (nodes > MAX_DOCUMENT_NODES) {
      throw new Error(`${label} exceeds the ${MAX_DOCUMENT_NODES}-node limit.`);
    }
    if (current.depth > MAX_DOCUMENT_DEPTH) {
      throw new Error(`${label} exceeds the depth limit.`);
    }
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

function assertNoSecretMaterial(value: unknown, label: string): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (CREDENTIAL_MATERIAL.test(current)) {
        throw new Error(`${label} contains credential-like material.`);
      }
      continue;
    }
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        const normalized = key.toLowerCase().replace(/[-_]/gu, "");
        if (
          [
            "token",
            "password",
            "secret",
            "apikey",
            "clientsecret",
            "privatekey",
            "accesskey",
            "authorization",
            "credential",
            "credentials",
          ].includes(normalized)
        ) {
          throw new Error(`${label}.${key} is a forbidden secret field.`);
        }
        stack.push(child);
      }
    }
  }
}

function readDocument(path: string, label: string): unknown {
  const extension = extname(path).toLowerCase();
  if (![".json", ".yaml", ".yml"].includes(extension)) {
    throw new Error(`${label} must use JSON or YAML.`);
  }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(path, label, MAX_DOCUMENT_BYTES),
  );
  let value: unknown;
  try {
    if (extension === ".json") {
      value = JSON.parse(source) as unknown;
      // The YAML parser is used only as an independent duplicate-key check.
      parseYaml(source, { maxAliasCount: 0, uniqueKeys: true });
    } else {
      value = parseYaml(source, { maxAliasCount: 25, uniqueKeys: true });
    }
  } catch (error) {
    throw new Error(
      `${label} is not valid ${extension === ".json" ? "JSON" : "YAML"}: ${
        error instanceof Error ? error.message : "parse failure"
      }`,
    );
  }
  inspectJson(value, label);
  return value;
}

function assertSloPolicy(value: unknown): asserts value is FactorySloPolicy {
  inspectJson(value, "Factory SLO Policy");
  if (!validateSloPolicy(value)) {
    throw new Error(
      `Invalid Factory SLO Policy: ${errors(validateSloPolicy.errors)}.`,
    );
  }
  const policy = value as FactorySloPolicy;
  const from = timestamp(policy.window.from, "Factory SLO Policy window.from");
  const to = timestamp(policy.window.to, "Factory SLO Policy window.to");
  if (from >= to) {
    throw new Error("Factory SLO Policy window.from must precede window.to.");
  }
}

export function loadFactorySloPolicy(path: string): FactorySloPolicy {
  const value = readDocument(path, "Factory SLO Policy");
  assertSloPolicy(value);
  return value;
}

function timestamp(value: string, label: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result))
    throw new Error(`${label} is not a valid date-time.`);
  return result;
}

function canonicalTimestamp(value: unknown, label: string): number {
  const text = boundedString(value, label, 100);
  const result = timestamp(text, label);
  if (new Date(result).toISOString() !== text) {
    throw new Error(`${label} must be a canonical UTC date-time.`);
  }
  return result;
}

function object(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  if (
    required.some((key) => !(key in record)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has missing or unknown fields.`);
  }
  return record;
}

function boundedString(value: unknown, label: string, maximum = 4_000): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} is not a bounded non-empty string.`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} is outside its integer bounds.`);
  }
  return value as number;
}

function validateExactReference(value: unknown, label: string): void {
  const reference = object(value, label, ["id", "version"]);
  boundedString(reference.id, `${label}.id`, 256);
  boundedString(reference.version, `${label}.version`, 128);
}

function validateTargetOutcome(value: unknown, label: string): void {
  const candidate = object(
    value,
    label,
    ["status", "application", "branch"],
    [
      "baseCommit",
      "resultCommit",
      "evidencePath",
      "evidenceDigest",
      "pullRequest",
      "failure",
    ],
  );
  validateExactReference(candidate.application, `${label}.application`);
  boundedString(candidate.branch, `${label}.branch`, 4_096);
  if (candidate.status === "completed") {
    const completed = object(
      value,
      label,
      [
        "status",
        "application",
        "baseCommit",
        "resultCommit",
        "branch",
        "evidencePath",
        "evidenceDigest",
      ],
      ["pullRequest"],
    );
    if (
      !COMMIT.test(String(completed.baseCommit)) ||
      !COMMIT.test(String(completed.resultCommit))
    ) {
      throw new Error(`${label} has a malformed commit.`);
    }
    normalizeRelativePath(
      boundedString(completed.evidencePath, `${label}.evidencePath`, 500),
      `${label}.evidencePath`,
    );
    if (!DIGEST.test(String(completed.evidenceDigest))) {
      throw new Error(`${label}.evidenceDigest is malformed.`);
    }
    if (completed.pullRequest !== undefined) {
      const pullRequest = object(
        completed.pullRequest,
        `${label}.pullRequest`,
        ["number", "url", "state", "draft", "author"],
      );
      safeInteger(
        pullRequest.number,
        `${label}.pullRequest.number`,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      boundedString(pullRequest.url, `${label}.pullRequest.url`, 2_000);
      boundedString(pullRequest.state, `${label}.pullRequest.state`, 100);
      boundedString(pullRequest.author, `${label}.pullRequest.author`, 100);
      if (typeof pullRequest.draft !== "boolean") {
        throw new Error(`${label}.pullRequest.draft is invalid.`);
      }
    }
    return;
  }
  if (candidate.status === "failed") {
    const failed = object(value, label, [
      "status",
      "application",
      "branch",
      "failure",
    ]);
    boundedString(failed.failure, `${label}.failure`, 16_384);
    return;
  }
  throw new Error(`${label}.status is invalid.`);
}

function validateResult(value: unknown, label: string): void {
  const result = object(value, label, [
    "status",
    "workOrderId",
    "baseCommit",
    "targets",
  ]);
  if (!["completed", "partial", "failed"].includes(String(result.status))) {
    throw new Error(`${label}.status is invalid.`);
  }
  boundedString(result.workOrderId, `${label}.workOrderId`, 256);
  if (!COMMIT.test(String(result.baseCommit))) {
    throw new Error(`${label}.baseCommit is malformed.`);
  }
  if (!Array.isArray(result.targets) || result.targets.length > 10_000) {
    throw new Error(`${label}.targets exceeds its entry budget.`);
  }
  result.targets.forEach((entry, targetIndex) =>
    validateTargetOutcome(entry, `${label}.targets[${targetIndex}]`),
  );
}

function eventPayload(event: FactoryTaskEvent): unknown {
  const { digest: _digest, ...payload } = event;
  return payload;
}

function validateTaskRecord(value: unknown, index: number): FactoryTaskRecord {
  const label = `Factory task record[${index}]`;
  inspectJson(value, label);
  assertNoSecretMaterial(value, label);
  const record = object(
    value,
    label,
    [
      "schemaVersion",
      "kind",
      "metadata",
      "spec",
      "phase",
      "attempts",
      "recoveryCount",
      "timing",
      "events",
    ],
    ["nextAttemptAt", "lease", "result", "failure"],
  );
  if (
    record.schemaVersion !== FACTORY_OPERATIONS_SCHEMA_VERSION ||
    record.kind !== "FactoryTask" ||
    !FACTORY_TASK_PHASES.includes(
      record.phase as (typeof FACTORY_TASK_PHASES)[number],
    )
  ) {
    throw new Error(`${label} has an unsupported identity or phase.`);
  }

  const metadata = object(record.metadata, `${label}.metadata`, [
    "id",
    "createdAt",
    "updatedAt",
    "recordDigest",
  ]);
  if (
    !DIGEST.test(String(metadata.id)) ||
    !DIGEST.test(String(metadata.recordDigest))
  ) {
    throw new Error(`${label} has a malformed task or record digest.`);
  }
  canonicalTimestamp(metadata.createdAt, `${label}.metadata.createdAt`);
  canonicalTimestamp(metadata.updatedAt, `${label}.metadata.updatedAt`);

  const spec = object(record.spec, `${label}.spec`, [
    "repositoryRoot",
    "workOrderPath",
    "workOrderDigest",
    "baseCommit",
    "delivery",
    "keepWorkspace",
    "maxAttempts",
  ]);
  boundedString(spec.repositoryRoot, `${label}.spec.repositoryRoot`, 4_096);
  normalizeRelativePath(
    boundedString(spec.workOrderPath, `${label}.spec.workOrderPath`, 500),
    `${label}.spec.workOrderPath`,
  );
  if (
    !DIGEST.test(String(spec.workOrderDigest)) ||
    !COMMIT.test(String(spec.baseCommit))
  ) {
    throw new Error(`${label}.spec has a malformed digest or commit.`);
  }
  if (
    !["local", "github"].includes(String(spec.delivery)) ||
    typeof spec.keepWorkspace !== "boolean"
  ) {
    throw new Error(`${label}.spec has an invalid delivery setting.`);
  }
  const maxAttempts = safeInteger(
    spec.maxAttempts,
    `${label}.spec.maxAttempts`,
    1,
    100,
  );
  safeInteger(record.attempts, `${label}.attempts`, 0, maxAttempts);
  safeInteger(record.recoveryCount, `${label}.recoveryCount`, 0, 1_000_000);
  if (sha256(canonicalJson(spec)) !== metadata.id) {
    throw new Error(
      `${label} task id does not bind the exact normalized request.`,
    );
  }

  const timing = object(
    record.timing,
    `${label}.timing`,
    ["enqueuedAt"],
    ["startedAt", "finishedAt", "runDurationMs"],
  );
  const enqueuedAt = canonicalTimestamp(
    timing.enqueuedAt,
    `${label}.timing.enqueuedAt`,
  );
  const startedAt =
    timing.startedAt === undefined
      ? undefined
      : canonicalTimestamp(timing.startedAt, `${label}.timing.startedAt`);
  const finishedAt =
    timing.finishedAt === undefined
      ? undefined
      : canonicalTimestamp(timing.finishedAt, `${label}.timing.finishedAt`);
  const runDurationMs =
    timing.runDurationMs === undefined
      ? undefined
      : safeInteger(
          timing.runDurationMs,
          `${label}.timing.runDurationMs`,
          0,
          Number.MAX_SAFE_INTEGER,
        );
  if (startedAt !== undefined && startedAt < enqueuedAt) {
    throw new Error(`${label} starts before it was enqueued.`);
  }
  if (
    finishedAt !== undefined &&
    (startedAt === undefined || finishedAt < startedAt)
  ) {
    throw new Error(`${label} has inconsistent start and finish timing.`);
  }
  if (
    (finishedAt === undefined) !== (runDurationMs === undefined) ||
    (finishedAt !== undefined &&
      startedAt !== undefined &&
      runDurationMs !== finishedAt - startedAt)
  ) {
    throw new Error(
      `${label} runDurationMs does not bind the recorded timing.`,
    );
  }

  if (
    !Array.isArray(record.events) ||
    record.events.length < 1 ||
    record.events.length > MAX_EVENTS_PER_RECORD
  ) {
    throw new Error(`${label}.events is outside its entry budget.`);
  }
  let previousDigest: Sha256Digest | undefined;
  let previousAt = -Infinity;
  let recovered = 0;
  let leased = 0;
  let firstLeasedAt: string | undefined;
  let lastLeasedAt: string | undefined;
  let lastHeartbeatAt: string | undefined;
  let activeWorker: string | undefined;
  let activeLease: string | undefined;
  let derivedPhase: FactoryTaskRecord["phase"] = "queued";
  for (let eventIndex = 0; eventIndex < record.events.length; eventIndex += 1) {
    const eventLabel = `${label}.events[${eventIndex}]`;
    const entry = object(
      record.events[eventIndex],
      eventLabel,
      ["sequence", "type", "at", "digest"],
      ["previousDigest", "workerId", "leaseId", "detail"],
    );
    safeInteger(
      entry.sequence,
      `${eventLabel}.sequence`,
      1,
      MAX_EVENTS_PER_RECORD,
    );
    if (entry.sequence !== eventIndex + 1)
      throw new Error(`${eventLabel} sequence is not contiguous.`);
    if (
      ![
        "enqueued",
        "leased",
        "heartbeat",
        "recovered",
        "retry-scheduled",
        "succeeded",
        "failed",
        "cancelled",
      ].includes(String(entry.type))
    ) {
      throw new Error(`${eventLabel}.type is invalid.`);
    }
    const atText = boundedString(entry.at, `${eventLabel}.at`, 100);
    const at = canonicalTimestamp(atText, `${eventLabel}.at`);
    if (at < previousAt)
      throw new Error(`${eventLabel} moves backward in time.`);
    previousAt = at;
    if (eventIndex === 0) {
      if (entry.type !== "enqueued" || entry.previousDigest !== undefined) {
        throw new Error(`${eventLabel} must be the unlinked enqueued event.`);
      }
    } else if (entry.previousDigest !== previousDigest) {
      throw new Error(
        `${eventLabel}.previousDigest does not bind the prior event.`,
      );
    }
    if (!DIGEST.test(String(entry.digest)))
      throw new Error(`${eventLabel}.digest is malformed.`);
    const expected = sha256(
      canonicalJson(eventPayload(entry as unknown as FactoryTaskEvent)),
    );
    if (entry.digest !== expected)
      throw new Error(`${eventLabel}.digest is inconsistent.`);
    previousDigest = entry.digest as Sha256Digest;
    for (const optional of ["workerId", "leaseId", "detail"] as const) {
      if (entry[optional] !== undefined) {
        const text = boundedString(
          entry[optional],
          `${eventLabel}.${optional}`,
          optional === "detail" ? 16_384 : 128,
        );
        if (optional !== "detail" && !SAFE_ID.test(text)) {
          throw new Error(
            `${eventLabel}.${optional} is not a safe identifier.`,
          );
        }
      }
    }
    if (eventIndex === 0) continue;
    if (["succeeded", "failed", "cancelled"].includes(derivedPhase)) {
      throw new Error(`${eventLabel} follows a terminal event.`);
    }
    if (entry.type === "enqueued") {
      throw new Error(`${eventLabel} repeats the enqueued event.`);
    }
    if (entry.type === "leased") {
      if (
        derivedPhase !== "queued" ||
        typeof entry.workerId !== "string" ||
        typeof entry.leaseId !== "string"
      ) {
        throw new Error(`${eventLabel} cannot lease from the current state.`);
      }
      derivedPhase = "leased";
      activeWorker = entry.workerId;
      activeLease = entry.leaseId;
      leased += 1;
      firstLeasedAt ??= atText;
      lastLeasedAt = atText;
      lastHeartbeatAt = atText;
      continue;
    }
    if (entry.type === "heartbeat") {
      if (
        derivedPhase !== "leased" ||
        entry.workerId !== activeWorker ||
        entry.leaseId !== activeLease
      ) {
        throw new Error(`${eventLabel} does not match the active lease.`);
      }
      lastHeartbeatAt = atText;
      continue;
    }
    if (entry.type === "recovered" || entry.type === "retry-scheduled") {
      if (
        derivedPhase !== "leased" ||
        entry.workerId !== activeWorker ||
        entry.leaseId !== activeLease
      ) {
        throw new Error(`${eventLabel} does not match the active lease.`);
      }
      derivedPhase = "queued";
      activeWorker = undefined;
      activeLease = undefined;
      if (entry.type === "recovered") recovered += 1;
      continue;
    }
    if (entry.type === "succeeded") {
      if (
        derivedPhase !== "leased" ||
        entry.workerId !== activeWorker ||
        entry.leaseId !== activeLease
      ) {
        throw new Error(`${eventLabel} does not match the active lease.`);
      }
      derivedPhase = "succeeded";
      activeWorker = undefined;
      activeLease = undefined;
      continue;
    }
    if (entry.type === "failed") {
      const afterRecovery =
        derivedPhase === "queued" &&
        record.events[eventIndex - 1]?.type === "recovered";
      const activeFailure =
        derivedPhase === "leased" &&
        entry.workerId === activeWorker &&
        entry.leaseId === activeLease;
      if (!afterRecovery && !activeFailure) {
        throw new Error(
          `${eventLabel} does not follow an active lease or recovery.`,
        );
      }
      derivedPhase = "failed";
      activeWorker = undefined;
      activeLease = undefined;
      continue;
    }
    if (entry.type === "cancelled") {
      if (entry.workerId !== undefined || entry.leaseId !== undefined) {
        throw new Error(
          `${eventLabel} cancellation must not claim a worker lease.`,
        );
      }
      derivedPhase = "cancelled";
      activeWorker = undefined;
      activeLease = undefined;
    }
  }
  const firstEvent = record.events[0] as FactoryTaskEvent;
  const lastEvent = record.events[record.events.length - 1] as FactoryTaskEvent;
  if (
    firstEvent.at !== timing.enqueuedAt ||
    metadata.createdAt !== timing.enqueuedAt
  ) {
    throw new Error(
      `${label} enqueued timing is inconsistent with its audit event.`,
    );
  }
  const expectedStartedAt =
    leased === 0 && record.phase === "cancelled" ? lastEvent.at : firstLeasedAt;
  if (timing.startedAt !== expectedStartedAt) {
    throw new Error(
      `${label} started timing is inconsistent with its first lease.`,
    );
  }
  if (metadata.updatedAt !== lastEvent.at) {
    throw new Error(
      `${label} updatedAt is inconsistent with its latest audit event.`,
    );
  }
  if (record.recoveryCount !== recovered) {
    throw new Error(
      `${label} recoveryCount is inconsistent with its audit events.`,
    );
  }
  if (record.attempts !== leased || record.recoveryCount > record.attempts) {
    throw new Error(
      `${label} attempts are inconsistent with its lease history.`,
    );
  }
  if (record.phase !== derivedPhase) {
    throw new Error(`${label} phase is inconsistent with its audit events.`);
  }

  const phase = record.phase as FactoryTaskRecord["phase"];
  const terminalType =
    phase === "succeeded"
      ? "succeeded"
      : phase === "failed"
        ? "failed"
        : phase === "cancelled"
          ? "cancelled"
          : undefined;
  if (
    (terminalType === undefined) !== (timing.finishedAt === undefined) ||
    (terminalType !== undefined && lastEvent.type !== terminalType)
  ) {
    throw new Error(
      `${label} phase, finish timing, and final event are inconsistent.`,
    );
  }
  if ((phase === "succeeded") !== (record.result !== undefined)) {
    throw new Error(`${label}.result does not match the succeeded phase.`);
  }
  if (record.result !== undefined) {
    validateResult(record.result, `${label}.result`);
  }
  if ((phase === "failed") !== (record.failure !== undefined)) {
    throw new Error(`${label}.failure does not match the failed phase.`);
  }
  if (record.failure !== undefined) {
    const failure = object(record.failure, `${label}.failure`, [
      "kind",
      "message",
      "occurredAt",
    ]);
    if (
      !["transient", "permanent", "isolation"].includes(String(failure.kind))
    ) {
      throw new Error(`${label}.failure.kind is invalid.`);
    }
    boundedString(failure.message, `${label}.failure.message`, 16_384);
    canonicalTimestamp(failure.occurredAt, `${label}.failure.occurredAt`);
    const lastFailureEvent = [...record.events]
      .reverse()
      .find(
        (entry) => entry.type === "failed" || entry.type === "retry-scheduled",
      );
    if (!lastFailureEvent || failure.occurredAt !== lastFailureEvent.at) {
      throw new Error(`${label}.failure occurredAt is inconsistent.`);
    }
  }
  if (record.lease !== undefined) {
    const lease = object(record.lease, `${label}.lease`, [
      "id",
      "workerId",
      "acquiredAt",
      "heartbeatAt",
      "expiresAt",
    ]);
    for (const key of ["id", "workerId"] as const) {
      const text = boundedString(lease[key], `${label}.lease.${key}`, 128);
      if (!SAFE_ID.test(text))
        throw new Error(`${label}.lease.${key} is not a safe identifier.`);
    }
    const acquired = canonicalTimestamp(
      lease.acquiredAt,
      `${label}.lease.acquiredAt`,
    );
    const heartbeat = canonicalTimestamp(
      lease.heartbeatAt,
      `${label}.lease.heartbeatAt`,
    );
    const expires = canonicalTimestamp(
      lease.expiresAt,
      `${label}.lease.expiresAt`,
    );
    if (
      heartbeat < acquired ||
      expires <= heartbeat ||
      phase !== "leased" ||
      lease.id !== activeLease ||
      lease.workerId !== activeWorker ||
      lease.acquiredAt !== lastLeasedAt ||
      lease.heartbeatAt !== lastHeartbeatAt
    ) {
      throw new Error(
        `${label}.lease is temporally or semantically inconsistent.`,
      );
    }
  } else if (phase === "leased") {
    throw new Error(`${label} is leased without an active lease.`);
  }
  if (record.nextAttemptAt !== undefined) {
    canonicalTimestamp(record.nextAttemptAt, `${label}.nextAttemptAt`);
    if (phase !== "queued")
      throw new Error(`${label}.nextAttemptAt is only valid while queued.`);
  }

  const { recordDigest: _digest, ...metadataPayload } = metadata;
  const expectedRecord = sha256(
    canonicalJson({ ...record, metadata: metadataPayload }),
  );
  if (metadata.recordDigest !== expectedRecord) {
    throw new Error(`${label}.metadata.recordDigest is inconsistent.`);
  }
  return record as unknown as FactoryTaskRecord;
}

function percentile95(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
}

function maximumQueueDepth(
  records: readonly FactoryTaskRecord[],
  from: number,
  to: number,
): number {
  let depth = 0;
  const deltas = new Map<number, number>();
  for (const record of records) {
    let state: "absent" | "queued" | "running" | "done" = "absent";
    for (const event of record.events) {
      const at = Date.parse(event.at);
      const next: "absent" | "queued" | "running" | "done" =
        event.type === "enqueued" ||
        event.type === "recovered" ||
        event.type === "retry-scheduled"
          ? "queued"
          : event.type === "leased"
            ? "running"
            : event.type === "heartbeat"
              ? state
              : "done";
      const delta = (next === "queued" ? 1 : 0) - (state === "queued" ? 1 : 0);
      if (at < from) {
        depth += delta;
      } else if (at < to && delta !== 0) {
        deltas.set(at, (deltas.get(at) ?? 0) + delta);
      }
      state = next;
    }
  }
  let maximum = depth;
  for (const at of [...deltas.keys()].sort((left, right) => left - right)) {
    depth += deltas.get(at) ?? 0;
    if (depth < 0)
      throw new Error("Factory SLO queue history produced a negative depth.");
    maximum = Math.max(maximum, depth);
  }
  return maximum;
}

function objective(
  metric: string,
  observed: number | undefined,
  operator: ">=" | "<=",
  target: number,
  samples: number,
  minimumSamples: number,
): FactorySloObjectiveResult {
  if (samples < minimumSamples || observed === undefined) {
    return { metric, operator, target, status: "insufficient-data" };
  }
  const passed = operator === ">=" ? observed >= target : observed <= target;
  return {
    metric,
    observed,
    operator,
    target,
    status: passed ? "passed" : "failed",
  };
}

export interface CreateFactorySloReportOptions {
  measuredAt?: string;
  now?: () => Date;
  minimumSamples?: number;
  maxRecords?: number;
}

export function createFactorySloReport(
  policyValue: FactorySloPolicy | unknown,
  recordValues: readonly (FactoryTaskRecord | unknown)[],
  options: CreateFactorySloReportOptions = {},
): FactorySloReport {
  assertSloPolicy(policyValue);
  if (!Array.isArray(recordValues))
    throw new Error("Factory SLO records must be an array.");
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > DEFAULT_MAX_RECORDS
  ) {
    throw new Error("Factory SLO maxRecords is outside its supported bounds.");
  }
  if (recordValues.length > maxRecords)
    throw new Error("Factory SLO records exceed the configured entry budget.");
  const minimumSamples = options.minimumSamples ?? 1;
  if (
    !Number.isSafeInteger(minimumSamples) ||
    minimumSamples < 1 ||
    minimumSamples > maxRecords
  ) {
    throw new Error(
      "Factory SLO minimumSamples is outside its supported bounds.",
    );
  }
  let measuredAt = options.measuredAt;
  if (measuredAt === undefined) {
    const measured = (options.now ?? (() => new Date()))();
    if (!(measured instanceof Date) || !Number.isFinite(measured.getTime())) {
      throw new Error("Factory SLO clock returned an invalid Date.");
    }
    measuredAt = measured.toISOString();
  }
  timestamp(measuredAt, "Factory SLO measuredAt");
  const from = timestamp(policyValue.window.from, "Factory SLO window.from");
  const to = timestamp(policyValue.window.to, "Factory SLO window.to");
  if (timestamp(measuredAt, "Factory SLO measuredAt") < to) {
    throw new Error(
      "Factory SLO measuredAt cannot precede the closed measurement window.",
    );
  }

  const records = recordValues.map(validateTaskRecord);
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.metadata.id))
      throw new Error("Factory SLO records contain a duplicate task id.");
    ids.add(record.metadata.id);
  }

  const finishedInWindow = records.filter((record) => {
    const finished = record.timing.finishedAt
      ? Date.parse(record.timing.finishedAt)
      : undefined;
    return finished !== undefined && finished >= from && finished < to;
  });
  const startedInWindow = records.filter((record) => {
    const started = record.timing.startedAt
      ? Date.parse(record.timing.startedAt)
      : undefined;
    return started !== undefined && started >= from && started < to;
  });
  const succeeded = finishedInWindow.filter(
    (record) => record.phase === "succeeded",
  );
  const failed = finishedInWindow.filter((record) => record.phase === "failed");
  const decided = [...succeeded, ...failed];
  const isolationFailures = failed.filter(
    (record) => record.failure?.kind === "isolation",
  );
  const recoveredTasks = records.filter((record) =>
    record.events.some(
      (entry) =>
        entry.type === "recovered" &&
        Date.parse(entry.at) >= from &&
        Date.parse(entry.at) < to,
    ),
  ).length;
  const queueDepth = maximumQueueDepth(records, from, to);
  const queueLatencies = startedInWindow.map(
    (record) =>
      Date.parse(record.timing.startedAt as string) -
      Date.parse(record.timing.enqueuedAt),
  );
  const runDurations = finishedInWindow.flatMap((record) =>
    record.timing.runDurationMs === undefined
      ? []
      : [record.timing.runDurationMs],
  );
  const successRate =
    decided.length === 0 ? undefined : succeeded.length / decided.length;
  const isolationFailureRate =
    decided.length === 0
      ? undefined
      : isolationFailures.length / decided.length;
  const p95QueueLatencyMs = percentile95(queueLatencies);
  const p95RunDurationMs = percentile95(runDurations);
  let computeMs = 0;
  for (const record of records) {
    const started = record.timing.startedAt
      ? Date.parse(record.timing.startedAt)
      : undefined;
    if (started === undefined || started >= to) continue;
    const finished = record.timing.finishedAt
      ? Date.parse(record.timing.finishedAt)
      : to;
    computeMs += Math.max(0, Math.min(finished, to) - Math.max(started, from));
  }
  const estimatedCostMicros = Math.ceil(
    (computeMs * policyValue.costModel.computeMicrosPerSecond) / 1_000,
  );
  if (!Number.isSafeInteger(estimatedCostMicros)) {
    throw new Error(
      "Factory SLO estimated cost exceeds the safe integer range.",
    );
  }

  const objectives: FactorySloObjectiveResult[] = [
    objective(
      "successRate",
      successRate,
      ">=",
      policyValue.objectives.minimumSuccessRate,
      decided.length,
      minimumSamples,
    ),
    objective(
      "p95QueueLatencyMs",
      p95QueueLatencyMs,
      "<=",
      policyValue.objectives.maximumP95QueueLatencyMs,
      queueLatencies.length,
      minimumSamples,
    ),
    objective(
      "p95RunDurationMs",
      p95RunDurationMs,
      "<=",
      policyValue.objectives.maximumP95RunDurationMs,
      runDurations.length,
      minimumSamples,
    ),
    objective(
      "isolationFailureRate",
      isolationFailureRate,
      "<=",
      policyValue.objectives.maximumIsolationFailureRate,
      decided.length,
      minimumSamples,
    ),
    objective(
      "queueDepth",
      queueDepth,
      "<=",
      policyValue.objectives.maximumQueueDepth,
      records.length,
      0,
    ),
    objective(
      "estimatedCostMicros",
      estimatedCostMicros,
      "<=",
      policyValue.objectives.maximumEstimatedCostMicros,
      records.length,
      0,
    ),
  ];
  const policyDigest = sha256(canonicalJson(policyValue));
  const draft: FactorySloReport = {
    schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
    kind: "FactorySloReport",
    metadata: {
      measuredAt,
      reportDigest: `sha256:${"0".repeat(64)}`,
    },
    policy: { id: policyValue.metadata.id, digest: policyDigest },
    metrics: {
      queueDepth,
      terminalTasks: finishedInWindow.length,
      succeededTasks: succeeded.length,
      failedTasks: failed.length,
      recoveredTasks,
      ...(successRate === undefined ? {} : { successRate }),
      ...(p95QueueLatencyMs === undefined ? {} : { p95QueueLatencyMs }),
      ...(p95RunDurationMs === undefined ? {} : { p95RunDurationMs }),
      ...(isolationFailureRate === undefined ? {} : { isolationFailureRate }),
      estimatedCostMicros,
    },
    objectives,
    compliant: objectives.every((entry) => entry.status === "passed"),
  };
  const { reportDigest: _reportDigest, ...reportMetadata } = draft.metadata;
  draft.metadata.reportDigest = sha256(
    canonicalJson({ ...draft, metadata: reportMetadata }),
  );
  return draft;
}
