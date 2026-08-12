import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { FactoryController } from "../src/controller.js";

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
    execFileSync("git", [
      "-C",
      repository,
      "checkout",
      "--detach",
      "FETCH_HEAD",
    ]);
    execFileSync("git", ["-C", repository, "switch", "-c", "factory-e2e-base"]);
    const result = await new FactoryController({
      repositoryRoot: repository,
      delivery: "local",
      commandTimeoutMs: 180_000,
    }).run(join(repository, ".coga/work-orders/cedar-status/work-order.yaml"));
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
  },
  240_000,
);
