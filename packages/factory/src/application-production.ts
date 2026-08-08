import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { digestFile, digestJson } from "./canonical.js";
import { loadApplicationRecipe } from "./profile.js";
import { assertRelativePath, resolveWithin } from "./security.js";
import type { ApplicationRecipe } from "./types.js";

export interface ProductionResult {
  recipe: { id: string; version: string; digest: string };
  deliveryTarget: string;
  outputRoot: string;
  harnessDependencies: Array<{ id: string; version: string }>;
  files: Array<{ path: string; digest: string; bytes: number }>;
  validators: Array<{ id: string; version: string }>;
  bundleDigest: string;
}

function templateFiles(root: string, cursor = root): string[] {
  return readdirSync(cursor, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(cursor, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `Application template may not contain symbolic links: '${path}'.`,
        );
      if (entry.isDirectory()) return templateFiles(root, path);
      if (!entry.isFile())
        throw new Error(`Unsupported application template entry: '${path}'.`);
      return [relative(root, path).replaceAll("\\", "/")];
    });
}

function resolvedParameters(
  recipe: ApplicationRecipe,
  supplied: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(recipe.spec.parameters.map((entry) => entry.name));
  for (const name of Object.keys(supplied)) {
    if (!allowed.has(name))
      throw new Error(`Unknown recipe parameter '${name}'.`);
  }
  const result: Record<string, string> = {};
  for (const parameter of recipe.spec.parameters) {
    const value = supplied[parameter.name] ?? parameter.default;
    if (value === undefined) {
      if (parameter.required)
        throw new Error(`Missing recipe parameter '${parameter.name}'.`);
      continue;
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(`^(?:${parameter.pattern})$`, "u");
    } catch {
      throw new Error(
        `Recipe parameter '${parameter.name}' has an invalid pattern.`,
      );
    }
    if (!pattern.test(value))
      throw new Error(`Recipe parameter '${parameter.name}' is invalid.`);
    result[parameter.name] = value;
  }
  return result;
}

function substitute(
  source: string,
  parameters: Record<string, string>,
  path: string,
): string {
  const output = source.replace(
    /\{\{([a-z][A-Za-z0-9]*)\}\}/gu,
    (_, name: string) => {
      const value = parameters[name];
      if (value === undefined)
        throw new Error(
          `Template '${path}' references missing parameter '${name}'.`,
        );
      return value;
    },
  );
  const unresolved = /\{\{[a-z][A-Za-z0-9]*\}\}/u.exec(output);
  if (unresolved)
    throw new Error(
      `Template '${path}' contains unresolved token '${unresolved[0]}'.`,
    );
  return output;
}

function assertFreshOutput(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink())
    throw new Error("Application output may not be a symbolic link.");
  if (!statSync(path).isDirectory() || readdirSync(path).length > 0) {
    throw new Error(
      `Application output '${path}' must not exist or must be empty.`,
    );
  }
}

export function produceApplication(input: {
  recipePath: string;
  outputRoot: string;
  parameters: Record<string, string>;
  allowedOutputRoot: string;
}): ProductionResult {
  const recipePath = resolve(input.recipePath);
  const recipe = loadApplicationRecipe(recipePath);
  const recipeRoot = dirname(recipePath);
  const templateRoot = resolveWithin(recipeRoot, recipe.spec.templateRoot);
  if (!existsSync(templateRoot) || !statSync(templateRoot).isDirectory()) {
    throw new Error(
      `Application template root does not exist: '${templateRoot}'.`,
    );
  }

  const relativeOutput = relative(
    resolve(input.allowedOutputRoot),
    resolve(input.outputRoot),
  ).replaceAll("\\", "/");
  assertRelativePath(relativeOutput || ".");
  const outputRoot = resolveWithin(
    input.allowedOutputRoot,
    relativeOutput || ".",
  );
  assertFreshOutput(outputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const parameters = resolvedParameters(recipe, input.parameters);
  const files = templateFiles(templateRoot);
  const declared = new Set(recipe.spec.outputs);
  for (const path of files) {
    if (!declared.has(path))
      throw new Error(`Template emits undeclared output '${path}'.`);
  }
  for (const path of declared) {
    if (!files.includes(path))
      throw new Error(`Recipe declares missing template output '${path}'.`);
  }

  for (const path of files) {
    const sourcePath = resolveWithin(templateRoot, path);
    const outputPath = resolveWithin(outputRoot, path);
    mkdirSync(dirname(outputPath), { recursive: true });
    const source = readFileSync(sourcePath);
    if (source.includes(0))
      throw new Error(`Binary templates are not supported: '${path}'.`);
    writeFileSync(
      outputPath,
      substitute(source.toString("utf8"), parameters, path),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
  }

  const emitted = files.map((path) => {
    const absolute = resolveWithin(outputRoot, path);
    return {
      path,
      digest: digestFile(absolute),
      bytes: statSync(absolute).size,
    };
  });
  const summary = {
    recipe: {
      id: recipe.metadata.id,
      version: recipe.metadata.version,
      digest: digestFile(recipePath),
    },
    deliveryTarget: recipe.spec.deliveryTarget,
    harnessDependencies: recipe.spec.harnessDependencies,
    files: emitted,
    validators: recipe.spec.validators,
  };
  return {
    ...summary,
    outputRoot,
    bundleDigest: digestJson(summary),
  };
}
