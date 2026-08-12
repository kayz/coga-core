import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FactoryRunState, FactoryState, Sha256Digest } from "./types.js";
import { FACTORY_SCHEMA_VERSION, FACTORY_STATES } from "./types.js";
import {
  canonicalJson,
  readBoundedFile,
  sanitizeIdentifier,
  sha256,
} from "./utils.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const BRANCH_PATTERN = /^codex\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/u;
const STEP_STATES = new Set(["pending", "running", "passed", "failed"]);
const RUN_STATES = new Set<FactoryState>(FACTORY_STATES);

function invalid(detail: string): never {
  throw new Error(`Invalid Factory state: ${detail}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    return invalid(`${label}.${key} must be a non-empty string`);
  }
  return candidate;
}

function inspect(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > 100_000) invalid("document exceeds the node limit");
    if (current.depth > 64) invalid("document exceeds the depth limit");
    if (
      current.value === null ||
      ["string", "number", "boolean"].includes(typeof current.value)
    ) {
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      invalid("document contains a non-JSON value");
    }
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

function assertShape(value: unknown): FactoryRunState {
  inspect(value);
  const document = record(value, "document");
  if (document.schemaVersion !== FACTORY_SCHEMA_VERSION) {
    invalid("schemaVersion is unsupported");
  }
  const workOrderId = requiredString(document, "workOrderId", "document");
  const workOrderDigest = requiredString(
    document,
    "workOrderDigest",
    "document",
  );
  const status = requiredString(document, "status", "document");
  const baseCommit = requiredString(document, "baseCommit", "document");
  const workspacePath = requiredString(document, "workspacePath", "document");
  const branch = requiredString(document, "branch", "document");
  const updatedAt = requiredString(document, "updatedAt", "document");
  if (!/^[a-z0-9][a-z0-9.-]{2,127}$/u.test(workOrderId))
    invalid("workOrderId is malformed");
  if (!DIGEST_PATTERN.test(workOrderDigest))
    invalid("workOrderDigest is malformed");
  if (!RUN_STATES.has(status as FactoryState)) invalid("status is unknown");
  if (!COMMIT_PATTERN.test(baseCommit)) invalid("baseCommit is malformed");
  if (!isAbsolute(workspacePath)) invalid("workspacePath must be absolute");
  if (!BRANCH_PATTERN.test(branch)) invalid("branch is unsafe");
  if (Number.isNaN(Date.parse(updatedAt))) invalid("updatedAt is malformed");
  if (!Array.isArray(document.steps) || document.steps.length > 100) {
    invalid("steps must be an array with at most 100 entries");
  }
  for (const [index, candidate] of document.steps.entries()) {
    const step = record(candidate, `steps[${index}]`);
    requiredString(step, "id", `steps[${index}]`);
    const stepStatus = requiredString(step, "status", `steps[${index}]`);
    if (!STEP_STATES.has(stepStatus))
      invalid(`steps[${index}].status is unknown`);
    if (
      typeof step.attempts !== "number" ||
      !Number.isInteger(step.attempts) ||
      step.attempts < 0 ||
      step.attempts > 1000
    ) {
      invalid(`steps[${index}].attempts is invalid`);
    }
  }
  return document as unknown as FactoryRunState;
}

function adapterReference(value: string): { id: string; version: string } {
  const match = /^(.*)\/v([^/]+)$/u.exec(value);
  if (!match?.[1] || !match[2])
    invalid(`planned adapter '${value}' is invalid`);
  return { id: match[1], version: match[2] };
}

function exactKey(value: { id: string; version: string }): string {
  return `${value.id}@${value.version}`;
}

export function runStatePath(
  stateRoot: string,
  workOrderId: string,
  digest: Sha256Digest,
): string {
  const name = `${sanitizeIdentifier(workOrderId)}-${digest.slice("sha256:".length, "sha256:".length + 12)}`;
  return resolve(stateRoot, name, "state.json");
}

export function loadRunState(path: string): FactoryRunState | undefined {
  try {
    const value = readBoundedFile(path, "Factory state", 5 * 1024 * 1024);
    return assertShape(JSON.parse(value.toString("utf8")) as unknown);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export function assertRunStateIntegrity(
  state: FactoryRunState,
  expected: {
    workOrderId: string;
    workOrderDigest: Sha256Digest;
    baseCommit: string;
    workspacePath: string;
    branch: string;
  },
): void {
  if (state.workOrderId !== expected.workOrderId)
    invalid("workOrderId does not match the Work Order");
  if (state.workOrderDigest !== expected.workOrderDigest)
    invalid("workOrderDigest does not match the Work Order");
  if (state.baseCommit !== expected.baseCommit)
    invalid("baseCommit does not match the Work Order");
  if (resolve(state.workspacePath) !== resolve(expected.workspacePath))
    invalid("workspacePath does not match the content-addressed workspace");
  if (state.branch !== expected.branch)
    invalid("branch does not match the Work Order");
  if (!state.plan) invalid("Execution Plan is missing");

  const { planDigest, ...planPayload } = state.plan;
  if (!DIGEST_PATTERN.test(planDigest)) invalid("planDigest is malformed");
  if (sha256(canonicalJson(planPayload)) !== planDigest)
    invalid("Execution Plan digest mismatch");
  if (
    state.plan.workOrder.id !== expected.workOrderId ||
    state.plan.workOrder.digest !== expected.workOrderDigest ||
    state.plan.baseCommit !== expected.baseCommit
  ) {
    invalid("Execution Plan bindings do not match the run");
  }

  const plannedIds = state.plan.steps.map((entry) => entry.id);
  const stateIds = state.steps.map((entry) => entry.id);
  if (
    new Set(plannedIds).size !== plannedIds.length ||
    canonicalJson(plannedIds) !== canonicalJson(stateIds)
  ) {
    invalid("step sequence does not match the Execution Plan");
  }
  let terminalSeen = false;
  let activeSteps = 0;
  for (const [index, step] of state.steps.entries()) {
    const planned = state.plan.steps[index];
    if (!planned) invalid(`step '${step.id}' is not planned`);
    if (step.status !== "passed") terminalSeen = true;
    else if (terminalSeen) invalid("passed steps are not a contiguous prefix");
    if (step.status === "running" || step.status === "failed") activeSteps += 1;
    if (activeSteps > 1) invalid("more than one step is active or failed");
    if (step.status === "passed" || step.status === "failed") {
      if (!step.receipt || step.receipt.status !== step.status)
        invalid(`step '${step.id}' has no matching receipt`);
      const adapter = adapterReference(planned.adapter);
      if (
        step.receipt.stepId !== step.id ||
        exactKey(step.receipt.adapter) !== exactKey(adapter)
      ) {
        invalid(`step '${step.id}' receipt binding is invalid`);
      }
    } else if (step.receipt) {
      invalid(`step '${step.id}' has a receipt before completion`);
    }
  }

  if (state.evidence) {
    if (!DIGEST_PATTERN.test(state.evidence.digest))
      invalid("Evidence Bundle digest is malformed");
    const expectedPath = `.coga/evidence/${state.evidence.digest.slice("sha256:".length)}.json`;
    if (state.evidence.path !== expectedPath)
      invalid("Evidence Bundle path is not content-addressed");
  }
  if (state.resultCommit && !COMMIT_PATTERN.test(state.resultCommit))
    invalid("resultCommit is malformed");
  if (state.result) {
    if (!state.resultCommit || !state.evidence)
      invalid("result is missing its commit or evidence binding");
    if (
      state.result.workOrderId !== expected.workOrderId ||
      state.result.baseCommit !== expected.baseCommit ||
      state.result.resultCommit !== state.resultCommit ||
      state.result.branch !== expected.branch ||
      state.result.evidencePath !== state.evidence.path ||
      state.result.evidenceDigest !== state.evidence.digest
    ) {
      invalid("result bindings do not match the run");
    }
  }
  if (state.status === "completed" && !state.result)
    invalid("completed run has no result");
}

export function saveRunState(path: string, state: FactoryRunState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, canonicalJson(state), {
    encoding: "utf8",
    flag: "w",
  });
  renameSync(temporary, path);
}
