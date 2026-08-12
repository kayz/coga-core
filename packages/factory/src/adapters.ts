import {
  lstatSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { validate } from "@coga/core";
import type {
  AdapterManifest,
  AdapterReceipt,
  ApplicationFactoryDefinition,
  EvidenceFile,
  SandboxRunner,
  Sha256Digest,
} from "./types.js";
import {
  compareText,
  normalizeRelativePath,
  resolveWithin,
  sha256,
} from "./utils.js";

export const ADAPTER_MANIFESTS: Readonly<Record<string, AdapterManifest>> = {
  "coga.domain.patch/v1": {
    id: "coga.domain.patch",
    version: "1",
    kind: "apply-domain-change",
    network: "none",
    mutatesWorkspace: true,
    credentialAccess: "none",
  },
  "coga.agent.proposal/v2": {
    id: "coga.agent.proposal",
    version: "2",
    kind: "apply-agent-proposal",
    network: "none",
    mutatesWorkspace: true,
    credentialAccess: "none",
  },
  "coga.core.validate/v1": {
    id: "coga.core.validate",
    version: "1",
    kind: "validate-instance",
    network: "none",
    mutatesWorkspace: false,
    credentialAccess: "none",
  },
  "coga.node.test/v1": {
    id: "coga.node.test",
    version: "1",
    kind: "test-application",
    network: "none",
    mutatesWorkspace: false,
    credentialAccess: "none",
  },
  "coga.node.build/v1": {
    id: "coga.node.build",
    version: "1",
    kind: "build-application",
    network: "none",
    mutatesWorkspace: false,
    credentialAccess: "none",
  },
  "coga.evidence.bundle/v2": {
    id: "coga.evidence.bundle",
    version: "2",
    kind: "create-evidence",
    network: "none",
    mutatesWorkspace: true,
    credentialAccess: "none",
  },
  "github.draft-pr/v2": {
    id: "github.draft-pr",
    version: "2",
    kind: "deliver-draft-pr",
    network: "github-only",
    mutatesWorkspace: false,
    credentialAccess: "github",
  },
};

export class AdapterFailure extends Error {
  readonly receipt: AdapterReceipt;

  constructor(message: string, receipt: AdapterReceipt) {
    super(message);
    this.name = "AdapterFailure";
    this.receipt = receipt;
  }
}

function exactAdapter(value: string): { id: string; version: string } {
  const manifest = ADAPTER_MANIFESTS[value];
  if (!manifest) throw new Error(`Adapter '${value}' is not registered.`);
  return { id: manifest.id, version: manifest.version };
}

function receipt(
  stepId: string,
  adapter: string,
  status: "passed" | "failed",
  startedAt: string,
  finishedAt: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  detail?: string,
  outputFiles?: EvidenceFile[],
): AdapterReceipt {
  const value: AdapterReceipt = {
    stepId,
    adapter: exactAdapter(adapter),
    status,
    startedAt,
    finishedAt,
    exitCode,
    stdoutDigest: sha256(stdout),
    stderrDigest: sha256(stderr),
  };
  if (detail !== undefined) value.detail = detail;
  if (outputFiles !== undefined) value.outputFiles = outputFiles;
  return value;
}

export function passedReceipt(
  stepId: string,
  adapter: string,
  startedAt: string,
  finishedAt: string,
  detail: string,
): AdapterReceipt {
  return receipt(
    stepId,
    adapter,
    "passed",
    startedAt,
    finishedAt,
    0,
    "",
    "",
    detail,
  );
}

export function failedReceipt(
  stepId: string,
  adapter: string,
  startedAt: string,
  finishedAt: string,
  detail: string,
): AdapterReceipt {
  return receipt(
    stepId,
    adapter,
    "failed",
    startedAt,
    finishedAt,
    1,
    "",
    detail,
    detail.slice(0, 1000),
  );
}

function collectOutput(root: string): EvidenceFile[] {
  const files: EvidenceFile[] = [];
  const stack = [root];
  let totalBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => compareText(left.name, right.name),
    )) {
      const path = resolve(current, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink())
        throw new Error("Build output contains a symbolic link.");
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile())
        throw new Error("Build output contains a special file.");
      if (files.length >= 1000)
        throw new Error("Build output exceeds 1000 files.");
      totalBytes += info.size;
      if (totalBytes > 20 * 1024 * 1024)
        throw new Error("Build output exceeds 20 MiB.");
      const value = readFileSync(path);
      files.push({
        path: relative(root, path).replaceAll("\\", "/"),
        digest: sha256(value),
        bytes: value.byteLength,
      });
    }
  }
  return files.sort((left, right) => compareText(left.path, right.path));
}

export function runCoreValidation(
  stepId: string,
  workspace: string,
  manifest: string,
  profile: "local" | "public",
  now: () => Date,
): AdapterReceipt {
  const startedAt = now().toISOString();
  const manifestPath = resolveWithin(workspace, manifest, "Instance manifest");
  const result = validate(manifestPath, {
    profile,
    rootDir: resolve(manifestPath, ".."),
  });
  const finishedAt = now().toISOString();
  if (!result.valid) {
    const errors = result.issues
      .filter((entry) => entry.severity === "error")
      .map((entry) => `${entry.code}: ${entry.message}`)
      .join("\n");
    const failed = receipt(
      stepId,
      "coga.core.validate/v1",
      "failed",
      startedAt,
      finishedAt,
      1,
      "",
      errors,
      `${result.issues.length} validation issues`,
    );
    throw new AdapterFailure(
      "COGA Instance validation failed after proposed changes.",
      failed,
    );
  }
  return receipt(
    stepId,
    "coga.core.validate/v1",
    "passed",
    startedAt,
    finishedAt,
    0,
    "",
    "",
    `Validated ${result.loaded.packages.length} packages, ${result.loaded.artifacts.length} artifacts, and ${result.loaded.applications.length} applications.`,
  );
}

export async function runNodeVerification(parameters: {
  stepId: string;
  workspace: string;
  definition: ApplicationFactoryDefinition;
  adapterIndex: number;
  image: string;
  sandbox: SandboxRunner;
  now: () => Date;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<AdapterReceipt> {
  const adapter =
    parameters.definition.spec.verification[parameters.adapterIndex];
  if (!adapter)
    throw new Error(
      `Missing verification adapter index ${parameters.adapterIndex}.`,
    );
  const startedAt = parameters.now().toISOString();
  let outputPath: string | undefined;
  let outputFiles: EvidenceFile[] | undefined;
  const args =
    adapter.adapter === "coga.node.test/v1"
      ? [
          "node",
          "--test",
          ...adapter.files.map((entry) => normalizeRelativePath(entry)),
        ]
      : ["node", normalizeRelativePath(adapter.entrypoint)];
  if (adapter.adapter === "coga.node.build/v1") {
    outputPath = mkdtempSync(join(tmpdir(), "coga-factory-build-"));
    chmodSync(outputPath, 0o777);
  }
  try {
    const result = await parameters.sandbox.run({
      name: parameters.stepId,
      workspacePath: parameters.workspace,
      ...(outputPath ? { outputPath } : {}),
      image: parameters.image,
      args,
      ...(outputPath ? { env: { COGA_BUILD_OUTPUT: "/output" } } : {}),
      timeoutMs: parameters.timeoutMs,
      maxOutputBytes: parameters.maxOutputBytes,
    });
    if (outputPath && result.exitCode === 0)
      outputFiles = collectOutput(outputPath);
    const finishedAt = parameters.now().toISOString();
    const resultReceipt = receipt(
      parameters.stepId,
      adapter.adapter,
      result.exitCode === 0 ? "passed" : "failed",
      startedAt,
      finishedAt,
      result.exitCode,
      result.stdout,
      result.stderr,
      adapter.adapter === "coga.node.test/v1"
        ? "Node tests completed in the network-disabled sandbox."
        : `Build completed with ${outputFiles?.length ?? 0} output files in an isolated output mount.`,
      outputFiles,
    );
    resultReceipt.sandbox = parameters.sandbox.evidence(parameters.image);
    if (result.exitCode !== 0) {
      throw new AdapterFailure(
        `${adapter.adapter} failed: ${(result.stderr || result.stdout).slice(0, 1000)}`,
        resultReceipt,
      );
    }
    return resultReceipt;
  } finally {
    if (outputPath) rmSync(outputPath, { recursive: true, force: true });
  }
}
