import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ProcessResult, Sha256Digest } from "./types.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_CANONICAL_BYTES = 1024 * 1024;

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(value: string | Buffer): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, normalizeCanonical(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(normalizeCanonical(value), null, 2)}\n`;
}

export function assertSha256(value: string, label: string): Sha256Digest {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase sha256 digest.`);
  }
  return value as Sha256Digest;
}

export function normalizeRelativePath(value: string, label = "path"): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`${label} must be a portable repository-relative path.`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.trim() !== segment,
    )
  ) {
    throw new Error(`${label} contains an empty, current, or parent segment.`);
  }
  return segments.join("/");
}

function within(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
}

export function resolveWithin(
  root: string,
  relativePath: string,
  label = "path",
): string {
  const normalized = normalizeRelativePath(relativePath, label);
  const absoluteRoot = realpathSync(resolve(root));
  const candidate = resolve(absoluteRoot, ...normalized.split("/"));
  if (!within(absoluteRoot, candidate)) {
    throw new Error(`${label} escapes the repository root.`);
  }

  let current = absoluteRoot;
  for (const segment of normalized.split("/")) {
    current = resolve(current, segment);
    try {
      const resolved = realpathSync(current);
      if (!within(absoluteRoot, resolved)) {
        throw new Error(
          `${label} traverses a link outside the repository root.`,
        );
      }
      current = resolved;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code !== "ENOENT") throw error;
    }
  }
  return candidate;
}

export function readBoundedFile(
  path: string,
  label: string,
  maxBytes = MAX_CANONICAL_BYTES,
): Buffer {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      `${label} must be a regular file, not a link or special file.`,
    );
  }
  if (info.size > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  const value = readFileSync(path);
  if (value.byteLength !== statSync(path).size) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return value;
}

export function verifyFileReference(
  repositoryRoot: string,
  reference: { path: string; digest: string },
  label: string,
  maxBytes = MAX_CANONICAL_BYTES,
): string {
  const path = resolveWithin(repositoryRoot, reference.path, `${label}.path`);
  const value = readBoundedFile(path, label, maxBytes);
  const expected = assertSha256(reference.digest, `${label}.digest`);
  const actual = sha256(value);
  if (actual !== expected) {
    throw new Error(
      `${label} digest mismatch: expected ${expected}, received ${actual}.`,
    );
  }
  return path;
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  return await new Promise<ProcessResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;

    const append = (
      target: Buffer[],
      chunk: Buffer,
      stream: "stdout" | "stderr",
    ) => {
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, maxOutputBytes - current);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;
      if (current + chunk.byteLength > maxOutputBytes) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("close", (code) => {
      clearTimeout(timer);
      const suffix = outputExceeded
        ? `\n[factory output exceeded ${maxOutputBytes} bytes]`
        : "";
      resolvePromise({
        exitCode: code ?? (timedOut || outputExceeded ? 137 : 1),
        stdout:
          Buffer.concat(stdout).toString("utf8") +
          (outputExceeded ? suffix : ""),
        stderr:
          Buffer.concat(stderr).toString("utf8") +
          (outputExceeded ? suffix : ""),
        timedOut,
      });
    });
  });
}

export async function runChecked(
  command: string,
  args: readonly string[],
  options: Parameters<typeof runProcess>[2],
  label: string,
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    throw new Error(`${label} failed with exit ${result.exitCode}: ${detail}`);
  }
  return result;
}

export function sanitizeIdentifier(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
  if (!/^[a-z0-9]/.test(result) || result.length > 100) {
    throw new Error(
      `Identifier '${value}' cannot be safely used by the factory.`,
    );
  }
  return result;
}
