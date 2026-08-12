import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  FactoryTaskQueueContract,
  FactoryTaskRecord,
  FactoryTaskRequest,
  FactoryWorkerResult,
} from "./operations-types.js";

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const TASK_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface FactoryTaskApiOptions {
  queue: FactoryTaskQueueContract;
  bearerToken: string;
  runOnce?: () => Promise<FactoryWorkerResult>;
  host?: "127.0.0.1" | "::1" | "localhost";
  port?: number;
  maxBodyBytes?: number;
}

export interface FactoryTaskApi {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

interface Problem {
  error: {
    code: string;
    message: string;
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(bytes.length),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(bytes);
}

function problem(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  writeJson(response, status, { error: { code, message } } satisfies Problem);
}

function authenticated(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new ApiInputError(
      415,
      "content-type",
      "Content-Type must be application/json.",
    );
  }
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
    throw new ApiInputError(
      413,
      "body-too-large",
      "Request body exceeds the configured byte limit.",
    );
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maximumBytes) {
      request.destroy();
      throw new ApiInputError(
        413,
        "body-too-large",
        "Request body exceeds the configured byte limit.",
      );
    }
    chunks.push(bytes);
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    return JSON.parse(source) as unknown;
  } catch {
    throw new ApiInputError(
      400,
      "invalid-json",
      "Request body is not valid UTF-8 JSON.",
    );
  }
}

class ApiInputError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function taskRequest(value: unknown): FactoryTaskRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiInputError(400, "invalid-task", "Task must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "repositoryRoot",
    "workOrderPath",
    "workOrderDigest",
    "baseCommit",
    "delivery",
    "keepWorkspace",
    "maxAttempts",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ApiInputError(
      400,
      "invalid-task",
      "Task contains an unknown field.",
    );
  }
  if (
    typeof record.repositoryRoot !== "string" ||
    typeof record.workOrderPath !== "string" ||
    typeof record.workOrderDigest !== "string" ||
    typeof record.baseCommit !== "string" ||
    (record.delivery !== "local" && record.delivery !== "github") ||
    typeof record.keepWorkspace !== "boolean" ||
    typeof record.maxAttempts !== "number"
  ) {
    throw new ApiInputError(
      400,
      "invalid-task",
      "Task fields are incomplete or invalid.",
    );
  }
  return record as unknown as FactoryTaskRequest;
}

function cancelReason(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiInputError(
      400,
      "invalid-cancellation",
      "Cancellation must be an object.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "reason") ||
    typeof record.reason !== "string" ||
    record.reason.trim().length === 0 ||
    record.reason.length > 500
  ) {
    throw new ApiInputError(
      400,
      "invalid-cancellation",
      "Cancellation reason must be a non-empty string of at most 500 characters.",
    );
  }
  return record.reason;
}

function routeTaskId(pathname: string, suffix = ""): string | undefined {
  const pattern = suffix
    ? new RegExp(`^/v1/tasks/([^/]+)/${suffix}$`, "u")
    : /^\/v1\/tasks\/([^/]+)$/u;
  const encoded = pattern.exec(pathname)?.[1];
  if (!encoded) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  return TASK_ID_PATTERN.test(decoded) ? decoded : undefined;
}

export async function startFactoryTaskApi(
  options: FactoryTaskApiOptions,
): Promise<FactoryTaskApi> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("Factory Task API may bind only to a loopback address.");
  }
  if (
    typeof options.bearerToken !== "string" ||
    Buffer.byteLength(options.bearerToken, "utf8") < 32 ||
    Buffer.byteLength(options.bearerToken, "utf8") > 4096 ||
    !/^[\x21-\x7e]+$/u.test(options.bearerToken)
  ) {
    throw new Error(
      "Factory Task API requires a 32-4096 byte printable ASCII bearer token.",
    );
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Factory Task API port is invalid.");
  }
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  if (
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1 ||
    maxBodyBytes > MAX_BODY_BYTES
  ) {
    throw new Error("Factory Task API body limit is invalid.");
  }
  let running = false;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://factory.invalid");
      if (url.search.length > 0) {
        return problem(
          response,
          400,
          "query-not-supported",
          "Query parameters are not supported.",
        );
      }
      if (url.pathname === "/healthz" && request.method === "GET") {
        return writeJson(response, 200, { status: "ok" });
      }
      if (!authenticated(request, options.bearerToken)) {
        response.setHeader("www-authenticate", "Bearer");
        return problem(
          response,
          401,
          "unauthorized",
          "A valid bearer token is required.",
        );
      }
      if (url.pathname === "/v1/tasks" && request.method === "GET") {
        return writeJson(response, 200, { tasks: options.queue.list() });
      }
      if (url.pathname === "/v1/tasks" && request.method === "POST") {
        const task = options.queue.enqueue(
          taskRequest(await readJson(request, maxBodyBytes)),
        );
        return writeJson(response, 202, task);
      }
      const cancellationId = routeTaskId(url.pathname, "cancel");
      if (cancellationId && request.method === "POST") {
        const task = options.queue.cancel(
          cancellationId as FactoryTaskRecord["metadata"]["id"],
          cancelReason(await readJson(request, maxBodyBytes)),
        );
        return writeJson(response, 200, task);
      }
      const taskId = routeTaskId(url.pathname);
      if (taskId && request.method === "GET") {
        const task = options.queue.get(
          taskId as FactoryTaskRecord["metadata"]["id"],
        );
        return task
          ? writeJson(response, 200, task)
          : problem(response, 404, "task-not-found", "Task was not found.");
      }
      if (url.pathname === "/v1/worker/run-once" && request.method === "POST") {
        if (!options.runOnce) {
          return problem(
            response,
            503,
            "worker-disabled",
            "This control plane has no worker.",
          );
        }
        if (running) {
          return problem(
            response,
            409,
            "worker-busy",
            "The worker is already executing a task.",
          );
        }
        running = true;
        try {
          return writeJson(response, 200, await options.runOnce());
        } finally {
          running = false;
        }
      }
      return problem(response, 404, "not-found", "Route was not found.");
    } catch (error) {
      if (error instanceof ApiInputError) {
        return problem(response, error.status, error.code, error.message);
      }
      return problem(
        response,
        500,
        "internal-error",
        "The Factory control plane rejected the request.",
      );
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Factory Task API did not acquire a TCP address.");
  }
  const displayHost = host === "::1" ? "[::1]" : host;
  return {
    server,
    url: `http://${displayHost}:${address.port}`,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
