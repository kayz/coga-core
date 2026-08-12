import type {
  FactoryTaskFailureKind,
  FactoryTaskRecord,
  FactoryWorkerOptions,
  FactoryWorkerResult,
} from "./operations-types.js";

const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_FAILURE_MESSAGE_BYTES = 16 * 1024;
const SENSITIVE_MESSAGE =
  /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:token|password|client_secret|api_key)\s*[=:]\s*\S+|\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,})/iu;

function assertDuration(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be an integer from 0 through ${maximum}.`);
  }
}

function assertWorkerId(value: string): void {
  if (!SAFE_ID.test(value))
    throw new Error("workerId must be a safe identifier.");
}

function sanitizeFailureMessage(error: unknown): string {
  let message = "Factory task executor failed.";
  try {
    if (error instanceof Error && typeof error.message === "string") {
      message = error.message;
    } else if (typeof error === "string") {
      message = error;
    }
  } catch {
    return message;
  }
  message = message.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim();
  if (message.length === 0 || SENSITIVE_MESSAGE.test(message)) {
    return "Factory task executor failed; sensitive detail was not persisted.";
  }
  const bytes = Buffer.from(message, "utf8");
  if (bytes.byteLength <= MAX_FAILURE_MESSAGE_BYTES) return message;
  return bytes
    .subarray(0, MAX_FAILURE_MESSAGE_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function classifyFailure(error: unknown): FactoryTaskFailureKind {
  try {
    if (error && typeof error === "object" && "kind" in error) {
      const value = (error as { kind?: unknown }).kind;
      if (
        value === "transient" ||
        value === "permanent" ||
        value === "isolation"
      ) {
        return value;
      }
    }
  } catch {
    return "transient";
  }
  return "transient";
}

export class FactoryWorker {
  private readonly queue: FactoryWorkerOptions["queue"];
  private readonly executor: FactoryWorkerOptions["executor"];
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private readonly now: () => Date;

  constructor(options: FactoryWorkerOptions) {
    if (!options || typeof options !== "object")
      throw new Error("FactoryWorker options are required.");
    assertWorkerId(options.workerId);
    assertDuration(options.leaseMs, "leaseMs", MAX_LEASE_MS);
    if (options.leaseMs === 0)
      throw new Error("leaseMs must be greater than zero.");
    assertDuration(options.retryDelayMs, "retryDelayMs", MAX_RETRY_DELAY_MS);
    this.queue = options.queue;
    this.executor = options.executor;
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs;
    this.retryDelayMs = options.retryDelayMs;
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<FactoryWorkerResult> {
    const claimed = this.queue.claim(this.workerId, this.leaseMs);
    if (!claimed || !claimed.lease) return { status: "idle" };

    const leaseId = claimed.lease.id;
    let heartbeatFailure: unknown;
    let heartbeatRunning = false;
    const heartbeatIntervalMs = Math.max(1, Math.floor(this.leaseMs / 3));
    const heartbeat = () => {
      if (heartbeatRunning || heartbeatFailure !== undefined) return;
      heartbeatRunning = true;
      try {
        this.queue.heartbeat(
          claimed.metadata.id,
          leaseId,
          this.workerId,
          this.leaseMs,
        );
      } catch (error) {
        heartbeatFailure = error;
      } finally {
        heartbeatRunning = false;
      }
    };
    const timer = setInterval(heartbeat, heartbeatIntervalMs);
    timer.unref();

    const cancelledResult = (): FactoryWorkerResult | undefined => {
      const current = this.queue.get(claimed.metadata.id);
      return current?.phase === "cancelled"
        ? { status: "cancelled", task: current }
        : undefined;
    };

    let settled: FactoryTaskRecord;
    try {
      const result = await this.executor.execute(claimed);
      clearInterval(timer);
      while (heartbeatRunning)
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 0),
        );
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      settled = this.queue.succeed(
        claimed.metadata.id,
        leaseId,
        this.workerId,
        result,
      );
      return { status: "succeeded", task: settled };
    } catch (error) {
      clearInterval(timer);
      while (heartbeatRunning)
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 0),
        );
      if (heartbeatFailure !== undefined) {
        const cancelled = cancelledResult();
        if (cancelled) return cancelled;
        // Losing the lease means another worker may have recovered the task.
        // Never write a terminal event using stale ownership.
        throw heartbeatFailure;
      }
      // Sample the injected clock for deterministic executors without ever
      // serializing the thrown object or its arbitrary properties.
      const observedAt = this.now();
      if (
        !(observedAt instanceof Date) ||
        !Number.isFinite(observedAt.getTime())
      ) {
        throw new Error("Factory worker clock must return a valid Date.");
      }
      const cancelled = cancelledResult();
      if (cancelled) return cancelled;
      settled = this.queue.fail(
        claimed.metadata.id,
        leaseId,
        this.workerId,
        {
          kind: classifyFailure(error),
          message: sanitizeFailureMessage(error),
        },
        this.retryDelayMs,
      );
      return {
        status: settled.phase === "queued" ? "retry-scheduled" : "failed",
        task: settled,
      };
    }
  }
}
