#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { produceApplication } from "./application-production.js";
import { formatJson } from "./canonical.js";
import { loadFactoryProfile } from "./profile.js";
import { FactoryService, type IntentInput } from "./service.js";
import type { Actor } from "./types.js";

const usage = `Usage:
  coga-factory profile validate <profile>
  coga-factory snapshot <profile> [--state <directory>] [--binding <path> ...]
  coga-factory intent create <profile> <intent.json> [--state <directory>]
  coga-factory task assess <profile> <task-id> [--offline|--deepseek] [--state <directory>]
  coga-factory task validate <profile> <task-id> [--state <directory>]
  coga-factory task approve <profile> <task-id> <approval.json> [--state <directory>]
  coga-factory task preview <profile> <task-id> [--state <directory>]
  coga-factory audit verify <profile> [--state <directory>]
  coga-factory application produce <recipe> <output> <parameters.json> --allowed-root <directory>`;

interface CommonOptions {
  values: string[];
  stateDirectory?: string;
  bindings: string[];
}

function parseCommon(args: string[]): CommonOptions {
  const values: string[] = [];
  const bindings: string[] = [];
  let stateDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--state") {
      const next = args[index + 1];
      if (!next) throw new Error("--state requires a directory.");
      stateDirectory = resolve(next);
      index += 1;
    } else if (value === "--binding") {
      const next = args[index + 1];
      if (!next) throw new Error("--binding requires a path.");
      bindings.push(resolve(next));
      index += 1;
    } else if (value) values.push(value);
  }
  return { values, ...(stateDirectory ? { stateDirectory } : {}), bindings };
}

function service(profilePath: string, options: CommonOptions): FactoryService {
  return new FactoryService({
    profilePath,
    ...(options.stateDirectory
      ? { stateDirectory: options.stateDirectory }
      : {}),
    ...(options.bindings.length ? { extraBindingPaths: options.bindings } : {}),
  });
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as T;
}

function actor(value: unknown): Actor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      id: "human.local.operator",
      type: "human",
      roles: ["domain-steward"],
    };
  }
  const candidate = value as Partial<Actor>;
  if (
    !candidate.id ||
    candidate.type !== "human" ||
    !Array.isArray(candidate.roles)
  ) {
    throw new Error("Approval actor must be a human with roles.");
  }
  return candidate as Actor;
}

async function main(args: string[]): Promise<void> {
  if (args.length < 2) throw new Error(usage);
  const [group, command, ...rest] = args;

  if (group === "profile" && command === "validate") {
    if (rest.length !== 1 || !rest[0])
      throw new Error("profile validate requires one profile path.");
    const loaded = loadFactoryProfile(rest[0]);
    process.stdout.write(
      `Valid COGA factory profile: ${loaded.document.metadata.id}\n`,
    );
    return;
  }

  if (group === "snapshot") {
    const options = parseCommon([command ?? "", ...rest]);
    const profile = options.values[0];
    if (!profile || options.values.length !== 1)
      throw new Error("snapshot requires one profile path.");
    process.stdout.write(formatJson(service(profile, options).snapshot()));
    return;
  }

  if (group === "intent" && command === "create") {
    const options = parseCommon(rest);
    const [profile, inputPath] = options.values;
    if (!profile || !inputPath || options.values.length !== 2) {
      throw new Error("intent create requires profile and intent JSON paths.");
    }
    const input = readJson<IntentInput & { actor?: Actor }>(inputPath);
    const result = service(profile, options).createIntent(
      input,
      input.actor ?? {
        id: "human.local.operator",
        type: "human",
        roles: ["domain-steward"],
      },
    );
    process.stdout.write(formatJson(result));
    return;
  }

  if (group === "task" && command === "assess") {
    const deepseek = rest.includes("--deepseek");
    const options = parseCommon(
      rest.filter((entry) => entry !== "--deepseek" && entry !== "--offline"),
    );
    const [profile, taskId] = options.values;
    if (!profile || !taskId || options.values.length !== 2) {
      throw new Error("task assess requires profile and task ID.");
    }
    const result = await service(profile, options).assessTask(
      taskId,
      deepseek ? "deepseek" : "offline",
    );
    process.stdout.write(formatJson(result));
    return;
  }

  if (group === "task" && command === "validate") {
    const options = parseCommon(rest);
    const [profile, taskId] = options.values;
    if (!profile || !taskId || options.values.length !== 2) {
      throw new Error("task validate requires profile and task ID.");
    }
    process.stdout.write(
      formatJson(await service(profile, options).runValidators(taskId)),
    );
    return;
  }

  if (group === "task" && command === "approve") {
    const options = parseCommon(rest);
    const [profile, taskId, approvalPath] = options.values;
    if (!profile || !taskId || !approvalPath || options.values.length !== 3) {
      throw new Error(
        "task approve requires profile, task ID, and approval JSON paths.",
      );
    }
    const input = readJson<{
      actor?: Actor;
      roles: string[];
      decision: "approve" | "reject";
      reason: string;
      impactDigest: string;
    }>(approvalPath);
    const result = service(profile, options).approve({
      taskId,
      actor: actor(input.actor),
      roles: input.roles,
      decision: input.decision,
      reason: input.reason,
      impactDigest: input.impactDigest,
    });
    process.stdout.write(formatJson(result));
    return;
  }

  if (group === "task" && command === "preview") {
    const options = parseCommon(rest);
    const [profile, taskId] = options.values;
    if (!profile || !taskId || options.values.length !== 2) {
      throw new Error("task preview requires profile and task ID.");
    }
    process.stdout.write(
      formatJson(service(profile, options).previewDecision(taskId)),
    );
    return;
  }

  if (group === "audit" && command === "verify") {
    const options = parseCommon(rest);
    const profile = options.values[0];
    if (!profile || options.values.length !== 1)
      throw new Error("audit verify requires one profile path.");
    const runtime = service(profile, options);
    const valid = runtime.store.verifyAudit();
    process.stdout.write(`${valid ? "Valid" : "Invalid"} COGA audit chain\n`);
    if (!valid) process.exitCode = 1;
    return;
  }

  if (group === "application" && command === "produce") {
    const allowedRootIndex = rest.indexOf("--allowed-root");
    if (allowedRootIndex < 0 || !rest[allowedRootIndex + 1]) {
      throw new Error("application produce requires --allowed-root.");
    }
    const values = rest.filter(
      (_, index) =>
        index !== allowedRootIndex && index !== allowedRootIndex + 1,
    );
    const [recipe, output, parameters] = values;
    if (!recipe || !output || !parameters || values.length !== 3) {
      throw new Error(
        "application produce requires recipe, output, and parameters JSON.",
      );
    }
    process.stdout.write(
      formatJson(
        produceApplication({
          recipePath: recipe,
          outputRoot: output,
          parameters: readJson<Record<string, string>>(parameters),
          allowedOutputRoot: rest[allowedRootIndex + 1]!,
        }),
      ),
    );
    return;
  }

  throw new Error(usage);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
});
