import { valid as validSemver } from "semver";
import type {
  ActorRef,
  AdapterKind,
  AdapterRef,
  ClaimResult,
  EvidenceBundle,
  Observation,
  PolicyDecision,
  TaskContract,
  TaskStep,
} from "./types.js";

export interface ExecutionControl {
  signal?: AbortSignal;
  heartbeat: (message?: string) => void;
  checkpoint: (value: Record<string, unknown>) => void;
  consumeBudget: (usage: {
    inputTokens?: number;
    outputTokens?: number;
    /** Backward-compatible shorthand for inputTokens. */
    tokens?: number;
    costUsd?: number;
    attempts?: number;
  }) => void;
}

export interface CandidateResult {
  disposition: "candidate";
  output: Record<string, unknown>;
  evidence?: EvidenceBundle;
}

export interface AdapterBase<K extends AdapterKind> {
  descriptor: AdapterRef & { kind: K };
}

export interface AgentAdapter extends AdapterBase<"agent"> {
  execute(
    request: { task: TaskContract; step: TaskStep },
    control: ExecutionControl,
  ): Promise<CandidateResult>;
}

export interface ToolAdapter extends AdapterBase<"tool"> {
  invoke(
    request: { action: string; input: Record<string, unknown> },
    control: ExecutionControl,
  ): Promise<{ output: Record<string, unknown>; evidence?: EvidenceBundle }>;
}

export interface WorkspaceAdapter extends AdapterBase<"workspace"> {
  prepare(task: TaskContract, control: ExecutionControl): Promise<void>;
  snapshot(control: ExecutionControl): Promise<Record<string, unknown>>;
  dispose(control: ExecutionControl): Promise<void>;
}

export interface ValidatorAdapter extends AdapterBase<"validator"> {
  validate(
    request: {
      task: TaskContract;
      step: TaskStep;
      candidate: Record<string, unknown>;
    },
    control: ExecutionControl,
  ): Promise<{ claims: ClaimResult[]; evidence?: EvidenceBundle }>;
}

export interface PolicyAdapter extends AdapterBase<"policy"> {
  evaluate(
    request: {
      task: TaskContract;
      policy: { id: string; version: string };
      taskDigest: `sha256:${string}`;
    },
    control: ExecutionControl,
  ): Promise<PolicyDecision>;
}

export interface ObservationAdapter extends AdapterBase<"observation"> {
  collect(control: ExecutionControl): Promise<Observation[]>;
}

export interface PreviewAdapter extends AdapterBase<"preview"> {
  render(
    request: { action: string; input: Record<string, unknown> },
    control: ExecutionControl,
  ): Promise<CandidateResult>;
}

export type AnyAdapter =
  | AgentAdapter
  | ToolAdapter
  | WorkspaceAdapter
  | ValidatorAdapter
  | PolicyAdapter
  | ObservationAdapter
  | PreviewAdapter;

interface AdapterByKind {
  agent: AgentAdapter;
  tool: ToolAdapter;
  workspace: WorkspaceAdapter;
  validator: ValidatorAdapter;
  policy: PolicyAdapter;
  observation: ObservationAdapter;
  preview: PreviewAdapter;
}

const requiredMethod: Record<AdapterKind, string> = {
  agent: "execute",
  tool: "invoke",
  workspace: "prepare",
  validator: "validate",
  policy: "evaluate",
  observation: "collect",
  preview: "render",
};

function key(ref: AdapterRef): string {
  return `${ref.kind}:${ref.id}@${ref.version}`;
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, AnyAdapter>();

  register(adapter: AnyAdapter): this {
    const descriptor = adapter.descriptor;
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(descriptor.id))
      throw new Error(
        `Adapter ID '${descriptor.id}' is not a stable namespaced ID.`,
      );
    if (
      validSemver(descriptor.version, { loose: false }) !== descriptor.version
    )
      throw new Error(
        `Adapter version '${descriptor.version}' is not exact SemVer.`,
      );
    if (
      typeof (adapter as unknown as Record<string, unknown>)[
        requiredMethod[descriptor.kind]
      ] !== "function"
    )
      throw new Error(
        `Adapter '${descriptor.id}' does not implement kind '${descriptor.kind}'.`,
      );
    const duplicateIdentity = [...this.#adapters.values()].find(
      (candidate) =>
        candidate.descriptor.id === descriptor.id &&
        candidate.descriptor.version === descriptor.version,
    );
    if (duplicateIdentity)
      throw new Error(
        `Duplicate adapter identity '${descriptor.id}@${descriptor.version}'.`,
      );
    const adapterKey = key(descriptor);
    this.#adapters.set(adapterKey, adapter);
    return this;
  }

  resolve<K extends AdapterKind>(
    ref: AdapterRef & { kind: K },
  ): AdapterByKind[K] {
    const adapter = this.#adapters.get(key(ref));
    if (!adapter) {
      const sameIdentity = [...this.#adapters.values()].find(
        (candidate) => candidate.descriptor.id === ref.id,
      );
      if (sameIdentity) {
        throw new Error(
          `Adapter '${ref.id}' was registered as ${sameIdentity.descriptor.kind}@${sameIdentity.descriptor.version}, not ${ref.kind}@${ref.version}.`,
        );
      }
      throw new Error(`Unknown adapter '${key(ref)}'.`);
    }
    return adapter as AdapterByKind[K];
  }
}

export const SYSTEM_ACTOR: ActorRef = {
  kind: "system",
  id: "coga.core.engine",
  roles: ["factory-control-plane"],
};
