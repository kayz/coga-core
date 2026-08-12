import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import {
  AdapterFailure,
  failedReceipt,
  passedReceipt,
  runCoreValidation,
  runNodeVerification,
} from "./adapters.js";
import {
  createEvidenceBundle,
  verifyEvidenceBundle,
  writeEvidenceBundle,
} from "./evidence.js";
import { GitRepository } from "./git.js";
import { deliverGitHubDraft } from "./github.js";
import {
  createFanOutExecutionPlan,
  createTargetExecutionPlan,
} from "./planner.js";
import { DockerSandbox } from "./sandbox.js";
import { loadWorkOrder } from "./schema.js";
import {
  assertRunStateIntegrity,
  loadRunState,
  runStatePath,
  saveRunState,
} from "./state.js";
import type {
  AdapterReceipt,
  ExecutionPlanStep,
  FactoryControllerDependencies,
  FactoryControllerOptions,
  FactoryRunResult,
  FactoryRunState,
  FactoryState,
  FactoryTargetFailure,
  FactoryTargetRunResult,
  FanOutExecutionPlan,
  PlannedTarget,
  WorkOrder,
} from "./types.js";
import { DEFAULT_NODE_IMAGE, FACTORY_SCHEMA_VERSION } from "./types.js";
import {
  canonicalJson,
  compareText,
  normalizeRelativePath,
  resolveWithin,
  sanitizeIdentifier,
  sha256,
} from "./utils.js";

export class FactoryPausedError extends Error {
  constructor(stepId: string) {
    super(`Factory execution paused after '${stepId}'.`);
    this.name = "FactoryPausedError";
  }
}

function exactKey(value: { id: string; version: string }): string {
  return `${value.id}@${value.version}`;
}

function phaseFor(step: ExecutionPlanStep): FactoryState {
  if (
    step.kind === "apply-domain-change" ||
    step.kind === "apply-agent-proposal"
  ) {
    return "executing";
  }
  if (
    step.kind === "validate-instance" ||
    step.kind === "test-application" ||
    step.kind === "build-application"
  ) {
    return "verifying";
  }
  return "review";
}

function verificationIndex(step: ExecutionPlanStep): number {
  const match = /\.(\d+)$/u.exec(step.id);
  if (!match) throw new Error(`Step '${step.id}' has no verification index.`);
  return Number(match[1]) - 1;
}

function workOrderRelativePath(repositoryRoot: string, path: string): string {
  return normalizeRelativePath(
    relative(repositoryRoot, resolve(path)).replaceAll("\\", "/"),
    "Work Order path",
  );
}

export class FactoryController {
  readonly options: Required<
    Pick<
      FactoryControllerOptions,
      | "nodeImage"
      | "delivery"
      | "keepWorkspace"
      | "now"
      | "commandTimeoutMs"
      | "maxOutputBytes"
    >
  > &
    Omit<
      FactoryControllerOptions,
      | "nodeImage"
      | "delivery"
      | "keepWorkspace"
      | "now"
      | "commandTimeoutMs"
      | "maxOutputBytes"
    >;
  readonly dependencies: FactoryControllerDependencies;

  constructor(
    options: FactoryControllerOptions = {},
    dependencies: FactoryControllerDependencies = {},
  ) {
    this.options = {
      ...options,
      nodeImage: options.nodeImage ?? DEFAULT_NODE_IMAGE,
      delivery: options.delivery ?? "github",
      keepWorkspace: options.keepWorkspace ?? false,
      now: options.now ?? (() => new Date()),
      commandTimeoutMs: options.commandTimeoutMs ?? 120_000,
      maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    };
    this.dependencies = dependencies;
  }

  async run(workOrderInputPath: string): Promise<FactoryRunResult> {
    const repository = await GitRepository.open(
      this.options.repositoryRoot ?? dirname(resolve(workOrderInputPath)),
    );
    await repository.assertClean();
    const relativeWorkOrder = workOrderRelativePath(
      repository.root,
      workOrderInputPath,
    );
    const localWorkOrderPath = resolveWithin(
      repository.root,
      relativeWorkOrder,
      "Work Order path",
    );
    const workOrder = loadWorkOrder(localWorkOrderPath);
    const workOrderDigest = sha256(canonicalJson(workOrder));
    const baseCommit = await repository.resolveWorkOrderBase(
      localWorkOrderPath,
      workOrder.spec.repository.baseCommit,
    );
    const workspaceRoot = resolve(
      this.options.workspaceRoot ??
        resolve(
          tmpdir(),
          "coga-factory",
          sha256(repository.root).slice(
            "sha256:".length,
            "sha256:".length + 12,
          ),
        ),
    );
    const planningWorkspace = resolve(
      workspaceRoot,
      `plan-${sanitizeIdentifier(workOrder.metadata.id)}-${workOrderDigest.slice("sha256:".length, "sha256:".length + 12)}`,
    );
    await repository.createDetachedWorktree(planningWorkspace, baseCommit);
    let fanOutPlan: FanOutExecutionPlan;
    try {
      const planningWorkOrderPath = resolveWithin(
        planningWorkspace,
        relativeWorkOrder,
        "Work Order path",
      );
      const planningWorkOrder = loadWorkOrder(planningWorkOrderPath);
      if (sha256(canonicalJson(planningWorkOrder)) !== workOrderDigest) {
        throw new Error(
          "Work Order changed between the source checkout and planning workspace.",
        );
      }
      fanOutPlan = createFanOutExecutionPlan(
        planningWorkspace,
        planningWorkOrderPath,
        planningWorkOrder,
        baseCommit,
      );
    } finally {
      await repository.removeWorktree(planningWorkspace);
    }

    const outcomes: FactoryRunResult["targets"] = [
      ...fanOutPlan.planningFailures,
    ];
    for (const target of fanOutPlan.targets) {
      try {
        outcomes.push(
          await this.runTarget({
            repository,
            relativeWorkOrder,
            workOrder,
            workOrderDigest,
            fanOutPlan,
            target,
            workspaceRoot,
          }),
        );
      } catch (error) {
        if (error instanceof FactoryPausedError) throw error;
        const failure: FactoryTargetFailure = {
          status: "failed",
          application: target.application,
          branch: target.delivery.branch,
          failure: error instanceof Error ? error.message : String(error),
        };
        outcomes.push(failure);
      }
    }
    const completed = outcomes.filter(
      (entry) => entry.status === "completed",
    ).length;
    return {
      status:
        completed === outcomes.length
          ? "completed"
          : completed === 0
            ? "failed"
            : "partial",
      workOrderId: workOrder.metadata.id,
      baseCommit,
      targets: outcomes.sort((left, right) =>
        compareText(exactKey(left.application), exactKey(right.application)),
      ),
    };
  }

  private async runTarget(parameters: {
    repository: GitRepository;
    relativeWorkOrder: string;
    workOrder: WorkOrder;
    workOrderDigest: ReturnType<typeof sha256>;
    fanOutPlan: FanOutExecutionPlan;
    target: PlannedTarget;
    workspaceRoot: string;
  }): Promise<FactoryTargetRunResult> {
    const {
      repository,
      relativeWorkOrder,
      workOrder,
      workOrderDigest,
      fanOutPlan,
      target,
      workspaceRoot,
    } = parameters;
    const stateRoot = resolve(
      this.options.stateRoot ?? resolve(repository.root, ".local/factory/runs"),
    );
    const statePath = runStatePath(
      stateRoot,
      workOrder.metadata.id,
      workOrderDigest,
      target.application.id,
    );
    const workspace = resolve(
      workspaceRoot,
      `${sanitizeIdentifier(workOrder.metadata.id)}-${workOrderDigest.slice("sha256:".length, "sha256:".length + 12)}-${sanitizeIdentifier(target.application.id)}`,
    );
    const plan = createTargetExecutionPlan(fanOutPlan, target);
    let state = loadRunState(statePath);
    if (state) {
      assertRunStateIntegrity(state, {
        workOrderId: workOrder.metadata.id,
        workOrderDigest,
        application: target.application,
        baseCommit: fanOutPlan.baseCommit,
        workspacePath: workspace,
        branch: target.delivery.branch,
        plan,
      });
      if (state.result && state.status === "completed") return state.result;
    }
    await repository.createWorktree(
      workspace,
      state?.resultCommit ?? fanOutPlan.baseCommit,
      target.delivery.branch,
    );
    const workspaceWorkOrderPath = resolveWithin(
      workspace,
      relativeWorkOrder,
      "Work Order path",
    );
    const workspaceWorkOrder = loadWorkOrder(workspaceWorkOrderPath);
    if (sha256(canonicalJson(workspaceWorkOrder)) !== workOrderDigest) {
      throw new Error(
        "Work Order changed between the source checkout and target workspace.",
      );
    }

    if (!state) {
      state = {
        schemaVersion: FACTORY_SCHEMA_VERSION,
        workOrderId: workOrder.metadata.id,
        workOrderDigest,
        application: target.application,
        status: "planned",
        baseCommit: fanOutPlan.baseCommit,
        workspacePath: workspace,
        branch: target.delivery.branch,
        plan,
        steps: plan.steps.map((step) => ({
          id: step.id,
          status: "pending",
          attempts: 0,
        })),
        updatedAt: this.options.now().toISOString(),
      };
      saveRunState(statePath, state);
    } else if (state.status === "failed") {
      for (const step of state.steps) {
        if (step.status === "failed" || step.status === "running") {
          step.status = "pending";
          delete step.receipt;
        }
      }
      delete state.failure;
      state.status = "planned";
      state.updatedAt = this.options.now().toISOString();
      saveRunState(statePath, state);
    }
    if (!state.plan) throw new Error("Factory target state has no plan.");

    for (const plannedStep of state.plan.steps) {
      const stepState = state.steps.find(
        (entry) => entry.id === plannedStep.id,
      );
      if (!stepState) {
        throw new Error(`Factory state is missing step '${plannedStep.id}'.`);
      }
      if (stepState.status === "passed") continue;
      stepState.status = "running";
      stepState.attempts += 1;
      state.status = phaseFor(plannedStep);
      state.updatedAt = this.options.now().toISOString();
      saveRunState(statePath, state);
      const startedAt = this.options.now().toISOString();
      try {
        const receipt = await this.executeStep(
          repository,
          workspaceWorkOrder,
          state,
          plannedStep,
          statePath,
        );
        stepState.status = "passed";
        stepState.receipt = receipt;
        state.updatedAt = this.options.now().toISOString();
        saveRunState(statePath, state);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        stepState.status = "failed";
        stepState.receipt =
          error instanceof AdapterFailure
            ? error.receipt
            : failedReceipt(
                plannedStep.id,
                plannedStep.adapter,
                startedAt,
                this.options.now().toISOString(),
                detail,
              );
        state.status = "failed";
        state.failure = detail;
        state.updatedAt = this.options.now().toISOString();
        saveRunState(statePath, state);
        throw error;
      }
      if (this.options.stopAfterStep === plannedStep.id) {
        throw new FactoryPausedError(plannedStep.id);
      }
    }

    if (!state.result) {
      throw new Error("Factory target completed all steps without a result.");
    }
    state.status = "completed";
    state.updatedAt = this.options.now().toISOString();
    saveRunState(statePath, state);
    if (!this.options.keepWorkspace && existsSync(workspace)) {
      await repository.removeWorktree(workspace);
    }
    return state.result;
  }

  private async executeStep(
    repository: GitRepository,
    workOrder: WorkOrder,
    state: FactoryRunState,
    step: ExecutionPlanStep,
    statePath: string,
  ): Promise<AdapterReceipt> {
    if (!state.plan) throw new Error("Factory state has no target plan.");
    const target = state.plan.target;
    const now = this.options.now;
    const startedAt = now().toISOString();
    if (step.kind === "apply-domain-change") {
      const result = await repository.applyPatch(
        state.workspacePath,
        workOrder.spec.change.patch,
        workOrder.spec.change.allowedPaths,
        "domain change patch",
      );
      return passedReceipt(
        step.id,
        step.adapter,
        startedAt,
        now().toISOString(),
        `${result.alreadyApplied ? "Reused" : "Applied"} ${result.paths.length} governed domain path(s).`,
      );
    }
    if (step.kind === "apply-agent-proposal") {
      const result = await repository.applyPatch(
        state.workspacePath,
        target.proposalReceipt.output.patch,
        target.definition.spec.changePaths,
        `Agent proposal for ${exactKey(target.application)}`,
      );
      return passedReceipt(
        step.id,
        step.adapter,
        startedAt,
        now().toISOString(),
        `${result.alreadyApplied ? "Reused" : "Applied"} ${result.paths.length} Agent-proposed path(s) from ${target.proposalReceipt.metadata.receiptDigest}.`,
      );
    }
    if (step.kind === "validate-instance") {
      return runCoreValidation(
        step.id,
        state.workspacePath,
        workOrder.spec.instance.manifest,
        workOrder.spec.instance.profile,
        now,
      );
    }
    if (step.kind === "test-application" || step.kind === "build-application") {
      return await runNodeVerification({
        stepId: step.id,
        workspace: state.workspacePath,
        definition: target.definition,
        adapterIndex: verificationIndex(step),
        image: this.options.nodeImage,
        sandbox: this.dependencies.sandbox ?? new DockerSandbox(),
        now,
        timeoutMs: this.options.commandTimeoutMs,
        maxOutputBytes: this.options.maxOutputBytes,
      });
    }
    if (step.kind === "create-evidence") {
      if (state.evidence) {
        const path = resolveWithin(
          state.workspacePath,
          state.evidence.path,
          "Evidence Bundle",
        );
        const verified = verifyEvidenceBundle(path);
        if (verified.metadata.bundleDigest !== state.evidence.digest) {
          throw new Error("Persisted Evidence Bundle digest changed.");
        }
        return passedReceipt(
          step.id,
          step.adapter,
          startedAt,
          now().toISOString(),
          `Reused content-addressed Evidence Bundle ${state.evidence.digest}.`,
        );
      }
      const allowed = [
        ...workOrder.spec.change.allowedPaths,
        ...target.definition.spec.changePaths,
      ];
      const changed = await repository.assertOnlyAllowedChanges(
        state.workspacePath,
        state.baseCommit,
        allowed,
      );
      if (changed.length === 0) {
        throw new Error(
          `Work Order produced no governed changes for ${exactKey(target.application)}.`,
        );
      }
      const files = repository.evidenceFiles(state.workspacePath, changed);
      const subjectTree = await repository.stageAndWriteTree(
        state.workspacePath,
      );
      const receipts = state.steps
        .map((entry) => entry.receipt)
        .filter(
          (entry): entry is AdapterReceipt =>
            entry !== undefined && entry.status === "passed",
        );
      const bundle = createEvidenceBundle({
        workOrder,
        plan: state.plan,
        subjectTree,
        changedFiles: files,
        receipts,
        generatedAt: now().toISOString(),
      });
      state.evidence = writeEvidenceBundle(state.workspacePath, bundle);
      state.updatedAt = now().toISOString();
      saveRunState(statePath, state);
      return passedReceipt(
        step.id,
        step.adapter,
        startedAt,
        now().toISOString(),
        `Created content-addressed Evidence Bundle ${state.evidence.digest}.`,
      );
    }
    if (step.kind === "deliver-draft-pr") {
      if (!state.evidence) {
        throw new Error("Draft delivery requires an Evidence Bundle.");
      }
      const allowed = [
        ...workOrder.spec.change.allowedPaths,
        ...target.definition.spec.changePaths,
        ".coga/evidence",
      ];
      await repository.assertOnlyAllowedChanges(
        state.workspacePath,
        state.baseCommit,
        allowed,
      );
      if (!state.resultCommit) {
        state.resultCommit = await repository.commit(
          state.workspacePath,
          target.delivery.commitMessage,
        );
        state.updatedAt = now().toISOString();
        saveRunState(statePath, state);
      }
      const result: FactoryTargetRunResult = {
        status: "completed",
        application: target.application,
        baseCommit: state.baseCommit,
        resultCommit: state.resultCommit,
        branch: state.branch,
        evidencePath: state.evidence.path,
        evidenceDigest: state.evidence.digest,
      };
      if (this.options.delivery === "github") {
        result.pullRequest = await deliverGitHubDraft(
          {
            workspace: state.workspacePath,
            workOrder,
            target,
            baseCommit: state.baseCommit,
            resultCommit: state.resultCommit,
            evidencePath: state.evidence.path,
            evidenceDigest: state.evidence.digest,
          },
          this.dependencies.githubDeliveryToken
            ? { token: this.dependencies.githubDeliveryToken }
            : {},
        );
      }
      state.result = result;
      state.updatedAt = now().toISOString();
      saveRunState(statePath, state);
      return passedReceipt(
        step.id,
        step.adapter,
        startedAt,
        now().toISOString(),
        result.pullRequest
          ? `Created or reused Draft PR ${result.pullRequest.url}.`
          : `Created local candidate commit ${result.resultCommit}.`,
      );
    }
    throw new Error(`Unsupported Factory step kind '${step.kind}'.`);
  }
}
