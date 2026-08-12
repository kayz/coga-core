#!/usr/bin/env node

import { catalog, renderCatalogMarkdown } from "./catalog.js";
import { impact } from "./impact.js";
import { validate } from "./validation.js";
import type {
  CogaOptions,
  ExactReference,
  ValidationProfile,
} from "./types.js";

const usage = `Usage:
  coga validate <instance-manifest> [--profile local|public|release] [--root <directory>]
  coga catalog <instance-manifest> [--format json|markdown] [--profile local|public|release] [--root <directory>]
  coga impact <instance-manifest> <artifact-id>@<version> [--profile local|public|release] [--root <directory>]`;

interface ParsedArguments {
  positionals: string[];
  options: CogaOptions;
  format: "json" | "markdown";
}

function printIssues(result: ReturnType<typeof validate>): void {
  for (const issue of result.issues) {
    const resource = issue.resourceId ? ` (${issue.resourceId})` : "";
    process.stderr.write(
      `${issue.severity.toUpperCase()} ${issue.code}${resource}: ${issue.message}\n  ${issue.path}\n`,
    );
  }
}

function parseProfile(value: string | undefined): ValidationProfile {
  if (value === "local" || value === "public" || value === "release") {
    return value;
  }
  throw new Error(`Unsupported validation profile '${value ?? ""}'.`);
}

function parseArguments(args: string[], allowFormat: boolean): ParsedArguments {
  const positionals: string[] = [];
  const options: CogaOptions = {};
  let format: "json" | "markdown" = "markdown";
  let profileSeen = false;
  let rootSeen = false;
  let formatSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--profile") {
      if (profileSeen) throw new Error("--profile may be supplied only once.");
      options.profile = parseProfile(args[index + 1]);
      profileSeen = true;
      index += 1;
      continue;
    }
    if (value === "--root") {
      if (rootSeen) throw new Error("--root may be supplied only once.");
      const rootDir = args[index + 1];
      if (!rootDir || rootDir.startsWith("--")) {
        throw new Error("--root requires a directory.");
      }
      options.rootDir = rootDir;
      rootSeen = true;
      index += 1;
      continue;
    }
    if (value === "--format") {
      if (!allowFormat) throw new Error("--format is valid only for catalog.");
      if (formatSeen) throw new Error("--format may be supplied only once.");
      const requested = args[index + 1];
      if (requested !== "json" && requested !== "markdown") {
        throw new Error(`Unsupported catalog format '${requested ?? ""}'.`);
      }
      format = requested;
      formatSeen = true;
      index += 1;
      continue;
    }
    if (value?.startsWith("--")) {
      throw new Error(`Unknown option '${value}'.`);
    }
    if (value) positionals.push(value);
  }

  return { positionals, options, format };
}

function parseArtifactReference(value: string): ExactReference {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("impact artifact must use '<artifact-id>@<version>'.");
  }
  return {
    id: value.slice(0, separator),
    version: value.slice(separator + 1),
  };
}

function requireValid(manifest: string, options: CogaOptions) {
  const result = validate(manifest, options);
  if (!result.valid) {
    printIssues(result);
    process.exitCode = 1;
    return undefined;
  }
  return result.loaded;
}

function main(args: string[]): void {
  const [command, ...commandArgs] = args;
  if (!command) {
    process.stderr.write(`${usage}\n`);
    process.exitCode = 2;
    return;
  }

  if (command === "validate") {
    const parsed = parseArguments(commandArgs, false);
    if (parsed.positionals.length !== 1) {
      throw new Error(
        `validate requires exactly one instance manifest.\n${usage}`,
      );
    }
    const manifest = parsed.positionals[0];
    if (!manifest) throw new Error("validate requires an instance manifest.");
    const result = validate(manifest, parsed.options);
    if (!result.valid) {
      printIssues(result);
      process.exitCode = 1;
      return;
    }
    const document = result.loaded.instance.document;
    const id =
      document &&
      typeof document === "object" &&
      "metadata" in document &&
      document.metadata &&
      typeof document.metadata === "object" &&
      "id" in document.metadata
        ? String(document.metadata.id)
        : manifest;
    process.stdout.write(`Valid COGA instance: ${id}\n`);
    return;
  }

  if (command === "catalog") {
    const parsed = parseArguments(commandArgs, true);
    if (parsed.positionals.length !== 1) {
      throw new Error(
        `catalog requires exactly one instance manifest.\n${usage}`,
      );
    }
    const manifest = parsed.positionals[0];
    if (!manifest) throw new Error("catalog requires an instance manifest.");
    const loaded = requireValid(manifest, parsed.options);
    if (!loaded) return;
    const result = catalog(loaded);
    process.stdout.write(
      parsed.format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderCatalogMarkdown(result),
    );
    return;
  }

  if (command === "impact") {
    const parsed = parseArguments(commandArgs, false);
    if (parsed.positionals.length !== 2) {
      throw new Error(
        `impact requires an instance manifest and one exact artifact reference.\n${usage}`,
      );
    }
    const [manifest, artifactValue] = parsed.positionals;
    if (!manifest || !artifactValue) {
      throw new Error(
        "impact requires an instance manifest and artifact reference.",
      );
    }
    const loaded = requireValid(manifest, parsed.options);
    if (!loaded) return;
    const result = impact(loaded, parseArtifactReference(artifactValue));
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
