import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { FactoryService } from "../src/service.js";
import { createFixtureWorkspace, testIntent } from "./helpers.js";

const actor = {
  id: "human.test.operator",
  type: "human" as const,
  roles: ["domain-steward"],
};
const approver = {
  id: "human.test.steward",
  type: "human" as const,
  roles: ["domain-steward"],
};

describe("governed factory service", () => {
  test("runs an idempotent intent-to-preview path and resumes from disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "coga-service-"));
    const { profilePath, statePath } = createFixtureWorkspace(root);
    const service = new FactoryService({
      profilePath,
      stateDirectory: statePath,
      now: () => "2026-08-08T00:00:00.000Z",
    });
    const created = service.createIntent(testIntent(), actor);
    const repeated = service.createIntent(testIntent(), actor);
    expect(repeated.task.metadata.id).toBe(created.task.metadata.id);
    expect(service.store.list("tasks")).toHaveLength(1);

    const policy = service.evaluatePolicy(created.task.metadata.id) as {
      decision: string;
    };
    expect(policy.decision).toBe("requireApproval");
    await service.assessTask(created.task.metadata.id, "offline");
    const evidence = await service.runValidators(created.task.metadata.id);
    expect(evidence).toHaveLength(1);
    expect(
      (evidence[0] as { spec: { claimResults: Array<{ status: string }> } })
        .spec.claimResults[0]?.status,
    ).toBe("passed");

    const impactDigest = service.impactDigestFor("domain.customer.identity");
    const approval = service.approve({
      taskId: created.task.metadata.id,
      actor: approver,
      roles: ["domain-steward"],
      decision: "approve",
      reason: "Authority, impact, and evidence were reviewed.",
      impactDigest,
    }) as { candidateDigest: string; evidenceDigest: string };
    expect(approval.candidateDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(approval.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(service.previewDecision(created.task.metadata.id)).toMatchObject({
      scope: "local-only",
      release: "blocked",
    });

    const restarted = new FactoryService({
      profilePath,
      stateDirectory: statePath,
    });
    expect(restarted.snapshot().tasks).toHaveLength(1);
    expect(restarted.snapshot().auditValid).toBe(true);
    await restarted.assessTask(created.task.metadata.id, "offline");
    expect(restarted.store.list("evidence")).toHaveLength(2);
  });

  test("denies direct published-to-published mutation before Agent execution", () => {
    const root = mkdtempSync(join(tmpdir(), "coga-service-"));
    const { profilePath, statePath } = createFixtureWorkspace(root);
    const service = new FactoryService({
      profilePath,
      stateDirectory: statePath,
    });
    const input = testIntent();
    input.candidate.after.metadata.lifecycle = "published";
    const created = service.createIntent(input, actor);
    const decision = service.evaluatePolicy(created.task.metadata.id) as {
      decision: string;
    };
    expect(decision.decision).toBe("deny");
    expect(service.store.list("evidence")).toHaveLength(0);
  });
});
