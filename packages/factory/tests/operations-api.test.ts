import { describe, expect, it } from "vitest";
import { startFactoryTaskApi } from "../src/operations-api.js";
import type {
  FactoryTaskQueueContract,
  FactoryTaskRecord,
  FactoryTaskRequest,
} from "../src/operations-types.js";
import type { Sha256Digest } from "../src/types.js";

const token = "api-token-".padEnd(48, "x");
const taskId = `sha256:${"1".repeat(64)}` as Sha256Digest;

function request(): FactoryTaskRequest {
  return {
    repositoryRoot: "C:\\factory\\repo",
    workOrderPath: ".coga/work-order.yaml",
    workOrderDigest: `sha256:${"2".repeat(64)}`,
    baseCommit: "3".repeat(40),
    delivery: "local",
    keepWorkspace: false,
    maxAttempts: 2,
  };
}

function task(phase: FactoryTaskRecord["phase"] = "queued"): FactoryTaskRecord {
  return {
    schemaVersion: "coga.dev/factory/operations/v0.1",
    kind: "FactoryTask",
    metadata: {
      id: taskId,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
      recordDigest: `sha256:${"4".repeat(64)}`,
    },
    spec: request(),
    phase,
    attempts: 0,
    recoveryCount: 0,
    timing: { enqueuedAt: "2026-08-13T00:00:00.000Z" },
    events: [],
  };
}

function fakeQueue(): FactoryTaskQueueContract & {
  cancelled: string[];
} {
  let value = task();
  const cancelled: string[] = [];
  return {
    cancelled,
    enqueue: () => value,
    get: (id) => (id === taskId ? value : undefined),
    list: () => [value],
    claim: () => undefined,
    heartbeat: () => value,
    succeed: () => value,
    fail: () => value,
    cancel: (_id, detail) => {
      cancelled.push(detail);
      value = task("cancelled");
      return value;
    },
  };
}

function auth(): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

describe("Factory Task API", () => {
  it("binds to loopback and requires an in-memory bearer token", async () => {
    const api = await startFactoryTaskApi({
      queue: fakeQueue(),
      bearerToken: token,
    });
    try {
      expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      const health = await fetch(`${api.url}/healthz`);
      expect(health.status).toBe(200);
      const denied = await fetch(`${api.url}/v1/tasks`);
      expect(denied.status).toBe(401);
      expect(await denied.json()).toEqual({
        error: {
          code: "unauthorized",
          message: "A valid bearer token is required.",
        },
      });
      const wrong = await fetch(`${api.url}/v1/tasks`, {
        headers: { authorization: `Bearer ${token}wrong` },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await api.close();
    }
  });

  it("exposes enqueue, list, exact get and cancellation without leaking secrets", async () => {
    const queue = fakeQueue();
    const api = await startFactoryTaskApi({ queue, bearerToken: token });
    try {
      const created = await fetch(`${api.url}/v1/tasks`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify(request()),
      });
      expect(created.status).toBe(202);
      expect(((await created.json()) as FactoryTaskRecord).metadata.id).toBe(
        taskId,
      );

      const listed = await fetch(`${api.url}/v1/tasks`, { headers: auth() });
      expect(listed.status).toBe(200);
      const listedBody = (await listed.json()) as {
        tasks: FactoryTaskRecord[];
      };
      expect(listedBody.tasks.map((entry) => entry.metadata.id)).toEqual([
        taskId,
      ]);

      const found = await fetch(
        `${api.url}/v1/tasks/${encodeURIComponent(taskId)}`,
        { headers: auth() },
      );
      expect(found.status).toBe(200);

      const cancelled = await fetch(
        `${api.url}/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
        {
          method: "POST",
          headers: { ...auth(), "content-type": "application/json" },
          body: JSON.stringify({ reason: "human stopped this task" }),
        },
      );
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as FactoryTaskRecord).phase).toBe(
        "cancelled",
      );
      expect(queue.cancelled).toEqual(["human stopped this task"]);
      expect(JSON.stringify(listedBody)).not.toContain(token);
    } finally {
      await api.close();
    }
  });

  it("rejects unknown fields, unsupported content and over-budget bodies", async () => {
    const api = await startFactoryTaskApi({
      queue: fakeQueue(),
      bearerToken: token,
      maxBodyBytes: 512,
    });
    try {
      const unknown = await fetch(`${api.url}/v1/tasks`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ ...request(), token: "must-not-be-accepted" }),
      });
      expect(unknown.status).toBe(400);
      expect(await unknown.text()).not.toContain("must-not-be-accepted");

      const content = await fetch(`${api.url}/v1/tasks`, {
        method: "POST",
        headers: { ...auth(), "content-type": "text/plain" },
        body: "{}",
      });
      expect(content.status).toBe(415);

      const large = await fetch(`${api.url}/v1/tasks`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(1024) }),
      });
      expect(large.status).toBe(413);
    } finally {
      await api.close();
    }
  });

  it("serializes run-once and fails closed when no worker is configured", async () => {
    const withoutWorker = await startFactoryTaskApi({
      queue: fakeQueue(),
      bearerToken: token,
    });
    try {
      const unavailable = await fetch(
        `${withoutWorker.url}/v1/worker/run-once`,
        {
          method: "POST",
          headers: auth(),
        },
      );
      expect(unavailable.status).toBe(503);
    } finally {
      await withoutWorker.close();
    }

    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = await startFactoryTaskApi({
      queue: fakeQueue(),
      bearerToken: token,
      runOnce: async () => {
        await waiting;
        return { status: "idle" };
      },
    });
    try {
      const first = fetch(`${api.url}/v1/worker/run-once`, {
        method: "POST",
        headers: auth(),
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const busy = await fetch(`${api.url}/v1/worker/run-once`, {
        method: "POST",
        headers: auth(),
      });
      expect(busy.status).toBe(409);
      release?.();
      expect((await first).status).toBe(200);
    } finally {
      release?.();
      await api.close();
    }
  });

  it("rejects non-loopback bindings and weak API tokens", async () => {
    await expect(
      startFactoryTaskApi({
        queue: fakeQueue(),
        bearerToken: token,
        host: "0.0.0.0" as "127.0.0.1",
      }),
    ).rejects.toThrow(/loopback/iu);
    await expect(
      startFactoryTaskApi({ queue: fakeQueue(), bearerToken: "weak" }),
    ).rejects.toThrow(/32-4096/iu);
    await expect(
      startFactoryTaskApi({
        queue: fakeQueue(),
        bearerToken: `${"x".repeat(31)}\n`,
      }),
    ).rejects.toThrow(/printable ASCII/iu);
  });
});
