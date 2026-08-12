import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createFanOutExecutionPlan } from "../src/planner.js";
import { loadWorkOrder } from "../src/schema.js";
import { canonicalJson, sha256 } from "../src/utils.js";
import { selectReplayBase, workOrderRelativePath } from "./replay-base.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function cloneCurrentHead(): { repository: string; baseCommit: string } {
  const directory = mkdtempSync(join(tmpdir(), "coga-factory-planner-"));
  const repository = join(directory, "repository");
  execFileSync("git", [
    "clone",
    "--no-checkout",
    "--no-local",
    repositoryRoot,
    repository,
  ]);
  execFileSync("git", ["-C", repository, "fetch", repositoryRoot, "HEAD"]);
  const baseCommit = selectReplayBase(repository);
  execFileSync("git", ["-C", repository, "switch", "-c", "planner-base"]);
  return { repository, baseCommit };
}

describe("proposal Harness context closure", () => {
  it("excludes ignored build residue and rejects an unbound versionable source file", () => {
    const { repository, baseCommit } = cloneCurrentHead();
    const workOrderPath = join(repository, workOrderRelativePath);
    const workOrder = loadWorkOrder(workOrderPath);
    const ignored = join(
      repository,
      "examples/broker-digital-channel/applications/cedar-insight-h5/dist",
    );
    mkdirSync(ignored, { recursive: true });
    writeFileSync(join(ignored, "stale-injection.js"), "ignored\n");
    expect(
      createFanOutExecutionPlan(
        repository,
        workOrderPath,
        workOrder,
        baseCommit,
      ).targets,
    ).toHaveLength(2);

    writeFileSync(
      join(
        repository,
        "examples/broker-digital-channel/applications/cedar-insight-h5/unbound.txt",
      ),
      "not in the proposal receipt\n",
    );
    const unbound = createFanOutExecutionPlan(
      repository,
      workOrderPath,
      workOrder,
      baseCommit,
    );
    expect(unbound.targets.map((entry) => entry.application.id)).toEqual([
      "application.birch.insight.h5",
    ]);
    expect(unbound.planningFailures).toMatchObject([
      {
        status: "failed",
        application: { id: "application.cedar.insight.h5" },
        failure: expect.stringMatching(/does not exactly bind.*missing/iu),
      },
    ]);
  }, 30_000);

  it("isolates a tampered target Proposal Receipt during planning", () => {
    const { repository, baseCommit } = cloneCurrentHead();
    const workOrderPath = join(repository, workOrderRelativePath);
    const workOrder = loadWorkOrder(workOrderPath);
    const target = workOrder.spec.targets.find(
      (entry) => entry.application.id === "application.birch.insight.h5",
    );
    if (!target) throw new Error("Expected Birch target.");
    const receiptPath = join(
      repository,
      ...target.proposal.receipt.path.split("/"),
    );
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      generator: { model: { version: string } };
    };
    receipt.generator.model.version = "tampered";
    const bytes = canonicalJson(receipt);
    writeFileSync(receiptPath, bytes);
    target.proposal.receipt.digest = sha256(bytes);

    const plan = createFanOutExecutionPlan(
      repository,
      workOrderPath,
      workOrder,
      baseCommit,
    );
    expect(plan.targets.map((entry) => entry.application.id)).toEqual([
      "application.cedar.insight.h5",
    ]);
    expect(plan.planningFailures).toMatchObject([
      {
        status: "failed",
        application: { id: "application.birch.insight.h5" },
        failure: expect.stringMatching(/Receipt digest mismatch/iu),
      },
    ]);
  }, 30_000);
});
