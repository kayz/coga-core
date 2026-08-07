#!/usr/bin/env node

import { catalog, renderCatalogMarkdown } from "./catalog.js";
import { impact } from "./impact.js";
import { load } from "./loader.js";
import { validate } from "./validation.js";

const usage = `Usage:
  coga validate <instance-manifest>
  coga catalog <instance-manifest> [--format json|markdown]
  coga impact <instance-manifest> <artifact-id>`;

function printIssues(result: ReturnType<typeof validate>): void {
  for (const issue of result.issues) {
    const resource = issue.resourceId ? ` (${issue.resourceId})` : "";
    process.stderr.write(
      `${issue.severity.toUpperCase()} ${issue.code}${resource}: ${issue.message}\n  ${issue.path}\n`,
    );
  }
}

function parseCatalogFormat(args: string[]): "json" | "markdown" {
  if (args.length === 0) return "markdown";
  if (args.length !== 2 || args[0] !== "--format") {
    throw new Error(
      "catalog accepts only '--format json' or '--format markdown'.",
    );
  }
  if (args[1] !== "json" && args[1] !== "markdown") {
    throw new Error(`Unsupported catalog format '${args[1] ?? ""}'.`);
  }
  return args[1];
}

function requireValid(manifest: string) {
  const loaded = load(manifest);
  const result = validate(loaded);
  if (!result.valid) {
    printIssues(result);
    process.exitCode = 1;
    return undefined;
  }
  return loaded;
}

function main(args: string[]): void {
  const [command, manifest, ...rest] = args;
  if (!command || !manifest) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }

  if (command === "validate") {
    if (rest.length > 0)
      throw new Error("validate does not accept additional arguments.");
    const result = validate(manifest);
    if (!result.valid) {
      printIssues(result);
      process.exitCode = 1;
      return;
    }
    const id =
      result.loaded.instance.document &&
      typeof result.loaded.instance.document === "object" &&
      "metadata" in result.loaded.instance.document &&
      result.loaded.instance.document.metadata &&
      typeof result.loaded.instance.document.metadata === "object" &&
      "id" in result.loaded.instance.document.metadata
        ? String(result.loaded.instance.document.metadata.id)
        : manifest;
    process.stdout.write(`Valid COGA instance: ${id}\n`);
    return;
  }

  if (command === "catalog") {
    const format = parseCatalogFormat(rest);
    const loaded = requireValid(manifest);
    if (!loaded) return;
    const result = catalog(loaded);
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderCatalogMarkdown(result),
    );
    return;
  }

  if (command === "impact") {
    if (rest.length !== 1 || !rest[0]) {
      throw new Error("impact requires exactly one artifact ID.");
    }
    const loaded = requireValid(manifest);
    if (!loaded) return;
    const result = impact(loaded, rest[0]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.found) process.exitCode = 1;
    return;
  }

  throw new Error(`Unknown command '${command}'.\n${usage}`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
}
