import { createHash } from "node:crypto";
import type { Digest } from "./types.js";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = normalize(child);
    }
    return result;
  }
  return value;
}

/** Deterministic JSON serialization: object keys sort recursively; array order remains semantic. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: unknown): Digest {
  const input =
    value instanceof Uint8Array || typeof value === "string"
      ? value
      : canonicalJson(value);
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as Digest;
