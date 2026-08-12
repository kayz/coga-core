#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { FactoryController } from "./controller.js";
import { verifyEvidenceBundle } from "./evidence.js";
import { ADAPTER_MANIFESTS } from "./adapters.js";
import { compileProposalRequest } from "./proposal.js";
import { loadProposalCompilation, loadWorkOrder } from "./schema.js";
import { collectRemoteEvidence } from "./remote.js";
import { createGovernanceView, governanceViewMarkdown } from "./governance.js";
import { GitRepository } from "./git.js";
import type { ExactReference } from "@coga/core";
import type { FactoryControllerOptions } from "./types.js";

const usage = `Usage:
  coga-factory run <work-order> [--delivery local|github] [--repo-root <directory>] [--keep-workspace]
  coga-factory compile-proposal <request> [--repo-root <directory>]
  coga-factory collect-remote <work-order> <application-id>@<version> <pr-number> <evidence-path> [--output-root <directory>] [--promote]
  coga-factory governance <work-order> [--evidence <bundle>] [--remote-evidence <bundle>] [--format json|markdown]
  coga-factory verify-evidence <bundle.json>
  coga-factory adapters`;

interface RunArguments {
  path: string;
  options: FactoryControllerOptions;
}

function exactReference(value: string): ExactReference {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(
      `Expected an exact id@version reference, received '${value}'.`,
    );
  }
  return { id: value.slice(0, separator), version: value.slice(separator + 1) };
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
  if (command === "compile-proposal") {
    const positionals: string[] = [];
    let repositoryRoot = process.cwd();
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index];
      if (value === "--repo-root") {
        const root = rest[index + 1];
        if (!root || root.startsWith("--")) {
          throw new Error("--repo-root requires a directory.");
        }
        repositoryRoot = resolve(root);
        index += 1;
      } else if (value?.startsWith("--")) {
        throw new Error(`Unknown option '${value}'.`);
      } else if (value) {
        positionals.push(value);
      }
    }
    if (positionals.length !== 1 || !positionals[0]) {
      throw new Error(`compile-proposal requires one request.\n${usage}`);
    }
    const request = loadProposalCompilation(resolve(positionals[0]));
    const result = compileProposalRequest(repositoryRoot, request);
    process.stdout.write(
      `${JSON.stringify({ path: result.path, digest: result.digest, receipt: result.receipt }, null, 2)}\n`,
    );
    return;
  }
  if (command === "collect-remote") {
    const positionals: string[] = [];
    let outputRoot = process.cwd();
    let promote = false;
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index];
      if (value === "--output-root") {
        const root = rest[index + 1];
        if (!root || root.startsWith("--")) {
          throw new Error("--output-root requires a directory.");
        }
        outputRoot = resolve(root);
        index += 1;
      } else if (value === "--promote") {
        promote = true;
      } else if (value?.startsWith("--")) {
        throw new Error(`Unknown option '${value}'.`);
      } else if (value) {
        positionals.push(value);
      }
    }
    if (positionals.length !== 4) {
      throw new Error(
        `collect-remote requires four positional arguments.\n${usage}`,
      );
    }
    const [workOrderPath, applicationValue, pullRequestValue, evidencePath] =
      positionals;
    if (
      !workOrderPath ||
      !applicationValue ||
      !pullRequestValue ||
      !evidencePath
    ) {
      throw new Error(`collect-remote arguments are incomplete.\n${usage}`);
    }
    const pullRequest = Number(pullRequestValue);
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) {
      throw new Error("PR number must be a positive integer.");
    }
    const absoluteWorkOrderPath = resolve(workOrderPath);
    const workOrder = loadWorkOrder(absoluteWorkOrderPath);
    const repository = await GitRepository.open(dirname(absoluteWorkOrderPath));
    const baseCommit = await repository.resolveWorkOrderBase(
      absoluteWorkOrderPath,
      workOrder.spec.repository.baseCommit,
    );
    const result = await collectRemoteEvidence({
      workOrder,
      baseCommit,
      application: exactReference(applicationValue),
      pullRequest,
      evidencePath,
      outputRoot,
      collectedAt: new Date().toISOString(),
      promote,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "governance") {
    const positionals: string[] = [];
    const evidencePaths: string[] = [];
    const remoteEvidencePaths: string[] = [];
    let format: "json" | "markdown" = "json";
    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index];
      if (value === "--evidence" || value === "--remote-evidence") {
        const path = rest[index + 1];
        if (!path || path.startsWith("--")) {
          throw new Error(`${value} requires a file path.`);
        }
        (value === "--evidence" ? evidencePaths : remoteEvidencePaths).push(
          resolve(path),
        );
        index += 1;
      } else if (value === "--format") {
        const selected = rest[index + 1];
        if (selected !== "json" && selected !== "markdown") {
          throw new Error("--format must be 'json' or 'markdown'.");
        }
        format = selected;
        index += 1;
      } else if (value?.startsWith("--")) {
        throw new Error(`Unknown option '${value}'.`);
      } else if (value) {
        positionals.push(value);
      }
    }
    if (positionals.length !== 1 || !positionals[0]) {
      throw new Error(`governance requires one Work Order.\n${usage}`);
    }
    const view = createGovernanceView({
      workOrder: loadWorkOrder(resolve(positionals[0])),
      evidencePaths,
      remoteEvidencePaths,
    });
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify(view, null, 2)}\n`
        : governanceViewMarkdown(view),
    );
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
