import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterEach, describe, expect, test } from "vitest";

import { createWorkbenchServer, type RunningWorkbench } from "../src/server.js";

const running: RunningWorkbench[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.close()));
});

function fixture(root: string): { profilePath: string; statePath: string } {
  const source = fileURLToPath(
    new URL("../../core/tests/fixtures/valid/", import.meta.url),
  );
  cpSync(source, root, { recursive: true });
  const profile = {
    schemaVersion: "coga.dev/factory/v0.1",
    kind: "FactoryProfile",
    metadata: {
      id: "factory.workbench.test",
      title: "Workbench test",
      version: "0.1.0",
    },
    spec: {
      workspaceRoot: ".",
      instanceManifest: "instance.yaml",
      stateDirectory: ".coga",
      candidateDirectory: ".coga/candidates",
      adapters: [
        {
          ref: {
            kind: "workspace",
            id: "workspace.test.files",
            version: "0.1.0",
          },
          runtime: "builtin",
          actions: ["candidate.patch"],
        },
        {
          ref: {
            kind: "agent",
            id: "agent.offline.asset.evaluator",
            version: "0.1.0",
          },
          runtime: "builtin",
          actions: ["assess-asset"],
        },
        {
          ref: {
            kind: "validator",
            id: "validator.test.pass",
            version: "0.1.0",
          },
          runtime: "process",
          actions: ["validate"],
          config: {
            cwd: ".",
            executable: process.execPath,
            args: ["-e", "process.stdout.write('ok')"],
            timeoutMs: 5_000,
            outputLimitBytes: 8_192,
            envAllowlist: [],
          },
        },
        {
          ref: {
            kind: "policy",
            id: "policy.test.governance",
            version: "0.1.0",
          },
          runtime: "builtin",
          actions: ["risk-evaluate"],
        },
      ],
      policies: {
        maxAutonomousRisk: "low",
        promotionRequiresHuman: true,
        releaseRequiresHuman: true,
        separationOfDuties: true,
        publishedMutation: "deny",
        requiredRoles: { candidate: ["domain-steward"] },
      },
      sourceAllowlist: ["https://example.com/"],
      workbench: { host: "127.0.0.1", port: 4376, locale: "zh-CN" },
    },
  };
  const profilePath = join(root, "profile.yaml");
  writeFileSync(profilePath, stringify(profile));
  const statePath = join(root, ".state");
  mkdirSync(statePath);
  return { profilePath, statePath };
}

function intent() {
  return {
    mode: "calibrate",
    goal: "Clarify default-deny behavior for expired authorization evidence.",
    acceptanceCriteria: ["Negative-path scenario passes."],
    nonGoals: ["Do not change backend authority."],
    risk: "high",
    sources: [
      {
        uri: "https://example.com/authority",
        sourceType: "standard",
        authority: "Public authority",
        visibility: "public",
        excerpt: "Stale authorization evidence denies restricted access.",
      },
    ],
    candidate: {
      artifactId: "domain.customer.identity",
      before: {
        metadata: {
          id: "domain.customer.identity",
          version: "0.1.0",
          lifecycle: "published",
        },
        spec: { statement: "Identity is server-owned." },
      },
      after: {
        metadata: {
          id: "domain.customer.identity",
          version: "0.2.0",
          lifecycle: "candidate",
        },
        spec: {
          statement:
            "Identity is server-owned; stale authorization denies access.",
        },
      },
    },
  };
}

async function start(root: string): Promise<RunningWorkbench> {
  const paths = fixture(root);
  const server = await createWorkbenchServer({
    profilePath: paths.profilePath,
    stateDirectory: paths.statePath,
    port: 0,
    now: () => "2026-08-08T00:00:00.000Z",
  });
  running.push(server);
  return server;
}

async function bootstrap(server: RunningWorkbench) {
  const response = await fetch(`${server.url}/api/bootstrap`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    actionToken: string;
    snapshot: { tasks: unknown[]; auditValid: boolean };
  };
}

async function action(
  server: RunningWorkbench,
  token: string,
  path: string,
  body: unknown,
  method = "POST",
) {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-coga-action-token": token,
      origin: server.url,
    },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error ?? response.status));
  return payload;
}

describe("Workbench server", () => {
  test("serves a strict local UI and rejects cross-origin mutation", async () => {
    const server = await start(mkdtempSync(join(tmpdir(), "coga-workbench-")));
    const page = await fetch(server.url);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(html).toContain("COGA Workbench");
    expect(html).toContain("治理轨迹");
    expect(html).not.toMatch(/<script[^>]*>[^<]/u);

    const boot = await bootstrap(server);
    const crossOrigin = await fetch(`${server.url}/api/intents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-coga-action-token": boot.actionToken,
        origin: "https://malicious.example",
      },
      body: JSON.stringify({ intent: intent() }),
    });
    expect(crossOrigin.status).toBe(400);
    expect(await crossOrigin.text()).toContain("Cross-origin");
  });

  test("executes the complete governed API loop and restores it after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "coga-workbench-"));
    const paths = fixture(root);
    const server = await createWorkbenchServer({
      profilePath: paths.profilePath,
      stateDirectory: paths.statePath,
      port: 0,
      now: () => "2026-08-08T00:00:00.000Z",
    });
    running.push(server);
    const boot = await bootstrap(server);
    const created = await action(server, boot.actionToken, "/api/intents", {
      intent: intent(),
      actor: { id: "human.operator", type: "human", roles: ["domain-steward"] },
    });
    const taskId = (created.task as { metadata: { id: string } }).metadata.id;
    await action(
      server,
      boot.actionToken,
      `/api/tasks/${encodeURIComponent(taskId)}/assess`,
      {
        mode: "offline",
      },
    );
    await action(
      server,
      boot.actionToken,
      `/api/tasks/${encodeURIComponent(taskId)}/validate`,
      {},
    );
    await action(
      server,
      boot.actionToken,
      `/api/tasks/${encodeURIComponent(taskId)}/approve`,
      {
        actor: {
          id: "human.steward",
          type: "human",
          roles: ["domain-steward"],
        },
        roles: ["domain-steward"],
        decision: "approve",
        reason: "Authority, impact, and evidence reviewed.",
      },
    );
    const preview = await action(
      server,
      boot.actionToken,
      `/api/tasks/${encodeURIComponent(taskId)}/preview`,
      {},
    );
    expect(preview).toMatchObject({ scope: "local-only", release: "blocked" });

    const observation = {
      specversion: "1.0",
      id: "event-workbench",
      source: "urn:coga:application:test",
      type: "coga.application.preview.error",
      time: "2026-08-08T00:00:00.000Z",
      datacontenttype: "application/json",
      data: { code: "AUTH_EXPIRED" },
      coga: {
        application: { id: "example.application.demo", version: "0.1.0" },
        scope: "application",
        classification: "internal",
        retentionDays: 30,
        schemaRef: "urn:coga:schema:error:0.1.0",
        purpose: "Test Workbench incident flow",
        owner: "example.application.demo",
      },
    };
    const observed = await action(
      server,
      boot.actionToken,
      "/api/observations",
      { observation },
    );
    const incidentId = "incident.workbench.test";
    await action(server, boot.actionToken, "/api/incidents", {
      id: incidentId,
      observationStoreIds: [observed.storeId],
      runbook: { id: "runbook.channel.api-degradation", version: "0.1.0" },
    });
    await action(
      server,
      boot.actionToken,
      `/api/incidents/${encodeURIComponent(incidentId)}`,
      {
        patch: {
          state: "verifying",
          severity: "sev3",
          closure: {
            severityAssignedByHuman: true,
            criticalJourneyPassed: true,
            monitoringRecovered: true,
            regressionEvidenceDigest: "a".repeat(64),
          },
        },
      },
      "PATCH",
    );
    await action(
      server,
      boot.actionToken,
      `/api/incidents/${encodeURIComponent(incidentId)}`,
      { patch: { state: "closed" } },
      "PATCH",
    );
    const promotion = await action(
      server,
      boot.actionToken,
      "/api/promotions",
      {
        id: "promotion.workbench.test",
        incidentIds: [incidentId],
        targetPackage: {
          id: "example.broker-channel.domain",
          version: "0.1.0",
        },
        candidateArtifact: {
          lifecycle: "candidate",
          statement: "Stale authorization denies access.",
        },
        consumerApplications: ["example.application.demo"],
        authoritativeSources: ["https://example.com/authority"],
        privateTermsScanPassed: true,
        independentScenarios: ["scenario.customer.access-allowed"],
      },
    );
    expect(promotion).toMatchObject({
      kind: "PromotionProposal",
      metadata: { lifecycle: "candidate" },
      spec: { proposedArtifactType: "rule" },
    });

    const forbidden = await fetch(`${server.url}/api/release`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-coga-action-token": boot.actionToken,
        origin: server.url,
      },
      body: "{}",
    });
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual({ error: "API route not found." });

    await server.close();
    running.splice(running.indexOf(server), 1);
    const restarted = await createWorkbenchServer({
      profilePath: paths.profilePath,
      stateDirectory: paths.statePath,
      port: 0,
    });
    running.push(restarted);
    const restored = await bootstrap(restarted);
    expect(restored.snapshot.tasks).toHaveLength(1);
    expect(restored.snapshot.auditValid).toBe(true);
  });
});
