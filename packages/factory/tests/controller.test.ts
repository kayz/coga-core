import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryController, FactoryPausedError } from "../src/controller.js";
import type { SandboxRunner } from "../src/types.js";
import { canonicalJson, sha256 } from "../src/utils.js";
import { selectReplayBase, workOrderRelativePath } from "./replay-base.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function cloneCurrentHead(): string {
  const directory = mkdtempSync(join(tmpdir(), "coga-factory-controller-"));
  const clone = join(directory, "repository");
  execFileSync("git", [
    "clone",
    "--no-checkout",
    "--no-local",
    repositoryRoot,
    clone,
  ]);
  execFileSync("git", ["-C", clone, "fetch", repositoryRoot, "HEAD"]);
  selectReplayBase(clone);
  execFileSync("git", ["-C", clone, "switch", "-c", "factory-test-base"]);
  return clone;
}

const fakeSandbox: SandboxRunner = {
  evidence(image) {
    return {
      runner: { id: "test.fake-sandbox", version: "1" },
      image,
      isolation: "test-double",
      network: "none",
      rootFilesystem: "simulated",
      repositoryMount: "simulated",
      credentialAccess: "none",
      user: "simulated",
      limits: { pids: 0, memoryBytes: 0, cpus: 0 },
    };
  },
  async run(request) {
    if (request.outputPath) {
      mkdirSync(request.outputPath, { recursive: true });
      writeFileSync(join(request.outputPath, "index.html"), "verified build\n");
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
  },
};

describe("FactoryController", () => {
  it("resumes after interruption and returns two idempotent local candidates", async () => {
    const repository = cloneCurrentHead();
    const workOrder = join(repository, workOrderRelativePath);
    const stateRoot = join(repository, ".local", "factory-test-state");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cfw-"));
    const paused = new FactoryController(
      {
        repositoryRoot: repository,
        stateRoot,
        workspaceRoot,
        delivery: "local",
        keepWorkspace: true,
        stopAfterStep: "proposal.apply",
      },
      { sandbox: fakeSandbox },
    );
    await expect(paused.run(workOrder)).rejects.toBeInstanceOf(
      FactoryPausedError,
    );

    const resumed = new FactoryController(
      {
        repositoryRoot: repository,
        stateRoot,
        workspaceRoot,
        delivery: "local",
      },
      { sandbox: fakeSandbox },
    );
    const first = await resumed.run(workOrder);
    expect(first.status).toBe("completed");
    expect(first.targets).toHaveLength(2);
    expect(first.targets.every((entry) => entry.status === "completed")).toBe(
      true,
    );
    const cedar = first.targets.find(
      (entry) => entry.application.id === "application.cedar.insight.h5",
    );
    if (!cedar || cedar.status !== "completed") {
      throw new Error("Expected completed Cedar target.");
    }
    expect(cedar.pullRequest).toBeUndefined();
    expect(
      git(
        repository,
        "show",
        `${cedar.resultCommit}:examples/broker-digital-channel/applications/cedar-insight-h5/src/app.mjs`,
      ),
    ).toContain("statusMessage");
    const evidence = git(
      repository,
      "show",
      `${cedar.resultCommit}:${cedar.evidencePath}`,
    );
    expect(JSON.parse(evidence).metadata.bundleDigest).toBe(
      cedar.evidenceDigest,
    );

    const second = await resumed.run(workOrder);
    expect(second).toEqual(first);
    for (const outcome of first.targets) {
      if (outcome.status !== "completed") continue;
      expect(
        git(
          repository,
          "rev-list",
          "--count",
          `${first.baseCommit}..${outcome.resultCommit}`,
        ),
      ).toBe("1");
    }
  }, 30_000);

  it("fails closed when recovery state or worktree identity is changed", async () => {
    const repository = cloneCurrentHead();
    const workOrder = join(repository, workOrderRelativePath);
    const stateRoot = join(repository, ".local", "factory-tamper-state");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cft-"));
    const paused = new FactoryController(
      {
        repositoryRoot: repository,
        stateRoot,
        workspaceRoot,
        delivery: "local",
        keepWorkspace: true,
        stopAfterStep: "proposal.apply",
      },
      { sandbox: fakeSandbox },
    );
    await expect(paused.run(workOrder)).rejects.toBeInstanceOf(
      FactoryPausedError,
    );

    const runDirectory = readdirSync(stateRoot, { withFileTypes: true }).find(
      (entry) => entry.isDirectory(),
    );
    if (!runDirectory) throw new Error("Factory test state was not written.");
    const statePath = join(stateRoot, runDirectory.name, "state.json");
    const original = JSON.parse(readFileSync(statePath, "utf8")) as {
      application: { id: string; version: string };
      workspacePath: string;
      plan: {
        instanceManifest: string;
        planDigest: `sha256:${string}`;
        [key: string]: unknown;
      };
    };
    const resumed = new FactoryController(
      {
        repositoryRoot: repository,
        stateRoot,
        workspaceRoot,
        delivery: "local",
      },
      { sandbox: fakeSandbox },
    );

    const expectIsolatedFailure = async (pattern: RegExp): Promise<void> => {
      const result = await resumed.run(workOrder);
      expect(result.status).toBe("partial");
      const failure = result.targets.find(
        (entry) => entry.application.id === original.application.id,
      );
      expect(failure?.status).toBe("failed");
      if (!failure || failure.status !== "failed") {
        throw new Error("Expected the tampered target to fail.");
      }
      expect(failure.failure).toMatch(pattern);
      expect(
        result.targets.some(
          (entry) =>
            entry.application.id !== original.application.id &&
            entry.status === "completed",
        ),
      ).toBe(true);
    };

    writeFileSync(
      statePath,
      JSON.stringify({ ...original, workspacePath: join(tmpdir(), "foreign") }),
    );
    await expectIsolatedFailure(/workspacePath does not match/iu);

    const changedPlan = structuredClone(original);
    changedPlan.plan.instanceManifest = "unbound-instance.yaml";
    const { planDigest: _oldDigest, ...changedPlanPayload } = changedPlan.plan;
    changedPlan.plan.planDigest = sha256(canonicalJson(changedPlanPayload));
    writeFileSync(statePath, JSON.stringify(changedPlan));
    await expectIsolatedFailure(/freshly derived target plan/iu);

    writeFileSync(statePath, JSON.stringify(original));
    git(original.workspacePath, "switch", "--detach");
    await expectIsolatedFailure(/does not match commit .* branch/iu);
  }, 30_000);

  it("isolates one target failure and retries only the failed Application", async () => {
    const repository = cloneCurrentHead();
    const workOrder = join(repository, workOrderRelativePath);
    const stateRoot = join(repository, ".local", "factory-fanout-state");
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cff-"));
    let failBirch = true;
    const attempts = new Map<string, number>();
    const selectiveSandbox: SandboxRunner = {
      ...fakeSandbox,
      async run(request) {
        const application = request.workspacePath.includes(
          "application.birch.insight.h5",
        )
          ? "birch"
          : "cedar";
        attempts.set(application, (attempts.get(application) ?? 0) + 1);
        if (application === "birch" && failBirch) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: "injected Birch verification failure",
            timedOut: false,
          };
        }
        if (request.outputPath) {
          mkdirSync(request.outputPath, { recursive: true });
          writeFileSync(
            join(request.outputPath, "index.html"),
            "verified build\n",
          );
        }
        return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
      },
    };
    const controller = new FactoryController(
      {
        repositoryRoot: repository,
        stateRoot,
        workspaceRoot,
        delivery: "local",
      },
      { sandbox: selectiveSandbox },
    );
    const partial = await controller.run(workOrder);
    expect(partial.status).toBe("partial");
    expect(partial.targets.map((entry) => entry.status).sort()).toEqual([
      "completed",
      "failed",
    ]);
    const cedarAttempts = attempts.get("cedar");
    expect(cedarAttempts).toBe(2);

    failBirch = false;
    const completed = await controller.run(workOrder);
    expect(completed.status).toBe("completed");
    expect(
      completed.targets.every((entry) => entry.status === "completed"),
    ).toBe(true);
    expect(attempts.get("cedar")).toBe(cedarAttempts);
    expect(attempts.get("birch")).toBe(3);
  }, 45_000);
});
