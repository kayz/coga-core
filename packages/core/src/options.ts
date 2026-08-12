import { dirname, resolve } from "node:path";
import type {
  CogaOptions,
  LoadContext,
  LoadedCogaInstance,
  ResourceLimits,
  ValidationProfile,
} from "./types.js";

export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = {
  canonicalFileBytes: 1024 * 1024,
  contractFileBytes: 5 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 100_000,
  maxAliases: 50,
};

const profiles = new Set<ValidationProfile>(["local", "public", "release"]);

export function normalizeOptions(
  manifestPath: string,
  options: CogaOptions = {},
): LoadContext {
  const profile = options.profile ?? "local";
  if (!profiles.has(profile))
    throw new Error(`Unknown validation profile '${profile}'.`);
  const rootDir = resolve(options.rootDir ?? dirname(resolve(manifestPath)));
  const limits: ResourceLimits = {
    ...DEFAULT_RESOURCE_LIMITS,
    ...options.limits,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        `Resource limit '${name}' must be a positive safe integer.`,
      );
    }
  }
  return { profile, rootDir, limits };
}

function contextsEqual(left: LoadContext, right: LoadContext): boolean {
  return (
    left.profile === right.profile &&
    left.rootDir === right.rootDir &&
    Object.keys(left.limits).every(
      (key) =>
        left.limits[key as keyof ResourceLimits] ===
        right.limits[key as keyof ResourceLimits],
    )
  );
}

export function assertCompatibleOptions(
  loaded: LoadedCogaInstance,
  options: CogaOptions | undefined,
): void {
  if (!options) return;
  const requested = normalizeOptions(loaded.manifestPath, options);
  if (!contextsEqual(loaded.context, requested)) {
    throw new Error(
      "A loaded COGA instance cannot be reused with different validation options.",
    );
  }
}
