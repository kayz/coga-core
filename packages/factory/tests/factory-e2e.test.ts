import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { FactoryController } from "../src/controller.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const dockerTest =
  process.env.COGA_FACTORY_DOCKER_E2E === "1" ? test : test.skip;
const workOrderRelativePath = ".coga/work-orders/cedar-status/work-order.yaml";
const patchRelativePaths = [
  ".coga/work-orders/cedar-status/domain-change.patch",
  ".coga/work-orders/cedar-status/agent-proposal.patch",
] as const;

function succeeds(root: string, ...args: string[]): boolean {
  try {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function selectReplayBase(repository: string): string {
  const head = execFileSync(
    "git",
    ["-C", repository, "rev-parse", "FETCH_HEAD^{commit}"],
    { encoding: "utf8" },
  ).trim();
  const line = execFileSync(
    "git",
    ["-C", repository, "rev-list", "--parents", "-n", "1", head],
    { encoding: "utf8" },
  ).trim();
  const candidates = line.split(/\s+/u);
  for (const commit of candidates) {
    if (
      !succeeds(
        repository,
        "cat-file",
        "-e",
        `${commit}:${workOrderRelativePath}`,
      )
    ) {
      continue;
    }
    execFileSync("git", ["-C", repository, "checkout", "--detach", commit]);
    const applicable = patchRelativePaths.every(
      (path) =>
        !succeeds(
          repository,
          "apply",
          "--reverse",
          "--check",
          "--unidiff-zero",
          path,
        ) &&
        succeeds(
          repository,
          "apply",
          "--check",
          "--unidiff-zero",
          "--whitespace=error-all",
          path,
        ),
    );
    if (applicable) return commit;
  }
  throw new Error(
    "No current or immediate parent commit contains an unapplied governed Factory Work Order.",
  );
}

dockerTest(
  "turns the governed H5 Harness change into a sandbox-verified local Application candidate",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "coga-factory-e2e-"));
    const repository = join(directory, "repository");
    execFileSync("git", [
      "clone",
      "--no-checkout",
      "--no-local",
      repositoryRoot,
      repository,
    ]);
    execFileSync("git", ["-C", repository, "fetch", repositoryRoot, "HEAD"]);
    selectReplayBase(repository);
    execFileSync("git", ["-C", repository, "switch", "-c", "factory-e2e-base"]);
    const result = await new FactoryController({
      repositoryRoot: repository,
      delivery: "local",
      commandTimeoutMs: 180_000,
    }).run(join(repository, workOrderRelativePath));
    expect(result.status).toBe("completed");
    expect(result.pullRequest).toBeUndefined();
    expect(
      execFileSync(
        "git",
        [
          "-C",
          repository,
          "show",
          `${result.resultCommit}:examples/broker-digital-channel/applications/cedar-insight-h5/tests/app.test.mjs`,
        ],
        { encoding: "utf8" },
      ),
    ).toContain("announces access state");
    const evidence = JSON.parse(
      execFileSync(
        "git",
        [
          "-C",
          repository,
          "show",
          `${result.resultCommit}:${result.evidencePath}`,
        ],
        { encoding: "utf8" },
      ),
    ) as {
      steps: Array<{
        adapter: { id: string };
        sandbox?: {
          isolation: string;
          network: string;
          rootFilesystem: string;
          repositoryMount: string;
        };
      }>;
    };
    const sandboxed = evidence.steps.filter((entry) =>
      entry.adapter.id.startsWith("coga.node."),
    );
    expect(sandboxed).toHaveLength(2);
    for (const receipt of sandboxed) {
      expect(receipt.sandbox).toMatchObject({
        isolation: "docker",
        network: "none",
        rootFilesystem: "read-only",
        repositoryMount: "read-only",
      });
    }
  },
  240_000,
);
