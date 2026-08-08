import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  approvalRequirementSatisfied,
  appendAuditEvent,
  canonicalJson,
  createControlEngine,
  createRunRecord,
  executeTask,
  recordApprovalDecision,
  reduceRunState,
  semanticDiff,
  sha256,
  validateControlDocument,
  validateControlResource,
  validateApprovalDecision,
  validateAuditEvent,
  validatePolicyDecision,
  verifyAuditTrail,
  verifyEvidenceBundle,
  ZERO_DIGEST,
} from "../src/index.js";
import type {
  ActorRef,
  ApprovalDecision,
  EvidenceBundle,
  Incident,
  Observation,
  PolicyAdapter,
  PromotionProposal,
  TaskContract,
} from "../src/index.js";

const at = "2026-08-08T00:00:00.000Z";
const human: ActorRef = {
  kind: "human",
  id: "human.domain.owner",
  roles: ["domain-owner"],
};
const agent: ActorRef = {
  kind: "agent",
  id: "agent.deepseek.asset-evaluator",
  roles: ["asset-evaluator"],
};
const metadata = (
  id: string,
  title: string,
  lifecycle:
    | "draft"
    | "candidate"
    | "approved"
    | "published"
    | "deprecated" = "candidate",
) => ({
  id,
  title,
  version: "0.1.0",
  lifecycle,
  scope: "core" as const,
  visibility: "internal" as const,
});

function task(overrides: Partial<TaskContract["spec"]> = {}): TaskContract {
  return {
    schemaVersion: "coga.dev/control/v0.1",
    kind: "TaskContract",
    metadata: metadata("task.asset.evaluate", "Evaluate asset candidate"),
    spec: {
      mode: "calibrate",
      risk: "high",
      requestedBy: agent,
      instance: { id: "instance.broker.channel", version: "0.1.0" },
      intent: {
        goal: "Evaluate a candidate domain asset.",
        acceptanceCriteria: ["Candidate evidence is produced."],
        nonGoals: ["Publish the asset."],
        sources: ["source.requirements.document"],
      },
      workspace: {
        kind: "workspace",
        id: "adapter.workspace.memory",
        version: "0.1.0",
      },
      steps: [
        {
          id: "evaluate",
          phase: "execute",
          adapter: {
            kind: "agent",
            id: "adapter.agent.deepseek",
            version: "0.1.0",
          },
          action: "evaluate-asset",
          input: { assetId: "domain.customer.identity" },
          validators: [
            {
              kind: "validator",
              id: "adapter.validator.claims",
              version: "0.1.0",
            },
          ],
          requiredClaims: ["candidate.valid"],
          maxAttempts: 1,
        },
      ],
      policies: [],
      approvals: [],
      budget: {
        maxDurationMs: 60_000,
        maxAttempts: 1,
        maxTokens: 1000,
        maxCostUsd: 1,
      },
      ...overrides,
    },
  };
}

function evidence(): EvidenceBundle {
  const subjectBytes = Buffer.from("candidate");
  const reportBytes = Buffer.from("report");
  return {
    schemaVersion: "coga.dev/control/v0.1",
    kind: "EvidenceBundle",
    metadata: metadata("evidence.asset.evaluate", "Asset evaluation evidence"),
    spec: {
      task: { id: "task.asset.evaluate", version: "0.1.0" },
      runId: "run-1",
      producedBy: agent,
      disposition: "candidate",
      subject: {
        path: "candidate.yaml",
        mediaType: "application/yaml",
        digest: sha256(subjectBytes),
      },
      materials: [
        {
          path: "report.json",
          mediaType: "application/json",
          digest: sha256(reportBytes),
        },
      ],
      claimResults: [
        {
          claim: "candidate.valid",
          status: "passed",
          validator: {
            kind: "validator",
            id: "adapter.validator.claims",
            version: "0.1.0",
          },
          materialPaths: ["report.json"],
        },
      ],
      execution: {
        model: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          responseId: "response-1",
          usage: { inputTokens: 10, outputTokens: 5 },
          promptDigest: sha256("prompt"),
          outputDigest: sha256("output"),
        },
      },
    },
  };
}

function adapters(
  calls: string[],
  claimStatus: "passed" | "failed" = "passed",
): AdapterRegistry {
  return new AdapterRegistry()
    .register({
      descriptor: {
        kind: "workspace",
        id: "adapter.workspace.memory",
        version: "0.1.0",
      },
      async prepare() {
        calls.push("workspace.prepare");
      },
      async snapshot() {
        calls.push("workspace.snapshot");
        return { tree: sha256("tree") };
      },
      async dispose() {
        calls.push("workspace.dispose");
      },
    })
    .register({
      descriptor: {
        kind: "agent",
        id: "adapter.agent.deepseek",
        version: "0.1.0",
      },
      async execute(_request, control) {
        calls.push("agent.execute");
        control.heartbeat("working");
        control.checkpoint({ phase: "evaluated" });
        control.consumeBudget({ tokens: 15, costUsd: 0.01 });
        return {
          disposition: "candidate" as const,
          output: { recommendation: "candidate" },
        };
      },
    })
    .register({
      descriptor: {
        kind: "validator",
        id: "adapter.validator.claims",
        version: "0.1.0",
      },
      async validate() {
        calls.push("validator.validate");
        return {
          claims: [
            {
              claim: "candidate.valid",
              status: claimStatus,
              validator: {
                kind: "validator" as const,
                id: "adapter.validator.claims",
                version: "0.1.0",
              },
              materialPaths: [],
            },
          ],
        };
      },
    });
}

describe("COGA control plane contracts", () => {
  it("validates a TaskContract and rejects missing intent, non-exact refs, and literal secrets", () => {
    expect(validateControlDocument(task()).valid).toBe(true);
    const referenced = task();
    referenced.spec.steps[0]!.input.apiKey = "env://DEEPSEEK_API_KEY";
    expect(validateControlDocument(referenced).valid).toBe(true);
    const invalid = structuredClone(task()) as any;
    delete invalid.spec.intent.goal;
    invalid.spec.workspace.version = "^0.1.0";
    invalid.spec.steps[0].input.apiKey = "sk-literalcredentialvalue123456789";
    invalid.spec.steps[0].input.accessToken = "literal-access-token";
    const result = validateControlDocument(invalid);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "control.schema.required",
        "control.schema.pattern",
        "control.secret.literal-sensitive-field",
      ]),
    );
  });

  it("round-trips safe model evidence and rejects raw prompts, reasoning, and credentials", () => {
    const bundle = evidence();
    expect(
      validateControlDocument(JSON.parse(canonicalJson(bundle))).valid,
    ).toBe(true);
    const unsafe = structuredClone(bundle) as any;
    unsafe.spec.execution.model.rawPrompt = "secret prompt";
    unsafe.spec.execution.model.reasoning = "hidden reasoning";
    unsafe.spec.execution.model.apiKey = "sk-literalcredentialvalue123456789";
    unsafe.spec.execution.command = {
      executable: "validator",
      args: ["--api-key", "literal-value"],
      exitCode: 0,
    };
    const result = validateControlDocument(unsafe);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "control.metadata.forbidden-field",
    );
    expect(result.issues.map((entry) => entry.code)).toContain(
      "control.secret.literal-command-argument",
    );
  });

  it("verifies evidence bytes and required claim coverage", () => {
    const bundle = evidence();
    const baseDir = resolve("virtual-evidence");
    const bytes: Record<string, Buffer> = {
      [resolve(baseDir, "candidate.yaml")]: Buffer.from("candidate"),
      [resolve(baseDir, "report.json")]: Buffer.from("report"),
    };
    const valid = verifyEvidenceBundle(bundle, {
      baseDir,
      requiredClaims: ["candidate.valid"],
      readFile: (path) => bytes[path]!,
    });
    expect(valid).toEqual([]);
    const invalid = verifyEvidenceBundle(bundle, {
      baseDir,
      requiredClaims: ["security.reviewed"],
      readFile: (path) =>
        path.endsWith("report.json") ? Buffer.from("tampered") : bytes[path]!,
    });
    expect(invalid.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "evidence.digest-mismatch",
        "evidence.required-claim-missing",
      ]),
    );

    for (const unsafePath of [
      "../candidate.yaml",
      "/tmp/candidate.yaml",
      "C:\\secrets\\candidate.yaml",
    ]) {
      const unsafe = structuredClone(bundle);
      unsafe.spec.subject.path = unsafePath;
      const validation = validateControlDocument(unsafe);
      expect(validation.valid).toBe(false);
      expect(
        validation.issues.some((entry) =>
          ["control.schema.pattern", "evidence.material-path-invalid"].includes(
            entry.code,
          ),
        ),
      ).toBe(true);
      expect(
        verifyEvidenceBundle(unsafe, {
          baseDir,
          readFile: () => {
            throw new Error("An unsafe path must not be read.");
          },
        }).map((entry) => entry.code),
      ).toContain("evidence.material-path-invalid");
    }
  });

  it("rejects unknown, duplicate, wrong-kind, and wrong-version adapters", () => {
    const registry = new AdapterRegistry();
    const tool = {
      descriptor: {
        kind: "tool" as const,
        id: "adapter.tool.safe",
        version: "0.1.0",
      },
      async invoke() {
        return { output: {} };
      },
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/Duplicate adapter/);
    expect(() =>
      registry.register({
        descriptor: {
          kind: "agent",
          id: "adapter.tool.safe",
          version: "0.1.0",
        },
        async execute() {
          return { disposition: "candidate", output: {} };
        },
      }),
    ).toThrow(/Duplicate adapter identity/);
    expect(() =>
      registry.resolve({
        kind: "tool",
        id: "adapter.tool.missing",
        version: "0.1.0",
      }),
    ).toThrow(/Unknown adapter/);
    expect(() =>
      registry.resolve({
        kind: "agent",
        id: "adapter.tool.safe",
        version: "0.1.0",
      }),
    ).toThrow(/registered as tool/);
    expect(() =>
      registry.resolve({
        kind: "tool",
        id: "adapter.tool.safe",
        version: "0.2.0",
      }),
    ).toThrow(/not tool@0.2.0/);
    expect(() =>
      registry.register({
        descriptor: {
          kind: "agent",
          id: "adapter.agent.bad",
          version: "0.1.0",
        },
        invoke() {},
      } as any),
    ).toThrow(/does not implement/);
    expect(() =>
      registry.register({
        descriptor: {
          kind: "tool",
          id: "adapter.tool.prefixed",
          version: "v0.1.0",
        },
        async invoke() {
          return { output: {} };
        },
      } as any),
    ).toThrow(/not exact SemVer/);
  });

  it("validates standalone policy, approval, and audit contracts", () => {
    const policy = {
      policy: { id: "policy.risk.high", version: "0.1.0" },
      evaluator: {
        kind: "policy" as const,
        id: "adapter.policy.gate",
        version: "0.1.0",
      },
      decision: "requireApproval" as const,
      reason: "Human review is required.",
      taskDigest: sha256(task()),
      evaluatedAt: at,
      approvalRequirementIds: ["meaning-review"],
    };
    expect(validatePolicyDecision(policy).valid).toBe(true);
    expect(
      validatePolicyDecision({ ...policy, approvalRequirementIds: [] }).valid,
    ).toBe(false);
    expect(validatePolicyDecision({ ...policy, decision: "allow" }).valid).toBe(
      false,
    );
    expect(
      validatePolicyDecision({
        ...policy,
        evaluator: { ...policy.evaluator, kind: "agent" },
      }).valid,
    ).toBe(false);

    const approval: ApprovalDecision = {
      requirementId: "meaning-review",
      decision: "approve",
      actor: human,
      decidedAt: at,
      reason: "Reviewed.",
      candidateDigest: sha256("candidate"),
      taskDigest: sha256("task"),
      evidenceDigest: sha256("evidence"),
      impactDigest: sha256("impact"),
    };
    expect(validateApprovalDecision(approval).valid).toBe(true);
    expect(validateApprovalDecision({ ...approval, actor: agent }).valid).toBe(
      false,
    );

    const event = appendAuditEvent([], {
      occurredAt: at,
      actor: human,
      type: "contract.checked",
      payload: {},
    });
    expect(validateAuditEvent(event.trail[0]).valid).toBe(true);
    const tampered = structuredClone(event.trail[0]!);
    tampered.payload.changed = true;
    expect(
      validateAuditEvent(tampered).issues.map((entry) => entry.code),
    ).toContain("audit.payload-digest-mismatch");
  });

  it("executes tool, preview, and observation adapters through the same controlled loop", async () => {
    const calls: string[] = [];
    const validator = {
      kind: "validator" as const,
      id: "adapter.validator.multi",
      version: "0.1.0",
    };
    const registry = new AdapterRegistry()
      .register({
        descriptor: {
          kind: "workspace",
          id: "adapter.workspace.memory",
          version: "0.1.0",
        },
        async prepare() {
          calls.push("workspace.prepare");
        },
        async snapshot() {
          calls.push("workspace.snapshot");
          return { tree: sha256("tree") };
        },
        async dispose() {
          calls.push("workspace.dispose");
        },
      })
      .register({
        descriptor: { kind: "tool", id: "adapter.tool.safe", version: "0.1.0" },
        async invoke(_request, control) {
          calls.push("tool.invoke");
          control.consumeBudget({ outputTokens: 2 });
          return { output: { changed: true } };
        },
      })
      .register({
        descriptor: {
          kind: "preview",
          id: "adapter.preview.safe",
          version: "0.1.0",
        },
        async render() {
          calls.push("preview.render");
          return {
            disposition: "candidate" as const,
            output: { preview: true },
          };
        },
      })
      .register({
        descriptor: {
          kind: "observation",
          id: "adapter.observation.safe",
          version: "0.1.0",
        },
        async collect() {
          calls.push("observation.collect");
          return [];
        },
      })
      .register({
        descriptor: validator,
        async validate({ step }) {
          calls.push(`validator.${step.id}`);
          return {
            claims: [
              {
                claim: `${step.id}.valid`,
                status: "passed" as const,
                validator,
                materialPaths: [],
              },
            ],
          };
        },
      });
    const value = task({
      steps: [
        {
          id: "tool",
          phase: "execute",
          adapter: { kind: "tool", id: "adapter.tool.safe", version: "0.1.0" },
          action: "change",
          input: {},
          validators: [validator],
          requiredClaims: ["tool.valid"],
          maxAttempts: 1,
        },
        {
          id: "preview",
          phase: "preview",
          adapter: {
            kind: "preview",
            id: "adapter.preview.safe",
            version: "0.1.0",
          },
          action: "render",
          input: {},
          validators: [validator],
          requiredClaims: ["preview.valid"],
          maxAttempts: 1,
        },
        {
          id: "observe",
          phase: "operate",
          adapter: {
            kind: "observation",
            id: "adapter.observation.safe",
            version: "0.1.0",
          },
          action: "collect",
          input: {},
          validators: [validator],
          requiredClaims: ["observe.valid"],
          maxAttempts: 1,
        },
      ],
      budget: {
        maxDurationMs: 60_000,
        maxAttempts: 3,
        maxTokens: 1000,
        maxCostUsd: 1,
      },
    });
    const run = await executeTask(value, { registry, now: () => at });
    expect(run.spec.state).toBe("succeeded");
    expect(run.spec.budget.outputTokens).toBe(2);
    expect(calls).toEqual([
      "workspace.prepare",
      "tool.invoke",
      "validator.tool",
      "preview.render",
      "validator.preview",
      "observation.collect",
      "validator.observe",
      "workspace.snapshot",
      "workspace.dispose",
    ]);
  });

  it("fails closed when an agent claims a non-candidate disposition", async () => {
    const calls: string[] = [];
    const registry = adapters(calls);
    const invalid = new AdapterRegistry()
      .register(
        registry.resolve({
          kind: "workspace",
          id: "adapter.workspace.memory",
          version: "0.1.0",
        }),
      )
      .register({
        descriptor: {
          kind: "agent",
          id: "adapter.agent.deepseek",
          version: "0.1.0",
        },
        async execute() {
          calls.push("agent.invalid");
          return { disposition: "approved", output: {} } as any;
        },
      })
      .register(
        registry.resolve({
          kind: "validator",
          id: "adapter.validator.claims",
          version: "0.1.0",
        }),
      );
    const run = await executeTask(task(), { registry: invalid, now: () => at });
    expect(run.spec.state).toBe("failed");
    expect(calls).toEqual([
      "workspace.prepare",
      "agent.invalid",
      "workspace.dispose",
    ]);
  });

  it("rejects a secret-bearing checkpoint without persisting the value", async () => {
    const calls: string[] = [];
    const safe = adapters(calls);
    const registry = new AdapterRegistry()
      .register(
        safe.resolve({
          kind: "workspace",
          id: "adapter.workspace.memory",
          version: "0.1.0",
        }),
      )
      .register({
        descriptor: {
          kind: "agent",
          id: "adapter.agent.deepseek",
          version: "0.1.0",
        },
        async execute(_request, control) {
          calls.push("agent.secret-checkpoint");
          control.checkpoint({ apiKey: "sk-literalcredentialvalue123456789" });
          return { disposition: "candidate" as const, output: {} };
        },
      })
      .register(
        safe.resolve({
          kind: "validator",
          id: "adapter.validator.claims",
          version: "0.1.0",
        }),
      );
    const run = await executeTask(task(), { registry, now: () => at });
    expect(run.spec.state).toBe("failed");
    expect(run.spec.checkpoint).toBeUndefined();
    expect(canonicalJson(run)).not.toContain(
      "sk-literalcredentialvalue123456789",
    );
  });

  it("executes workspace, agent, validator, snapshot, and cleanup in deterministic order", async () => {
    const calls: string[] = [];
    const run = await executeTask(task(), {
      registry: adapters(calls),
      now: () => at,
    });
    expect(run.spec.state).toBe("succeeded");
    expect(run.spec.steps[0]).toMatchObject({
      state: "completed",
      attempts: 1,
    });
    expect(calls).toEqual([
      "workspace.prepare",
      "agent.execute",
      "validator.validate",
      "workspace.snapshot",
      "workspace.dispose",
    ]);
    expect(run.spec.checkpoint).toEqual({ phase: "evaluated" });
    expect(run.spec.budget.inputTokens).toBe(15);
    expect(canonicalJson(run)).not.toContain('"working"');
    expect(verifyAuditTrail(run.spec.audit, run.spec.auditHead).valid).toBe(
      true,
    );
    expect(validateControlDocument(run).valid).toBe(true);
  });

  it("exposes a bound control engine facade and canonical resource validator", async () => {
    const calls: string[] = [];
    const value = task();
    expect(validateControlResource(value)).toEqual(
      validateControlDocument(value),
    );
    const engine = createControlEngine({
      registry: adapters(calls),
      now: () => at,
    });
    const run = await engine.execute(value);
    expect(run.spec.state).toBe("succeeded");
    expect(await engine.resume(value, run)).toEqual(run);
  });

  it("enforces token budgets before snapshot or approval", async () => {
    const calls: string[] = [];
    const value = task({
      budget: {
        maxDurationMs: 60_000,
        maxAttempts: 1,
        maxTokens: 10,
        maxCostUsd: 1,
      },
    });
    const run = await executeTask(value, {
      registry: adapters(calls),
      now: () => at,
    });
    expect(run.spec.state).toBe("failed");
    expect(run.spec.stateReason).toBe("token budget exceeded");
    expect(calls).toEqual([
      "workspace.prepare",
      "agent.execute",
      "workspace.dispose",
    ]);
  });

  it("stops on validator failure and does not publish a snapshot", async () => {
    const calls: string[] = [];
    const run = await executeTask(task(), {
      registry: adapters(calls, "failed"),
      now: () => at,
    });
    expect(run.spec.state).toBe("failed");
    expect(calls).toEqual([
      "workspace.prepare",
      "agent.execute",
      "validator.validate",
      "workspace.dispose",
    ]);
  });

  it("policy deny calls no workspace, agent, or tool", async () => {
    const calls: string[] = [];
    const registry = adapters(calls);
    const policyRef = {
      kind: "policy" as const,
      id: "adapter.policy.gate",
      version: "0.1.0",
    };
    const policy: PolicyAdapter = {
      descriptor: policyRef,
      async evaluate(request) {
        calls.push("policy.evaluate");
        return {
          policy: request.policy,
          evaluator: policyRef,
          decision: "deny",
          reason: "Risk policy denied execution.",
          taskDigest: request.taskDigest,
          evaluatedAt: at,
          approvalRequirementIds: [],
        };
      },
    };
    registry.register(policy);
    const value = task({
      policies: [
        {
          policy: { id: "policy.risk.high", version: "0.1.0" },
          evaluator: policyRef,
        },
      ],
    });
    const run = await executeTask(value, { registry, now: () => at });
    expect(run.spec.state).toBe("denied");
    expect(calls).toEqual(["policy.evaluate"]);
  });

  it("fails closed when requireApproval names no approval requirement", async () => {
    const calls: string[] = [];
    const registry = adapters(calls);
    const policyRef = {
      kind: "policy" as const,
      id: "adapter.policy.gate",
      version: "0.1.0",
    };
    registry.register({
      descriptor: policyRef,
      async evaluate(request) {
        calls.push("policy.evaluate");
        return {
          policy: request.policy,
          evaluator: policyRef,
          decision: "requireApproval" as const,
          reason: "Approval required.",
          taskDigest: request.taskDigest,
          evaluatedAt: at,
          approvalRequirementIds: [],
        };
      },
    });
    const value = task({
      policies: [
        {
          policy: { id: "policy.risk.high", version: "0.1.0" },
          evaluator: policyRef,
        },
      ],
    });
    const run = await executeTask(value, { registry, now: () => at });
    expect(run.spec.state).toBe("failed");
    expect(calls).toEqual(["policy.evaluate"]);
  });

  it("requireApproval pauses, enforces human role and separation, then resumes once", async () => {
    const calls: string[] = [];
    const registry = adapters(calls);
    const policyRef = {
      kind: "policy" as const,
      id: "adapter.policy.gate",
      version: "0.1.0",
    };
    registry.register({
      descriptor: policyRef,
      async evaluate(request) {
        calls.push("policy.evaluate");
        return {
          policy: request.policy,
          evaluator: policyRef,
          decision: "requireApproval" as const,
          reason: "Human meaning review required.",
          taskDigest: request.taskDigest,
          evaluatedAt: at,
          approvalRequirementIds: ["meaning-review"],
        };
      },
    });
    const value = task({
      policies: [
        {
          policy: { id: "policy.risk.high", version: "0.1.0" },
          evaluator: policyRef,
        },
      ],
      approvals: [
        {
          id: "meaning-review",
          phase: "preflight",
          roles: ["domain-owner"],
          minimumApprovals: 1,
          separationOfDuties: true,
        },
      ],
    });
    const paused = await executeTask(value, { registry, now: () => at });
    expect(paused.spec.state).toBe("awaitingApproval");
    expect(calls).toEqual(["policy.evaluate"]);
    const decision: ApprovalDecision = {
      requirementId: "meaning-review",
      decision: "approve",
      actor: {
        kind: "human",
        id: "human.domain.owner",
        roles: ["domain-owner"],
      },
      decidedAt: at,
      reason: "Meaning reviewed.",
      candidateDigest: paused.spec.candidateDigest,
      taskDigest: paused.spec.taskDigest,
      evidenceDigest: paused.spec.evidenceDigest,
      impactDigest: paused.spec.impactDigest,
    };
    expect(() =>
      recordApprovalDecision(value, paused, {
        ...decision,
        actor: agent as any,
      }),
    ).toThrow(/cannot approve/);
    expect(() =>
      recordApprovalDecision(value, paused, {
        ...decision,
        actor: { kind: "human", id: agent.id, roles: ["domain-owner"] },
      }),
    ).toThrow(/Separation/);
    const rejected = recordApprovalDecision(value, paused, {
      ...decision,
      decision: "reject",
      reason: "Meaning is incorrect.",
    });
    expect(rejected.spec.state).toBe("rejected");
    expect(rejected.spec.audit.at(-1)?.type).toBe("run.rejected");
    const approved = recordApprovalDecision(value, paused, decision);
    const completed = await executeTask(value, {
      registry,
      now: () => at,
      existingRun: approved,
    });
    expect(completed.spec.state, completed.spec.stateReason).toBe("succeeded");
    const replayed = await executeTask(value, {
      registry,
      now: () => at,
      existingRun: completed,
    });
    expect(replayed).toEqual(completed);
    expect(calls.filter((entry) => entry === "agent.execute")).toHaveLength(1);
    const stale = { ...decision, candidateDigest: sha256("changed") };
    expect(() => recordApprovalDecision(value, paused, stale)).toThrow(/stale/);
  });

  it("invalidates a prior approval when any bound review digest changes", async () => {
    const calls: string[] = [];
    const value = task({
      approvals: [
        {
          id: "meaning-review",
          phase: "preflight",
          roles: ["domain-owner"],
          minimumApprovals: 1,
          separationOfDuties: true,
        },
      ],
    });
    const registry = adapters(calls);
    const paused = await executeTask(value, { registry, now: () => at });
    const approval: ApprovalDecision = {
      requirementId: "meaning-review",
      decision: "approve",
      actor: human,
      decidedAt: at,
      reason: "Reviewed.",
      candidateDigest: paused.spec.candidateDigest,
      taskDigest: paused.spec.taskDigest,
      evidenceDigest: paused.spec.evidenceDigest,
      impactDigest: paused.spec.impactDigest,
    };
    const approved = recordApprovalDecision(value, paused, approval);
    const changedCandidate = sha256("changed-candidate");
    const invalidated = await executeTask(value, {
      registry,
      now: () => at,
      existingRun: approved,
      digests: { candidateDigest: changedCandidate },
    });
    expect(invalidated.spec.state).toBe("awaitingApproval");
    expect(calls).toEqual([]);
    expect(invalidated.spec.audit.map((entry) => entry.type)).toContain(
      "run.review-context-updated",
    );

    const refreshed = recordApprovalDecision(value, invalidated, {
      ...approval,
      candidateDigest: invalidated.spec.candidateDigest,
      evidenceDigest: invalidated.spec.evidenceDigest,
      impactDigest: invalidated.spec.impactDigest,
    });
    const completed = await executeTask(value, {
      registry,
      now: () => at,
      existingRun: refreshed,
    });
    expect(completed.spec.state).toBe("succeeded");
    expect(calls.filter((entry) => entry === "agent.execute")).toHaveLength(1);
  });

  it("requires the configured number of distinct human approvers with matching roles", async () => {
    const requirement = {
      id: "two-person-review",
      phase: "preflight" as const,
      roles: ["domain-owner"],
      minimumApprovals: 2,
      separationOfDuties: true,
    };
    const value = task({ approvals: [requirement] });
    const paused = await executeTask(value, {
      registry: adapters([]),
      now: () => at,
    });
    const base = {
      requirementId: requirement.id,
      decision: "approve" as const,
      decidedAt: at,
      reason: "Reviewed.",
      candidateDigest: paused.spec.candidateDigest,
      taskDigest: paused.spec.taskDigest,
      evidenceDigest: paused.spec.evidenceDigest,
      impactDigest: paused.spec.impactDigest,
    };
    const once = recordApprovalDecision(value, paused, {
      ...base,
      actor: human,
    });
    expect(approvalRequirementSatisfied(requirement, value, once)).toBe(false);
    const twice = recordApprovalDecision(value, once, {
      ...base,
      actor: {
        kind: "human",
        id: "human.security.owner",
        roles: ["domain-owner", "security-owner"],
      },
    });
    expect(approvalRequirementSatisfied(requirement, value, twice)).toBe(true);
  });

  it("binds post-validation approval to produced candidate and evidence without rerunning work", async () => {
    const calls: string[] = [];
    const value = task({
      approvals: [
        {
          id: "candidate-review",
          phase: "post-validation",
          roles: ["domain-owner"],
          minimumApprovals: 1,
          separationOfDuties: true,
        },
      ],
    });
    const registry = adapters(calls);
    const paused = await executeTask(value, { registry, now: () => at });
    expect(paused.spec.state).toBe("awaitingApproval");
    expect(paused.spec.steps[0]?.state).toBe("completed");
    expect(paused.spec.candidateDigest).not.toBe(ZERO_DIGEST);
    expect(paused.spec.evidenceDigest).not.toBe(ZERO_DIGEST);
    const approved = recordApprovalDecision(value, paused, {
      requirementId: "candidate-review",
      decision: "approve",
      actor: human,
      decidedAt: at,
      reason: "Candidate and evidence reviewed.",
      candidateDigest: paused.spec.candidateDigest,
      taskDigest: paused.spec.taskDigest,
      evidenceDigest: paused.spec.evidenceDigest,
      impactDigest: paused.spec.impactDigest,
    });
    const completed = await executeTask(value, {
      registry,
      now: () => at,
      existingRun: approved,
    });
    expect(completed.spec.state, completed.spec.stateReason).toBe("succeeded");
    expect(calls.filter((entry) => entry === "agent.execute")).toHaveLength(1);
  });

  it("resumes a partial checkpoint without repeating a completed step", async () => {
    const calls: string[] = [];
    const value = task({
      steps: [
        task().spec.steps[0]!,
        { ...task().spec.steps[0]!, id: "evaluate-second" },
      ],
      budget: {
        maxDurationMs: 60_000,
        maxAttempts: 2,
        maxTokens: 1000,
        maxCostUsd: 1,
      },
    });
    const run = createRunRecord(value, at);
    const firstOutput = sha256({ completed: "first" });
    const firstClaims = sha256([
      { claim: "candidate.valid", status: "passed" },
    ]);
    run.spec.state = "executing";
    run.spec.steps[0] = {
      id: "evaluate",
      state: "completed",
      attempts: 1,
      outputDigest: firstOutput,
      claimDigest: firstClaims,
    };
    run.spec.budget.attempts = 1;

    const completed = await executeTask(value, {
      registry: adapters(calls),
      now: () => at,
      existingRun: run,
    });
    expect(completed.spec.state).toBe("succeeded");
    expect(calls.filter((entry) => entry === "agent.execute")).toHaveLength(1);
    expect(completed.spec.candidateDigest).toBe(
      sha256({
        outputDigests: [firstOutput, sha256({ recommendation: "candidate" })],
        snapshot: { tree: sha256("tree") },
      }),
    );
  });

  it("supports cancellation before adapter execution", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const run = await executeTask(task(), {
      registry: adapters(calls),
      now: () => at,
      signal: controller.signal,
    });
    expect(run.spec.state).toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it("detects audit field changes, deletion, and reordering against an anchored head", () => {
    const payload = { value: 1 };
    const one = appendAuditEvent([], {
      occurredAt: at,
      actor: human,
      type: "one",
      payload,
    });
    payload.value = 99;
    expect(one.trail[0]!.payload).toEqual({ value: 1 });
    const two = appendAuditEvent(one.trail, {
      occurredAt: at,
      actor: human,
      type: "two",
      payload: { value: 2 },
    });
    expect(verifyAuditTrail(two.trail, two.head).valid).toBe(true);
    const changed = structuredClone(two.trail);
    changed[0]!.payload.value = 9;
    expect(verifyAuditTrail(changed, two.head).valid).toBe(false);
    expect(() =>
      appendAuditEvent(changed, {
        occurredAt: at,
        actor: human,
        type: "three",
        payload: {},
      }),
    ).toThrow(/invalid audit trail/);
    expect(verifyAuditTrail(two.trail.slice(0, 1), two.head).valid).toBe(false);
    expect(verifyAuditTrail([...two.trail].reverse(), two.head).valid).toBe(
      false,
    );
  });

  it("classifies expansion and narrowing only for provable primitive set inclusion", () => {
    expect(
      semanticDiff({ roles: ["a"] }, { roles: ["a", "b"] })[0]!.classification,
    ).toBe("expanded");
    expect(
      semanticDiff({ roles: ["a", "b"] }, { roles: ["a"] })[0]!.classification,
    ).toBe("narrowed");
    expect(
      semanticDiff({ threshold: 1 }, { threshold: 2 })[0]!.classification,
    ).toBe("changed");
  });

  it("validates CloudEvents observation classification, retention, and schema reference", () => {
    const observation: Observation = {
      schemaVersion: "coga.dev/control/v0.1",
      kind: "Observation",
      metadata: metadata("observation.api.failure", "API failure"),
      spec: {
        cloudEvent: {
          specversion: "1.0",
          id: "event-1",
          source: "urn:app:demo",
          type: "com.example.api.failure",
          time: at,
          datacontenttype: "application/json",
          dataschema: "urn:schema:api-failure",
          data: { status: 500 },
        },
        classification: "internal",
        retention: {
          class: "operational",
          retainUntil: "2026-09-08T00:00:00.000Z",
        },
        schemaRef: { id: "schema.observation.api-failure", version: "0.1.0" },
        application: { id: "application.demo.channel", version: "0.1.0" },
      },
    };
    expect(validateControlDocument(observation).valid).toBe(true);
    const invalid = structuredClone(observation);
    invalid.spec.cloudEvent.specversion = "0.3" as "1.0";
    delete invalid.spec.retention.retainUntil;
    invalid.metadata.visibility = "public";
    const result = validateControlDocument(invalid);
    expect(result.valid).toBe(false);
    const misclassified = structuredClone(observation);
    misclassified.metadata.visibility = "public";
    expect(
      validateControlDocument(misclassified).issues.map((entry) => entry.code),
    ).toContain("observation.classification-mismatch");
  });

  it("does not close an incident using only a deploy event", () => {
    const incident: Incident = {
      schemaVersion: "coga.dev/control/v0.1",
      kind: "Incident",
      metadata: metadata("incident.api.failure", "API failure incident"),
      spec: {
        application: { id: "application.demo.channel", version: "0.1.0" },
        status: "closed",
        summary: "API failed.",
        observations: [{ id: "observation.api.failure", version: "0.1.0" }],
        closure: {
          cause: "Upstream error.",
          resolution: "Released a fix.",
          verification: [
            {
              type: "deploy",
              evidence: { id: "evidence.deploy.success", version: "0.1.0" },
            },
          ],
          closedBy: { kind: "human", id: human.id, roles: human.roles },
          closedAt: at,
        },
      },
    };
    expect(
      validateControlDocument(incident).issues.map((entry) => entry.code),
    ).toContain("incident.deploy-only-closure");
    incident.spec.closure!.verification.push({
      type: "monitoring",
      evidence: { id: "evidence.monitoring.recovered", version: "0.1.0" },
    });
    expect(validateControlDocument(incident).valid).toBe(true);
  });

  it("keeps promotion candidate and blocks single-application promotion without authority", () => {
    const proposal: PromotionProposal = {
      schemaVersion: "coga.dev/control/v0.1",
      kind: "PromotionProposal",
      metadata: metadata("promotion.api.rule", "Promote API rule"),
      spec: {
        proposedBy: agent,
        observations: [{ id: "observation.api.failure", version: "0.1.0" }],
        sourceApplications: [
          { id: "application.demo.channel", version: "0.1.0" },
        ],
        authoritativeSources: [],
        targetPackage: { id: "package.channel.operations", version: "0.1.0" },
        proposedArtifactType: "rule",
        generalization: "Retry only idempotent requests.",
        scenarioRefs: [{ id: "scenario.api.retry", version: "0.1.0" }],
        candidateDigest: sha256("candidate"),
      },
    };
    expect(
      validateControlDocument(proposal).issues.map((entry) => entry.code),
    ).toContain("promotion.insufficient-generalization");
    proposal.spec.sourceApplications.push({
      id: "application.demo.channel",
      version: "0.2.0",
    });
    expect(
      validateControlDocument(proposal).issues.map((entry) => entry.code),
    ).toContain("promotion.insufficient-generalization");
    proposal.spec.authoritativeSources.push("standard.http.retry");
    expect(validateControlDocument(proposal).valid).toBe(true);
    proposal.metadata.lifecycle = "published" as "candidate";
    expect(validateControlDocument(proposal).valid).toBe(false);
  });

  it("validates a newly created RunRecord and its audit anchor", () => {
    const run = createRunRecord(task(), at);
    expect(run.spec.auditHead).not.toBe(ZERO_DIGEST);
    expect(validateControlDocument(run).valid).toBe(true);
  });

  it("reduces run state without mutating the input and rejects illegal jumps", () => {
    const created = createRunRecord(task(), at);
    const preflight = reduceRunState(created, "preflight", {
      occurredAt: at,
      actor: human,
    });
    expect(created.spec.state).toBe("created");
    expect(preflight.spec.state).toBe("preflight");
    expect(preflight.spec.audit).toHaveLength(created.spec.audit.length + 1);
    expect(() =>
      reduceRunState(created, "succeeded", { occurredAt: at, actor: human }),
    ).toThrow(/Invalid run state transition/);
  });
});
