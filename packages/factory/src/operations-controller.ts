import { resolve } from "node:path";
import type { ExactReference } from "@coga/core";
import { FactoryController } from "./controller.js";
import { collectRemoteEvidence, GhEvidenceClient } from "./remote.js";
import { loadWorkOrder } from "./schema.js";
import type {
  FactoryTaskExecutor,
  FactoryTaskRecord,
  GitHubCredentialProvider,
} from "./operations-types.js";
import type { FactoryRunResult, RemoteEvidence, WorkOrder } from "./types.js";

const GITHUB_DELIVERY_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
} as const;

export interface FactoryOperationsExecutorOptions {
  credentialProvider?: GitHubCredentialProvider;
  appSlug?: string;
  repository?: string;
  minimumCredentialTtlMs?: number;
  createController?: (
    task: FactoryTaskRecord,
    githubDeliveryToken?: string,
  ) => Pick<FactoryController, "run">;
}

/**
 * Connects a durable task to the existing deterministic Factory controller.
 * The GitHub token exists only in the acquired lease and controller dependency;
 * it is never copied into the persisted task record or process environment.
 */
export class FactoryOperationsExecutor implements FactoryTaskExecutor {
  readonly options: FactoryOperationsExecutorOptions;

  constructor(options: FactoryOperationsExecutorOptions = {}) {
    this.options = options;
  }

  async execute(task: FactoryTaskRecord): Promise<FactoryRunResult> {
    if (task.spec.delivery === "local") {
      return await this.controller(task).run(
        resolve(task.spec.repositoryRoot, task.spec.workOrderPath),
      );
    }

    const provider = this.options.credentialProvider;
    if (!provider) {
      const error = new Error(
        "GitHub task execution requires an explicit short-lived credential provider, App slug, and repository.",
      );
      Object.assign(error, { kind: "permanent" as const });
      throw error;
    }
    const workOrder = loadWorkOrder(
      resolve(task.spec.repositoryRoot, task.spec.workOrderPath),
    );
    const appSlug =
      this.options.appSlug ?? workOrder.spec.delivery.identity.appSlug;
    const repository =
      this.options.repository ?? workOrder.spec.delivery.repository;
    if (
      this.options.appSlug &&
      this.options.appSlug !== workOrder.spec.delivery.identity.appSlug
    ) {
      throw new Error(
        "Configured GitHub App slug disagrees with the Work Order.",
      );
    }
    if (
      this.options.repository &&
      this.options.repository.toLowerCase() !==
        workOrder.spec.delivery.repository.toLowerCase()
    ) {
      throw new Error(
        "Configured GitHub repository disagrees with the Work Order.",
      );
    }
    const lease = await provider.acquire({
      purpose: "draft-delivery",
      repository,
      appSlug,
      permissions: GITHUB_DELIVERY_PERMISSIONS,
      minimumTtlMs: this.options.minimumCredentialTtlMs ?? 5 * 60_000,
    });
    try {
      return await this.controller(task, lease.token).run(
        resolve(task.spec.repositoryRoot, task.spec.workOrderPath),
      );
    } finally {
      await provider.revoke(lease);
    }
  }

  private controller(
    task: FactoryTaskRecord,
    githubDeliveryToken?: string,
  ): Pick<FactoryController, "run"> {
    if (this.options.createController) {
      return this.options.createController(task, githubDeliveryToken);
    }
    return new FactoryController(
      {
        repositoryRoot: task.spec.repositoryRoot,
        delivery: task.spec.delivery,
        keepWorkspace: task.spec.keepWorkspace,
      },
      githubDeliveryToken ? { githubDeliveryToken } : {},
    );
  }
}

export interface RemoteEvidenceCollectionRequest {
  workOrder: WorkOrder;
  baseCommit: string;
  application: ExactReference;
  pullRequest: number;
  evidencePath: string;
  outputRoot: string;
  collectedAt: string;
  promote?: boolean;
}

/** Collects remote evidence under a purpose-bound installation-token lease. */
export async function collectRemoteEvidenceWithCredential(
  parameters: RemoteEvidenceCollectionRequest,
  provider: GitHubCredentialProvider,
  dependencies: {
    clientFactory?: (token: string) => GhEvidenceClient;
    collect?: typeof collectRemoteEvidence;
  } = {},
): Promise<{ path: string; evidence: RemoteEvidence; promoted: boolean }> {
  const repository = parameters.workOrder.spec.delivery.repository;
  const lease = await provider.acquire({
    purpose: "remote-evidence",
    repository,
    appSlug: parameters.workOrder.spec.delivery.identity.appSlug,
    permissions: {
      actions: "read",
      checks: "read",
      contents: "read",
      pull_requests: "write",
    },
    minimumTtlMs: 5 * 60_000,
  });
  try {
    return await (dependencies.collect ?? collectRemoteEvidence)({
      ...parameters,
      client: (
        dependencies.clientFactory ??
        ((token) => new GhEvidenceClient({ token }))
      )(lease.token),
    });
  } finally {
    await provider.revoke(lease);
  }
}
