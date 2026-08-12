import { execFileSync, spawnSync } from "node:child_process";
import { Worker as ThreadWorker } from "node:worker_threads";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  factoryTaskEventDigest,
  factoryTaskRecordDigest,
  FactoryTaskQueue,
} from "../src/queue.js";
import type {
  FactoryTaskRequest,
  FactoryTaskRecord,
} from "../src/operations-types.js";
import { FactoryWorker } from "../src/worker.js";
import type { FactoryRunResult, Sha256Digest } from "../src/types.js";
import { canonicalJson, sha256 } from "../src/utils.js";

function fixture(options: { maxAttempts?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "coga-factory-queue-"));
  const repositoryRoot = join(root, "repository");
  const queueRoot = join(root, "queue");
  mkdirSync(repositoryRoot);
  const workOrderPath = "orders/work-order.yaml";
  const workOrder = join(repositoryRoot, workOrderPath);
  mkdirSync(dirname(workOrder));
  const bytes = Buffer.from(
    "schemaVersion: coga.dev/factory/v0.5\nkind: WorkOrder\n",
    "utf8",
  );
  writeFileSync(workOrder, bytes);
  let value = Date.parse("2026-08-13T00:00:00.000Z");
  let sequence = 0;
  const now = () => new Date(value);
  const advance = (milliseconds: number) => {
    value += milliseconds;
  };
  const queue = new FactoryTaskQueue({
    root: queueRoot,
    now,
    randomId: () => `id-${++sequence}`,
    maxTasks: 20,
    maxRecordBytes: 256 * 1024,
  });
  const request: FactoryTaskRequest = {
    repositoryRoot,
    workOrderPath,
    workOrderDigest: sha256(bytes),
    baseCommit: "a".repeat(40),
    delivery: "local",
    keepWorkspace: false,
    maxAttempts: options.maxAttempts ?? 3,
  };
  return {
    root,
    repositoryRoot,
    queueRoot,
    workOrder,
    queue,
    request,
    now,
    advance,
  };
}

function resultFor(task: FactoryTaskRecord): FactoryRunResult {
  return {
    status: "completed",
    workOrderId: task.metadata.id,
    baseCommit: task.spec.baseCommit,
    targets: [],
  };
}

function taskPath(queueRoot: string, id: Sha256Digest): string {
  return join(queueRoot, "tasks", `${id.slice("sha256:".length)}.json`);
}

function rewriteWithValidDigests(
  path: string,
  mutate: (record: FactoryTaskRecord) => void,
): void {
  const record = JSON.parse(readFileSync(path, "utf8")) as FactoryTaskRecord;
  mutate(record);
  let previous: Sha256Digest | undefined;
  for (const event of record.events) {
    if (previous === undefined) delete event.previousDigest;
    else event.previousDigest = previous;
    const { digest: _old, ...payload } = event;
    event.digest = factoryTaskEventDigest(payload);
    previous = event.digest;
  }
  record.metadata.recordDigest = factoryTaskRecordDigest(record);
  writeFileSync(path, canonicalJson(record));
}

describe("FactoryTaskQueue durable operations", () => {
  it("emits queued, leased, and succeeded records accepted by the operations schema", () => {
    const schema = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../schemas/factory-task.schema.json"),
        "utf8",
      ),
    ) as object;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const { queue, request } = fixture();
    const queued = queue.enqueue(request);
    expect(validate(queued), JSON.stringify(validate.errors)).toBe(true);
    const leased = queue.claim("schema-worker", 1_000)!;
    expect(validate(leased), JSON.stringify(validate.errors)).toBe(true);
    const succeeded = queue.succeed(
      leased.metadata.id,
      leased.lease!.id,
      "schema-worker",
      resultFor(leased),
    );
    expect(validate(succeeded), JSON.stringify(validate.errors)).toBe(true);
  });

  it("idempotently enqueues the exact request and rejects changed content", () => {
    const { queue, request, workOrder } = fixture();
    const first = queue.enqueue(request);
    const second = queue.enqueue(structuredClone(request));
    expect(second).toEqual(first);
    expect(queue.list()).toEqual([first]);

    writeFileSync(workOrder, "changed\n");
    expect(() => queue.enqueue(request)).toThrow(/workOrderDigest mismatch/u);
  });

  it("claims one task atomically across independent queue instances", () => {
    const { queue, queueRoot, request, now } = fixture();
    queue.enqueue(request);
    const competing = new FactoryTaskQueue({
      root: queueRoot,
      now,
      randomId: () => "competing-lease",
    });
    const first = queue.claim("worker-a", 1_000);
    const second = competing.claim("worker-b", 1_000);
    expect(first?.phase).toBe("leased");
    expect(second).toBeUndefined();
    expect(first?.lease?.workerId).toBe("worker-a");
  });

  it("supports heartbeats, expired lease recovery, and attempt exhaustion", () => {
    const { queue, request, advance } = fixture({ maxAttempts: 2 });
    const enqueued = queue.enqueue(request);
    const first = queue.claim("worker-a", 100)!;
    advance(50);
    const heartbeat = queue.heartbeat(
      enqueued.metadata.id,
      first.lease!.id,
      "worker-a",
      100,
    );
    expect(heartbeat.events.at(-1)?.type).toBe("heartbeat");
    advance(101);
    const recovered = queue.claim("worker-b", 100)!;
    expect(recovered.recoveryCount).toBe(1);
    expect(recovered.attempts).toBe(2);
    expect(recovered.events.map((event) => event.type)).toEqual([
      "enqueued",
      "leased",
      "heartbeat",
      "recovered",
      "leased",
    ]);
    advance(101);
    expect(queue.claim("worker-c", 100)).toBeUndefined();
    const terminal = queue.get(enqueued.metadata.id)!;
    expect(terminal.phase).toBe("failed");
    expect(terminal.recoveryCount).toBe(2);
    expect(terminal.events.at(-1)?.type).toBe("failed");
  });

  it("retries transient failures and terminates at the attempt budget", () => {
    const { queue, request, advance } = fixture({ maxAttempts: 2 });
    const task = queue.enqueue(request);
    const first = queue.claim("worker", 1_000)!;
    const retry = queue.fail(
      task.metadata.id,
      first.lease!.id,
      "worker",
      { kind: "transient", message: "temporary failure" },
      50,
    );
    expect(retry.phase).toBe("queued");
    expect(retry.nextAttemptAt).toBe("2026-08-13T00:00:00.050Z");
    expect(queue.claim("early", 1_000)).toBeUndefined();
    advance(50);
    const second = queue.claim("worker", 1_000)!;
    const failed = queue.fail(
      task.metadata.id,
      second.lease!.id,
      "worker",
      { kind: "transient", message: "temporary failure" },
      50,
    );
    expect(failed.phase).toBe("failed");
    expect(failed.events.at(-1)?.detail).toBe("Attempt budget exhausted.");
    expect(
      queue.fail(
        task.metadata.id,
        second.lease!.id,
        "worker",
        { kind: "transient", message: "temporary failure" },
        50,
      ),
    ).toEqual(failed);
  });

  it("keeps stable list ordering and idempotent terminal operations", () => {
    const { queue, request, advance } = fixture();
    const first = queue.enqueue(request);
    advance(1);
    const secondRequest = { ...request, baseCommit: "b".repeat(40) };
    const second = queue.enqueue(secondRequest);
    expect(queue.list().map((task) => task.metadata.id)).toEqual([
      first.metadata.id,
      second.metadata.id,
    ]);

    const lease = queue.claim("worker", 1_000)!;
    expect(() =>
      queue.succeed(first.metadata.id, lease.lease!.id, "worker", {
        ...resultFor(lease),
        baseCommit: "f".repeat(40),
      }),
    ).toThrow(/baseCommit must match/u);
    const succeeded = queue.succeed(
      first.metadata.id,
      lease.lease!.id,
      "worker",
      resultFor(lease),
    );
    expect(
      queue.succeed(
        first.metadata.id,
        lease.lease!.id,
        "worker",
        resultFor(lease),
      ),
    ).toEqual(succeeded);
    expect(() =>
      queue.succeed(first.metadata.id, "wrong", "worker", resultFor(lease)),
    ).toThrow(/original lease/u);

    const cancelled = queue.cancel(
      second.metadata.id,
      "operator cancelled queued work",
    );
    expect(
      queue.cancel(second.metadata.id, "operator cancelled queued work"),
    ).toEqual(cancelled);
    expect(() => queue.cancel(second.metadata.id, "different reason")).toThrow(
      /different detail/u,
    );
  });

  it("fails closed on record, event-chain, semantic-history, path, and symlink tampering", () => {
    const { root, repositoryRoot, queueRoot, queue, request } = fixture();
    const task = queue.enqueue(request);
    const path = taskPath(queueRoot, task.metadata.id);

    const changed = JSON.parse(readFileSync(path, "utf8")) as FactoryTaskRecord;
    changed.attempts = 1;
    writeFileSync(path, canonicalJson(changed));
    expect(() => queue.get(task.metadata.id)).toThrow(/recordDigest/u);

    writeFileSync(path, canonicalJson(task));
    rewriteWithValidDigests(path, (record) => {
      record.phase = "failed";
      record.timing.startedAt = record.metadata.createdAt;
      record.timing.finishedAt = record.metadata.createdAt;
      record.timing.runDurationMs = 0;
      record.failure = {
        kind: "permanent",
        message: "forged",
        occurredAt: record.metadata.createdAt,
      };
      record.events.push({
        sequence: 2,
        type: "failed",
        at: record.metadata.createdAt,
        digest: sha256("placeholder"),
      });
    });
    expect(() => queue.get(task.metadata.id)).toThrow(
      /active lease or recovery/u,
    );

    const escaping: FactoryTaskRequest = {
      ...request,
      workOrderPath: "../outside.yaml",
    };
    expect(() => queue.enqueue(escaping)).toThrow(
      /invalid segment|repository-relative/u,
    );

    const outsideDirectory = join(root, "outside-orders");
    mkdirSync(outsideDirectory);
    writeFileSync(join(outsideDirectory, "outside.yaml"), "outside\n");
    const link = join(repositoryRoot, "linked-orders");
    symlinkSync(
      outsideDirectory,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      queue.enqueue({
        ...request,
        workOrderPath: "linked-orders/outside.yaml",
        workOrderDigest: sha256("outside\n"),
      }),
    ).toThrow(/symbolic link/u);
  });

  it("enforces task, record-size, and unclassified-entry budgets", () => {
    const one = fixture();
    const bounded = new FactoryTaskQueue({
      root: one.queueRoot,
      now: one.now,
      maxTasks: 1,
    });
    bounded.enqueue(one.request);
    expect(() =>
      bounded.enqueue({ ...one.request, baseCommit: "c".repeat(40) }),
    ).toThrow(/task budget/u);

    const recordFixture = fixture();
    const small = new FactoryTaskQueue({
      root: recordFixture.queueRoot,
      now: recordFixture.now,
      maxRecordBytes: 1024,
    });
    expect(() => small.enqueue(recordFixture.request)).toThrow(
      /record exceeds/u,
    );

    const layout = fixture();
    writeFileSync(
      join(layout.queueRoot, "tasks", "unexpected.txt"),
      "unexpected\n",
    );
    expect(() => layout.queue.list()).toThrow(/Unclassified/u);
  });

  it("uses a concurrent worker-thread atomic claim lock", async () => {
    const { queue, queueRoot, request } = fixture();
    queue.enqueue(request);
    const runner = `
      const { workerData, parentPort } = require("node:worker_threads");
      import(workerData.module).then(({ FactoryTaskQueue }) => {
        const queue = new FactoryTaskQueue({
          root: workerData.root,
          now: () => new Date("2026-08-13T00:00:00.000Z"),
        });
        const task = queue.claim(workerData.worker, 10000);
        parentPort.postMessage(task ? task.metadata.id : "idle");
      }).catch((error) => { throw error; });
    `;
    const module = new URL("../dist/queue.js", import.meta.url).href;
    const outputs = await Promise.all(
      ["thread-a", "thread-b"].map(
        (worker) =>
          new Promise<string>((resolvePromise, reject) => {
            const thread = new ThreadWorker(runner, {
              eval: true,
              execArgv: ["--experimental-strip-types"],
              workerData: { module, root: queueRoot, worker },
            });
            thread.once("message", resolvePromise);
            thread.once("error", reject);
          }),
      ),
    );
    expect(outputs.filter((output) => output !== "idle")).toHaveLength(1);
  });

  it("recovers locks abandoned by a dead process and legacy empty locks", () => {
    const deadOwner = fixture();
    const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    expect(exited.status).toBe(0);
    expect(exited.pid).toBeTypeOf("number");
    const deadLock = join(deadOwner.queueRoot, "mutation.lock");
    mkdirSync(deadLock);
    writeFileSync(
      join(deadLock, "owner.json"),
      canonicalJson({
        pid: exited.pid,
        acquiredAt: "2026-08-13T00:00:00.000Z",
        token: "dead-process-lock",
      }),
    );
    expect(deadOwner.queue.enqueue(deadOwner.request).phase).toBe("queued");

    const emptyOwner = fixture();
    const emptyLock = join(emptyOwner.queueRoot, "mutation.lock");
    mkdirSync(emptyLock);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(emptyLock, stale, stale);
    expect(emptyOwner.queue.enqueue(emptyOwner.request).phase).toBe("queued");
  });
});

describe("FactoryWorker", () => {
  it("executes one task successfully and returns idle afterwards", async () => {
    const { queue, request, now } = fixture();
    queue.enqueue(request);
    const execute = vi.fn(async (task: FactoryTaskRecord) => resultFor(task));
    const worker = new FactoryWorker({
      queue,
      executor: { execute },
      workerId: "worker",
      leaseMs: 1_000,
      retryDelayMs: 20,
      now,
    });
    const completed = await worker.runOnce();
    expect(completed.status).toBe("succeeded");
    expect(completed.task?.phase).toBe("succeeded");
    expect(execute).toHaveBeenCalledOnce();
    expect((await worker.runOnce()).status).toBe("idle");
  });

  it("heartbeats a long executor task so another worker cannot recover it", async () => {
    const root = mkdtempSync(join(tmpdir(), "coga-factory-long-worker-"));
    const repositoryRoot = join(root, "repository");
    mkdirSync(repositoryRoot);
    writeFileSync(join(repositoryRoot, "work-order.yaml"), "work-order\n");
    const queue = new FactoryTaskQueue({ root: join(root, "queue") });
    const request: FactoryTaskRequest = {
      repositoryRoot,
      workOrderPath: "work-order.yaml",
      workOrderDigest: sha256("work-order\n"),
      baseCommit: "d".repeat(40),
      delivery: "local",
      keepWorkspace: false,
      maxAttempts: 2,
    };
    const task = queue.enqueue(request);
    let releaseExecutor: (() => void) | undefined;
    const executorGate = new Promise<void>((resolvePromise) => {
      releaseExecutor = resolvePromise;
    });
    const worker = new FactoryWorker({
      queue,
      executor: {
        async execute(claimed) {
          await executorGate;
          return resultFor(claimed);
        },
      },
      workerId: "long-worker",
      leaseMs: 3_000,
      retryDelayMs: 10,
    });
    const running = worker.runOnce();
    try {
      const deadline = Date.now() + 5_000;
      while (
        !queue
          .get(task.metadata.id)
          ?.events.some((event) => event.type === "heartbeat")
      ) {
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for a worker heartbeat.");
        }
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 25),
        );
      }
      expect(queue.claim("competing-worker", 3_000)).toBeUndefined();
      releaseExecutor();
      const completed = await running;
      expect(completed.status).toBe("succeeded");
      const heartbeatCount = completed.task!.events.filter(
        (event) => event.type === "heartbeat",
      ).length;
      expect(heartbeatCount).toBeGreaterThanOrEqual(1);
      const eventCount = completed.task!.events.length;
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, 1_100),
      );
      expect(queue.get(task.metadata.id)?.events).toHaveLength(eventCount);
    } finally {
      releaseExecutor?.();
      await running.catch(() => undefined);
    }
  }, 10_000);

  it("classifies executor failure and never persists secret-bearing thrown data", async () => {
    const { queue, request, now } = fixture({ maxAttempts: 2 });
    const task = queue.enqueue(request);
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
    const worker = new FactoryWorker({
      queue,
      executor: {
        async execute() {
          const error = new Error(`token=${secret}`) as Error & {
            kind: string;
            nested: object;
          };
          error.kind = "transient";
          error.nested = { authorization: `Bearer ${secret}` };
          throw error;
        },
      },
      workerId: "worker",
      leaseMs: 1_000,
      retryDelayMs: 20,
      now,
    });
    const failure = await worker.runOnce();
    expect(failure.status).toBe("retry-scheduled");
    expect(failure.task?.failure?.message).toMatch(
      /sensitive detail was not persisted/u,
    );
    expect(
      readFileSync(taskPath(queue.root, task.metadata.id), "utf8"),
    ).not.toContain(secret);
  });

  it("records permanent executor failures as terminal", async () => {
    const { queue, request, now } = fixture();
    queue.enqueue(request);
    const worker = new FactoryWorker({
      queue,
      executor: {
        async execute() {
          throw Object.assign(new Error("invalid work order"), {
            kind: "permanent",
          });
        },
      },
      workerId: "worker",
      leaseMs: 1_000,
      retryDelayMs: 20,
      now,
    });
    const failure = await worker.runOnce();
    expect(failure.status).toBe("failed");
    expect(failure.task?.phase).toBe("failed");
    expect(failure.task?.failure?.kind).toBe("permanent");
  });

  it("preserves an operator cancellation that races executor settlement", async () => {
    const { queue, request, now } = fixture();
    queue.enqueue(request);
    const worker = new FactoryWorker({
      queue,
      executor: {
        async execute(claimed) {
          queue.cancel(claimed.metadata.id, "operator cancelled the task");
          return resultFor(claimed);
        },
      },
      workerId: "worker",
      leaseMs: 1_000,
      retryDelayMs: 20,
      now,
    });
    const cancelled = await worker.runOnce();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.task?.phase).toBe("cancelled");
    expect(cancelled.task?.events.at(-1)?.detail).toBe(
      "operator cancelled the task",
    );
  });
});
