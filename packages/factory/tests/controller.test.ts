import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactoryController, FactoryPausedError } from "../src/controller.js";
import type { SandboxRunner } from "../src/types.js";

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
  execFileSync("git", ["-C", clone, "checkout", "--detach", "FETCH_HEAD"]);
  execFileSync("git", ["-C", clone, "switch", "-c", "factory-test-base"]);
  return clone;
}

const fakeSandbox: SandboxRunner = {
  async run(request) {
    if (request.outputPath) {
      mkdirSync(request.outputPath, { recursive: true });
      writeFileSync(join(request.outputPath, "index.html"), "verified build\n");
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
  },
};

describe("FactoryController", () => {
  it("resumes after interruption and returns one idempotent local candidate", async () => {
    const repository = cloneCurrentHead();
    const workOrder = join(
      repository,
      ".coga/work-orders/cedar-status/work-order.yaml",
    );
    const stateRoot = join(repository, ".local", "factory-test-state");
    const workspaceRoot = join(
      tmpdir(),
      `coga-factory-workspaces-${Date.now()}`,
    );
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
    expect(first.pullRequest).toBeUndefined();
    expect(
      git(
        repository,
        "show",
        `${first.resultCommit}:examples/broker-digital-channel/applications/cedar-insight-h5/src/app.mjs`,
      ),
    ).toContain("statusMessage");
    const evidence = git(
      repository,
      "show",
      `${first.resultCommit}:${first.evidencePath}`,
    );
    expect(JSON.parse(evidence).metadata.bundleDigest).toBe(
      first.evidenceDigest,
    );

    const second = await resumed.run(workOrder);
    expect(second).toEqual(first);
    expect(
      git(
        repository,
        "rev-list",
        "--count",
        `${first.baseCommit}..${first.resultCommit}`,
      ),
    ).toBe("1");
  }, 30_000);
});
