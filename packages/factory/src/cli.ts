#!/usr/bin/env node

import { resolve } from "node:path";
import { FactoryController } from "./controller.js";
import { verifyEvidenceBundle } from "./evidence.js";
import { ADAPTER_MANIFESTS } from "./adapters.js";
import type { FactoryControllerOptions } from "./types.js";

const usage = `Usage:
  coga-factory run <work-order> [--delivery local|github] [--repo-root <directory>] [--keep-workspace]
  coga-factory verify-evidence <bundle.json>
  coga-factory adapters`;

interface RunArguments {
  path: string;
  options: FactoryControllerOptions;
}

function parseRun(args: string[]): RunArguments {
  const positionals: string[] = [];
  const options: FactoryControllerOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--delivery") {
      const delivery = args[index + 1];
      if (delivery !== "local" && delivery !== "github") {
        throw new Error("--delivery must be 'local' or 'github'.");
      }
      options.delivery = delivery;
      index += 1;
      continue;
    }
    if (value === "--repo-root") {
      const root = args[index + 1];
      if (!root || root.startsWith("--"))
        throw new Error("--repo-root requires a directory.");
      options.repositoryRoot = resolve(root);
      index += 1;
      continue;
    }
    if (value === "--keep-workspace") {
      options.keepWorkspace = true;
      continue;
    }
    if (value?.startsWith("--")) throw new Error(`Unknown option '${value}'.`);
    if (value) positionals.push(value);
  }
  if (positionals.length !== 1 || !positionals[0]) {
    throw new Error(`run requires exactly one Work Order.\n${usage}`);
  }
  return { path: resolve(positionals[0]), options };
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "run") {
    const parsed = parseRun(rest);
    const result = await new FactoryController(parsed.options).run(parsed.path);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "verify-evidence") {
    if (rest.length !== 1 || !rest[0])
      throw new Error(`verify-evidence requires one bundle.\n${usage}`);
    const result = verifyEvidenceBundle(resolve(rest[0]));
    process.stdout.write(
      `${JSON.stringify({ valid: true, workOrderId: result.metadata.workOrderId, digest: result.metadata.bundleDigest }, null, 2)}\n`,
    );
    return;
  }
  if (command === "adapters") {
    if (rest.length !== 0)
      throw new Error(`adapters accepts no arguments.\n${usage}`);
    process.stdout.write(
      `${JSON.stringify(Object.values(ADAPTER_MANIFESTS), null, 2)}\n`,
    );
    return;
  }
  throw new Error(usage);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
