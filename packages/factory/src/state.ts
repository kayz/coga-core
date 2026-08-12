import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FactoryRunState, Sha256Digest } from "./types.js";
import { canonicalJson, sanitizeIdentifier } from "./utils.js";

export function runStatePath(
  stateRoot: string,
  workOrderId: string,
  digest: Sha256Digest,
): string {
  const name = `${sanitizeIdentifier(workOrderId)}-${digest.slice("sha256:".length, "sha256:".length + 12)}`;
  return resolve(stateRoot, name, "state.json");
}

export function loadRunState(path: string): FactoryRunState | undefined {
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as FactoryRunState;
    if (document.schemaVersion !== "coga.dev/factory/v0.1") {
      throw new Error("Factory state uses an unsupported schemaVersion.");
    }
    return document;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export function saveRunState(path: string, state: FactoryRunState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, canonicalJson(state), {
    encoding: "utf8",
    flag: "w",
  });
  renameSync(temporary, path);
}
