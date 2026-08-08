import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import {
  ZERO_DIGEST,
  approvalsSatisfied,
  catalog,
  createRunRecord,
  impact,
  load,
  recordApprovalDecision,
  reduceRunState,
  sha256 as controlDigest,
  validate as validateInstance,
  validateControlResource,
  type ActorRef,
  type ApprovalDecision,
  type Digest,
  type EvidenceBundle,
  type Incident,
  type Observation,
  type PolicyDecision,
  type PromotionProposal,
  type RunRecord,
  type TaskContract,
} from "@coga/core";

import {
  DeepSeekAssetEvaluator,
  DeterministicAssetEvaluator,
  type AssetEvaluator,
} from "./adapters/asset-evaluator.js";
import { runCommandAdapter } from "./adapters/command-validator.js";
import { digestJson, sha256 } from "./canonical.js";
import {
  canCloseIncident,
  normalizeApplicationObservation,
  proposePromotion,
  validateObservation,
  type IncidentRecord,
} from "./operations.js";
import { loadFactoryProfile } from "./profile.js";
import { DescriptorRegistry } from "./registry.js";
import { assertNoLiteralSecrets, resolveWithin } from "./security.js";
import { structuralDiff } from "./semantic-diff.js";
import { FileControlStore } from "./store.js";
import type {
  Actor,
  AdapterDescriptor,
  AssessmentResult,
  FactorySnapshot,
  LoadedApplicationBinding,
  LoadedFactoryProfile,
} from "./types.js";

const exactSemver =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 } as const;

export interface IntentSource {
  uri: string;
  sourceType: "document" | "standard" | "expert" | "system" | "observation";
  authority: string;
  visibility: "public" | "internal" | "restricted";
  excerpt: string;
  digest?: string;
}

export interface IntentInput {
  idempotencyKey?: string;
  mode:
    | "calibrate"
    | "build"
    | "repair"
    | "upgrade"
    | "operate"
    | "release-harness";
  goal: string;
  acceptanceCriteria: string[];
  nonGoals: string[];
  risk: "low" | "medium" | "high" | "critical";
  sources: IntentSource[];
  application?: { id: string; version: string };
  candidate: {
    artifactId: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
}

export interface ServiceOptions {
  profilePath: string;
  stateDirectory?: string;
  extraBindingPaths?: string[];
  now?: () => string;
}

type StoredTask = TaskContract;
type StoredRun = RunRecord;

interface IncidentControl extends IncidentRecord {
  createdAt: string;
  updatedAt: string;
}

function readStructured(path: string): unknown {
  const source = readFileSync(path, "utf8");
  return /\.json$/iu.test(path)
    ? (JSON.parse(source) as unknown)
    : parse(source);
}

function cleanText(value: string, label: string, maxLength = 10_000): string {
  const result = value.trim();
  if (!result || result.length > maxLength)
    throw new Error(`${label} must contain 1-${maxLength} characters.`);
  return result;
}

function idFrom(prefix: string, value: unknown): string {
  return `${prefix}.x${digestJson(value).slice(0, 24)}`;
}

function asControlActor(actor: Actor): ActorRef {
  return { kind: actor.type, id: actor.id, roles: [...actor.roles] };
}

function requireValidControl<T>(document: T, label: string): T {
  const result = validateControlResource(document);
  if (!result.valid) {
    throw new Error(
      `${label} is not a valid Core control resource: ${result.issues.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
  }
  return document;
}

function sourceAllowed(
  source: IntentSource,
  allowlist: readonly string[],
): boolean {
  if (source.visibility !== "public") return true;
  return allowlist.some(
    (entry) => source.uri === entry || source.uri.startsWith(entry),
  );
}

function taskCandidate(
  task: StoredTask,
  store: FileControlStore,
): Record<string, unknown> {
  const candidateId = task.spec.steps[0]?.input.candidateId;
  if (typeof candidateId !== "string")
    throw new Error(`Task '${task.metadata.id}' has no candidate binding.`);
  const value = store.get<Record<string, unknown>>("candidates", candidateId);
  if (!value) throw new Error(`Candidate '${candidateId}' is missing.`);
  return value;
}

function evidenceDigest(store: FileControlStore, taskId: string): Digest {
  const values = store
    .list<EvidenceBundle>("evidence")
    .filter((entry) => entry.spec.task.id === taskId)
    .map((entry) => controlDigest(entry))
    .sort();
  return values.length ? controlDigest(values) : ZERO_DIGEST;
}

export class FactoryService {
  readonly profile: LoadedFactoryProfile;
  readonly store: FileControlStore;
  readonly registry: DescriptorRegistry;
  readonly bindings: LoadedApplicationBinding[];
  private readonly now: () => string;

  constructor(options: ServiceOptions) {
    this.profile = loadFactoryProfile(options.profilePath);
    this.now = options.now ?? (() => new Date().toISOString());
    const stateRoot = options.stateDirectory
      ? resolve(options.stateDirectory)
      : resolveWithin(
          this.profile.root,
          this.profile.document.spec.stateDirectory,
        );
    this.store = new FileControlStore(stateRoot, { now: this.now });
    const descriptors = [...this.profile.document.spec.adapters];
    this.bindings = (options.extraBindingPaths ?? [])
      .filter((path) => existsSync(resolve(path)))
      .map((path) => this.loadBinding(path));
    for (const binding of this.bindings)
      descriptors.push(...this.bindingAdapters(binding));
    this.registry = new DescriptorRegistry(descriptors);
    this.store.initialize();
    this.assertInstance();
  }

  createIntent(
    input: IntentInput,
    actor: Actor,
  ): { task: StoredTask; run: StoredRun; candidate: object } {
    assertNoLiteralSecrets(input);
    if (actor.type !== "human")
      throw new Error("A governed intent must originate from a human actor.");
    cleanText(input.goal, "Intent goal", 2_000);
    if (!input.acceptanceCriteria.length)
      throw new Error("Intent requires at least one acceptance criterion.");
    if (!input.sources.length)
      throw new Error("Intent requires at least one authority source.");
    if (input.application && !exactSemver.test(input.application.version)) {
      throw new Error(
        "Application reference requires an exact SemVer version.",
      );
    }
    const allowlist = this.profile.document.spec.sourceAllowlist ?? [];
    const sources = input.sources.map((source) => {
      cleanText(source.authority, "Source authority", 500);
      cleanText(source.excerpt, "Source excerpt", 20_000);
      let url: URL;
      try {
        url = new URL(source.uri);
      } catch {
        throw new Error(`Source URI '${source.uri}' is invalid.`);
      }
      if (!(["https:", "urn:"] as string[]).includes(url.protocol)) {
        throw new Error("Authority sources must use https or urn identifiers.");
      }
      if (!sourceAllowed(source, allowlist))
        throw new Error(`Public source '${source.uri}' is not allowlisted.`);
      const digest = source.digest ?? sha256(source.excerpt);
      if (!/^[a-f0-9]{64}$/u.test(digest))
        throw new Error("Source digest must be SHA-256.");
      return { ...source, digest };
    });
    const normalized = {
      ...input,
      goal: input.goal.trim(),
      acceptanceCriteria: input.acceptanceCriteria.map((entry) =>
        cleanText(entry, "Acceptance criterion", 1_000),
      ),
      nonGoals: input.nonGoals.map((entry) =>
        cleanText(entry, "Non-goal", 1_000),
      ),
      sources,
    };
    const idempotencyKey = input.idempotencyKey ?? digestJson(normalized);
    if (!/^[A-Za-z0-9._:-]{12,160}$/u.test(idempotencyKey)) {
      throw new Error("Idempotency key is invalid.");
    }
    const taskId = idFrom("task", idempotencyKey);
    const existing = this.store.get<StoredTask>("tasks", taskId);
    if (existing) {
      const run = this.store.get<StoredRun>("runs", `${taskId}.run`);
      if (!run)
        throw new Error(`Idempotent task '${taskId}' has no run record.`);
      return {
        task: existing,
        run,
        candidate: taskCandidate(existing, this.store),
      };
    }

    const candidateId = idFrom("candidate", normalized.candidate);
    const diff = structuralDiff(
      normalized.candidate.before,
      normalized.candidate.after,
    );
    const candidate = {
      id: candidateId,
      lifecycle: "candidate",
      artifactId: normalized.candidate.artifactId,
      before: normalized.candidate.before,
      after: normalized.candidate.after,
      diff,
      createdAt: this.now(),
      createdBy: actor,
    };
    this.store.put("candidates", candidateId, candidate, { createOnly: true });

    const instance = this.instanceIdentity();
    const workspace = this.registry.list("workspace")[0];
    const agent = this.registry.list("agent")[0];
    const validators = this.registry.list("validator");
    const policy = this.registry.list("policy")[0];
    if (!workspace)
      throw new Error("Factory profile has no Workspace adapter.");
    if (!agent) throw new Error("Factory profile has no Agent adapter.");
    const requiredRoles = this.profile.document.spec.policies.requiredRoles
      ?.candidate ?? ["domain-steward"];
    const validatorRefs = validators.map((entry) => ({
      kind: "validator" as const,
      id: entry.ref.id,
      version: entry.ref.version,
    }));
    const task: StoredTask = requireValidControl(
      {
        schemaVersion: "coga.dev/control/v0.1",
        kind: "TaskContract",
        metadata: {
          id: taskId,
          title: normalized.goal.slice(0, 120),
          version: "0.1.0",
          lifecycle: "draft",
          scope: "core",
          visibility: "internal",
        },
        spec: {
          mode: normalized.mode,
          risk: normalized.risk,
          requestedBy: asControlActor(actor),
          instance,
          ...(normalized.application
            ? { application: normalized.application }
            : {}),
          intent: {
            goal: normalized.goal,
            acceptanceCriteria: normalized.acceptanceCriteria,
            nonGoals: normalized.nonGoals,
            sources: sources.map(
              (entry) => `${entry.uri}#sha256=${entry.digest}`,
            ),
          },
          workspace: {
            kind: "workspace" as const,
            id: workspace.ref.id,
            version: workspace.ref.version,
          },
          steps: [
            {
              id: "assess-candidate",
              phase: "execute" as const,
              adapter: {
                kind: "agent" as const,
                id: agent.ref.id,
                version: agent.ref.version,
              },
              action: "assess-asset",
              input: {
                candidateId,
                artifactId: normalized.candidate.artifactId,
                idempotencyKey,
                sources,
              },
              validators: validatorRefs,
              requiredClaims: validatorRefs.map(
                (entry) => `validator.${entry.id}`,
              ),
              maxAttempts: 2,
            },
          ],
          policies: policy
            ? [
                {
                  policy: {
                    id: "policy.coga.factory.governance",
                    version: "0.1.0",
                  },
                  evaluator: {
                    kind: "policy" as const,
                    id: policy.ref.id,
                    version: policy.ref.version,
                  },
                },
              ]
            : [],
          approvals: [
            {
              id: "candidate-review",
              phase: "post-validation" as const,
              roles: requiredRoles,
              minimumApprovals: 1,
              separationOfDuties:
                this.profile.document.spec.policies.separationOfDuties,
            },
          ],
          budget: {
            maxDurationMs: 600_000,
            maxAttempts: Math.max(2, validators.length + 1),
            maxTokens: 4_096,
            maxCostUsd: 1,
          },
        },
      } satisfies TaskContract,
      "TaskContract",
    );
    this.store.put("tasks", taskId, task, { createOnly: true });
    const run = requireValidControl(
      createRunRecord(task, this.now(), {
        candidateDigest: controlDigest(candidate),
        evidenceDigest: ZERO_DIGEST,
        impactDigest: controlDigest(
          this.impactFor(normalized.candidate.artifactId),
        ),
      }),
      "RunRecord",
    );
    this.store.put("runs", run.metadata.id, run, { createOnly: true });
    this.store.appendAudit({
      runId: run.metadata.id,
      type: "task.created",
      actor,
      payload: { taskId, candidateId },
    });
    return { task, run, candidate };
  }

  evaluatePolicy(taskId: string): object {
    const task = this.requireTask(taskId);
    const run = this.requireRun(task);
    if (run.spec.policyDecisions[0]) return run.spec.policyDecisions[0];
    const candidate = taskCandidate(task, this.store);
    const publishedMutation =
      this.isPublished(candidate.before) && this.isPublished(candidate.after);
    const max = this.profile.document.spec.policies.maxAutonomousRisk;
    const requiresApproval =
      riskOrder[task.spec.risk] > riskOrder[max] ||
      task.spec.mode === "release-harness";
    const decision: PolicyDecision["decision"] = publishedMutation
      ? "deny"
      : requiresApproval
        ? "requireApproval"
        : "allow";
    const reasons = [
      ...(publishedMutation
        ? [
            "Published assets may not be mutated directly; create a candidate version.",
          ]
        : []),
      ...(requiresApproval
        ? [`Risk '${task.spec.risk}' exceeds autonomous level '${max}'.`]
        : []),
      ...(!publishedMutation && !requiresApproval
        ? ["Task is within the configured autonomous preparation boundary."]
        : []),
    ];
    const evaluator = task.spec.policies[0]?.evaluator ?? {
      kind: "policy" as const,
      id: "policy.coga.factory.governance",
      version: "0.1.0",
    };
    const document: PolicyDecision = {
      policy: task.spec.policies[0]?.policy ?? {
        id: "policy.coga.factory.governance",
        version: "0.1.0",
      },
      evaluator,
      decision,
      reason: reasons.join(" "),
      taskDigest: run.spec.taskDigest,
      evaluatedAt: this.now(),
      approvalRequirementIds:
        decision === "requireApproval" ? ["candidate-review"] : [],
    };
    const id = idFrom("policy", { taskId, decision, reasons });
    this.store.put("policy-decisions", id, document, { createOnly: true });
    let updated = reduceRunState(run, "preflight", {
      occurredAt: this.now(),
      actor: { kind: "system", id: evaluator.id, roles: ["policy"] },
    });
    updated.spec.policyDecisions.push(document);
    if (decision === "deny") {
      updated = reduceRunState(updated, "denied", {
        occurredAt: this.now(),
        actor: { kind: "system", id: evaluator.id, roles: ["policy"] },
        reason: document.reason,
      });
    }
    requireValidControl(updated, "RunRecord after policy decision");
    this.replaceRun(run, updated);
    this.store.appendAudit({
      runId: run.metadata.id,
      type: `policy.${decision}`,
      actor: { id: "coga.policy.reference", type: "system", roles: ["policy"] },
      payload: document,
    });
    return document;
  }

  async assessTask(
    taskId: string,
    mode: "offline" | "deepseek" = "offline",
  ): Promise<object> {
    const task = this.requireTask(taskId);
    let run = this.requireRun(task);
    if (run.spec.state === "created") {
      this.evaluatePolicy(taskId);
      run = this.requireRun(task);
    }
    if (
      ["denied", "rejected", "failed", "cancelled"].includes(run.spec.state)
    ) {
      throw new Error(`Run is terminal with state '${run.spec.state}'.`);
    }
    const existing = this.store
      .list<EvidenceBundle>("evidence")
      .find(
        (entry) =>
          entry.spec.task.id === taskId &&
          entry.spec.claimResults.some(
            (claim) => claim.claim === "asset.semantic-assessment",
          ),
      );
    if (existing) return existing;
    const candidate = taskCandidate(task, this.store);
    const sourceInput = task.spec.steps[0]?.input.sources;
    const sources = Array.isArray(sourceInput)
      ? (sourceInput as Array<IntentSource & { digest: string }>)
      : [];
    if (!sources.length)
      throw new Error("Task has no governed source records.");
    if (
      mode === "deepseek" &&
      sources.some((entry) => entry.visibility !== "public")
    ) {
      throw new Error(
        "DeepSeek evaluation is blocked because the task contains non-public source material.",
      );
    }
    const evaluator = this.evaluator(mode);
    const result = await evaluator.assess({
      taskId,
      prompt: task.spec.intent.goal,
      sourceMaterial: JSON.stringify({
        sources: sources.map((entry) => ({
          uri: entry.uri,
          authority: entry.authority,
          excerpt: entry.excerpt,
          digest: entry.digest,
        })),
        candidate: {
          artifactId: candidate.artifactId,
          diff: candidate.diff,
          after: candidate.after,
        },
      }),
      sourceVisibility: sources.every((entry) => entry.visibility === "public")
        ? "public"
        : "restricted",
      candidateDigest: digestJson(candidate),
      timeoutMs: 60_000,
    });
    return this.storeAssessment(task, run, result);
  }

  async runValidators(taskId: string, signal?: AbortSignal): Promise<object[]> {
    const task = this.requireTask(taskId);
    let run = this.requireRun(task);
    const assessment = this.store
      .list<EvidenceBundle>("evidence")
      .find(
        (entry) =>
          entry.spec.task.id === taskId &&
          entry.spec.claimResults.some(
            (claim) => claim.claim === "asset.semantic-assessment",
          ),
      );
    if (!assessment) {
      throw new Error(
        "Asset assessment must complete before deterministic validators.",
      );
    }
    if (run.spec.steps[0]?.state === "completed") {
      return this.store
        .list<EvidenceBundle>("evidence")
        .filter(
          (entry) =>
            entry.spec.task.id === taskId &&
            entry.metadata.id !== assessment.metadata.id,
        );
    }
    if (
      ["denied", "rejected", "failed", "cancelled"].includes(run.spec.state)
    ) {
      throw new Error(`Run is terminal with state '${run.spec.state}'.`);
    }
    const previous = run;
    if (run.spec.state === "preflight") {
      run = reduceRunState(run, "executing", {
        occurredAt: this.now(),
        actor: {
          kind: "system",
          id: "factory.local.orchestrator",
          roles: ["orchestrator"],
        },
      });
    }
    if (run.spec.state === "executing") {
      run = reduceRunState(run, "validating", {
        occurredAt: this.now(),
        actor: {
          kind: "system",
          id: "factory.local.orchestrator",
          roles: ["orchestrator"],
        },
      });
    }
    const step = run.spec.steps[0];
    if (!step) throw new Error("Run has no candidate assessment step.");
    step.state = "running";
    const outputs: object[] = [];
    const claimResults: Array<{ claim: string; status: "passed" | "failed" }> =
      [];
    const candidate = taskCandidate(task, this.store);
    for (const descriptor of this.registry.list("validator")) {
      const existing = this.store
        .list<EvidenceBundle>("evidence")
        .find(
          (entry) =>
            entry.spec.task.id === taskId &&
            entry.spec.claimResults.some(
              (claim) => claim.validator.id === descriptor.ref.id,
            ),
        );
      if (existing) {
        outputs.push(existing);
        claimResults.push(
          ...existing.spec.claimResults.map(({ claim, status }) => ({
            claim,
            status,
          })),
        );
        continue;
      }
      const result = await runCommandAdapter(descriptor, {
        root: descriptor.config?.workspaceRoot ?? this.profile.root,
        action: descriptor.actions[0] ?? "validate",
        ...(signal ? { signal } : {}),
      });
      const claim = `validator.${descriptor.ref.id}`;
      const passed =
        result.exitCode === 0 && !result.timedOut && !result.cancelled;
      const evidenceId = idFrom("evidence", {
        taskId,
        validator: descriptor.ref,
        result,
      });
      const subjectPath = `candidates/${String(task.spec.steps[0]?.input.candidateId)}.json`;
      const evidence: EvidenceBundle = requireValidControl(
        {
          schemaVersion: "coga.dev/control/v0.1",
          kind: "EvidenceBundle",
          metadata: {
            id: evidenceId,
            title: `Validator evidence: ${descriptor.ref.id}`,
            version: "0.1.0",
            lifecycle: "candidate",
            scope: "core",
            visibility: "internal",
          },
          spec: {
            task: { id: taskId, version: "0.1.0" },
            runId: run.metadata.id,
            producedBy: {
              kind: "system",
              id: descriptor.ref.id,
              roles: ["validator"],
            },
            disposition: "candidate",
            subject: {
              path: subjectPath,
              mediaType: "application/json",
              digest: controlDigest(candidate),
            },
            materials: [
              {
                path: `tasks/${task.metadata.id}.json`,
                mediaType: "application/json",
                digest: controlDigest(task),
              },
            ],
            claimResults: [
              {
                claim,
                status: passed ? "passed" : "failed",
                validator: {
                  kind: "validator",
                  id: descriptor.ref.id,
                  version: descriptor.ref.version,
                },
                materialPaths: [subjectPath],
                message: passed
                  ? "Allowlisted validator passed."
                  : "Allowlisted validator failed closed.",
              },
            ],
            execution: {
              validator: {
                kind: "validator",
                id: descriptor.ref.id,
                version: descriptor.ref.version,
              },
              command: {
                executable: result.executable,
                args: result.args,
                exitCode: result.exitCode ?? -1,
                stdoutDigest: `sha256:${result.stdoutDigest}`,
                stderrDigest: `sha256:${result.stderrDigest}`,
              },
            },
          },
        },
        "EvidenceBundle",
      );
      this.store.put("evidence", evidenceId, evidence, { createOnly: true });
      outputs.push(evidence);
      claimResults.push({ claim, status: passed ? "passed" : "failed" });
      run.spec.evidence.push({
        id: evidenceId,
        version: "0.1.0",
        path: `evidence/${evidenceId}.json`,
      });
      step.attempts += 1;
      run.spec.budget.attempts += 1;
      run.spec.evidenceDigest = evidenceDigest(this.store, taskId);
      this.store.appendAudit({
        runId: run.metadata.id,
        type: passed ? "validator.passed" : "validator.failed",
        actor: { id: descriptor.ref.id, type: "system", roles: ["validator"] },
        payload: evidence,
      });
      if (!passed) {
        step.state = "failed";
        run = reduceRunState(run, "failed", {
          occurredAt: this.now(),
          actor: {
            kind: "system",
            id: descriptor.ref.id,
            roles: ["validator"],
          },
          reason: `Validator '${descriptor.ref.id}' failed.`,
        });
        requireValidControl(run, "Failed RunRecord");
        this.replaceRun(previous, run);
        return outputs;
      }
    }
    step.state = "completed";
    step.outputDigest = controlDigest(candidate);
    step.claimDigest = controlDigest(claimResults);
    run.spec.candidateDigest = controlDigest(candidate);
    run.spec.evidenceDigest = evidenceDigest(this.store, taskId);
    run = reduceRunState(run, "awaitingApproval", {
      occurredAt: this.now(),
      actor: {
        kind: "system",
        id: "factory.local.orchestrator",
        roles: ["orchestrator"],
      },
      reason: "Deterministic evidence is ready for human review.",
    });
    requireValidControl(run, "RunRecord awaiting approval");
    this.replaceRun(previous, run);
    return outputs;
  }

  approve(input: {
    taskId: string;
    actor: Actor;
    roles: string[];
    decision: "approve" | "reject";
    reason: string;
    impactDigest: string;
  }): object {
    const task = this.requireTask(input.taskId);
    const run = this.requireRun(task);
    if (run.spec.state !== "awaitingApproval")
      throw new Error("Run is not waiting for approval.");
    if (input.actor.type !== "human")
      throw new Error("Only a human actor can approve a candidate.");
    const requirement = task.spec.approvals[0];
    if (
      !requirement ||
      !requirement.roles.some((role) => input.roles.includes(role))
    ) {
      throw new Error("Approver does not hold a required role.");
    }
    cleanText(input.reason, "Approval reason", 2_000);
    if (!/^sha256:[a-f0-9]{64}$/u.test(input.impactDigest))
      throw new Error("Impact digest must be a Core SHA-256 digest.");
    if (input.impactDigest !== run.spec.impactDigest)
      throw new Error("Impact digest is stale.");
    const approval: ApprovalDecision = {
      requirementId: requirement.id,
      decision: input.decision,
      actor: { kind: "human", id: input.actor.id, roles: [...input.roles] },
      decidedAt: this.now(),
      reason: input.reason.trim(),
      candidateDigest: run.spec.candidateDigest,
      taskDigest: run.spec.taskDigest,
      evidenceDigest: run.spec.evidenceDigest,
      impactDigest: run.spec.impactDigest,
    };
    const id = idFrom("approval", {
      task: input.taskId,
      actor: input.actor.id,
      decision: input.decision,
      at: this.now(),
    });
    this.store.put("approvals", id, approval, { createOnly: true });
    let updated = recordApprovalDecision(task, run, approval);
    if (
      input.decision === "approve" &&
      approvalsSatisfied(task, updated, "post-validation") &&
      approvalsSatisfied(task, updated, "release")
    ) {
      updated = reduceRunState(updated, "succeeded", {
        occurredAt: this.now(),
        actor: asControlActor(input.actor),
        reason: "All digest-bound human approval requirements are satisfied.",
      });
    }
    requireValidControl(updated, "RunRecord after approval");
    this.replaceRun(run, updated);
    this.store.appendAudit({
      runId: run.metadata.id,
      type: `approval.${input.decision}`,
      actor: input.actor,
      payload: approval,
    });
    if (input.decision === "approve") this.recordMetric(task, updated);
    return approval;
  }

  previewDecision(taskId: string): object {
    const task = this.requireTask(taskId);
    const run = this.requireRun(task);
    if (run.spec.state !== "succeeded")
      throw new Error(
        "A successful digest-bound approval is required for preview.",
      );
    const decision = {
      taskId,
      status: "ready-for-human-preview",
      scope: "local-only",
      release: "blocked",
      reason:
        "The reference adapter has no upload or production-release capability.",
      decidedAt: this.now(),
    };
    this.store.appendAudit({
      runId: run.metadata.id,
      type: "preview.ready-local",
      actor: { id: "coga.preview.local", type: "system", roles: ["preview"] },
      payload: decision,
    });
    return decision;
  }

  ingestObservation(value: unknown, actor: Actor): Observation {
    const event = validateObservation(value, new Date(this.now()));
    const id = idFrom("observation", event.id);
    const observedAt = Date.parse(event.time);
    const retainUntil = new Date(
      observedAt + event.coga.retentionDays * 86_400_000,
    ).toISOString();
    const retentionClass =
      event.coga.retentionDays <= 7
        ? ("ephemeral" as const)
        : event.coga.retentionDays <= 90
          ? ("operational" as const)
          : ("record" as const);
    const observation: Observation = requireValidControl(
      {
        schemaVersion: "coga.dev/control/v0.1",
        kind: "Observation",
        metadata: {
          id,
          title: `Application observation ${event.type}`,
          version: "0.1.0",
          lifecycle: "candidate",
          scope: "application",
          visibility: event.coga.classification,
        },
        spec: {
          cloudEvent: {
            specversion: "1.0",
            id: event.id,
            source: event.source,
            type: event.type,
            ...(event.subject ? { subject: event.subject } : {}),
            time: event.time,
            datacontenttype: event.datacontenttype,
            dataschema: event.coga.schemaRef,
            data: event.data,
          },
          classification: event.coga.classification,
          retention: { class: retentionClass, retainUntil },
          schemaRef: {
            id: `schema.${event.coga.application.id}.telemetry`,
            version: event.coga.application.version,
          },
          application: event.coga.application,
        },
      },
      "Observation",
    );
    this.store.put("observations", id, observation, { createOnly: true });
    this.store.appendAudit({
      runId: id,
      type: "observation.ingested",
      actor,
      payload: observation,
    });
    return observation;
  }

  loadBindingFixture(
    bindingId: string,
    type: "observation" | "incident",
    index: number,
  ): unknown {
    const binding = this.bindings.find(
      (entry) => entry.document.metadata.id === bindingId,
    );
    if (!binding)
      throw new Error(`Application binding '${bindingId}' is not attached.`);
    if (!Number.isInteger(index) || index < 0)
      throw new Error("Fixture index is invalid.");
    const paths =
      type === "observation"
        ? (binding.document.spec.operations?.observationFixtures ?? [])
        : (binding.document.spec.operations?.incidentFixtures ?? []);
    const path = paths[index];
    if (!path)
      throw new Error(
        `Application binding has no ${type} fixture at index ${index}.`,
      );
    const value = readStructured(resolveWithin(binding.root, path));
    assertNoLiteralSecrets(value);
    if (type !== "observation") return value;
    const observation = normalizeApplicationObservation(value, {
      application: {
        id: binding.document.spec.application.id,
        version: binding.document.spec.application.version,
      },
      ...(binding.document.spec.operations?.telemetryRegistry
        ? {
            telemetryRegistry:
              binding.document.spec.operations.telemetryRegistry,
          }
        : {}),
    });
    return observation.data.fixture === true
      ? { ...observation, time: this.now() }
      : observation;
  }

  createIncident(input: {
    id: string;
    observationStoreIds: string[];
    runbook: { id: string; version: string };
    actor: Actor;
  }): IncidentRecord {
    const observations = input.observationStoreIds.map((id) => {
      const value = this.store.get<Observation>("observations", id);
      if (!value) throw new Error(`Observation '${id}' is missing.`);
      return value;
    });
    if (!observations.length)
      throw new Error("Incident requires at least one Observation.");
    const application = observations[0]!.spec.application;
    if (
      observations.some((entry) => entry.spec.application.id !== application.id)
    ) {
      throw new Error(
        "One incident may not silently combine different Applications.",
      );
    }
    const createdAt = this.now();
    const control: IncidentControl = {
      id: input.id,
      state: "open",
      severity: "unassessed",
      application,
      observationIds: observations.map((entry) => entry.metadata.id).sort(),
      runbook: input.runbook,
      closure: {
        severityAssignedByHuman: false,
        criticalJourneyPassed: false,
        monitoringRecovered: false,
      },
      createdAt,
      updatedAt: createdAt,
    };
    const incident: Incident = requireValidControl(
      {
        schemaVersion: "coga.dev/control/v0.1",
        kind: "Incident",
        metadata: {
          id: input.id,
          title: `Incident ${input.id}`,
          version: "0.1.0",
          lifecycle: "candidate",
          scope: "application",
          visibility: "internal",
          tags: [
            `runbook:${input.runbook.id}@${input.runbook.version}`,
            "severity:unassessed",
          ],
        },
        spec: {
          application,
          status: "open",
          summary: `Opened from ${observations.length} governed observation(s).`,
          observations: observations.map((entry) => ({
            id: entry.metadata.id,
            version: entry.metadata.version,
          })),
        },
      },
      "Incident",
    );
    this.store.put("incidents", input.id, incident, { createOnly: true });
    this.store.put("incident-controls", input.id, control, {
      createOnly: true,
    });
    this.store.appendAudit({
      runId: input.id,
      type: "incident.opened",
      actor: input.actor,
      payload: incident,
    });
    return control;
  }

  updateIncident(
    id: string,
    patch: Partial<IncidentRecord>,
    actor: Actor,
  ): IncidentRecord {
    const currentResource = this.store.get<Incident>("incidents", id);
    const current = this.store.get<IncidentControl>("incident-controls", id);
    if (!currentResource || !current)
      throw new Error(`Incident '${id}' is missing.`);
    const updated: IncidentControl = {
      ...current,
      ...patch,
      id: current.id,
      application: current.application,
      observationIds: current.observationIds,
      closure: { ...current.closure, ...(patch.closure ?? {}) },
      createdAt: current.createdAt,
      updatedAt: this.now(),
    };
    if (patch.state === "closed") {
      const closure = canCloseIncident(updated);
      if (!closure.allowed)
        throw new Error(`Incident cannot close: ${closure.reasons.join(" ")}`);
      if (actor.type !== "human")
        throw new Error("Only a human may close an Incident.");
    }
    const status =
      updated.state === "closed"
        ? ("closed" as const)
        : updated.state === "mitigated"
          ? ("mitigated" as const)
          : updated.state === "verifying"
            ? ("resolved" as const)
            : ("open" as const);
    const summary = updated.diagnosis
      ? `${currentResource.spec.summary.split("\nDiagnosis:")[0]}\nDiagnosis: ${updated.diagnosis}`
      : currentResource.spec.summary;
    const resource: Incident = requireValidControl(
      {
        ...currentResource,
        metadata: {
          ...currentResource.metadata,
          tags: [
            `runbook:${updated.runbook.id}@${updated.runbook.version}`,
            `severity:${updated.severity}`,
          ],
        },
        spec: {
          ...currentResource.spec,
          status,
          summary,
          ...(status === "closed"
            ? {
                closure: {
                  cause:
                    updated.diagnosis ??
                    "Cause established by the governed local incident workflow.",
                  resolution:
                    "Candidate repair passed the critical journey, monitoring, and regression gates.",
                  verification: [
                    {
                      type: "reproduction" as const,
                      evidence: {
                        id: idFrom("evidence", `${id}.critical-journey`),
                        version: "0.1.0",
                      },
                    },
                    {
                      type: "monitoring" as const,
                      evidence: {
                        id: idFrom("evidence", `${id}.monitoring-recovered`),
                        version: "0.1.0",
                      },
                    },
                    ...(updated.closure.deploymentSucceeded
                      ? [
                          {
                            type: "deploy" as const,
                            evidence: {
                              id: idFrom("evidence", `${id}.deploy`),
                              version: "0.1.0",
                            },
                          },
                        ]
                      : []),
                  ],
                  closedBy: {
                    kind: "human" as const,
                    id: actor.id,
                    roles: actor.roles,
                  },
                  closedAt: this.now(),
                },
              }
            : {}),
        },
      },
      "Incident",
    );
    this.store.put("incidents", id, resource, {
      expectedDigest: digestJson(currentResource),
    });
    this.store.put("incident-controls", id, updated, {
      expectedDigest: digestJson(current),
    });
    this.store.appendAudit({
      runId: id,
      type: `incident.${updated.state}`,
      actor,
      payload: resource,
    });
    return updated;
  }

  incidentClosure(id: string): ReturnType<typeof canCloseIncident> {
    const incident = this.store.get<IncidentControl>("incident-controls", id);
    if (!incident) throw new Error(`Incident '${id}' is missing.`);
    return canCloseIncident(incident);
  }

  incidentControl(id: string): IncidentRecord {
    const incident = this.store.get<IncidentControl>("incident-controls", id);
    if (!incident) throw new Error(`Incident '${id}' is missing.`);
    return incident;
  }

  promote(
    input: {
      id: string;
      incidentIds: string[];
      targetPackage: { id: string; version: string };
      candidateArtifact: Record<string, unknown>;
      consumerApplications: string[];
      authoritativeSources: string[];
      privateTermsScanPassed: boolean;
      independentScenarios: string[];
    },
    actor: Actor,
  ): PromotionProposal {
    if (actor.type !== "human")
      throw new Error(
        "Only a human may submit a generalized promotion candidate.",
      );
    const incidents = input.incidentIds.map((id) => this.incidentControl(id));
    proposePromotion({ ...input, incidents });
    const incidentResources = input.incidentIds.map((id) => {
      const value = this.store.get<Incident>("incidents", id);
      if (!value) throw new Error(`Incident '${id}' is missing.`);
      return value;
    });
    const applicationVersions = new Map<string, string>([
      ...incidents.map(
        (entry) => [entry.application.id, entry.application.version] as const,
      ),
      ...this.bindings.map(
        (entry) =>
          [
            entry.document.spec.application.id,
            entry.document.spec.application.version,
          ] as const,
      ),
    ]);
    const sourceApplicationIds = [
      ...new Set([
        ...incidents.map((entry) => entry.application.id),
        ...input.consumerApplications,
      ]),
    ].sort();
    const proposal: PromotionProposal = requireValidControl(
      {
        schemaVersion: "coga.dev/control/v0.1",
        kind: "PromotionProposal",
        metadata: {
          id: input.id,
          title: `Harness promotion ${input.id}`,
          version: "0.1.0",
          lifecycle: "candidate",
          scope: "instance",
          visibility: "internal",
        },
        spec: {
          proposedBy: asControlActor(actor),
          observations: incidentResources.flatMap(
            (entry) => entry.spec.observations,
          ),
          sourceApplications: sourceApplicationIds.map((id) => ({
            id,
            version: applicationVersions.get(id) ?? "0.1.0",
          })),
          authoritativeSources: [...new Set(input.authoritativeSources)].sort(),
          targetPackage: input.targetPackage,
          proposedArtifactType: "rule",
          generalization: JSON.stringify({
            candidateArtifact: input.candidateArtifact,
            incidentIds: [...input.incidentIds].sort(),
            privateTermsScanPassed: true,
          }),
          scenarioRefs: [...new Set(input.independentScenarios)]
            .sort()
            .map((id) => ({ id, version: "0.1.0" })),
          candidateDigest: controlDigest(input.candidateArtifact),
        },
      },
      "PromotionProposal",
    );
    this.store.put("promotions", proposal.metadata.id, proposal, {
      createOnly: true,
    });
    this.store.appendAudit({
      runId: proposal.metadata.id,
      type: "promotion.candidate",
      actor,
      payload: proposal,
    });
    return proposal;
  }

  instanceCatalog(): unknown {
    const manifest = resolveWithin(
      this.profile.root,
      this.profile.document.spec.instanceManifest,
    );
    return catalog(manifest);
  }

  impactFor(artifactId: string): unknown {
    const manifest = resolveWithin(
      this.profile.root,
      this.profile.document.spec.instanceManifest,
    );
    return impact(manifest, artifactId);
  }

  impactDigestFor(artifactId: string): string {
    return controlDigest(this.impactFor(artifactId));
  }

  snapshot(): FactorySnapshot & {
    catalog: unknown;
    profile: object;
    adapters: object[];
    applicationBindings: object[];
  } {
    return {
      ...this.store.snapshot(),
      catalog: this.instanceCatalog(),
      profile: {
        id: this.profile.document.metadata.id,
        title: this.profile.document.metadata.title,
        version: this.profile.document.metadata.version,
        policies: this.profile.document.spec.policies,
      },
      adapters: this.registry.list().map((entry) => ({
        ref: entry.ref,
        runtime: entry.runtime,
        actions: entry.actions,
        available:
          entry.runtime !== "deepseek" ||
          Boolean(
            entry.config?.secretRef &&
              process.env[entry.config.secretRef.replace(/^env:\/\//u, "")],
          ),
      })),
      applicationBindings: this.bindings.map((entry) => ({
        id: entry.document.metadata.id,
        version: entry.document.metadata.version,
        visibility: entry.document.metadata.visibility ?? "restricted",
        application: entry.document.spec.application,
        harnessLocks: entry.document.spec.harnessLocks ?? [],
        preview: entry.document.spec.preview ?? {},
        criticalJourneys: entry.document.spec.criticalJourneys ?? [],
        fixtures: {
          observations:
            entry.document.spec.operations?.observationFixtures?.length ?? 0,
          incidents:
            entry.document.spec.operations?.incidentFixtures?.length ?? 0,
        },
        networkTransport:
          entry.document.spec.operations?.networkTransport ?? "none",
        publicationPolicy:
          entry.document.spec.operations?.publicationPolicy ?? "prohibited",
      })),
    };
  }

  private loadBinding(path: string): LoadedApplicationBinding {
    const absolute = resolve(path);
    const document = readStructured(absolute);
    assertNoLiteralSecrets(document);
    if (
      !document ||
      typeof document !== "object" ||
      Array.isArray(document) ||
      (document as Record<string, unknown>).kind !== "ApplicationFactoryBinding"
    ) {
      throw new Error(`Application binding '${absolute}' is invalid.`);
    }
    const binding = document as LoadedApplicationBinding["document"];
    if (!binding.metadata?.id || !exactSemver.test(binding.metadata.version)) {
      throw new Error(
        `Application binding '${absolute}' has no exact identity.`,
      );
    }
    if (
      !binding.spec?.application?.id ||
      !exactSemver.test(binding.spec.application.version)
    ) {
      throw new Error(
        `Application binding '${absolute}' has no exact Application reference.`,
      );
    }
    return { path: absolute, root: dirname(absolute), document: binding };
  }

  private bindingAdapters(
    binding: LoadedApplicationBinding,
  ): AdapterDescriptor[] {
    return (binding.document.spec.validators ?? []).map((validator) => {
      if (validator.shell !== false) {
        throw new Error(
          `Private validator '${validator.id}' must disable shell execution.`,
        );
      }
      const npmExecPath = process.env.npm_execpath;
      const windowsNpm =
        process.platform === "win32" &&
        validator.executable.toLowerCase() === "npm";
      if (windowsNpm && !npmExecPath) {
        throw new Error(
          `Private validator '${validator.id}' requires npm_execpath on Windows; start Factory through npm.`,
        );
      }
      return {
        ref: {
          kind: "validator",
          id: validator.id,
          version: binding.document.metadata.version,
        },
        runtime: "process",
        actions: ["validate"],
        config: {
          cwd: validator.cwd,
          executable: windowsNpm ? process.execPath : validator.executable,
          args: windowsNpm ? [npmExecPath!, ...validator.args] : validator.args,
          ...(validator.timeoutMs === undefined
            ? {}
            : { timeoutMs: validator.timeoutMs }),
          ...(validator.outputLimitBytes === undefined
            ? {}
            : { outputLimitBytes: validator.outputLimitBytes }),
          ...(validator.envAllowlist === undefined
            ? {}
            : { envAllowlist: validator.envAllowlist }),
          workspaceRoot: binding.root,
        },
      };
    });
  }

  private assertInstance(): void {
    const manifest = resolveWithin(
      this.profile.root,
      this.profile.document.spec.instanceManifest,
    );
    const loaded = load(manifest);
    const result = validateInstance(loaded);
    if (!result.valid) {
      throw new Error(
        `Factory profile references an invalid Instance: ${result.issues.map((entry) => entry.message).join("; ")}`,
      );
    }
  }

  private instanceIdentity(): { id: string; version: string } {
    const manifest = resolveWithin(
      this.profile.root,
      this.profile.document.spec.instanceManifest,
    );
    const loaded = load(manifest);
    const document = loaded.instance.document as {
      metadata?: { id?: string; version?: string };
    };
    if (!document.metadata?.id || !document.metadata.version)
      throw new Error("Instance identity is missing.");
    return { id: document.metadata.id, version: document.metadata.version };
  }

  private evaluator(mode: "offline" | "deepseek"): AssetEvaluator {
    if (mode === "offline") return new DeterministicAssetEvaluator();
    const descriptor = this.registry
      .list("agent")
      .find((entry) => entry.runtime === "deepseek");
    if (!descriptor)
      throw new Error("Factory profile has no DeepSeek Agent adapter.");
    return new DeepSeekAssetEvaluator(descriptor);
  }

  private requireTask(id: string): StoredTask {
    const task = this.store.get<StoredTask>("tasks", id);
    if (!task) throw new Error(`Task '${id}' is missing.`);
    return task;
  }

  private requireRun(task: StoredTask): StoredRun {
    const run = this.store.get<StoredRun>("runs", `${task.metadata.id}.run`);
    if (!run) throw new Error(`Run for task '${task.metadata.id}' is missing.`);
    if (run.spec.taskDigest !== controlDigest(task))
      throw new Error("Task changed after its run was created.");
    requireValidControl(run, "Stored RunRecord");
    return run;
  }

  private replaceRun(previous: StoredRun, next: StoredRun): void {
    this.store.put("runs", previous.metadata.id, next, {
      expectedDigest: digestJson(previous),
    });
  }

  private isPublished(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const metadata = (value as Record<string, unknown>).metadata;
    return Boolean(
      metadata &&
        typeof metadata === "object" &&
        (metadata as Record<string, unknown>).lifecycle === "published",
    );
  }

  private storeAssessment(
    task: StoredTask,
    run: StoredRun,
    result: AssessmentResult,
  ): object {
    const evidenceId = idFrom("evidence", {
      task: task.metadata.id,
      output: result.outputDigest,
    });
    const subjectPath = `assessment-results/${evidenceId}.json`;
    this.store.put(
      "assessment-results",
      evidenceId,
      {
        id: evidenceId,
        taskId: task.metadata.id,
        provider: result.provider,
        model: result.model,
        responseId: result.responseId,
        assessment: result.assessment,
        outputDigest: `sha256:${result.outputDigest}`,
      },
      { createOnly: true },
    );
    const evidence: EvidenceBundle = requireValidControl(
      {
        schemaVersion: "coga.dev/control/v0.1",
        kind: "EvidenceBundle",
        metadata: {
          id: evidenceId,
          title: `Asset assessment evidence (${result.provider})`,
          version: "0.1.0",
          lifecycle: "candidate",
          scope: "core",
          visibility: "internal",
        },
        spec: {
          task: { id: task.metadata.id, version: "0.1.0" },
          runId: run.metadata.id,
          producedBy: {
            kind: "agent",
            id: `agent.asset-evaluator.${result.provider}`,
            roles: ["evaluator"],
          },
          disposition: "candidate",
          subject: {
            path: subjectPath,
            mediaType: "application/json",
            digest: `sha256:${result.outputDigest}`,
          },
          materials: [
            {
              path: `tasks/${task.metadata.id}.json`,
              mediaType: "application/json",
              digest: controlDigest(task),
            },
          ],
          claimResults: [
            {
              claim: "asset.semantic-assessment",
              status:
                result.assessment.recommendation === "reject"
                  ? "failed"
                  : "passed",
              validator: {
                kind: "validator",
                id: "validator.asset.assessment",
                version: "0.1.0",
              },
              materialPaths: [subjectPath],
              message: result.assessment.summary,
            },
          ],
          execution: {
            model: {
              provider: result.provider,
              model: result.model,
              responseId: result.responseId,
              ...(result.usage
                ? {
                    usage: {
                      ...(result.usage.promptTokens === undefined
                        ? {}
                        : { inputTokens: result.usage.promptTokens }),
                      ...(result.usage.completionTokens === undefined
                        ? {}
                        : { outputTokens: result.usage.completionTokens }),
                    },
                  }
                : {}),
              promptDigest: `sha256:${result.promptDigest}`,
              outputDigest: `sha256:${result.outputDigest}`,
            },
          },
        },
      },
      "EvidenceBundle",
    );
    this.store.put("evidence", evidenceId, evidence, { createOnly: true });
    const failed = result.assessment.recommendation === "reject";
    let updated =
      run.spec.state === "preflight"
        ? reduceRunState(run, "executing", {
            occurredAt: this.now(),
            actor: {
              kind: "agent",
              id: `agent.asset-evaluator.${result.provider}`,
              roles: ["evaluator"],
            },
          })
        : structuredClone(run);
    updated.spec.evidence.push({
      id: evidenceId,
      version: "0.1.0",
      path: `evidence/${evidenceId}.json`,
    });
    updated.spec.evidenceDigest = evidenceDigest(this.store, task.metadata.id);
    updated.spec.budget.attempts += 1;
    updated.spec.budget.inputTokens += result.usage?.promptTokens ?? 0;
    updated.spec.budget.outputTokens += result.usage?.completionTokens ?? 0;
    if (failed) {
      updated = reduceRunState(updated, "failed", {
        occurredAt: this.now(),
        actor: {
          kind: "agent",
          id: `agent.asset-evaluator.${result.provider}`,
          roles: ["evaluator"],
        },
        reason: "Asset evaluator rejected the candidate.",
      });
    }
    requireValidControl(updated, "RunRecord after asset assessment");
    this.replaceRun(run, updated);
    this.store.appendAudit({
      runId: run.metadata.id,
      type: failed ? "agent.assessment-rejected" : "agent.assessment-completed",
      actor: {
        id: `asset-evaluator.${result.provider}`,
        type: "agent",
        roles: ["evaluator"],
      },
      payload: evidence,
    });
    return evidence;
  }

  private recordMetric(task: StoredTask, run: StoredRun): void {
    const startedAt = run.spec.audit[0]?.occurredAt;
    const endedAt = run.spec.audit.at(-1)?.occurredAt;
    const started = startedAt ? Date.parse(startedAt) : Number.NaN;
    const ended = endedAt ? Date.parse(endedAt) : Number.NaN;
    const metric = {
      id: idFrom("change", task.metadata.id),
      taskId: task.metadata.id,
      mode: task.spec.mode,
      risk: task.spec.risk,
      durationMs:
        Number.isFinite(started) && Number.isFinite(ended)
          ? Math.max(0, ended - started)
          : null,
      attempts: run.spec.budget.attempts,
      reusedArtifacts: task.spec.intent.sources.length,
      reusedScenarios: task.spec.steps.reduce(
        (count, step) => count + step.requiredClaims.length,
        0,
      ),
      manualGates: run.spec.approvalDecisions.length,
      incidents: task.spec.mode === "repair" ? 1 : 0,
      completedAt: endedAt ?? this.now(),
    };
    this.store.put("metrics", metric.id, metric, { createOnly: true });
  }
}
