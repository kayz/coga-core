import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { produceApplication } from "../src/application-production.js";
import {
  canCloseIncident,
  closeIncident,
  openIncident,
  proposePromotion,
  validateObservation,
} from "../src/operations.js";

describe("repeatable application production", () => {
  test("renders declared outputs deterministically and refuses overwrite", () => {
    const root = mkdtempSync(join(tmpdir(), "coga-recipe-"));
    const template = join(root, "template");
    const allowed = join(root, "candidates");
    mkdirSync(template);
    mkdirSync(allowed);
    writeFileSync(
      join(template, "package.json"),
      '{"name":"{{applicationId}}","version":"0.1.0"}\n',
    );
    writeFileSync(
      join(root, "recipe.json"),
      JSON.stringify({
        schemaVersion: "coga.dev/factory/v0.1",
        kind: "ApplicationRecipe",
        metadata: {
          id: "recipe.test.app",
          title: "Test app",
          version: "0.1.0",
        },
        spec: {
          deliveryTarget: "test",
          templateRoot: "template",
          parameters: [
            {
              name: "applicationId",
              pattern: "@[a-z0-9-]+/[a-z0-9-]+",
              required: true,
            },
          ],
          harnessDependencies: [{ id: "package.domain", version: "0.1.0" }],
          outputs: ["package.json"],
          validators: [{ id: "validator.test", version: "0.1.0" }],
        },
      }),
    );
    const output = join(allowed, "one");
    const result = produceApplication({
      recipePath: join(root, "recipe.json"),
      outputRoot: output,
      allowedOutputRoot: allowed,
      parameters: { applicationId: "@example/one" },
    });
    expect(result.files).toHaveLength(1);
    expect(result.bundleDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      produceApplication({
        recipePath: join(root, "recipe.json"),
        outputRoot: output,
        allowedOutputRoot: allowed,
        parameters: { applicationId: "@example/one" },
      }),
    ).toThrow(/must not exist|empty/iu);
  });
});

describe("observation, incident, and promotion", () => {
  const observation = {
    specversion: "1.0" as const,
    id: "event-test",
    source: "urn:coga:test-app",
    type: "coga.application.error",
    time: "2026-08-08T00:00:00.000Z",
    datacontenttype: "application/json" as const,
    data: { code: "AUTH_EXPIRED" },
    coga: {
      application: { id: "application.test", version: "0.1.0" },
      scope: "application" as const,
      classification: "internal" as const,
      retentionDays: 30,
      schemaRef: "urn:coga:schema:error:0.1.0",
      purpose: "Test incident flow",
      owner: "application.test.owner",
    },
  };

  test("keeps observations local and requires all closure evidence", () => {
    const valid = validateObservation(
      observation,
      new Date("2026-08-09T00:00:00.000Z"),
    );
    const incident = openIncident({
      id: "incident.test",
      observations: [valid],
      runbook: { id: "runbook.test", version: "0.1.0" },
    });
    expect(incident.severity).toBe("unassessed");
    expect(
      canCloseIncident({
        ...incident,
        closure: { ...incident.closure, deploymentSucceeded: true },
      }).allowed,
    ).toBe(false);
    const recovered = {
      ...incident,
      state: "verifying" as const,
      severity: "sev3" as const,
      closure: {
        severityAssignedByHuman: true,
        criticalJourneyPassed: true,
        monitoringRecovered: true,
        regressionEvidenceDigest: "a".repeat(64),
        deploymentSucceeded: false,
      },
    };
    expect(closeIncident(recovered).state).toBe("closed");
  });

  test("blocks one-app promotion without authority and always returns candidate", () => {
    const valid = validateObservation(
      observation,
      new Date("2026-08-09T00:00:00.000Z"),
    );
    const closed = closeIncident({
      ...openIncident({
        id: "incident.test",
        observations: [valid],
        runbook: { id: "runbook.test", version: "0.1.0" },
      }),
      state: "verifying",
      severity: "sev3",
      closure: {
        severityAssignedByHuman: true,
        criticalJourneyPassed: true,
        monitoringRecovered: true,
        regressionEvidenceDigest: "a".repeat(64),
      },
    });
    const base = {
      id: "promotion.test",
      incidents: [closed],
      targetPackage: { id: "package.domain", version: "0.1.0" },
      candidateArtifact: { lifecycle: "candidate" },
      consumerApplications: ["application.test"],
      authoritativeSources: [] as string[],
      privateTermsScanPassed: true,
      independentScenarios: ["scenario.denied"],
    };
    expect(() => proposePromotion(base)).toThrow(/authoritative/iu);
    const candidate = proposePromotion({
      ...base,
      authoritativeSources: ["https://example.com/authority"],
    });
    expect(candidate.lifecycle).toBe("candidate");
    expect(candidate.requiresHumanApproval).toBe(true);
  });
});
