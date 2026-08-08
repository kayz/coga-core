import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parse } from "yaml";

import { assertNoLiteralSecrets, resolveWithin } from "./security.js";
import type {
  ApplicationRecipe,
  FactoryProfile,
  LoadedFactoryProfile,
} from "./types.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function schema(name: string): object {
  const path = fileURLToPath(new URL(`../schemas/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as object;
}

const validateProfile = ajv.compile(schema("factory-profile.schema.json"));
const validateRecipe = ajv.compile(schema("application-recipe.schema.json"));

function explain(validator: ValidateFunction): string {
  return (validator.errors ?? [])
    .map(
      (entry) =>
        `${entry.instancePath || "/"} ${entry.message ?? "is invalid"}`,
    )
    .join("; ");
}

function parseDocument(path: string): unknown {
  const source = readFileSync(path, "utf8");
  return /\.json$/iu.test(path)
    ? (JSON.parse(source) as unknown)
    : parse(source);
}

function assertUniqueAdapters(profile: FactoryProfile): void {
  const seen = new Set<string>();
  for (const adapter of profile.spec.adapters) {
    const key = `${adapter.ref.kind}:${adapter.ref.id}@${adapter.ref.version}`;
    if (seen.has(key))
      throw new Error(`Duplicate adapter descriptor '${key}'.`);
    seen.add(key);
    if (!adapter.actions.length)
      throw new Error(`Adapter '${key}' declares no actions.`);
    if (adapter.runtime === "process") {
      if (!adapter.config?.executable || !adapter.config.cwd) {
        throw new Error(
          `Process adapter '${key}' requires executable and cwd.`,
        );
      }
      if (/[;&|<>`\r\n]/u.test(adapter.config.executable)) {
        throw new Error(
          `Process adapter '${key}' executable is not a plain program name.`,
        );
      }
    }
    if (adapter.runtime === "deepseek") {
      if (
        !adapter.config?.secretRef ||
        !adapter.config.model ||
        !adapter.config.baseUrl
      ) {
        throw new Error(
          `DeepSeek adapter '${key}' requires secretRef, model, and baseUrl.`,
        );
      }
      if (adapter.config.allowRestrictedInput !== false) {
        throw new Error(
          `DeepSeek adapter '${key}' must deny restricted input.`,
        );
      }
    }
  }
}

export function loadFactoryProfile(path: string): LoadedFactoryProfile {
  const absolute = resolve(path);
  const document = parseDocument(absolute);
  assertNoLiteralSecrets(document);
  if (!validateProfile(document)) {
    throw new Error(
      `Invalid FactoryProfile '${absolute}': ${explain(validateProfile)}`,
    );
  }
  const profile = document as FactoryProfile;
  assertUniqueAdapters(profile);
  const profileRoot = dirname(absolute);
  const root =
    profile.spec.workspaceRoot === ".."
      ? resolve(profileRoot, "..")
      : profileRoot;
  resolveWithin(root, profile.spec.instanceManifest);
  resolveWithin(root, profile.spec.stateDirectory);
  resolveWithin(root, profile.spec.candidateDirectory);
  for (const binding of profile.spec.applicationBindings ?? [])
    resolveWithin(root, binding);
  for (const evaluation of profile.spec.evaluationProfiles ?? [])
    resolveWithin(root, evaluation);
  for (const recipe of profile.spec.recipes ?? []) resolveWithin(root, recipe);
  return { path: absolute, root, document: profile };
}

export function loadApplicationRecipe(path: string): ApplicationRecipe {
  const absolute = resolve(path);
  const document = parseDocument(absolute);
  assertNoLiteralSecrets(document);
  if (!validateRecipe(document)) {
    throw new Error(
      `Invalid ApplicationRecipe '${absolute}': ${explain(validateRecipe)}`,
    );
  }
  return document as ApplicationRecipe;
}

export function adapterKey(value: {
  kind: string;
  id: string;
  version: string;
}): string {
  return `${value.kind}:${value.id}@${value.version}`;
}
