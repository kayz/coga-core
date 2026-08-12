#!/usr/bin/env node

import { dirname, relative, resolve } from "node:path";
import { FactoryController } from "./controller.js";
import { verifyEvidenceBundle } from "./evidence.js";
import { ADAPTER_MANIFESTS } from "./adapters.js";
import { compileProposalRequest } from "./proposal.js";
import {
  loadProposalCompilation,
  loadRemoteEvidence,
  loadWorkOrder,
} from "./schema.js";
import { collectRemoteEvidence } from "./remote.js";
import { createGovernanceView, governanceViewMarkdown } from "./governance.js";
import { GitRepository } from "./git.js";
import { FactoryTaskQueue } from "./queue.js";
import { FactoryWorker } from "./worker.js";
import { FactoryOperationsExecutor } from "./operations-controller.js";
import {
  BoundedEnvironmentSecretSource,
  GitHubAppInstallationCredentialProvider,
} from "./credentials.js";
import {
  evidenceArchiveReceiptPath,
  FileSystemImmutableEvidenceStore,
} from "./evidence-store.js";
import { createFactorySloReport, loadFactorySloPolicy } from "./slo.js";
import {
  evaluateMergeGate,
  evaluateTestEnvironmentGate,
  loadMergeAuthorization,
  loadTestEnvironmentAuthorization,
} from "./promotion.js";
import {
  evaluatePlatformEvidence,
  loadPlatformEvidence,
} from "./platform-gate.js";
import { normalizeRelativePath, readBoundedFile, sha256 } from "./utils.js";
import type { ExactReference } from "@coga/core";
import type {
  ArchivedEvidenceKind,
  FactoryTaskQueueContract,
} from "./operations-types.js";
import type { FactoryControllerOptions, RemoteEvidence } from "./types.js";

const usage = `Usage:
  coga-factory run <work-order> [--delivery local|github] [--repo-root <directory>] [--keep-workspace]
  coga-factory compile-proposal <request> [--repo-root <directory>]
  coga-factory collect-remote <work-order> <application-id>@<version> <pr-number> <evidence-path> [--output-root <directory>] [--promote]
  coga-factory governance <work-order> [--evidence <bundle>] [--remote-evidence <bundle>] [--format json|markdown]
  coga-factory verify-evidence <bundle.json>
  coga-factory operations enqueue <work-order> --queue-root <directory> [--delivery local|github] [--repo-root <directory>] [--max-attempts <count>] [--keep-workspace]
  coga-factory operations list --queue-root <directory>
  coga-factory operations show <task-id> --queue-root <directory>
  coga-factory operations cancel <task-id> --queue-root <directory> --reason <text>
  coga-factory operations run-once --queue-root <directory> [--worker-id <id>] [--lease-ms <milliseconds>] [--retry-delay-ms <milliseconds>]
  coga-factory archive-evidence <document> --store-root <directory> --source-root <directory> --retention-policy <id> --retain-until <date-time> [--kind EvidenceBundle|RemoteEvidence|PlatformEvidence]
  coga-factory verify-archive <receipt-path> --store-root <directory> [--source-root <directory>]
  coga-factory slo-report <policy> --queue-root <directory> [--measured-at <date-time>] [--minimum-samples <count>]
  coga-factory audit-merge <remote-evidence> <authorization> <snapshot.json> --repo-root <directory> --required-checks <comma-separated-names>
  coga-factory audit-test-environment <authorization> <snapshot.json> --repo-root <directory> --environment <name>
  coga-factory audit-platform <platform-evidence> <application-id>@<version> <candidate-commit> --repo-root <directory>
  coga-factory adapters`;

const GITHUB_APP_ID_SECRET = "COGA_FACTORY_GITHUB_APP_ID";
const GITHUB_APP_PRIVATE_KEY_SECRET = "COGA_FACTORY_GITHUB_APP_PRIVATE_KEY";
const MAX_CLI_JSON_BYTES = 1024 * 1024;

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

function parseArguments(
  args: string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
): ParsedArguments {
  const allowedValues = new Set(valueOptions);
  const allowedFlags = new Set(flagOptions);
  const parsed: ParsedArguments = {
    positionals: [],
    options: new Map(),
    flags: new Set(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) continue;
    if (allowedFlags.has(value)) {
      if (parsed.flags.has(value)) {
        throw new Error(`Option '${value}' may be supplied only once.`);
      }
      parsed.flags.add(value);
      continue;
    }
    if (allowedValues.has(value)) {
      const selected = args[index + 1];
      if (!selected || selected.startsWith("--")) {
        throw new Error(`${value} requires a value.`);
      }
      if (parsed.options.has(value)) {
        throw new Error(`Option '${value}' may be supplied only once.`);
      }
      parsed.options.set(value, selected);
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`Unknown option '${value}'.`);
    parsed.positionals.push(value);
  }
  return parsed;
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = parsed.options.get(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeInteger(
  value: string | undefined,
  label: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function readJsonDocument(path: string, label: string): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(
    readBoundedFile(resolve(path), label, MAX_CLI_JSON_BYTES),
  );
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function writeResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function queueAt(path: string): FactoryTaskQueue {
  return new FactoryTaskQueue({ root: resolve(path) });
}

function operationsCredentialProvider(): GitHubAppInstallationCredentialProvider {
  const secretSource = new BoundedEnvironmentSecretSource({
    allowedNames: [GITHUB_APP_ID_SECRET, GITHUB_APP_PRIVATE_KEY_SECRET],
  });
  return new GitHubAppInstallationCredentialProvider({
    secretSource,
    appIdSecretName: GITHUB_APP_ID_SECRET,
    privateKeySecretName: GITHUB_APP_PRIVATE_KEY_SECRET,
  });
}

function workerFor(
  queue: FactoryTaskQueueContract,
  parsed: ParsedArguments,
): FactoryWorker {
  return new FactoryWorker({
    queue,
    executor: new FactoryOperationsExecutor({
      credentialProvider: operationsCredentialProvider(),
    }),
    workerId: parsed.options.get("--worker-id") ?? `cli-${process.pid}`,
    leaseMs: safeInteger(
      parsed.options.get("--lease-ms"),
      "--lease-ms",
      15 * 60_000,
      1_000,
      24 * 60 * 60_000,
    ),
    retryDelayMs: safeInteger(
      parsed.options.get("--retry-delay-ms"),
      "--retry-delay-ms",
      60_000,
      0,
      30 * 24 * 60 * 60_000,
    ),
  });
}

function markGateResult(result: { eligible: boolean }): void {
  if (!result.eligible) process.exitCode = 2;
}

async function runOperations(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  if (operation === "enqueue") {
    const parsed = parseArguments(
      rest,
      ["--queue-root", "--delivery", "--repo-root", "--max-attempts"],
      ["--keep-workspace"],
    );
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
      throw new Error(`operations enqueue requires one Work Order.\n${usage}`);
    }
    const workOrderPath = resolve(parsed.positionals[0]);
    const workOrder = loadWorkOrder(workOrderPath);
    const repository = await GitRepository.open(
      parsed.options.get("--repo-root") ?? dirname(workOrderPath),
    );
    const baseCommit = await repository.resolveWorkOrderBase(
      workOrderPath,
      workOrder.spec.repository.baseCommit,
    );
    const delivery = parsed.options.get("--delivery") ?? "local";
    if (delivery !== "local" && delivery !== "github") {
      throw new Error("--delivery must be 'local' or 'github'.");
    }
    const workOrderRelativePath = normalizeRelativePath(
      relative(repository.root, workOrderPath).replaceAll("\\", "/"),
      "Work Order repository path",
    );
    const record = queueAt(requiredOption(parsed, "--queue-root")).enqueue({
      repositoryRoot: repository.root,
      workOrderPath: workOrderRelativePath,
      workOrderDigest: sha256(
        readBoundedFile(workOrderPath, "Work Order", MAX_CLI_JSON_BYTES),
      ),
      baseCommit,
      delivery,
      keepWorkspace: parsed.flags.has("--keep-workspace"),
      maxAttempts: safeInteger(
        parsed.options.get("--max-attempts"),
        "--max-attempts",
        3,
        1,
        100,
      ),
    });
    writeResult(record);
    return;
  }
  if (operation === "list") {
    const parsed = parseArguments(rest, ["--queue-root"]);
    if (parsed.positionals.length !== 0) {
      throw new Error(
        `operations list accepts no positional arguments.\n${usage}`,
      );
    }
    writeResult({
      tasks: queueAt(requiredOption(parsed, "--queue-root")).list(),
    });
    return;
  }
  if (operation === "show") {
    const parsed = parseArguments(rest, ["--queue-root"]);
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
      throw new Error(`operations show requires one task ID.\n${usage}`);
    }
    const task = queueAt(requiredOption(parsed, "--queue-root")).get(
      parsed.positionals[0] as `sha256:${string}`,
    );
    if (!task) throw new Error("Factory task was not found.");
    writeResult(task);
    return;
  }
  if (operation === "cancel") {
    const parsed = parseArguments(rest, ["--queue-root", "--reason"]);
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
      throw new Error(`operations cancel requires one task ID.\n${usage}`);
    }
    writeResult(
      queueAt(requiredOption(parsed, "--queue-root")).cancel(
        parsed.positionals[0] as `sha256:${string}`,
        requiredOption(parsed, "--reason"),
      ),
    );
    return;
  }
  if (operation === "run-once") {
    const parsed = parseArguments(rest, [
      "--queue-root",
      "--worker-id",
      "--lease-ms",
      "--retry-delay-ms",
    ]);
    if (parsed.positionals.length !== 0) {
      throw new Error(
        `operations run-once accepts no positional arguments.\n${usage}`,
      );
    }
    const queue = queueAt(requiredOption(parsed, "--queue-root"));
    writeResult(await workerFor(queue, parsed).runOnce());
    return;
  }
  throw new Error(`Unknown operations command '${operation ?? ""}'.\n${usage}`);
}

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
  if (command === "operations") {
    await runOperations(rest);
    return;
  }
  if (command === "archive-evidence") {
    const parsed = parseArguments(rest, [
      "--store-root",
      "--source-root",
      "--retention-policy",
      "--retain-until",
      "--kind",
    ]);
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
      throw new Error(`archive-evidence requires one document.\n${usage}`);
    }
    const selectedKind = parsed.options.get("--kind");
    if (
      selectedKind !== undefined &&
      selectedKind !== "EvidenceBundle" &&
      selectedKind !== "RemoteEvidence" &&
      selectedKind !== "PlatformEvidence"
    ) {
      throw new Error(
        "--kind must be EvidenceBundle, RemoteEvidence, or PlatformEvidence.",
      );
    }
    const store = new FileSystemImmutableEvidenceStore({
      root: resolve(requiredOption(parsed, "--store-root")),
      sourceRoot: resolve(requiredOption(parsed, "--source-root")),
    });
    const request = {
      path: resolve(parsed.positionals[0]),
      retentionPolicy: requiredOption(parsed, "--retention-policy"),
      retainUntil: requiredOption(parsed, "--retain-until"),
      ...(selectedKind ? { kind: selectedKind as ArchivedEvidenceKind } : {}),
    };
    const receipt = store.archive(request);
    writeResult({ receipt, receiptPath: evidenceArchiveReceiptPath(receipt) });
    return;
  }
  if (command === "verify-archive") {
    const parsed = parseArguments(rest, ["--store-root", "--source-root"]);
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
      throw new Error(`verify-archive requires one receipt path.\n${usage}`);
    }
    const sourceRoot = parsed.options.get("--source-root");
    const store = new FileSystemImmutableEvidenceStore({
      root: resolve(requiredOption(parsed, "--store-root")),
      ...(sourceRoot ? { sourceRoot: resolve(sourceRoot) } : {}),
    });
    writeResult({ valid: true, receipt: store.verify(parsed.positionals[0]) });
    return;
  }
  if (command === "slo-report") {
    const parsed = parseArguments(rest, [
      "--queue-root",
      "--measured-at",
      "--minimum-samples",
    ]);
    if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
      throw new Error(`slo-report requires one policy.\n${usage}`);
    }
    const measuredAt = parsed.options.get("--measured-at");
    const report = createFactorySloReport(
      loadFactorySloPolicy(resolve(parsed.positionals[0])),
      queueAt(requiredOption(parsed, "--queue-root")).list(),
      {
        minimumSamples: safeInteger(
          parsed.options.get("--minimum-samples"),
          "--minimum-samples",
          1,
          1,
          100_000,
        ),
        ...(measuredAt ? { measuredAt } : {}),
      },
    );
    writeResult(report);
    if (!report.compliant) process.exitCode = 2;
    return;
  }
  if (command === "audit-merge") {
    const parsed = parseArguments(rest, ["--repo-root", "--required-checks"]);
    if (parsed.positionals.length !== 3) {
      throw new Error(
        `audit-merge requires Remote Evidence, authorization, and snapshot JSON.\n${usage}`,
      );
    }
    const [remotePath, authorizationPath, snapshotPath] = parsed.positionals;
    if (!remotePath || !authorizationPath || !snapshotPath) {
      throw new Error(`audit-merge arguments are incomplete.\n${usage}`);
    }
    const requiredChecks = requiredOption(parsed, "--required-checks")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (requiredChecks.length === 0) {
      throw new Error(
        "--required-checks must contain at least one check name.",
      );
    }
    const result = evaluateMergeGate(
      resolve(requiredOption(parsed, "--repo-root")),
      loadRemoteEvidence(resolve(remotePath)) as RemoteEvidence,
      loadMergeAuthorization(resolve(authorizationPath)),
      readJsonDocument(snapshotPath, "Merge gate snapshot"),
      { requiredChecks },
    );
    writeResult(result);
    markGateResult(result);
    return;
  }
  if (command === "audit-test-environment") {
    const parsed = parseArguments(rest, ["--repo-root", "--environment"]);
    if (parsed.positionals.length !== 2) {
      throw new Error(
        `audit-test-environment requires authorization and snapshot JSON.\n${usage}`,
      );
    }
    const [authorizationPath, snapshotPath] = parsed.positionals;
    if (!authorizationPath || !snapshotPath) {
      throw new Error(
        `audit-test-environment arguments are incomplete.\n${usage}`,
      );
    }
    const expectedEnvironment = requiredOption(parsed, "--environment");
    const result = evaluateTestEnvironmentGate(
      resolve(requiredOption(parsed, "--repo-root")),
      loadTestEnvironmentAuthorization(resolve(authorizationPath)),
      readJsonDocument(snapshotPath, "Test Environment gate snapshot"),
      { expectedEnvironment },
    );
    writeResult(result);
    markGateResult(result);
    return;
  }
  if (command === "audit-platform") {
    const parsed = parseArguments(rest, ["--repo-root"]);
    if (parsed.positionals.length !== 3) {
      throw new Error(
        `audit-platform requires Platform Evidence, Application, and candidate commit.\n${usage}`,
      );
    }
    const [evidencePath, application, candidateCommit] = parsed.positionals;
    if (!evidencePath || !application || !candidateCommit) {
      throw new Error(`audit-platform arguments are incomplete.\n${usage}`);
    }
    const result = evaluatePlatformEvidence(
      resolve(requiredOption(parsed, "--repo-root")),
      loadPlatformEvidence(resolve(evidencePath)),
      { application: exactReference(application), candidateCommit },
    );
    writeResult(result);
    markGateResult(result);
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
