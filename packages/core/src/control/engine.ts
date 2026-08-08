import {
  AdapterRegistry,
  SYSTEM_ACTOR,
  type ExecutionControl,
} from "./adapters.js";
import { appendAuditEvent } from "./audit.js";
import { approvalsSatisfied } from "./approval.js";
import { sha256, ZERO_DIGEST } from "./canonical.js";
import { scanControlSecrets } from "./secret-scan.js";
import {
  validateControlDocument,
  validatePolicyDecision,
} from "./validation.js";
import type {
  ActorRef,
  Digest,
  PolicyDecision,
  RunRecord,
  RunState,
  TaskContract,
  TaskStep,
} from "./types.js";

export interface RunDigests {
  taskDigest?: Digest;
  candidateDigest?: Digest;
  evidenceDigest?: Digest;
  impactDigest?: Digest;
}

export interface TaskEngineOptions {
  registry: AdapterRegistry;
  now: () => string;
  actor?: ActorRef;
  signal?: AbortSignal;
  digests?: RunDigests;
  existingRun?: RunRecord;
}

export interface ControlEngineOptions {
  registry: AdapterRegistry;
  now: () => string;
  actor?: ActorRef;
}

export interface ControlEngineInvocationOptions {
  actor?: ActorRef;
  signal?: AbortSignal;
  digests?: RunDigests;
}

export interface ControlEngine {
  createRun(task: TaskContract, digests?: RunDigests): RunRecord;
  execute(
    task: TaskContract,
    options?: ControlEngineInvocationOptions,
  ): Promise<RunRecord>;
  resume(
    task: TaskContract,
    run: RunRecord,
    options?: ControlEngineInvocationOptions,
  ): Promise<RunRecord>;
}

const terminalStates = new Set<RunState>([
  "succeeded",
  "denied",
  "rejected",
  "failed",
  "cancelled",
]);

function assertExistingRunMatchesTask(
  task: TaskContract,
  run: RunRecord,
  taskDigest: Digest,
): void {
  const validation = validateControlDocument(run);
  const blockingIssues = validation.issues.filter(
    (issue) => issue.code !== "approval.stale-digest",
  );
  if (blockingIssues.length > 0)
    throw new Error(
      `Invalid existing RunRecord: ${blockingIssues[0]!.message}`,
    );
  if (
    run.spec.task.id !== task.metadata.id ||
    run.spec.task.version !== task.metadata.version ||
    run.spec.taskDigest !== taskDigest
  ) {
    throw new Error(
      "Existing RunRecord is bound to a different TaskContract digest or identity.",
    );
  }
  if (
    run.spec.steps.length !== task.spec.steps.length ||
    run.spec.steps.some((step, index) => step.id !== task.spec.steps[index]?.id)
  ) {
    throw new Error(
      "Existing RunRecord step order does not match the TaskContract.",
    );
  }
  const expectedKey = sha256({
    task: task.metadata.id,
    version: task.metadata.version,
    taskDigest,
  });
  if (run.spec.idempotencyKey !== expectedKey)
    throw new Error("Existing RunRecord has an invalid idempotency key.");
}

function updateReviewDigests(
  run: RunRecord,
  digests: RunDigests | undefined,
  options: TaskEngineOptions,
): void {
  if (!digests) return;
  const changed: Record<string, Digest> = {};
  for (const field of [
    "candidateDigest",
    "evidenceDigest",
    "impactDigest",
  ] as const) {
    const next = digests[field];
    if (next !== undefined && next !== run.spec[field]) {
      run.spec[field] = next;
      changed[field] = next;
    }
  }
  if (Object.keys(changed).length > 0)
    audit(
      run,
      options.now(),
      options.actor ?? SYSTEM_ACTOR,
      "run.review-context-updated",
      changed,
    );
}

function audit(
  run: RunRecord,
  occurredAt: string,
  actor: ActorRef,
  type: string,
  payload: Record<string, unknown>,
): void {
  const appended = appendAuditEvent(run.spec.audit, {
    occurredAt,
    actor,
    type,
    payload,
  });
  run.spec.audit = appended.trail;
  run.spec.auditHead = appended.head;
}

const allowedStateTransitions: Record<RunState, readonly RunState[]> = {
  created: ["preflight", "failed", "cancelled"],
  preflight: [
    "preflight",
    "executing",
    "awaitingApproval",
    "succeeded",
    "denied",
    "failed",
    "cancelled",
  ],
  executing: [
    "preflight",
    "executing",
    "validating",
    "awaitingApproval",
    "succeeded",
    "failed",
    "cancelled",
  ],
  validating: [
    "preflight",
    "executing",
    "validating",
    "awaitingApproval",
    "succeeded",
    "failed",
    "cancelled",
  ],
  awaitingApproval: [
    "preflight",
    "executing",
    "awaitingApproval",
    "succeeded",
    "rejected",
    "failed",
    "cancelled",
  ],
  succeeded: ["succeeded"],
  denied: ["denied"],
  rejected: ["rejected"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

export interface RunStateReduction {
  occurredAt: string;
  actor: ActorRef;
  reason?: string;
}

/** Pure, audited state reducer used by the engine and available to orchestrators. */
export function reduceRunState(
  run: RunRecord,
  state: RunState,
  input: RunStateReduction,
): RunRecord {
  if (!allowedStateTransitions[run.spec.state].includes(state))
    throw new Error(
      `Invalid run state transition '${run.spec.state}' -> '${state}'.`,
    );
  if (terminalStates.has(run.spec.state) && state === run.spec.state)
    return structuredClone(run);
  const updated = structuredClone(run);
  updated.spec.state = state;
  if (input.reason === undefined) delete updated.spec.stateReason;
  else updated.spec.stateReason = input.reason;
  audit(
    updated,
    input.occurredAt,
    input.actor,
    `run.${state}`,
    input.reason ? { reason: input.reason } : {},
  );
  return updated;
}

function transition(
  run: RunRecord,
  state: RunState,
  options: TaskEngineOptions,
  reason?: string,
): void {
  const updated = reduceRunState(run, state, {
    occurredAt: options.now(),
    actor: options.actor ?? SYSTEM_ACTOR,
    ...(reason === undefined ? {} : { reason }),
  });
  run.spec.state = updated.spec.state;
  if (updated.spec.stateReason === undefined) delete run.spec.stateReason;
  else run.spec.stateReason = updated.spec.stateReason;
  run.spec.audit = updated.spec.audit;
  run.spec.auditHead = updated.spec.auditHead;
}

export function createRunRecord(
  task: TaskContract,
  now: string,
  digests: RunDigests = {},
): RunRecord {
  const taskDigest = digests.taskDigest ?? sha256(task);
  const empty = ZERO_DIGEST;
  const run: RunRecord = {
    schemaVersion: "coga.dev/control/v0.1",
    kind: "RunRecord",
    metadata: {
      id: `${task.metadata.id}.run`,
      title: `Run for ${task.metadata.title}`,
      version: task.metadata.version,
      lifecycle: "draft",
      scope: "core",
      visibility: "internal",
    },
    spec: {
      task: { id: task.metadata.id, version: task.metadata.version },
      idempotencyKey: sha256({
        task: task.metadata.id,
        version: task.metadata.version,
        taskDigest,
      }),
      state: "created",
      taskDigest,
      candidateDigest: digests.candidateDigest ?? empty,
      evidenceDigest: digests.evidenceDigest ?? empty,
      impactDigest: digests.impactDigest ?? empty,
      requestedBy: task.spec.requestedBy,
      steps: task.spec.steps.map((step) => ({
        id: step.id,
        state: "pending",
        attempts: 0,
      })),
      policyDecisions: [],
      approvalDecisions: [],
      evidence: [],
      audit: [],
      auditHead: empty,
      budget: {
        elapsedMs: 0,
        attempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      },
      heartbeatAt: now,
    },
  };
  audit(run, now, SYSTEM_ACTOR, "run.created", { taskDigest });
  return run;
}

function makeControl(
  run: RunRecord,
  options: TaskEngineOptions,
): ExecutionControl {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    heartbeat: (message) => {
      run.spec.heartbeatAt = options.now();
      audit(
        run,
        run.spec.heartbeatAt,
        options.actor ?? SYSTEM_ACTOR,
        "run.heartbeat",
        message ? { messageDigest: sha256(message) } : {},
      );
    },
    checkpoint: (value) => {
      if (scanControlSecrets(value).length > 0)
        throw new Error("Checkpoint contains forbidden secret-like material.");
      run.spec.checkpoint = structuredClone(value);
      audit(
        run,
        options.now(),
        options.actor ?? SYSTEM_ACTOR,
        "run.checkpoint",
        { digest: sha256(value) },
      );
    },
    consumeBudget: (usage) => {
      const attempts = usage.attempts ?? 0;
      const inputTokens = usage.inputTokens ?? usage.tokens ?? 0;
      const outputTokens = usage.outputTokens ?? 0;
      const costUsd = usage.costUsd ?? 0;
      if (
        !Number.isInteger(attempts) ||
        attempts < 0 ||
        !Number.isInteger(inputTokens) ||
        inputTokens < 0 ||
        !Number.isInteger(outputTokens) ||
        outputTokens < 0 ||
        !Number.isFinite(costUsd) ||
        costUsd < 0
      ) {
        throw new Error(
          "Budget consumption must contain non-negative finite usage.",
        );
      }
      run.spec.budget.attempts += attempts;
      run.spec.budget.inputTokens += inputTokens;
      run.spec.budget.outputTokens += outputTokens;
      run.spec.budget.costUsd += costUsd;
    },
  };
}

function budgetExceeded(
  task: TaskContract,
  run: RunRecord,
): string | undefined {
  if (run.spec.budget.elapsedMs > task.spec.budget.maxDurationMs)
    return "duration budget exceeded";
  if (run.spec.budget.attempts > task.spec.budget.maxAttempts)
    return "attempt budget exceeded";
  if (
    task.spec.budget.maxTokens !== undefined &&
    run.spec.budget.inputTokens + run.spec.budget.outputTokens >
      task.spec.budget.maxTokens
  )
    return "token budget exceeded";
  if (
    task.spec.budget.maxCostUsd !== undefined &&
    run.spec.budget.costUsd > task.spec.budget.maxCostUsd
  )
    return "cost budget exceeded";
  return undefined;
}

function updateElapsed(run: RunRecord, now: string): void {
  const startedAt = run.spec.audit[0]?.occurredAt;
  if (!startedAt) return;
  const elapsed = Date.parse(now) - Date.parse(startedAt);
  if (Number.isFinite(elapsed))
    run.spec.budget.elapsedMs = Math.max(0, elapsed);
}

function requiredPolicyApprovals(
  decisions: readonly PolicyDecision[],
): string[] {
  return [
    ...new Set(
      decisions
        .filter((entry) => entry.decision === "requireApproval")
        .flatMap((entry) => entry.approvalRequirementIds),
    ),
  ].sort();
}

async function invokeStep(
  task: TaskContract,
  step: TaskStep,
  registry: AdapterRegistry,
  control: ExecutionControl,
): Promise<Record<string, unknown>> {
  if (step.adapter.kind === "agent") {
    const result = await registry
      .resolve({ ...step.adapter, kind: "agent" })
      .execute({ task, step }, control);
    if (result.disposition !== "candidate")
      throw new Error("Agent adapters may return candidate output only.");
    return result.output;
  }
  if (step.adapter.kind === "tool")
    return (
      await registry
        .resolve({ ...step.adapter, kind: "tool" })
        .invoke({ action: step.action, input: step.input }, control)
    ).output;
  if (step.adapter.kind === "preview") {
    const result = await registry
      .resolve({ ...step.adapter, kind: "preview" })
      .render({ action: step.action, input: step.input }, control);
    if (result.disposition !== "candidate")
      throw new Error("Preview adapters may return candidate output only.");
    return result.output;
  }
  if (step.adapter.kind === "observation")
    return {
      observations: await registry
        .resolve({ ...step.adapter, kind: "observation" })
        .collect(control),
    };
  throw new Error(`Unsupported task step adapter kind '${step.adapter.kind}'.`);
}

function cancelled(
  run: RunRecord,
  task: TaskContract,
  options: TaskEngineOptions,
): boolean {
  if (!options.signal?.aborted) return false;
  run.spec.cancellation = {
    requestedBy: options.actor ?? SYSTEM_ACTOR,
    reason: "abort signal",
    requestedAt: options.now(),
  };
  transition(run, "cancelled", options, "abort signal");
  return true;
}

/** Execute or resume with injected adapters; completed steps and terminal runs are idempotent. */
export async function executeTask(
  task: TaskContract,
  options: TaskEngineOptions,
): Promise<RunRecord> {
  const validation = validateControlDocument(task);
  if (!validation.valid)
    throw new Error(
      `Invalid TaskContract: ${validation.issues[0]?.message ?? "unknown"}`,
    );
  const expectedTaskDigest = options.digests?.taskDigest ?? sha256(task);
  const run = options.existingRun
    ? structuredClone(options.existingRun)
    : createRunRecord(task, options.now(), {
        ...options.digests,
        taskDigest: expectedTaskDigest,
      });
  if (options.existingRun)
    assertExistingRunMatchesTask(task, run, expectedTaskDigest);
  if (terminalStates.has(run.spec.state)) return run;
  updateReviewDigests(run, options.digests, options);
  if (cancelled(run, task, options)) return run;
  const control = makeControl(run, options);

  if (run.spec.policyDecisions.length === 0) {
    transition(run, "preflight", options);
    for (const check of task.spec.policies) {
      let decision: PolicyDecision;
      try {
        decision = await options.registry
          .resolve(check.evaluator)
          .evaluate(
            { task, policy: check.policy, taskDigest: run.spec.taskDigest },
            control,
          );
      } catch {
        transition(run, "failed", options, "policy adapter failed");
        return run;
      }
      const decisionValidation = validatePolicyDecision(decision);
      if (!decisionValidation.valid) {
        transition(
          run,
          "failed",
          options,
          "policy adapter returned an invalid decision",
        );
        return run;
      }
      updateElapsed(run, options.now());
      const policyBudget = budgetExceeded(task, run);
      if (policyBudget) {
        transition(run, "failed", options, policyBudget);
        return run;
      }
      if (
        decision.policy.id !== check.policy.id ||
        decision.policy.version !== check.policy.version ||
        decision.evaluator.id !== check.evaluator.id ||
        decision.evaluator.version !== check.evaluator.version ||
        decision.evaluator.kind !== "policy" ||
        decision.taskDigest !== run.spec.taskDigest
      ) {
        transition(
          run,
          "failed",
          options,
          "policy adapter returned an unbound decision",
        );
        return run;
      }
      run.spec.policyDecisions.push(decision);
      audit(
        run,
        options.now(),
        options.actor ?? SYSTEM_ACTOR,
        "policy.decision",
        {
          policy: decision.policy,
          decision: decision.decision,
          taskDigest: decision.taskDigest,
        },
      );
      if (decision.decision === "deny") {
        transition(run, "denied", options, decision.reason);
        return run;
      }
    }
  }

  if (cancelled(run, task, options)) return run;

  const preflightIds = requiredPolicyApprovals(run.spec.policyDecisions);
  const preflightRequirements = new Set(
    task.spec.approvals
      .filter((requirement) => requirement.phase === "preflight")
      .map((requirement) => requirement.id),
  );
  if (preflightIds.some((id) => !preflightRequirements.has(id))) {
    transition(
      run,
      "failed",
      options,
      "policy requested an unknown preflight approval requirement",
    );
    return run;
  }
  if (
    !approvalsSatisfied(
      task,
      run,
      "preflight",
      preflightIds.length > 0 ? preflightIds : undefined,
    )
  ) {
    transition(run, "awaitingApproval", options, "preflight approval required");
    return run;
  }

  const allStepsCompleted = run.spec.steps.every(
    (step) => step.state === "completed",
  );
  if (allStepsCompleted) {
    if (
      !approvalsSatisfied(task, run, "post-validation") ||
      !approvalsSatisfied(task, run, "release")
    ) {
      transition(
        run,
        "awaitingApproval",
        options,
        "post-validation approval required",
      );
      return run;
    }
    transition(run, "succeeded", options);
    return run;
  }

  const workspace = options.registry.resolve(task.spec.workspace);
  const outputDigests: Digest[] = run.spec.steps.flatMap((step) =>
    step.state === "completed" && step.outputDigest ? [step.outputDigest] : [],
  );
  const claimDigests: Digest[] = run.spec.steps.flatMap((step) =>
    step.state === "completed" && step.claimDigest ? [step.claimDigest] : [],
  );
  let prepared = false;
  try {
    await workspace.prepare(task, control);
    prepared = true;
    updateElapsed(run, options.now());
    const preparationBudget = budgetExceeded(task, run);
    if (preparationBudget) {
      transition(run, "failed", options, preparationBudget);
      return run;
    }
    for (const [index, step] of task.spec.steps.entries()) {
      const stepRun = run.spec.steps[index]!;
      if (stepRun.state === "completed") continue;
      if (cancelled(run, task, options)) return run;
      transition(run, "executing", options);
      let output: Record<string, unknown> | undefined;
      let lastError: unknown;
      while (stepRun.attempts < step.maxAttempts && output === undefined) {
        stepRun.state = "running";
        stepRun.attempts += 1;
        run.spec.budget.attempts += 1;
        try {
          output = await invokeStep(task, step, options.registry, control);
        } catch (error) {
          lastError = error;
          if (options.signal?.aborted) break;
        }
      }
      updateElapsed(run, options.now());
      if (cancelled(run, task, options)) return run;
      if (!output) {
        stepRun.state = "failed";
        transition(
          run,
          "failed",
          options,
          lastError === undefined
            ? "step returned no output"
            : "step adapter failed",
        );
        return run;
      }
      const exceeded = budgetExceeded(task, run);
      if (exceeded) {
        stepRun.state = "failed";
        transition(run, "failed", options, exceeded);
        return run;
      }
      transition(run, "validating", options);
      const claims = [];
      for (const validatorRef of step.validators) {
        const result = await options.registry
          .resolve(validatorRef)
          .validate({ task, step, candidate: output }, control);
        claims.push(...result.claims);
      }
      updateElapsed(run, options.now());
      const validationBudget = budgetExceeded(task, run);
      if (validationBudget) {
        stepRun.state = "failed";
        transition(run, "failed", options, validationBudget);
        return run;
      }
      if (cancelled(run, task, options)) return run;
      const passed = new Set(
        claims
          .filter((claim) => claim.status === "passed")
          .map((claim) => claim.claim),
      );
      const missing = step.requiredClaims.filter((claim) => !passed.has(claim));
      if (
        claims.some((claim) => claim.status === "failed") ||
        missing.length > 0
      ) {
        stepRun.state = "failed";
        transition(
          run,
          "failed",
          options,
          missing.length > 0
            ? `missing claims: ${missing.join(", ")}`
            : "validator failed",
        );
        return run;
      }
      stepRun.outputDigest = sha256(output);
      stepRun.claimDigest = sha256(claims);
      stepRun.state = "completed";
      outputDigests.push(stepRun.outputDigest);
      claimDigests.push(stepRun.claimDigest);
      audit(
        run,
        options.now(),
        options.actor ?? SYSTEM_ACTOR,
        "step.completed",
        {
          step: step.id,
          outputDigest: stepRun.outputDigest,
          claimDigest: stepRun.claimDigest,
        },
      );
    }
    if (cancelled(run, task, options)) return run;
    const snapshot = await workspace.snapshot(control);
    run.spec.candidateDigest = sha256({ outputDigests, snapshot });
    run.spec.evidenceDigest = sha256(claimDigests);
  } catch {
    if (!terminalStates.has(run.spec.state))
      transition(
        run,
        "failed",
        options,
        "workspace or validation adapter failed",
      );
    return run;
  } finally {
    if (prepared) {
      try {
        await workspace.dispose(control);
      } catch {
        if (!terminalStates.has(run.spec.state))
          transition(run, "failed", options, "workspace cleanup failed");
      }
    }
  }

  if (terminalStates.has(run.spec.state)) return run;

  if (
    !approvalsSatisfied(task, run, "post-validation") ||
    !approvalsSatisfied(task, run, "release")
  ) {
    transition(
      run,
      "awaitingApproval",
      options,
      "post-validation approval required",
    );
    return run;
  }
  transition(run, "succeeded", options);
  return run;
}

/** Bind an exact registry and deterministic clock for repeated execute/resume calls. */
export function createControlEngine(base: ControlEngineOptions): ControlEngine {
  const invocationOptions = (
    options: ControlEngineInvocationOptions = {},
    existingRun?: RunRecord,
  ): TaskEngineOptions => {
    const actor = options.actor ?? base.actor;
    return {
      registry: base.registry,
      now: base.now,
      ...(actor ? { actor } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.digests ? { digests: options.digests } : {}),
      ...(existingRun ? { existingRun } : {}),
    };
  };
  return {
    createRun: (task, digests) => {
      const validation = validateControlDocument(task);
      if (!validation.valid)
        throw new Error(
          `Invalid TaskContract: ${validation.issues[0]?.message ?? "unknown"}`,
        );
      return createRunRecord(task, base.now(), digests);
    },
    execute: (task, options) => executeTask(task, invocationOptions(options)),
    resume: (task, run, options) =>
      executeTask(task, invocationOptions(options, run)),
  };
}
