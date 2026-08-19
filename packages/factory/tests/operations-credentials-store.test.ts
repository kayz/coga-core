import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { inspect } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedEnvironmentSecretSource,
  GITHUB_APP_PERMISSION_POLICY,
  GitHubAppInstallationCredentialProvider,
} from "../src/credentials.js";
import {
  FileSystemImmutableEvidenceStore,
  evidenceArchiveReceiptPath,
} from "../src/evidence-store.js";
import type { GitHubCredentialRequest } from "../src/operations-types.js";

const temporaryDirectories: string[] = [];
function temporary(): string {
  const result = mkdtempSync(join(tmpdir(), "coga-operations-test-"));
  temporaryDirectories.push(result);
  return result;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function jsonResponse(value: unknown, status: number, url: string): Response {
  const response = new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

const now = new Date("2026-08-13T00:00:00.000Z");
const token = `ghs_${"x".repeat(48)}`;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function credentialRequest(): GitHubCredentialRequest {
  return {
    purpose: "draft-delivery",
    repository: "kayz/coga-core",
    appSlug: "coga-factory",
    permissions: GITHUB_APP_PERMISSION_POLICY["draft-delivery"],
    minimumTtlMs: 30 * 60 * 1000,
  };
}

function provider(parameters?: {
  tokenResponse?: Record<string, unknown>;
  fetchFailure?: Error;
  revokeFailure?: Error;
  calls?: Array<{ url: string; init: RequestInit }>;
}) {
  const secrets = new Map([
    ["APP_ID", "42"],
    ["PRIVATE_KEY", privateKeyPem],
  ]);
  const source = { read: async (name: string) => secrets.get(name) ?? "" };
  const calls = parameters?.calls ?? [];
  const fetch = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/installation/token") && parameters?.revokeFailure) {
      throw parameters.revokeFailure;
    }
    if (parameters?.fetchFailure) throw parameters.fetchFailure;
    if (url.endsWith("/app")) {
      return jsonResponse({ id: 42, slug: "coga-factory" }, 200, url);
    }
    if (url.endsWith("/installation")) {
      return jsonResponse({ id: 99, app_slug: "coga-factory" }, 200, url);
    }
    if (url.endsWith("/access_tokens")) {
      return jsonResponse(
        parameters?.tokenResponse ?? {
          token,
          expires_at: "2026-08-13T01:00:00.000Z",
          permissions: GITHUB_APP_PERMISSION_POLICY["draft-delivery"],
          repositories: [{ full_name: "kayz/coga-core" }],
        },
        201,
        url,
      );
    }
    return new Response(null, { status: 204 });
  };
  return {
    source,
    calls,
    instance: new GitHubAppInstallationCredentialProvider({
      secretSource: source,
      appIdSecretName: "APP_ID",
      privateKeySecretName: "PRIVATE_KEY",
      fetch,
      now: () => new Date(now),
      randomId: () => "lease-1",
    }),
  };
}

describe("bounded GitHub App credential broker", () => {
  it("reads only allowlisted bounded environment values without mutation", async () => {
    const environment = Object.freeze({ APP_ID: "42", OTHER: "hidden" });
    const source = new BoundedEnvironmentSecretSource({
      allowedNames: ["APP_ID"],
      environment,
      maxSecretBytes: 8,
    });
    await expect(source.read("APP_ID")).resolves.toBe("42");
    await expect(source.read("OTHER")).rejects.toThrow(/outside/iu);
    expect(environment).toEqual({ APP_ID: "42", OTHER: "hidden" });
  });

  it("signs an RS256 JWT, scopes an exact repository and permissions, then revokes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const broker = provider({ calls });
    const lease = await broker.instance.acquire(credentialRequest());
    expect(lease.repository).toBe("kayz/coga-core");
    expect(lease.token).toBe(token);
    expect(JSON.stringify(lease)).not.toContain(token);
    expect(inspect(lease)).not.toContain(token);
    const jwt = String(
      (calls[0]?.init.headers as Record<string, string>).Authorization,
    ).slice(7);
    const [header, payload] = jwt
      .split(".")
      .slice(0, 2)
      .map((part) =>
        JSON.parse(Buffer.from(part!, "base64url").toString("utf8")),
      );
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toMatchObject({ iss: "42" });
    expect(payload.exp - payload.iat).toBe(600);
    const tokenBody = JSON.parse(String(calls[2]?.init.body));
    expect(tokenBody).toEqual({
      repositories: ["coga-core"],
      permissions: GITHUB_APP_PERMISSION_POLICY["draft-delivery"],
    });
    await broker.instance.revoke(lease);
    expect(calls.at(-1)?.url).toBe("https://api.github.com/installation/token");
    expect(
      (calls.at(-1)?.init.headers as Record<string, string>).Authorization,
    ).toBe(`token ${token}`);
    await expect(broker.instance.revoke(lease)).rejects.toThrow(/not issued/iu);
  });

  it("bounds GitHub credential network requests", async () => {
    const base = provider();
    const hangingFetch: typeof fetch = async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    const bounded = new GitHubAppInstallationCredentialProvider({
      secretSource: base.source,
      appIdSecretName: "APP_ID",
      privateKeySecretName: "PRIVATE_KEY",
      fetch: hangingFetch,
      now: () => new Date(now),
      requestTimeoutMs: 10,
    });
    await expect(bounded.acquire(credentialRequest())).rejects.toThrow(
      /abort|timeout/iu,
    );
  });

  it("rejects expanded permissions, another repository, short TTL, and forged leases", async () => {
    const broker = provider();
    await expect(
      broker.instance.acquire({
        ...credentialRequest(),
        permissions: {
          contents: "write",
          pull_requests: "write",
          administration: "write",
        },
      }),
    ).rejects.toThrow(/exact minimal policy/iu);
    await expect(
      provider({
        tokenResponse: {
          token,
          expires_at: "2026-08-13T00:10:00.000Z",
          permissions: GITHUB_APP_PERMISSION_POLICY["draft-delivery"],
          repositories: [{ full_name: "kayz/coga-core" }],
        },
      }).instance.acquire(credentialRequest()),
    ).rejects.toThrow(/TTL/iu);
    await expect(
      provider({
        tokenResponse: {
          token,
          expires_at: "2026-08-13T01:00:00.000Z",
          permissions: GITHUB_APP_PERMISSION_POLICY["draft-delivery"],
          repositories: [{ full_name: "attacker/other" }],
        },
      }).instance.acquire(credentialRequest()),
    ).rejects.toThrow(/different repository/iu);
    await expect(
      broker.instance.revoke({
        kind: "github-app-installation",
        id: "forged",
        provider: "forged",
        token,
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        repository: "kayz/coga-core",
        permissions: {},
      }),
    ).rejects.toThrow(/not issued/iu);
  });

  it("redacts raw, URL encoded, base64 and base64url credentials from revocation failures", async () => {
    for (const leaked of [
      token,
      encodeURIComponent(token),
      Buffer.from(token).toString("base64"),
      Buffer.from(token).toString("base64url"),
    ]) {
      const failing = provider({
        revokeFailure: new Error(`upstream leaked ${leaked}`),
      });
      const lease = await failing.instance.acquire(credentialRequest());
      const message = await failing.instance
        .revoke(lease)
        .catch((error: unknown) =>
          error instanceof Error ? error.message : String(error),
        );
      expect(message).not.toContain(token);
      expect(message).not.toContain(leaked);
    }
  });
});

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonical(value: unknown): string {
  const normalize = (child: unknown): unknown => {
    if (Array.isArray(child)) return child.map(normalize);
    if (child && typeof child === "object") {
      return Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return child;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function evidence(
  kind: "EvidenceBundle" | "RemoteEvidence" | "PlatformEvidence",
) {
  const field =
    kind === "EvidenceBundle"
      ? "bundleDigest"
      : kind === "RemoteEvidence"
        ? "remoteEvidenceDigest"
        : "evidenceDigest";
  const document = {
    schemaVersion: "coga.dev/factory/operations/v0.1",
    kind,
    metadata: {
      generatedAt: now.toISOString(),
      [field]: `sha256:${"0".repeat(64)}`,
    },
    subject: { id: "candidate" },
  };
  const { [field]: _ignored, ...metadata } = document.metadata;
  document.metadata[field] = sha256(canonical({ ...document, metadata }));
  return document;
}

function storeFixture(
  kind:
    | "EvidenceBundle"
    | "RemoteEvidence"
    | "PlatformEvidence" = "EvidenceBundle",
) {
  const root = temporary();
  const sources = join(root, "sources");
  const archive = join(root, "archive");
  mkdirSync(sources);
  const document = evidence(kind);
  const raw = Buffer.from(JSON.stringify(document), "utf8");
  const sourcePath = join(sources, "evidence.json");
  writeFileSync(sourcePath, raw);
  const store = new FileSystemImmutableEvidenceStore({
    root: archive,
    sourceRoot: sources,
    now: () => new Date(now),
  });
  return { root, sources, archive, sourcePath, raw, document, store };
}

describe("immutable evidence store", () => {
  it.each(["EvidenceBundle", "RemoteEvidence", "PlatformEvidence"] as const)(
    "archives and verifies byte-preserving %s evidence idempotently",
    (kind) => {
      const fixture = storeFixture(kind);
      const request = {
        path: "evidence.json",
        kind,
        retentionPolicy: "factory-release-7y",
        retainUntil: "2033-08-13T00:00:00.000Z",
      } as const;
      const first = fixture.store.archive(request);
      const second = fixture.store.archive(request);
      expect(second).toEqual(first);
      expect(first.subject.byteDigest).toBe(sha256(fixture.raw));
      expect(first.subject.logicalDigest).toBe(
        Object.values(fixture.document.metadata).find((value) =>
          String(value).startsWith("sha256:"),
        ),
      );
      const object = readFileSync(
        join(fixture.archive, ...first.subject.objectPath.split("/")),
      );
      expect(object.equals(fixture.raw)).toBe(true);
      expect(fixture.store.verify(evidenceArchiveReceiptPath(first))).toEqual(
        first,
      );
    },
  );

  it("rejects source traversal, source links, oversized and overdeep JSON", () => {
    const fixture = storeFixture();
    expect(() =>
      fixture.store.archive({
        path: "../outside.json",
        retentionPolicy: "policy",
        retainUntil: "2033-08-13T00:00:00.000Z",
      }),
    ).toThrow(/escapes/iu);
    const link = join(fixture.sources, "link.json");
    try {
      symlinkSync(fixture.sourcePath, link, "file");
      expect(() =>
        fixture.store.archive({
          path: "link.json",
          retentionPolicy: "policy",
          retainUntil: "2033-08-13T00:00:00.000Z",
        }),
      ).toThrow(/link/iu);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("EPERM");
    }
    const overdeep = join(fixture.sources, "deep.json");
    writeFileSync(overdeep, `${"[".repeat(70)}0${"]".repeat(70)}`);
    expect(() =>
      fixture.store.archive({
        path: "deep.json",
        retentionPolicy: "policy",
        retainUntil: "2033-08-13T00:00:00.000Z",
      }),
    ).toThrow(/depth/iu);
    const smallStore = new FileSystemImmutableEvidenceStore({
      root: join(fixture.root, "small"),
      sourceRoot: fixture.sources,
      maxEvidenceBytes: 10,
    });
    expect(() =>
      smallStore.archive({
        path: "evidence.json",
        retentionPolicy: "policy",
        retainUntil: "2033-08-13T00:00:00.000Z",
      }),
    ).toThrow(/byte limit/iu);
  });

  it("detects object and receipt tampering and content-address collisions", () => {
    const fixture = storeFixture();
    const receipt = fixture.store.archive({
      path: "evidence.json",
      retentionPolicy: "policy",
      retainUntil: "2033-08-13T00:00:00.000Z",
    });
    const objectPath = join(
      fixture.archive,
      ...receipt.subject.objectPath.split("/"),
    );
    chmodSync(objectPath, 0o644);
    writeFileSync(objectPath, "tampered");
    expect(() =>
      fixture.store.verify(evidenceArchiveReceiptPath(receipt)),
    ).toThrow(/byte integrity/iu);

    const second = storeFixture();
    const secondReceipt = second.store.archive({
      path: "evidence.json",
      retentionPolicy: "policy",
      retainUntil: "2033-08-13T00:00:00.000Z",
    });
    const receiptPath = join(
      second.archive,
      ...evidenceArchiveReceiptPath(secondReceipt).split("/"),
    );
    chmodSync(receiptPath, 0o644);
    writeFileSync(receiptPath, "{}");
    expect(() =>
      second.store.verify(evidenceArchiveReceiptPath(secondReceipt)),
    ).toThrow();

    const third = storeFixture();
    const byteDigest = sha256(third.raw).slice("sha256:".length);
    writeFileSync(
      join(third.archive, "objects", "sha256", `${byteDigest}.bin`),
      "collision",
    );
    expect(() =>
      third.store.archive({
        path: "evidence.json",
        retentionPolicy: "policy",
        retainUntil: "2033-08-13T00:00:00.000Z",
      }),
    ).toThrow(/collision/iu);
  });

  it("rejects an incorrect declared logical digest and expired retention", () => {
    const fixture = storeFixture();
    const document = JSON.parse(readFileSync(fixture.sourcePath, "utf8"));
    document.metadata.bundleDigest = `sha256:${"f".repeat(64)}`;
    writeFileSync(fixture.sourcePath, JSON.stringify(document));
    expect(() =>
      fixture.store.archive({
        path: "evidence.json",
        retentionPolicy: "policy",
        retainUntil: "2033-08-13T00:00:00.000Z",
      }),
    ).toThrow(/logical digest mismatch/iu);
    expect(() =>
      fixture.store.archive({
        path: "evidence.json",
        retentionPolicy: "policy",
        retainUntil: "2026-08-12T00:00:00.000Z",
      }),
    ).toThrow(/after archive/iu);
  });
});
