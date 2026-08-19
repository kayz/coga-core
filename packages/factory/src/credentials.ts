import { createPrivateKey, createSign } from "node:crypto";
import { inspect } from "node:util";
import type {
  GitHubCredentialLease,
  GitHubCredentialProvider,
  GitHubCredentialPurpose,
  GitHubCredentialRequest,
  SecretSource,
} from "./operations-types.js";

const DEFAULT_API = "https://api.github.com";
const MAX_SECRET_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_TTL_MS = 65 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PERMISSION_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;

export const GITHUB_APP_PERMISSION_POLICY: Readonly<
  Record<GitHubCredentialPurpose, Readonly<Record<string, "read" | "write">>>
> = Object.freeze({
  "draft-delivery": Object.freeze({
    contents: "write",
    pull_requests: "write",
  }),
  "remote-evidence": Object.freeze({
    actions: "read",
    checks: "read",
    contents: "read",
    pull_requests: "write",
  }),
  "authorized-merge": Object.freeze({
    contents: "write",
    pull_requests: "write",
  }),
  "test-environment": Object.freeze({
    actions: "write",
    contents: "write",
    deployments: "write",
  }),
});

export interface EnvironmentSecretSourceOptions {
  allowedNames: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
  maxSecretBytes?: number;
}

/** Reads only an explicit allowlist and never mutates or snapshots process.env. */
export class BoundedEnvironmentSecretSource implements SecretSource {
  readonly #allowedNames: ReadonlySet<string>;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #maxSecretBytes: number;

  constructor(options: EnvironmentSecretSourceOptions) {
    if (options.allowedNames.length < 1 || options.allowedNames.length > 32) {
      throw new Error("Environment secret source requires 1-32 allowed names.");
    }
    const names = new Set<string>();
    for (const name of options.allowedNames) {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/u.test(name) || names.has(name)) {
        throw new Error(
          "Environment secret source contains an invalid or duplicate name.",
        );
      }
      names.add(name);
    }
    const limit = options.maxSecretBytes ?? MAX_SECRET_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024 * 1024) {
      throw new Error("Environment secret source byte limit is invalid.");
    }
    this.#allowedNames = names;
    this.#environment = options.environment ?? process.env;
    this.#maxSecretBytes = limit;
  }

  async read(name: string): Promise<string> {
    if (!this.#allowedNames.has(name)) {
      throw new Error(
        "Secret name is outside the configured environment boundary.",
      );
    }
    const value = this.#environment[name];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0") ||
      Buffer.byteLength(value, "utf8") > this.#maxSecretBytes
    ) {
      throw new Error(
        "Configured environment secret is missing or outside its byte budget.",
      );
    }
    return value;
  }
}

export { BoundedEnvironmentSecretSource as EnvironmentSecretSource };

type Fetch = typeof fetch;

export interface GitHubAppCredentialProviderOptions {
  secretSource: SecretSource;
  appIdSecretName: string;
  privateKeySecretName: string;
  fetch?: Fetch;
  now?: () => Date;
  randomId?: () => string;
  maxResponseBytes?: number;
  maxTtlMs?: number;
  requestTimeoutMs?: number;
  permissionPolicy?: Readonly<
    Record<GitHubCredentialPurpose, Readonly<Record<string, "read" | "write">>>
  >;
}

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid object.`);
  }
  return value as JsonObject;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function credentialVariants(value: string): string[] {
  if (!value) return [];
  return [
    value,
    encodeURIComponent(value),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
  ].filter(
    (entry, index, all) => entry.length >= 4 && all.indexOf(entry) === index,
  );
}

export function redactCredentialError(
  error: unknown,
  credentials: readonly string[],
): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const credential of credentials) {
    for (const variant of credentialVariants(credential)) {
      message = message.split(variant).join("[REDACTED]");
    }
  }
  return new Error(message || "GitHub credential operation failed.");
}

function assertPlainPermissions(
  permissions: Readonly<Record<string, "read" | "write">>,
  label: string,
): Record<string, "read" | "write"> {
  if (
    !permissions ||
    typeof permissions !== "object" ||
    Array.isArray(permissions)
  ) {
    throw new Error(`${label} must be an object.`);
  }
  const entries = Object.entries(permissions).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (entries.length < 1 || entries.length > 32) {
    throw new Error(`${label} must contain 1-32 permissions.`);
  }
  const result: Record<string, "read" | "write"> = {};
  for (const [name, access] of entries) {
    if (
      !PERMISSION_NAME.test(name) ||
      (access !== "read" && access !== "write")
    ) {
      throw new Error(`${label} contains an invalid permission.`);
    }
    result[name] = access;
  }
  return result;
}

function samePermissions(
  left: Readonly<Record<string, "read" | "write">>,
  right: Readonly<Record<string, "read" | "write">>,
): boolean {
  const leftEntries = Object.entries(left).sort();
  const rightEntries = Object.entries(right).sort();
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function createJwt(appId: string, privateKey: Buffer, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: appId }),
  );
  const input = `${header}.${payload}`;
  const key = createPrivateKey({ key: privateKey, format: "pem" });
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return `${input}.${signer.sign(key).toString("base64url")}`;
}

async function readBoundedJson(
  response: Response,
  limit: number,
  label: string,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    throw new Error(`${label} response exceeds its byte budget.`);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error(`${label} response exceeds its byte budget.`);
    }
    chunks.push(result.value);
  }
  const buffer = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    ) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function validateRepository(repository: string): {
  owner: string;
  name: string;
} {
  if (
    !REPOSITORY.test(repository) ||
    repository.includes("..") ||
    repository.endsWith(".git")
  ) {
    throw new Error("GitHub credential repository must be exactly owner/name.");
  }
  const [owner, name] = repository.split("/");
  if (!owner || !name)
    throw new Error("GitHub credential repository is invalid.");
  return { owner, name };
}

function safeLease(value: GitHubCredentialLease): GitHubCredentialLease {
  const lease = { ...value } as GitHubCredentialLease & {
    toJSON?: () => unknown;
  };
  Object.defineProperty(lease, "token", {
    value: value.token,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(lease, "toJSON", {
    enumerable: false,
    value: () => ({ ...value, token: "[REDACTED]" }),
  });
  Object.defineProperty(lease, inspect.custom, {
    enumerable: false,
    value: () => ({ ...value, token: "[REDACTED]" }),
  });
  return Object.freeze(lease);
}

export class GitHubAppInstallationCredentialProvider
  implements GitHubCredentialProvider
{
  readonly #secretSource: SecretSource;
  readonly #appIdSecretName: string;
  readonly #privateKeySecretName: string;
  readonly #fetch: Fetch;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #maxResponseBytes: number;
  readonly #maxTtlMs: number;
  readonly #requestTimeoutMs: number;
  readonly #policy: Readonly<
    Record<GitHubCredentialPurpose, Readonly<Record<string, "read" | "write">>>
  >;
  readonly #issued = new WeakSet<object>();

  constructor(options: GitHubAppCredentialProviderOptions) {
    this.#secretSource = options.secretSource;
    this.#appIdSecretName = options.appIdSecretName;
    this.#privateKeySecretName = options.privateKeySecretName;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? (() => crypto.randomUUID());
    this.#maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxTtlMs = options.maxTtlMs ?? DEFAULT_MAX_TTL_MS;
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#policy = options.permissionPolicy ?? GITHUB_APP_PERMISSION_POLICY;
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(this.#appIdSecretName) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(this.#privateKeySecretName) ||
      this.#appIdSecretName === this.#privateKeySecretName
    ) {
      throw new Error("GitHub App secret names are invalid.");
    }
    if (
      !Number.isSafeInteger(this.#maxResponseBytes) ||
      this.#maxResponseBytes < 1024 ||
      this.#maxResponseBytes > 1024 * 1024
    ) {
      throw new Error("GitHub API response byte limit is invalid.");
    }
    if (
      !Number.isSafeInteger(this.#maxTtlMs) ||
      this.#maxTtlMs < 60_000 ||
      this.#maxTtlMs > 2 * 60 * 60 * 1000
    ) {
      throw new Error("GitHub credential maximum TTL is invalid.");
    }
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > 2 * 60_000
    ) {
      throw new Error("GitHub credential request timeout is invalid.");
    }
  }

  async #request(
    path: string,
    init: RequestInit,
    label: string,
    credentials: readonly string[],
    expectedStatus: number,
  ): Promise<unknown> {
    try {
      const response = await this.#fetch(`${DEFAULT_API}${path}`, {
        ...init,
        signal: init.signal
          ? AbortSignal.any([
              init.signal,
              AbortSignal.timeout(this.#requestTimeoutMs),
            ])
          : AbortSignal.timeout(this.#requestTimeoutMs),
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "coga-factory-credential-broker/0.5",
          ...init.headers,
        },
      });
      if (
        response.redirected ||
        (response.url && !response.url.startsWith(`${DEFAULT_API}/`))
      ) {
        throw new Error(`${label} refused a redirected response.`);
      }
      if (response.status !== expectedStatus) {
        throw new Error(`${label} failed with HTTP ${response.status}.`);
      }
      if (expectedStatus === 204) return null;
      return await readBoundedJson(response, this.#maxResponseBytes, label);
    } catch (error) {
      throw redactCredentialError(error, credentials);
    }
  }

  async acquire(
    request: GitHubCredentialRequest,
  ): Promise<GitHubCredentialLease> {
    const { owner, name } = validateRepository(request.repository);
    if (!APP_SLUG.test(request.appSlug))
      throw new Error("GitHub App slug is invalid.");
    if (
      !Number.isSafeInteger(request.minimumTtlMs) ||
      request.minimumTtlMs < 1 ||
      request.minimumTtlMs > this.#maxTtlMs
    ) {
      throw new Error("GitHub credential minimum TTL is invalid.");
    }
    const permissions = assertPlainPermissions(
      request.permissions,
      "GitHub credential permissions",
    );
    const policy = assertPlainPermissions(
      this.#policy[request.purpose],
      "GitHub credential purpose policy",
    );
    if (!samePermissions(permissions, policy)) {
      throw new Error(
        "GitHub credential permissions are not the exact minimal policy for this purpose.",
      );
    }

    let appId = "";
    let privateKeyText = "";
    let privateKey = Buffer.alloc(0);
    let jwt = "";
    let token = "";
    try {
      try {
        [appId, privateKeyText] = await Promise.all([
          this.#secretSource.read(this.#appIdSecretName),
          this.#secretSource.read(this.#privateKeySecretName),
        ]);
      } catch {
        throw new Error("GitHub App secret acquisition failed.");
      }
      if (!/^[1-9]\d{0,19}$/u.test(appId))
        throw new Error("GitHub App ID secret is invalid.");
      privateKey = Buffer.from(privateKeyText, "utf8");
      privateKeyText = "";
      const issued = this.#now();
      if (!Number.isFinite(issued.getTime()))
        throw new Error("GitHub credential clock returned an invalid time.");
      try {
        jwt = createJwt(appId, privateKey, issued);
      } catch {
        throw new Error(
          "GitHub App private key cannot sign RS256 credentials.",
        );
      }

      const bearer = { Authorization: `Bearer ${jwt}` };
      const app = asObject(
        await this.#request(
          "/app",
          { method: "GET", headers: bearer },
          "GitHub App identity",
          [privateKeyText, jwt],
          200,
        ),
        "GitHub App identity",
      );
      if (String(app.id) !== appId || app.slug !== request.appSlug) {
        throw new Error("GitHub App identity does not match the declared app.");
      }
      const installation = asObject(
        await this.#request(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
          { method: "GET", headers: bearer },
          "GitHub App installation lookup",
          [jwt],
          200,
        ),
        "GitHub App installation lookup",
      );
      if (
        !Number.isSafeInteger(installation.id) ||
        Number(installation.id) < 1 ||
        installation.app_slug !== request.appSlug
      ) {
        throw new Error("GitHub App installation identity is invalid.");
      }
      const tokenResponse = asObject(
        await this.#request(
          `/app/installations/${String(installation.id)}/access_tokens`,
          {
            method: "POST",
            headers: { ...bearer, "Content-Type": "application/json" },
            body: JSON.stringify({ repositories: [name], permissions }),
          },
          "GitHub App installation token",
          [jwt],
          201,
        ),
        "GitHub App installation token",
      );
      if (
        typeof tokenResponse.token !== "string" ||
        tokenResponse.token.length < 20 ||
        tokenResponse.token.length > 1024 ||
        /[\u0000-\u0020\u007f]/u.test(tokenResponse.token)
      ) {
        throw new Error("GitHub App installation token is invalid.");
      }
      token = tokenResponse.token;
      const expiresAt =
        typeof tokenResponse.expires_at === "string"
          ? new Date(tokenResponse.expires_at)
          : new Date(Number.NaN);
      const ttl = expiresAt.getTime() - issued.getTime();
      if (
        !Number.isFinite(expiresAt.getTime()) ||
        ttl < request.minimumTtlMs ||
        ttl > this.#maxTtlMs
      ) {
        throw new Error(
          "GitHub App installation token TTL is outside the requested bounds.",
        );
      }
      const returnedPermissions = assertPlainPermissions(
        asObject(
          tokenResponse.permissions,
          "GitHub App installation token permissions",
        ) as Record<string, "read" | "write">,
        "GitHub App installation token permissions",
      );
      if (!samePermissions(returnedPermissions, permissions)) {
        throw new Error(
          "GitHub App installation token returned different permissions.",
        );
      }
      if (
        !Array.isArray(tokenResponse.repositories) ||
        tokenResponse.repositories.length !== 1
      ) {
        throw new Error(
          "GitHub App installation token is not limited to one repository.",
        );
      }
      const returnedRepository = asObject(
        tokenResponse.repositories[0],
        "GitHub App installation repository",
      );
      if (
        typeof returnedRepository.full_name !== "string" ||
        returnedRepository.full_name.toLowerCase() !==
          request.repository.toLowerCase()
      ) {
        throw new Error(
          "GitHub App installation token returned a different repository.",
        );
      }
      const id = this.#randomId();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(id))
        throw new Error("GitHub credential lease ID is invalid.");
      const lease = safeLease({
        kind: "github-app-installation",
        id,
        provider: `github-app:${request.appSlug}:${appId}`,
        token,
        issuedAt: issued.toISOString(),
        expiresAt: expiresAt.toISOString(),
        repository: request.repository,
        permissions: Object.freeze({ ...permissions }),
      });
      this.#issued.add(lease);
      return lease;
    } catch (error) {
      throw redactCredentialError(error, [appId, privateKeyText, jwt, token]);
    } finally {
      appId = "";
      privateKeyText = "";
      privateKey.fill(0);
      jwt = "";
      token = "";
    }
  }

  async revoke(lease: GitHubCredentialLease): Promise<void> {
    if (!this.#issued.has(lease))
      throw new Error(
        "GitHub credential lease was not issued by this provider.",
      );
    const token = lease.token;
    try {
      await this.#request(
        "/installation/token",
        { method: "DELETE", headers: { Authorization: `token ${token}` } },
        "GitHub App installation token revocation",
        [token],
        204,
      );
      this.#issued.delete(lease);
    } catch (error) {
      throw redactCredentialError(error, [token]);
    }
  }
}

export { GitHubAppInstallationCredentialProvider as GitHubAppCredentialProvider };
