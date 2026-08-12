import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { FactoryRunResult, Sha256Digest } from "./types.js";
import {
  FACTORY_OPERATIONS_SCHEMA_VERSION,
  type FactoryTaskEvent,
  type FactoryTaskEventType,
  type FactoryTaskFailure,
  type FactoryTaskQueueContract,
  type FactoryTaskQueueOptions,
  type FactoryTaskRecord,
  type FactoryTaskRequest,
} from "./operations-types.js";
import { assertSha256, canonicalJson, compareText, sha256 } from "./utils.js";

const DEFAULT_MAX_TASKS = 10_000;
const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const MAX_WORK_ORDER_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_STRING_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 100;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 5;
const LOCK_OWNER_NAME = "owner.json";
const LOCK_OWNER_MAX_BYTES = 4 * 1024;
const TASK_NAME = /^[0-9a-f]{64}\.json$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FULL_COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const HIGH_CONFIDENCE_SECRET =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:token|password|client_secret|api_key)\s*[=:]\s*\S+|\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,})/iu;

interface EventPayload {
  sequence: number;
  type: FactoryTaskEventType;
  at: string;
  previousDigest?: Sha256Digest;
  workerId?: string;
  leaseId?: string;
  detail?: string;
}

interface QueueLockOwner {
  pid: number;
  acquiredAt: string;
  token: string;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!hasOwn(value, key)) throw new Error(`${label}.${key} is required.`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`${label}.${key} is not registered.`);
  }
}

function assertString(
  value: unknown,
  label: string,
  min = 1,
  max = 4096,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    Buffer.byteLength(value, "utf8") > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded printable string.`);
  }
}

function assertSafeIdentifier(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a safe identifier.`);
  }
}

function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string")
    throw new Error(`${label} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
}

function assertDuration(value: number, label: string, maximum: number): void {
  assertInteger(value, label, 0, maximum);
}

function assertQueueLockOwner(
  value: unknown,
  label: string,
): asserts value is QueueLockOwner {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ["pid", "acquiredAt", "token"], [], label);
  assertInteger(value.pid, `${label}.pid`, 1, 2_147_483_647);
  assertTimestamp(value.acquiredAt, `${label}.acquiredAt`);
  assertSafeIdentifier(value.token, `${label}.token`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new Error(`Unable to inspect queue lock owner process ${pid}.`, {
      cause: error,
    });
  }
}

function timestampMs(value: string): number {
  return new Date(value).getTime();
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Factory task clock must return a valid Date.");
  }
  return value.toISOString();
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(timestampMs(value) + milliseconds).toISOString();
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function within(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

function assertDirectory(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `${label} must be a real directory and cannot be a symbolic link.`,
    );
  }
}

function assertRegularFile(path: string, label: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `${label} must be a regular file and cannot be a symbolic link.`,
    );
  }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertJsonBudget(value: unknown, label: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES)
      throw new Error(`${label} exceeds the logical-node budget.`);
    if (current.depth > MAX_JSON_DEPTH)
      throw new Error(`${label} exceeds the depth budget.`);
    if (typeof current.value === "string") {
      if (Buffer.byteLength(current.value, "utf8") > MAX_STRING_BYTES) {
        throw new Error(`${label} contains an oversized string.`);
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value)
        stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (isRecord(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        if (Buffer.byteLength(key, "utf8") > 256)
          throw new Error(`${label} contains an oversized key.`);
        stack.push({ value: child, depth: current.depth + 1 });
      }
      continue;
    }
    if (
      current.value !== null &&
      typeof current.value !== "boolean" &&
      (typeof current.value !== "number" || !Number.isFinite(current.value))
    ) {
      throw new Error(`${label} contains a non-JSON value.`);
    }
  }
}

function assertNoSecretMaterial(value: unknown, label: string): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (HIGH_CONFIDENCE_SECRET.test(current)) {
        throw new Error(`${label} contains credential-like material.`);
      }
    } else if (Array.isArray(current)) {
      stack.push(...current);
    } else if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) {
        const normalized = key.toLowerCase().replace(/[-_]/gu, "");
        if (
          normalized === "token" ||
          normalized === "password" ||
          normalized === "secret" ||
          normalized === "apikey" ||
          normalized === "clientsecret" ||
          normalized === "privatekey" ||
          normalized === "accesskey" ||
          normalized === "authorization" ||
          normalized === "credential" ||
          normalized === "credentials"
        ) {
          throw new Error(`${label}.${key} is a forbidden secret field.`);
        }
        stack.push(child);
      }
    }
  }
}

function normalizePortablePath(value: unknown, label: string): string {
  assertString(value, label, 1, 4096);
  if (value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`${label} must be a portable repository-relative path.`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.trim() !== segment,
    )
  ) {
    throw new Error(`${label} contains an invalid segment.`);
  }
  return segments.join("/");
}

function readBounded(path: string, maxBytes: number, label: string): Buffer {
  assertRegularFile(path, label);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file.`);
    if (before.size > maxBytes)
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.byteLength !== after.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function resolveRepositoryFile(
  repositoryRoot: string,
  relativePath: string,
  label: string,
): string {
  if (
    !isAbsolute(repositoryRoot) ||
    resolve(repositoryRoot) !== repositoryRoot
  ) {
    throw new Error("spec.repositoryRoot must be an absolute normalized path.");
  }
  assertDirectory(repositoryRoot, "spec.repositoryRoot");
  const realRoot = realpathSync(repositoryRoot);
  if (!samePath(realRoot, repositoryRoot)) {
    throw new Error("spec.repositoryRoot cannot traverse a symbolic link.");
  }
  const normalized = normalizePortablePath(relativePath, label);
  let current = realRoot;
  for (const segment of normalized.split("/")) {
    current = resolve(current, segment);
    if (!within(realRoot, current))
      throw new Error(`${label} escapes spec.repositoryRoot.`);
    const info = lstatSync(current);
    if (info.isSymbolicLink())
      throw new Error(`${label} cannot traverse a symbolic link.`);
  }
  assertRegularFile(current, label);
  return current;
}

function assertRequest(
  value: unknown,
  verifySource = true,
): asserts value is FactoryTaskRequest {
  if (!isRecord(value)) throw new Error("spec must be an object.");
  assertExactKeys(
    value,
    [
      "repositoryRoot",
      "workOrderPath",
      "workOrderDigest",
      "baseCommit",
      "delivery",
      "keepWorkspace",
      "maxAttempts",
    ],
    [],
    "spec",
  );
  assertString(value.repositoryRoot, "spec.repositoryRoot", 1, 4096);
  assertString(value.workOrderPath, "spec.workOrderPath", 1, 4096);
  assertSha256(String(value.workOrderDigest), "spec.workOrderDigest");
  if (
    typeof value.baseCommit !== "string" ||
    !FULL_COMMIT.test(value.baseCommit)
  ) {
    throw new Error(
      "spec.baseCommit must be a full lowercase Git commit hash.",
    );
  }
  if (value.delivery !== "local" && value.delivery !== "github") {
    throw new Error("spec.delivery must be local or github.");
  }
  if (typeof value.keepWorkspace !== "boolean") {
    throw new Error("spec.keepWorkspace must be boolean.");
  }
  assertInteger(value.maxAttempts, "spec.maxAttempts", 1, MAX_ATTEMPTS);
  if (verifySource) {
    const workOrder = resolveRepositoryFile(
      value.repositoryRoot,
      value.workOrderPath,
      "spec.workOrderPath",
    );
    const bytes = readBounded(workOrder, MAX_WORK_ORDER_BYTES, "work order");
    const actual = sha256(bytes);
    if (actual !== value.workOrderDigest) {
      throw new Error(
        `spec.workOrderDigest mismatch: expected ${value.workOrderDigest}, received ${actual}.`,
      );
    }
  }
}

function assertTargetOutcome(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (value.status === "completed") {
    assertExactKeys(
      value,
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
      label,
    );
    assertExactReference(value.application, `${label}.application`);
    for (const key of [
      "baseCommit",
      "resultCommit",
      "branch",
      "evidencePath",
    ] as const) {
      assertString(value[key], `${label}.${key}`, 1, 4096);
    }
    assertSha256(String(value.evidenceDigest), `${label}.evidenceDigest`);
    if (value.pullRequest !== undefined) {
      if (!isRecord(value.pullRequest))
        throw new Error(`${label}.pullRequest must be an object.`);
      assertExactKeys(
        value.pullRequest,
        ["number", "url", "state", "draft", "author"],
        [],
        `${label}.pullRequest`,
      );
      assertInteger(
        value.pullRequest.number,
        `${label}.pullRequest.number`,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      for (const key of ["url", "state", "author"] as const) {
        assertString(
          value.pullRequest[key],
          `${label}.pullRequest.${key}`,
          1,
          4096,
        );
      }
      if (typeof value.pullRequest.draft !== "boolean")
        throw new Error(`${label}.pullRequest.draft must be boolean.`);
    }
    return;
  }
  if (value.status === "failed") {
    assertExactKeys(
      value,
      ["status", "application", "branch", "failure"],
      [],
      label,
    );
    assertExactReference(value.application, `${label}.application`);
    assertString(value.branch, `${label}.branch`, 1, 4096);
    assertString(value.failure, `${label}.failure`, 1, 16_384);
    return;
  }
  throw new Error(`${label}.status is invalid.`);
}

function assertExactReference(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ["id", "version"], [], label);
  assertString(value.id, `${label}.id`, 1, 256);
  assertString(value.version, `${label}.version`, 1, 128);
}

function assertResult(value: unknown): asserts value is FactoryRunResult {
  if (!isRecord(value)) throw new Error("result must be an object.");
  assertExactKeys(
    value,
    ["status", "workOrderId", "baseCommit", "targets"],
    [],
    "result",
  );
  if (
    value.status !== "completed" &&
    value.status !== "partial" &&
    value.status !== "failed"
  ) {
    throw new Error("result.status is invalid.");
  }
  assertString(value.workOrderId, "result.workOrderId", 1, 256);
  assertString(value.baseCommit, "result.baseCommit", 1, 128);
  if (!Array.isArray(value.targets) || value.targets.length > 10_000) {
    throw new Error("result.targets must be a bounded array.");
  }
  value.targets.forEach((target, index) =>
    assertTargetOutcome(target, `result.targets[${index}]`),
  );
  assertJsonBudget(value, "result");
  assertNoSecretMaterial(value, "result");
}

function assertFailureInput(
  value: unknown,
): asserts value is Omit<FactoryTaskFailure, "occurredAt"> {
  if (!isRecord(value)) throw new Error("failure must be an object.");
  assertExactKeys(value, ["kind", "message"], [], "failure");
  if (
    value.kind !== "transient" &&
    value.kind !== "permanent" &&
    value.kind !== "isolation"
  ) {
    throw new Error("failure.kind is invalid.");
  }
  assertString(value.message, "failure.message", 1, 16_384);
  assertNoSecretMaterial(value, "failure");
}

function eventPayload(event: FactoryTaskEvent): EventPayload {
  const payload: EventPayload = {
    sequence: event.sequence,
    type: event.type,
    at: event.at,
  };
  if (event.previousDigest !== undefined)
    payload.previousDigest = event.previousDigest;
  if (event.workerId !== undefined) payload.workerId = event.workerId;
  if (event.leaseId !== undefined) payload.leaseId = event.leaseId;
  if (event.detail !== undefined) payload.detail = event.detail;
  return payload;
}

export function factoryTaskEventDigest(
  event: Omit<FactoryTaskEvent, "digest">,
): Sha256Digest {
  return sha256(canonicalJson(event));
}

export function factoryTaskRecordDigest(
  record: FactoryTaskRecord,
): Sha256Digest {
  const copy = clone(record) as unknown as {
    metadata: Record<string, unknown>;
  };
  delete copy.metadata.recordDigest;
  return sha256(canonicalJson(copy));
}

function appendEvent(
  record: FactoryTaskRecord,
  type: FactoryTaskEventType,
  at: string,
  options: { workerId?: string; leaseId?: string; detail?: string } = {},
): void {
  const previous = record.events.at(-1);
  const payload: EventPayload = {
    sequence: record.events.length + 1,
    type,
    at,
  };
  if (previous) payload.previousDigest = previous.digest;
  if (options.workerId !== undefined) payload.workerId = options.workerId;
  if (options.leaseId !== undefined) payload.leaseId = options.leaseId;
  if (options.detail !== undefined) payload.detail = options.detail;
  record.events.push({ ...payload, digest: factoryTaskEventDigest(payload) });
}

function finalizeRecord(
  record: FactoryTaskRecord,
  updatedAt: string,
): FactoryTaskRecord {
  record.metadata.updatedAt = updatedAt;
  record.metadata.recordDigest = factoryTaskRecordDigest(record);
  return record;
}

function assertEvent(
  value: unknown,
  index: number,
  previous?: FactoryTaskEvent,
): asserts value is FactoryTaskEvent {
  const label = `events[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(
    value,
    ["sequence", "type", "at", "digest"],
    ["previousDigest", "workerId", "leaseId", "detail"],
    label,
  );
  assertInteger(value.sequence, `${label}.sequence`, 1, 1_000_000);
  if (value.sequence !== index + 1)
    throw new Error(`${label}.sequence is not contiguous.`);
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
    ].includes(String(value.type))
  )
    throw new Error(`${label}.type is invalid.`);
  assertTimestamp(value.at, `${label}.at`);
  const digest = assertSha256(String(value.digest), `${label}.digest`);
  if (previous) {
    if (value.previousDigest !== previous.digest)
      throw new Error(`${label}.previousDigest breaks the event chain.`);
    if (timestampMs(value.at) < timestampMs(previous.at))
      throw new Error(`${label}.at moves backwards.`);
  } else if (value.previousDigest !== undefined) {
    throw new Error(`${label}.previousDigest is forbidden on the first event.`);
  }
  if (value.workerId !== undefined)
    assertSafeIdentifier(value.workerId, `${label}.workerId`);
  if (value.leaseId !== undefined)
    assertSafeIdentifier(value.leaseId, `${label}.leaseId`);
  if (value.detail !== undefined) {
    assertString(value.detail, `${label}.detail`, 1, 16_384);
    assertNoSecretMaterial(value.detail, `${label}.detail`);
  }
  const actual = factoryTaskEventDigest(
    eventPayload(value as unknown as FactoryTaskEvent),
  );
  if (digest !== actual)
    throw new Error(`${label}.digest does not match its canonical payload.`);
}

function assertEventSemantics(record: FactoryTaskRecord): void {
  let derivedPhase: FactoryTaskRecord["phase"] = "queued";
  let attempts = 0;
  let recoveries = 0;
  let activeWorker: string | undefined;
  let activeLease: string | undefined;
  let firstLeaseAt: string | undefined;
  let lastLeaseAt: string | undefined;
  let lastHeartbeatAt: string | undefined;

  for (const [index, event] of record.events.entries()) {
    if (index === 0) continue;
    if (
      derivedPhase === "succeeded" ||
      derivedPhase === "failed" ||
      derivedPhase === "cancelled"
    ) {
      throw new Error(`events[${index}] follows a terminal event.`);
    }
    if (event.type === "enqueued")
      throw new Error("enqueued can appear only as the first event.");
    if (event.type === "leased") {
      if (derivedPhase !== "queued" || !event.workerId || !event.leaseId) {
        throw new Error(
          `events[${index}] cannot lease from the current state.`,
        );
      }
      derivedPhase = "leased";
      activeWorker = event.workerId;
      activeLease = event.leaseId;
      attempts += 1;
      firstLeaseAt ??= event.at;
      lastLeaseAt = event.at;
      lastHeartbeatAt = event.at;
      continue;
    }
    if (event.type === "heartbeat") {
      if (
        derivedPhase !== "leased" ||
        event.workerId !== activeWorker ||
        event.leaseId !== activeLease
      )
        throw new Error(
          `events[${index}] heartbeat does not match the active lease.`,
        );
      lastHeartbeatAt = event.at;
      continue;
    }
    if (event.type === "recovered") {
      if (
        derivedPhase !== "leased" ||
        event.workerId !== activeWorker ||
        event.leaseId !== activeLease
      )
        throw new Error(
          `events[${index}] recovery does not match the active lease.`,
        );
      derivedPhase = "queued";
      activeWorker = undefined;
      activeLease = undefined;
      recoveries += 1;
      continue;
    }
    if (event.type === "retry-scheduled") {
      if (
        derivedPhase !== "leased" ||
        event.workerId !== activeWorker ||
        event.leaseId !== activeLease
      )
        throw new Error(
          `events[${index}] retry does not match the active lease.`,
        );
      derivedPhase = "queued";
      activeWorker = undefined;
      activeLease = undefined;
      continue;
    }
    if (event.type === "succeeded") {
      if (
        derivedPhase !== "leased" ||
        event.workerId !== activeWorker ||
        event.leaseId !== activeLease
      )
        throw new Error(
          `events[${index}] success does not match the active lease.`,
        );
      derivedPhase = "succeeded";
      activeWorker = undefined;
      activeLease = undefined;
      continue;
    }
    if (event.type === "failed") {
      const afterRecovery =
        derivedPhase === "queued" &&
        record.events[index - 1]?.type === "recovered";
      const activeFailure =
        derivedPhase === "leased" &&
        event.workerId === activeWorker &&
        event.leaseId === activeLease;
      if (!afterRecovery && !activeFailure) {
        throw new Error(
          `events[${index}] failure does not follow an active lease or recovery.`,
        );
      }
      if (activeFailure) {
        if (!event.workerId || !event.leaseId) {
          throw new Error(
            `events[${index}] terminal failure requires lease identity.`,
          );
        }
      } else if (event.workerId !== undefined || event.leaseId !== undefined) {
        throw new Error(
          `events[${index}] recovery failure cannot invent lease identity.`,
        );
      }
      derivedPhase = "failed";
      activeWorker = undefined;
      activeLease = undefined;
      continue;
    }
    if (event.type === "cancelled") {
      derivedPhase = "cancelled";
      activeWorker = undefined;
      activeLease = undefined;
    }
  }

  if (derivedPhase !== record.phase)
    throw new Error("phase does not match the event history.");
  if (attempts !== record.attempts)
    throw new Error("attempts does not match leased events.");
  if (recoveries !== record.recoveryCount)
    throw new Error("recoveryCount does not match recovered events.");
  if (attempts > 0 && firstLeaseAt !== record.timing.startedAt) {
    throw new Error("timing.startedAt does not match the first lease event.");
  }
  if (attempts === 0) {
    const expectedStart =
      record.phase === "cancelled" ? record.events.at(-1)!.at : undefined;
    if (record.timing.startedAt !== expectedStart) {
      throw new Error(
        "timing.startedAt is inconsistent for a task without attempts.",
      );
    }
  }
  if (record.phase === "leased") {
    const lease = record.lease;
    if (
      !lease ||
      lease.id !== activeLease ||
      lease.workerId !== activeWorker ||
      lease.acquiredAt !== lastLeaseAt ||
      lease.heartbeatAt !== lastHeartbeatAt
    )
      throw new Error("lease does not match the active event history.");
  }
  if (
    record.phase === "queued" &&
    record.events.at(-1)!.type === "retry-scheduled" &&
    record.nextAttemptAt === undefined
  ) {
    throw new Error("retry-scheduled tasks require nextAttemptAt.");
  }
  if (
    record.phase === "queued" &&
    record.events.at(-1)!.type === "recovered" &&
    record.nextAttemptAt !== record.metadata.updatedAt
  ) {
    throw new Error("recovered queued tasks must be immediately eligible.");
  }
  if (
    record.phase === "succeeded" ||
    record.phase === "failed" ||
    record.phase === "cancelled"
  ) {
    if (record.timing.finishedAt !== record.events.at(-1)!.at) {
      throw new Error("timing.finishedAt does not match the terminal event.");
    }
  }
}

function assertRecord(
  value: unknown,
  expectedId?: Sha256Digest,
): asserts value is FactoryTaskRecord {
  assertJsonBudget(value, "FactoryTaskRecord");
  assertNoSecretMaterial(value, "FactoryTaskRecord");
  if (!isRecord(value)) throw new Error("FactoryTaskRecord must be an object.");
  assertExactKeys(
    value,
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
    "FactoryTaskRecord",
  );
  if (
    value.schemaVersion !== FACTORY_OPERATIONS_SCHEMA_VERSION ||
    value.kind !== "FactoryTask"
  ) {
    throw new Error("FactoryTaskRecord identity is invalid.");
  }
  if (!isRecord(value.metadata)) throw new Error("metadata must be an object.");
  assertExactKeys(
    value.metadata,
    ["id", "createdAt", "updatedAt", "recordDigest"],
    [],
    "metadata",
  );
  const id = assertSha256(String(value.metadata.id), "metadata.id");
  if (expectedId !== undefined && id !== expectedId)
    throw new Error("metadata.id does not match the task path.");
  assertTimestamp(value.metadata.createdAt, "metadata.createdAt");
  assertTimestamp(value.metadata.updatedAt, "metadata.updatedAt");
  if (
    timestampMs(value.metadata.updatedAt) <
    timestampMs(value.metadata.createdAt)
  ) {
    throw new Error("metadata.updatedAt predates metadata.createdAt.");
  }
  const recordDigest = assertSha256(
    String(value.metadata.recordDigest),
    "metadata.recordDigest",
  );
  const actualRecordDigest = factoryTaskRecordDigest(
    value as unknown as FactoryTaskRecord,
  );
  if (recordDigest !== actualRecordDigest)
    throw new Error("metadata.recordDigest does not match the record.");
  assertRequest(value.spec, false);
  const expectedTaskId = sha256(canonicalJson(value.spec));
  if (id !== expectedTaskId)
    throw new Error("metadata.id does not match the exact request.");
  if (
    !["queued", "leased", "succeeded", "failed", "cancelled"].includes(
      String(value.phase),
    )
  ) {
    throw new Error("phase is invalid.");
  }
  assertInteger(value.attempts, "attempts", 0, value.spec.maxAttempts);
  assertInteger(value.recoveryCount, "recoveryCount", 0, value.attempts);
  if (!isRecord(value.timing)) throw new Error("timing must be an object.");
  assertExactKeys(
    value.timing,
    ["enqueuedAt"],
    ["startedAt", "finishedAt", "runDurationMs"],
    "timing",
  );
  assertTimestamp(value.timing.enqueuedAt, "timing.enqueuedAt");
  if (value.timing.enqueuedAt !== value.metadata.createdAt)
    throw new Error("timing.enqueuedAt must equal metadata.createdAt.");
  if (value.timing.startedAt !== undefined)
    assertTimestamp(value.timing.startedAt, "timing.startedAt");
  if (value.timing.finishedAt !== undefined)
    assertTimestamp(value.timing.finishedAt, "timing.finishedAt");
  if (value.timing.runDurationMs !== undefined) {
    assertInteger(
      value.timing.runDurationMs,
      "timing.runDurationMs",
      0,
      Number.MAX_SAFE_INTEGER,
    );
  }
  if (value.nextAttemptAt !== undefined)
    assertTimestamp(value.nextAttemptAt, "nextAttemptAt");
  if (value.lease !== undefined) {
    if (!isRecord(value.lease)) throw new Error("lease must be an object.");
    assertExactKeys(
      value.lease,
      ["id", "workerId", "acquiredAt", "heartbeatAt", "expiresAt"],
      [],
      "lease",
    );
    assertSafeIdentifier(value.lease.id, "lease.id");
    assertSafeIdentifier(value.lease.workerId, "lease.workerId");
    for (const key of ["acquiredAt", "heartbeatAt", "expiresAt"] as const) {
      assertTimestamp(value.lease[key], `lease.${key}`);
    }
    const acquiredAt = value.lease.acquiredAt as string;
    const heartbeatAt = value.lease.heartbeatAt as string;
    const expiresAt = value.lease.expiresAt as string;
    if (
      timestampMs(heartbeatAt) < timestampMs(acquiredAt) ||
      timestampMs(expiresAt) <= timestampMs(heartbeatAt)
    )
      throw new Error("lease timestamps are inconsistent.");
  }
  if (value.result !== undefined) assertResult(value.result);
  if (value.failure !== undefined) {
    if (!isRecord(value.failure)) throw new Error("failure must be an object.");
    assertExactKeys(
      value.failure,
      ["kind", "message", "occurredAt"],
      [],
      "failure",
    );
    assertFailureInput({
      kind: value.failure.kind,
      message: value.failure.message,
    });
    assertTimestamp(value.failure.occurredAt, "failure.occurredAt");
  }
  if (
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    value.events.length > 1_000_000
  ) {
    throw new Error("events must be a non-empty bounded array.");
  }
  let previous: FactoryTaskEvent | undefined;
  value.events.forEach((event, index) => {
    assertEvent(event, index, previous);
    previous = event;
  });
  if (value.events[0]!.type !== "enqueued")
    throw new Error("The first event must be enqueued.");
  if (value.events[0]!.at !== value.metadata.createdAt)
    throw new Error("The enqueued event must match metadata.createdAt.");
  if (value.events.at(-1)!.at !== value.metadata.updatedAt)
    throw new Error("The final event must match metadata.updatedAt.");
  assertEventSemantics(value as unknown as FactoryTaskRecord);

  if (value.phase === "queued") {
    if (
      value.lease !== undefined ||
      value.result !== undefined ||
      value.timing.finishedAt !== undefined ||
      value.timing.runDurationMs !== undefined
    ) {
      throw new Error("queued tasks contain terminal or lease state.");
    }
    const finalEvent = value.events.at(-1)!.type;
    if (
      finalEvent === "retry-scheduled" &&
      value.failure?.kind !== "transient"
    ) {
      throw new Error("retry-scheduled tasks require a transient failure.");
    }
    if (
      finalEvent === "enqueued" &&
      (value.failure !== undefined || value.nextAttemptAt !== undefined)
    ) {
      throw new Error(
        "newly enqueued tasks cannot contain failure or retry state.",
      );
    }
  } else if (value.phase === "leased") {
    if (
      !value.lease ||
      value.nextAttemptAt !== undefined ||
      value.result !== undefined ||
      value.timing.startedAt === undefined ||
      value.timing.finishedAt !== undefined
    ) {
      throw new Error("leased task state is incomplete or contradictory.");
    }
  } else {
    if (
      value.lease !== undefined ||
      value.nextAttemptAt !== undefined ||
      value.timing.finishedAt === undefined ||
      value.timing.runDurationMs === undefined
    ) {
      throw new Error("terminal task state is incomplete or contradictory.");
    }
    if (
      value.phase === "succeeded" &&
      (value.result === undefined || value.failure !== undefined)
    ) {
      throw new Error("succeeded tasks require only result terminal state.");
    }
    if (
      value.phase === "failed" &&
      (value.failure === undefined || value.result !== undefined)
    ) {
      throw new Error("failed tasks require only failure terminal state.");
    }
    if (
      value.phase === "cancelled" &&
      (value.result !== undefined || value.failure !== undefined)
    ) {
      throw new Error("cancelled tasks cannot contain result or failure.");
    }
  }
  if (value.timing.startedAt === undefined && value.attempts !== 0)
    throw new Error("attempted tasks require timing.startedAt.");
  if (value.timing.runDurationMs !== undefined) {
    if (!value.timing.startedAt || !value.timing.finishedAt)
      throw new Error("runDurationMs requires startedAt and finishedAt.");
    if (
      value.timing.runDurationMs !==
      timestampMs(value.timing.finishedAt) - timestampMs(value.timing.startedAt)
    ) {
      throw new Error("timing.runDurationMs is inconsistent.");
    }
  }
}

function taskFileName(id: Sha256Digest): string {
  return `${id.slice("sha256:".length)}.json`;
}

function idFromTaskFile(name: string): Sha256Digest {
  if (!TASK_NAME.test(name))
    throw new Error(`Unclassified queue entry '${name}'.`);
  return `sha256:${name.slice(0, 64)}`;
}

export class FactoryTaskQueue implements FactoryTaskQueueContract {
  readonly root: string;
  readonly tasksRoot: string;
  readonly temporaryRoot: string;
  readonly lockPath: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly maxTasks: number;
  private readonly maxRecordBytes: number;

  constructor(options: FactoryTaskQueueOptions) {
    if (!isRecord(options))
      throw new Error("FactoryTaskQueue options are required.");
    assertString(options.root, "root", 1, 4096);
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    assertInteger(this.maxTasks, "maxTasks", 1, 1_000_000);
    assertInteger(
      this.maxRecordBytes,
      "maxRecordBytes",
      1024,
      16 * 1024 * 1024,
    );
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;

    const requestedRoot = resolve(options.root);
    mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
    assertDirectory(requestedRoot, "queue root");
    const realRoot = realpathSync(requestedRoot);
    if (!samePath(realRoot, requestedRoot))
      throw new Error("queue root cannot traverse a symbolic link.");
    this.root = realRoot;
    this.tasksRoot = resolve(this.root, "tasks");
    this.temporaryRoot = resolve(this.root, "tmp");
    this.lockPath = resolve(this.root, "mutation.lock");
    mkdirSync(this.tasksRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.temporaryRoot, { recursive: true, mode: 0o700 });
    this.assertLayout();
  }

  enqueue(request: FactoryTaskRequest): FactoryTaskRecord {
    assertRequest(request);
    const exactRequest = clone(request);
    const id = sha256(canonicalJson(exactRequest));
    return this.withLock(() => {
      const existing = this.readRecord(id, true);
      if (existing) {
        if (canonicalJson(existing.spec) !== canonicalJson(exactRequest)) {
          throw new Error(
            "Task ID collision does not match the exact request.",
          );
        }
        return clone(existing);
      }
      if (this.taskNames().length >= this.maxTasks)
        throw new Error(`Queue exceeds the ${this.maxTasks}-task budget.`);
      const at = timestamp(this.now);
      const record: FactoryTaskRecord = {
        schemaVersion: FACTORY_OPERATIONS_SCHEMA_VERSION,
        kind: "FactoryTask",
        metadata: {
          id,
          createdAt: at,
          updatedAt: at,
          recordDigest: sha256(""),
        },
        spec: exactRequest,
        phase: "queued",
        attempts: 0,
        recoveryCount: 0,
        timing: { enqueuedAt: at },
        events: [],
      };
      appendEvent(record, "enqueued", at);
      finalizeRecord(record, at);
      this.writeRecord(record, false);
      return clone(record);
    });
  }

  get(id: Sha256Digest): FactoryTaskRecord | undefined {
    const validatedId = assertSha256(String(id), "task id");
    const record = this.readRecord(validatedId, true);
    return record ? clone(record) : undefined;
  }

  list(): FactoryTaskRecord[] {
    this.assertLayout();
    const records = this.taskNames().map((name) => {
      const record = this.readRecord(idFromTaskFile(name), false);
      if (!record)
        throw new Error(`Queue task '${name}' disappeared while listing.`);
      return record;
    });
    records.sort((left, right) => {
      const created = compareText(
        left.metadata.createdAt,
        right.metadata.createdAt,
      );
      return created === 0
        ? compareText(left.metadata.id, right.metadata.id)
        : created;
    });
    return clone(records);
  }

  claim(workerId: string, leaseMs: number): FactoryTaskRecord | undefined {
    assertSafeIdentifier(workerId, "workerId");
    assertDuration(leaseMs, "leaseMs", MAX_LEASE_MS);
    if (leaseMs === 0) throw new Error("leaseMs must be greater than zero.");
    return this.withLock(() => {
      const at = timestamp(this.now);
      const nowMs = timestampMs(at);
      const records = this.listUnsafe();
      for (const record of records) {
        if (
          record.phase !== "leased" ||
          timestampMs(record.lease!.expiresAt) > nowMs
        )
          continue;
        const expiredLease = record.lease!;
        record.recoveryCount += 1;
        delete record.lease;
        record.failure = {
          kind: "transient",
          message: "Worker lease expired.",
          occurredAt: at,
        };
        appendEvent(record, "recovered", at, {
          workerId: expiredLease.workerId,
          leaseId: expiredLease.id,
          detail: "Expired worker lease recovered.",
        });
        if (record.attempts >= record.spec.maxAttempts) {
          record.phase = "failed";
          record.timing.finishedAt = at;
          record.timing.runDurationMs =
            nowMs - timestampMs(record.timing.startedAt!);
          appendEvent(record, "failed", at, {
            detail: "Attempt budget exhausted after lease recovery.",
          });
        } else {
          record.phase = "queued";
          record.nextAttemptAt = at;
        }
        finalizeRecord(record, at);
        this.writeRecord(record, true);
      }

      const eligible = records
        .filter(
          (record) =>
            record.phase === "queued" &&
            (record.nextAttemptAt === undefined ||
              timestampMs(record.nextAttemptAt) <= nowMs),
        )
        .sort((left, right) => {
          const leftReady = left.nextAttemptAt ?? left.metadata.createdAt;
          const rightReady = right.nextAttemptAt ?? right.metadata.createdAt;
          const ready = compareText(leftReady, rightReady);
          if (ready !== 0) return ready;
          const created = compareText(
            left.metadata.createdAt,
            right.metadata.createdAt,
          );
          return created === 0
            ? compareText(left.metadata.id, right.metadata.id)
            : created;
        })[0];
      if (!eligible) return undefined;
      const usedLeaseIds = new Set(
        eligible.events
          .map((event) => event.leaseId)
          .filter((value): value is string => value !== undefined),
      );
      const leaseId = this.nextUniqueSafeId("lease id", usedLeaseIds);
      eligible.phase = "leased";
      eligible.attempts += 1;
      delete eligible.nextAttemptAt;
      delete eligible.failure;
      eligible.lease = {
        id: leaseId,
        workerId,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: addMilliseconds(at, leaseMs),
      };
      eligible.timing.startedAt ??= at;
      appendEvent(eligible, "leased", at, { workerId, leaseId });
      finalizeRecord(eligible, at);
      this.writeRecord(eligible, true);
      return clone(eligible);
    });
  }

  heartbeat(
    id: Sha256Digest,
    leaseId: string,
    workerId: string,
    leaseMs: number,
  ): FactoryTaskRecord {
    const validatedId = assertSha256(String(id), "task id");
    assertSafeIdentifier(leaseId, "leaseId");
    assertSafeIdentifier(workerId, "workerId");
    assertDuration(leaseMs, "leaseMs", MAX_LEASE_MS);
    if (leaseMs === 0) throw new Error("leaseMs must be greater than zero.");
    return this.withLock(() => {
      const record = this.requiredRecord(validatedId);
      const at = timestamp(this.now);
      this.assertActiveLease(record, leaseId, workerId, at);
      record.lease!.heartbeatAt = at;
      record.lease!.expiresAt = addMilliseconds(at, leaseMs);
      appendEvent(record, "heartbeat", at, { workerId, leaseId });
      finalizeRecord(record, at);
      this.writeRecord(record, true);
      return clone(record);
    });
  }

  succeed(
    id: Sha256Digest,
    leaseId: string,
    workerId: string,
    result: FactoryRunResult,
  ): FactoryTaskRecord {
    const validatedId = assertSha256(String(id), "task id");
    assertSafeIdentifier(leaseId, "leaseId");
    assertSafeIdentifier(workerId, "workerId");
    assertResult(result);
    return this.withLock(() => {
      const record = this.requiredRecord(validatedId);
      if (record.phase === "succeeded") {
        if (canonicalJson(record.result) !== canonicalJson(result))
          throw new Error("Task already succeeded with a different result.");
        const event = record.events.at(-1)!;
        if (event.workerId !== workerId || event.leaseId !== leaseId) {
          throw new Error(
            "Idempotent success requires the original lease identity.",
          );
        }
        return clone(record);
      }
      const at = timestamp(this.now);
      this.assertActiveLease(record, leaseId, workerId, at);
      if (result.baseCommit !== record.spec.baseCommit) {
        throw new Error("result.baseCommit must match the task request.");
      }
      record.phase = "succeeded";
      delete record.lease;
      delete record.nextAttemptAt;
      delete record.failure;
      record.result = clone(result);
      record.timing.finishedAt = at;
      record.timing.runDurationMs =
        timestampMs(at) - timestampMs(record.timing.startedAt!);
      appendEvent(record, "succeeded", at, { workerId, leaseId });
      finalizeRecord(record, at);
      this.writeRecord(record, true);
      return clone(record);
    });
  }

  fail(
    id: Sha256Digest,
    leaseId: string,
    workerId: string,
    failure: Omit<FactoryTaskFailure, "occurredAt">,
    retryDelayMs: number,
  ): FactoryTaskRecord {
    const validatedId = assertSha256(String(id), "task id");
    assertSafeIdentifier(leaseId, "leaseId");
    assertSafeIdentifier(workerId, "workerId");
    assertFailureInput(failure);
    assertDuration(retryDelayMs, "retryDelayMs", MAX_RETRY_DELAY_MS);
    return this.withLock(() => {
      const record = this.requiredRecord(validatedId);
      if (record.phase === "failed") {
        if (
          record.failure?.kind !== failure.kind ||
          record.failure.message !== failure.message
        ) {
          throw new Error("Task already failed with a different failure.");
        }
        const event = record.events.at(-1)!;
        if (event.workerId !== workerId || event.leaseId !== leaseId) {
          throw new Error(
            "Idempotent failure requires the original lease identity.",
          );
        }
        return clone(record);
      }
      const at = timestamp(this.now);
      this.assertActiveLease(record, leaseId, workerId, at);
      delete record.lease;
      record.failure = { ...clone(failure), occurredAt: at };
      if (
        failure.kind === "transient" &&
        record.attempts < record.spec.maxAttempts
      ) {
        record.phase = "queued";
        record.nextAttemptAt = addMilliseconds(at, retryDelayMs);
        appendEvent(record, "retry-scheduled", at, {
          workerId,
          leaseId,
          detail: "Transient executor failure scheduled for retry.",
        });
      } else {
        record.phase = "failed";
        delete record.nextAttemptAt;
        record.timing.finishedAt = at;
        record.timing.runDurationMs =
          timestampMs(at) - timestampMs(record.timing.startedAt!);
        appendEvent(record, "failed", at, {
          workerId,
          leaseId,
          detail:
            failure.kind === "transient"
              ? "Attempt budget exhausted."
              : "Terminal executor failure.",
        });
      }
      finalizeRecord(record, at);
      this.writeRecord(record, true);
      return clone(record);
    });
  }

  cancel(id: Sha256Digest, detail: string): FactoryTaskRecord {
    const validatedId = assertSha256(String(id), "task id");
    assertString(detail, "detail", 1, 16_384);
    assertNoSecretMaterial(detail, "detail");
    return this.withLock(() => {
      const record = this.requiredRecord(validatedId);
      if (record.phase === "cancelled") {
        if (record.events.at(-1)?.detail !== detail)
          throw new Error("Task already cancelled with different detail.");
        return clone(record);
      }
      if (record.phase === "succeeded" || record.phase === "failed") {
        throw new Error(`Cannot cancel terminal ${record.phase} task.`);
      }
      const at = timestamp(this.now);
      record.phase = "cancelled";
      delete record.lease;
      delete record.nextAttemptAt;
      record.timing.startedAt ??= at;
      record.timing.finishedAt = at;
      record.timing.runDurationMs =
        timestampMs(at) - timestampMs(record.timing.startedAt);
      appendEvent(record, "cancelled", at, { detail });
      finalizeRecord(record, at);
      this.writeRecord(record, true);
      return clone(record);
    });
  }

  private assertLayout(): void {
    assertDirectory(this.root, "queue root");
    if (!samePath(realpathSync(this.root), this.root))
      throw new Error("queue root identity changed.");
    for (const [path, label] of [
      [this.tasksRoot, "tasks directory"],
      [this.temporaryRoot, "temporary directory"],
    ] as const) {
      if (!within(this.root, path))
        throw new Error(`${label} escapes queue root.`);
      assertDirectory(path, label);
      if (!samePath(realpathSync(path), path))
        throw new Error(`${label} cannot traverse a symbolic link.`);
    }
  }

  private taskNames(): string[] {
    this.assertLayout();
    return readdirSync(this.tasksRoot, { withFileTypes: true })
      .map((entry) => {
        if (
          entry.isSymbolicLink() ||
          !entry.isFile() ||
          !TASK_NAME.test(entry.name)
        ) {
          throw new Error(
            `Unclassified or linked queue entry '${entry.name}'.`,
          );
        }
        return entry.name;
      })
      .sort(compareText);
  }

  private listUnsafe(): FactoryTaskRecord[] {
    return this.taskNames().map((name) => {
      const record = this.readRecord(idFromTaskFile(name), false);
      if (!record) throw new Error(`Queue task '${name}' disappeared.`);
      return record;
    });
  }

  private taskPath(id: Sha256Digest): string {
    const path = resolve(this.tasksRoot, taskFileName(id));
    if (!within(this.tasksRoot, path))
      throw new Error("Task path escapes tasks directory.");
    return path;
  }

  private readRecord(
    id: Sha256Digest,
    allowMissing: boolean,
  ): FactoryTaskRecord | undefined {
    this.assertLayout();
    const path = this.taskPath(id);
    try {
      const bytes = readBounded(path, this.maxRecordBytes, `task ${id}`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = JSON.parse(text) as unknown;
      assertRecord(value, id);
      return value;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (allowMissing && code === "ENOENT") return undefined;
      throw error;
    }
  }

  private requiredRecord(id: Sha256Digest): FactoryTaskRecord {
    const record = this.readRecord(id, true);
    if (!record) throw new Error(`Factory task ${id} does not exist.`);
    return record;
  }

  private writeRecord(record: FactoryTaskRecord, replace: boolean): void {
    assertRecord(record, record.metadata.id);
    const bytes = Buffer.from(canonicalJson(record), "utf8");
    if (bytes.byteLength > this.maxRecordBytes) {
      throw new Error(
        `Factory task record exceeds the ${this.maxRecordBytes}-byte limit.`,
      );
    }
    this.assertLayout();
    const target = this.taskPath(record.metadata.id);
    if (replace) assertRegularFile(target, `task ${record.metadata.id}`);
    const temporary = resolve(
      this.temporaryRoot,
      `${taskFileName(record.metadata.id)}.${this.nextSafeId("temporary id")}.tmp`,
    );
    if (!within(this.temporaryRoot, temporary))
      throw new Error("Temporary task path escapes queue root.");
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* best-effort cleanup of owned temporary */
      }
      throw error;
    }
  }

  private assertActiveLease(
    record: FactoryTaskRecord,
    leaseId: string,
    workerId: string,
    at: string,
  ): void {
    if (record.phase !== "leased" || !record.lease)
      throw new Error("Task is not leased.");
    if (record.lease.id !== leaseId || record.lease.workerId !== workerId) {
      throw new Error("Task lease identity does not match.");
    }
    if (timestampMs(record.lease.expiresAt) <= timestampMs(at)) {
      throw new Error("Task lease has expired.");
    }
  }

  private nextSafeId(label: string): string {
    const value = this.randomId();
    assertSafeIdentifier(value, label);
    return value;
  }

  private nextUniqueSafeId(label: string, used: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = this.nextSafeId(label);
      if (!used.has(value)) return value;
    }
    throw new Error(`${label} generator did not produce a unique identifier.`);
  }

  private lockOwnerPath(directory: string): string {
    const path = resolve(directory, LOCK_OWNER_NAME);
    if (!within(this.root, path))
      throw new Error("Queue mutation lock owner path escapes queue root.");
    return path;
  }

  private readLockOwner(directory: string): QueueLockOwner {
    const entries = readdirSync(directory, { withFileTypes: true });
    if (
      entries.length !== 1 ||
      entries[0]?.name !== LOCK_OWNER_NAME ||
      entries[0].isSymbolicLink() ||
      !entries[0].isFile()
    ) {
      throw new Error("Queue mutation lock has invalid ownership metadata.");
    }
    const bytes = readBounded(
      this.lockOwnerPath(directory),
      LOCK_OWNER_MAX_BYTES,
      "queue mutation lock owner",
    );
    let owner: unknown;
    try {
      owner = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      throw new Error("Queue mutation lock owner is not valid UTF-8 JSON.", {
        cause: error,
      });
    }
    assertQueueLockOwner(owner, "queue mutation lock owner");
    return owner;
  }

  private removeOwnedLockDirectory(
    directory: string,
    expected: QueueLockOwner,
  ): void {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Queue mutation lock is not a real directory.");
    const actual = this.readLockOwner(directory);
    if (
      actual.pid !== expected.pid ||
      actual.acquiredAt !== expected.acquiredAt ||
      actual.token !== expected.token
    ) {
      throw new Error("Queue mutation lock ownership changed unexpectedly.");
    }
    unlinkSync(this.lockOwnerPath(directory));
    rmdirSync(directory);
  }

  private prepareLockCandidate(owner: QueueLockOwner): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = resolve(
        this.temporaryRoot,
        `mutation-lock-${randomUUID()}`,
      );
      if (!within(this.temporaryRoot, candidate))
        throw new Error("Queue mutation lock candidate escapes queue root.");
      try {
        mkdirSync(candidate, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        throw error;
      }
      const ownerPath = this.lockOwnerPath(candidate);
      const descriptor = openSync(
        ownerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        writeFileSync(descriptor, canonicalJson(owner), "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return candidate;
    }
    throw new Error("Unable to allocate a unique queue mutation lock.");
  }

  private tryRecoverAbandonedLock(): boolean {
    let info;
    try {
      info = lstatSync(this.lockPath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Queue mutation lock is not a real directory.");
    const entries = readdirSync(this.lockPath, { withFileTypes: true });
    if (entries.length === 0) {
      if (Date.now() - info.mtimeMs < LOCK_WAIT_MS) return false;
      try {
        rmdirSync(this.lockPath);
        return true;
      } catch (error) {
        if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error)))
          return true;
        throw error;
      }
    }
    const owner = this.readLockOwner(this.lockPath);
    if (isProcessAlive(owner.pid)) return false;
    const quarantine = resolve(
      this.temporaryRoot,
      `abandoned-lock-${randomUUID()}`,
    );
    if (!within(this.temporaryRoot, quarantine))
      throw new Error("Abandoned queue lock quarantine escapes queue root.");
    try {
      renameSync(this.lockPath, quarantine);
    } catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(errorCode(error)))
        return true;
      throw error;
    }
    this.removeOwnedLockDirectory(quarantine, owner);
    return true;
  }

  private withLock<T>(action: () => T): T {
    this.assertLayout();
    const started = Date.now();
    const owner: QueueLockOwner = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      token: randomUUID(),
    };
    const candidate = this.prepareLockCandidate(owner);
    let postTimeoutRecoveryUsed = false;
    try {
      while (true) {
        try {
          renameSync(candidate, this.lockPath);
          break;
        } catch (error) {
          const code = errorCode(error);
          if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(code)) throw error;
          const timedOut = Date.now() - started >= LOCK_WAIT_MS;
          if (this.tryRecoverAbandonedLock()) {
            if (timedOut) {
              if (postTimeoutRecoveryUsed)
                throw new Error(
                  "Timed out acquiring the queue mutation lock after recovery.",
                );
              postTimeoutRecoveryUsed = true;
            }
            continue;
          }
          if (timedOut)
            throw new Error("Timed out waiting for the queue mutation lock.");
          sleep(LOCK_POLL_MS);
        }
      }
    } catch (error) {
      this.removeOwnedLockDirectory(candidate, owner);
      throw error;
    }
    try {
      return action();
    } finally {
      this.removeOwnedLockDirectory(this.lockPath, owner);
    }
  }
}
