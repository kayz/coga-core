import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const secretKeyName =
  /(?:api[-_]?key|access[-_]?token|auth[-_]?token|password|passwd|private[-_]?key|client[-_]?secret|credential)/iu;
const literalSecret = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/u,
  /\b(?:ghp|github_pat|glpat)-[A-Za-z0-9_-]{12,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/iu,
] as const;

export function assertSafeId(id: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(id)) {
    throw new Error(`Unsafe identifier '${id}'.`);
  }
}

export function assertRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path) ||
    path.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new Error(
      `Path must stay relative to its declared workspace: '${path}'.`,
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return (
    local === "" ||
    (!local.startsWith(`..${sep}`) && local !== ".." && !isAbsolute(local))
  );
}

function nearestExisting(path: string): string {
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    cursor = parent;
  }
  return cursor;
}

export function resolveWithin(root: string, path: string): string {
  assertRelativePath(path);
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, path);
  if (!isWithin(absoluteRoot, candidate)) {
    throw new Error(`Resolved path escapes its workspace: '${path}'.`);
  }

  const existingRoot = realpathSync.native(nearestExisting(absoluteRoot));
  const existingCandidate = realpathSync.native(nearestExisting(candidate));
  if (!isWithin(existingRoot, existingCandidate)) {
    throw new Error(
      `Resolved path crosses a symbolic link outside its workspace: '${path}'.`,
    );
  }

  if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) {
    const target = realpathSync.native(candidate);
    if (!isWithin(existingRoot, target)) {
      throw new Error(`Symbolic link escapes its workspace: '${path}'.`);
    }
  }
  return candidate;
}

export function assertDirectory(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`Expected directory '${path}'.`);
  }
}

export function assertNoLiteralSecrets(value: unknown, pointer = "$"): void {
  if (typeof value === "string") {
    if (literalSecret.some((pattern) => pattern.test(value))) {
      throw new Error(`Literal secret-like value is forbidden at ${pointer}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoLiteralSecrets(entry, `${pointer}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      secretKeyName.test(key) &&
      typeof entry === "string" &&
      !entry.startsWith("env://") &&
      !/^\[?redacted\]?$/iu.test(entry) &&
      entry.length > 0
    ) {
      throw new Error(
        `Secret field '${key}' must use an env:// reference at ${pointer}.`,
      );
    }
    assertNoLiteralSecrets(entry, `${pointer}.${key}`);
  }
}

export function redactText(value: string): string {
  let result = value;
  for (const pattern of literalSecret)
    result = result.replace(pattern, "[REDACTED]");
  result = result.replace(
    /((?:api[-_]?key|access[-_]?token|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
    "$1[REDACTED]",
  );
  return result;
}

export function safeEnvironment(
  allowlist: readonly string[],
): NodeJS.ProcessEnv {
  const safeNames = new Set([
    "PATH",
    "Path",
    "SYSTEMROOT",
    "SystemRoot",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "CI",
    ...allowlist,
  ]);
  const result: NodeJS.ProcessEnv = { CI: "true", COGA_FACTORY: "1" };
  for (const [name, value] of Object.entries(process.env)) {
    if (safeNames.has(name) && value !== undefined) result[name] = value;
  }
  return result;
}

export function readEnvironmentSecret(reference: string): string {
  const match = /^env:\/\/([A-Z][A-Z0-9_]*)$/u.exec(reference);
  if (!match?.[1])
    throw new Error("Provider credentials must use env://NAME references.");
  const value = process.env[match[1]];
  if (!value)
    throw new Error(
      `Required provider credential '${match[1]}' is not available.`,
    );
  return value;
}
