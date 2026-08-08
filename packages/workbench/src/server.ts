import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FactoryService,
  type Actor,
  type IncidentRecord,
  type IntentInput,
} from "@coga/factory";

const assetsRoot = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY_BYTES = 1_048_576;

export interface WorkbenchServerOptions {
  profilePath: string;
  stateDirectory?: string;
  bindingPaths?: string[];
  port?: number;
  host?: "127.0.0.1";
  now?: () => string;
}

export interface RunningWorkbench {
  server: Server;
  host: "127.0.0.1";
  port: number;
  url: string;
  actionToken: string;
  service: FactoryService;
  close(): Promise<void>;
}

interface ApiRequest {
  method: string;
  pathname: string;
  segments: string[];
  body?: unknown;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "text/html; charset=utf-8";
  }
}

function serveAsset(pathname: string, response: ServerResponse): void {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  if (
    !/^[A-Za-z0-9._/-]+$/u.test(requested) ||
    requested.split("/").includes("..")
  ) {
    json(response, 404, { error: "Not found." });
    return;
  }
  const path = normalize(join(assetsRoot, requested));
  if (!path.startsWith(normalize(assetsRoot))) {
    json(response, 404, { error: "Not found." });
    return;
  }
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    const body = readFileSync(path);
    securityHeaders(response);
    response.writeHead(200, {
      "content-type": contentType(path),
      "content-length": body.byteLength,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    json(response, 404, { error: "Not found." });
  }
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body exceeds 1 MiB.");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const type = request.headers["content-type"]?.split(";", 1)[0];
  if (type !== "application/json")
    throw new Error("State-changing requests require application/json.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function human(value: unknown, fallbackRoles = ["domain-steward"]): Actor {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<Actor>)
      : {};
  return {
    id:
      typeof candidate.id === "string" && candidate.id
        ? candidate.id
        : "human.local.operator",
    type: "human",
    roles:
      Array.isArray(candidate.roles) &&
      candidate.roles.every((role: unknown) => typeof role === "string")
        ? candidate.roles
        : fallbackRoles,
  };
}

function candidateForTask(
  service: FactoryService,
  taskId: string,
): Record<string, unknown> {
  const task = service.store.get<Record<string, unknown>>("tasks", taskId);
  const spec = task?.spec;
  const steps =
    spec && typeof spec === "object"
      ? (spec as Record<string, unknown>).steps
      : undefined;
  const firstStep = Array.isArray(steps) ? steps[0] : undefined;
  const input =
    firstStep && typeof firstStep === "object"
      ? (firstStep as Record<string, unknown>).input
      : undefined;
  const candidateId =
    input && typeof input === "object"
      ? (input as Record<string, unknown>).candidateId
      : undefined;
  if (typeof candidateId !== "string")
    throw new Error(`Task '${taskId}' has no candidate.`);
  const candidate = service.store.get<Record<string, unknown>>(
    "candidates",
    candidateId,
  );
  if (!candidate) throw new Error(`Candidate '${candidateId}' is missing.`);
  return candidate;
}

function requireAction(request: IncomingMessage, token: string): void {
  if (request.headers["x-coga-action-token"] !== token)
    throw new Error("Invalid Workbench action token.");
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && host && origin !== `http://${host}`)
    throw new Error("Cross-origin action rejected.");
}

async function api(
  input: ApiRequest,
  service: FactoryService,
  actionToken: string,
  request: IncomingMessage,
): Promise<{ status: number; value: unknown }> {
  if (input.method === "GET" && input.pathname === "/api/bootstrap") {
    return {
      status: 200,
      value: {
        actionToken,
        server: {
          mode: "localhost",
          releaseCapability: false,
          credentialStorage: "process-memory-only",
        },
        snapshot: service.snapshot(),
        form: {
          risk: ["low", "medium", "high", "critical"],
          mode: [
            "calibrate",
            "build",
            "repair",
            "upgrade",
            "operate",
            "release-harness",
          ],
          required: [
            "goal",
            "acceptanceCriteria",
            "risk",
            "source",
            "candidate.before",
            "candidate.after",
          ],
        },
      },
    };
  }

  if (
    input.method === "GET" &&
    input.segments[2] === "impact" &&
    input.segments[3]
  ) {
    return {
      status: 200,
      value: service.impactFor(decodeURIComponent(input.segments[3])),
    };
  }

  if (
    input.method === "GET" &&
    input.segments[2] === "incidents" &&
    input.segments[3] &&
    input.segments[4] === "closure"
  ) {
    return {
      status: 200,
      value: service.incidentClosure(decodeURIComponent(input.segments[3])),
    };
  }

  requireAction(request, actionToken);
  const body = record(input.body);

  if (input.method === "POST" && input.pathname === "/api/intents") {
    const intent = body.intent as IntentInput;
    return {
      status: 201,
      value: service.createIntent(intent, human(body.actor)),
    };
  }

  if (
    input.method === "POST" &&
    input.segments[2] === "tasks" &&
    input.segments[3]
  ) {
    const taskId = decodeURIComponent(input.segments[3]);
    const action = input.segments[4];
    if (action === "assess") {
      return {
        status: 200,
        value: await service.assessTask(
          taskId,
          body.mode === "deepseek" ? "deepseek" : "offline",
        ),
      };
    }
    if (action === "validate") {
      return { status: 200, value: await service.runValidators(taskId) };
    }
    if (action === "approve") {
      const candidate = candidateForTask(service, taskId);
      const artifactId = candidate.artifactId;
      if (typeof artifactId !== "string")
        throw new Error("Candidate artifact ID is missing.");
      return {
        status: 200,
        value: service.approve({
          taskId,
          actor: human(
            body.actor,
            Array.isArray(body.roles)
              ? (body.roles as string[])
              : ["domain-steward"],
          ),
          roles: Array.isArray(body.roles)
            ? (body.roles as string[])
            : ["domain-steward"],
          decision: body.decision === "reject" ? "reject" : "approve",
          reason:
            typeof body.reason === "string"
              ? body.reason
              : "Reviewed in the local COGA Workbench.",
          impactDigest: service.impactDigestFor(artifactId),
        }),
      };
    }
    if (action === "preview") {
      return { status: 200, value: service.previewDecision(taskId) };
    }
  }

  if (input.method === "POST" && input.pathname === "/api/observations") {
    const observation = service.ingestObservation(
      body.observation,
      human(body.actor, ["operator"]),
    );
    return {
      status: 201,
      value: { observation, storeId: observation.metadata.id },
    };
  }

  if (input.method === "POST" && input.pathname === "/api/fixtures/load") {
    const type = body.type === "incident" ? "incident" : "observation";
    return {
      status: 200,
      value: {
        fixture: service.loadBindingFixture(
          String(body.bindingId),
          type,
          Number(body.index ?? 0),
        ),
        type,
      },
    };
  }

  if (input.method === "POST" && input.pathname === "/api/incidents") {
    return {
      status: 201,
      value: service.createIncident({
        id: String(body.id),
        observationStoreIds: Array.isArray(body.observationStoreIds)
          ? body.observationStoreIds.map(String)
          : [],
        runbook: body.runbook as { id: string; version: string },
        actor: human(body.actor, ["operator"]),
      }),
    };
  }

  if (
    input.method === "PATCH" &&
    input.segments[2] === "incidents" &&
    input.segments[3]
  ) {
    return {
      status: 200,
      value: service.updateIncident(
        decodeURIComponent(input.segments[3]),
        body.patch as Partial<IncidentRecord>,
        human(body.actor, ["incident-commander"]),
      ),
    };
  }

  if (input.method === "POST" && input.pathname === "/api/promotions") {
    const incidentIds = Array.isArray(body.incidentIds)
      ? body.incidentIds.map(String)
      : [];
    return {
      status: 201,
      value: service.promote(
        {
          id: String(body.id),
          incidentIds,
          targetPackage: body.targetPackage as { id: string; version: string },
          candidateArtifact: body.candidateArtifact as Record<string, unknown>,
          consumerApplications: Array.isArray(body.consumerApplications)
            ? body.consumerApplications.map(String)
            : [],
          authoritativeSources: Array.isArray(body.authoritativeSources)
            ? body.authoritativeSources.map(String)
            : [],
          privateTermsScanPassed: body.privateTermsScanPassed === true,
          independentScenarios: Array.isArray(body.independentScenarios)
            ? body.independentScenarios.map(String)
            : [],
        },
        human(body.actor),
      ),
    };
  }

  return { status: 404, value: { error: "API route not found." } };
}

export async function createWorkbenchServer(
  options: WorkbenchServerOptions,
): Promise<RunningWorkbench> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1")
    throw new Error("COGA Workbench may bind only to 127.0.0.1.");
  const service = new FactoryService({
    profilePath: options.profilePath,
    ...(options.stateDirectory
      ? { stateDirectory: options.stateDirectory }
      : {}),
    ...(options.bindingPaths?.length
      ? { extraBindingPaths: options.bindingPaths }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const actionToken = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
      if (url.pathname.startsWith("/api/")) {
        const method = request.method ?? "GET";
        const parsed: ApiRequest = {
          method,
          pathname: url.pathname,
          segments: url.pathname.split("/"),
          ...(["POST", "PUT", "PATCH", "DELETE"].includes(method)
            ? { body: await bodyOf(request) }
            : {}),
        };
        const result = await api(parsed, service, actionToken, request);
        json(response, result.status, result.value);
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      serveAsset(url.pathname, response);
    } catch (error) {
      json(response, 400, {
        error:
          error instanceof Error ? error.message : "Workbench request failed.",
      });
    }
  });

  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4376, host, () => {
      server.off("error", reject);
      resolveReady();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Workbench did not receive a TCP address.");
  const port = address.port;
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}`,
    actionToken,
    service,
    async close(): Promise<void> {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}
