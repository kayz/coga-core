import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { FactoryController } from "../src/controller.js";
import { selectReplayBase, workOrderRelativePath } from "./replay-base.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const dockerTest =
  process.env.COGA_FACTORY_DOCKER_E2E === "1" ? test : test.skip;

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
    expect(result.targets).toHaveLength(2);
    const cedar = result.targets.find(
      (entry) => entry.application.id === "application.cedar.insight.h5",
    );
    if (!cedar || cedar.status !== "completed") {
      throw new Error("Expected a completed Cedar target.");
    }
    expect(cedar.pullRequest).toBeUndefined();
    expect(
      execFileSync(
        "git",
        [
          "-C",
          repository,
          "show",
          `${cedar.resultCommit}:examples/broker-digital-channel/applications/cedar-insight-h5/tests/app.test.mjs`,
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
          `${cedar.resultCommit}:${cedar.evidencePath}`,
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
    const birch = result.targets.find(
      (entry) => entry.application.id === "application.birch.insight.h5",
    );
    if (!birch || birch.status !== "completed") {
      throw new Error("Expected a completed Birch target.");
    }
    expect(
      execFileSync(
        "git",
        [
          "-C",
          repository,
          "show",
          `${birch.resultCommit}:examples/broker-digital-channel/applications/birch-insight-h5/tests/app.test.mjs`,
        ],
        { encoding: "utf8" },
      ),
    ).toContain("announces brief state");
  },
  240_000,
);
