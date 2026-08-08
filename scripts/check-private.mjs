import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";

import { validateControlResource } from "../packages/core/dist/index.js";
import { FactoryService } from "../packages/factory/dist/index.js";

const privateRoot = "private/application";
if (!existsSync(`${privateRoot}/package.json`)) {
  console.log(
    "No local-only application is present; public checks are complete.",
  );
  process.exit(0);
}

const manifest = spawnSync(
  process.execPath,
  ["../../packages/core/dist/cli.js", "validate", "local-instance.yaml"],
  {
    cwd: privateRoot,
    stdio: "inherit",
  },
);
if (manifest.status !== 0) process.exit(manifest.status ?? 1);

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  console.error("Run this integration gate through 'npm run check:local'.");
  process.exit(2);
}

for (const script of ["typecheck", "test", "build"]) {
  const result = spawnSync(
    process.execPath,
    [npmExecPath, "run", script, "--if-present"],
    {
      cwd: privateRoot,
      stdio: "inherit",
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const temporaryRoot = mkdtempSync(
  join(tmpdir(), "coga-private-factory-check-"),
);
const profilePath = resolve(
  "examples/broker-digital-channel/factory/profile.yaml",
);
const bindingPath = resolve(`${privateRoot}/factory.binding.yaml`);

function readYaml(path) {
  return YAML.parse(readFileSync(path, "utf8"));
}

try {
  const before = readYaml(
    "examples/broker-digital-channel/factory/changes/entitlement-deny-by-default/before.yaml",
  );
  const after = readYaml(
    "examples/broker-digital-channel/factory/changes/entitlement-deny-by-default/after.yaml",
  );
  const service = new FactoryService({
    profilePath,
    stateDirectory: join(temporaryRoot, "state"),
    extraBindingPaths: [bindingPath],
    now: () => "2026-08-08T02:00:00.000Z",
  });
  const binding = service.snapshot().applicationBindings[0];
  assert.equal(binding.application.id, "application.xinditing.mini.program");
  assert.equal(binding.networkTransport, "none");
  assert.equal(binding.publicationPolicy, "prohibited");

  const created = service.createIntent(
    {
      mode: "build",
      goal: "Verify the restricted Application against the exact public Harness locks without publishing it.",
      acceptanceCriteria: [
        "Public and private deterministic validators pass.",
        "The resulting preview remains local and release-blocked.",
      ],
      nonGoals: [
        "Do not upload, release, or copy restricted Application assets into the public Instance.",
      ],
      risk: "high",
      sources: [
        {
          uri: "https://owasp.org/www-project-application-security-verification-standard/",
          sourceType: "standard",
          authority: "OWASP ASVS",
          visibility: "public",
          excerpt:
            "Authorization decisions remain server-authoritative and client presentation fails closed.",
        },
      ],
      application: {
        id: "application.xinditing.mini.program",
        version: "0.1.0",
      },
      candidate: {
        artifactId: "broker.channel.entitlement.authority",
        before,
        after,
      },
    },
    {
      id: "human.private.change.requester",
      type: "human",
      roles: ["requester"],
    },
  );
  service.evaluatePolicy(created.task.metadata.id);
  await service.assessTask(created.task.metadata.id, "offline");
  const evidence = await service.runValidators(created.task.metadata.id);
  assert.equal(
    evidence.length,
    7,
    "Three public and four private validators must run.",
  );
  service.approve({
    taskId: created.task.metadata.id,
    actor: {
      id: "human.private.domain.reviewer",
      type: "human",
      roles: ["example.domain.reviewer"],
    },
    roles: ["example.domain.reviewer"],
    decision: "approve",
    reason:
      "Reviewed the private binding, exact Harness locks, impact, and all seven validator claims.",
    impactDigest: service.impactDigestFor(
      "broker.channel.entitlement.authority",
    ),
  });
  assert.equal(
    service.previewDecision(created.task.metadata.id).release,
    "blocked",
  );

  const fixture = service.loadBindingFixture(
    "application.xinditing.mini.program.factory.binding",
    "observation",
    1,
  );
  const observation = service.ingestObservation(fixture, {
    id: "human.private.operator",
    type: "human",
    roles: ["operator"],
  });
  assert.equal(validateControlResource(observation).valid, true);
  const incidentId = "incident.xinditing.preview.error";
  service.createIncident({
    id: incidentId,
    observationStoreIds: [observation.metadata.id],
    runbook: { id: "client.operations.incident.triage", version: "0.1.0" },
    actor: { id: "human.private.operator", type: "human", roles: ["operator"] },
  });
  service.updateIncident(
    incidentId,
    {
      state: "verifying",
      severity: "sev3",
      diagnosis:
        "The deterministic fixture reproduced a recoverable content-load failure after local preview.",
      repairCandidateDigest: "b".repeat(64),
      closure: {
        severityAssignedByHuman: true,
        criticalJourneyPassed: true,
        monitoringRecovered: true,
        regressionEvidenceDigest: "a".repeat(64),
        deploymentSucceeded: false,
      },
    },
    {
      id: "human.private.incident.commander",
      type: "human",
      roles: ["incident-commander"],
    },
  );
  service.updateIncident(
    incidentId,
    { state: "closed" },
    {
      id: "human.private.incident.commander",
      type: "human",
      roles: ["incident-commander"],
    },
  );
  const promotion = service.promote(
    {
      id: "promotion.xinditing.entitlement.failure",
      incidentIds: [incidentId],
      targetPackage: { id: "broker.digital.channel.domain", version: "0.1.0" },
      candidateArtifact: {
        lifecycle: "candidate",
        statement:
          "Missing or stale entitlement evidence remains visibly non-entitled.",
      },
      consumerApplications: [
        "application.xinditing.mini.program",
        "application.aster.mini.program",
      ],
      authoritativeSources: [
        "https://owasp.org/www-project-application-security-verification-standard/",
      ],
      privateTermsScanPassed: true,
      independentScenarios: ["client.operations.scenario.incident"],
    },
    {
      id: "human.private.domain.reviewer",
      type: "human",
      roles: ["example.domain.reviewer"],
    },
  );
  assert.equal(promotion.metadata.lifecycle, "candidate");
  const snapshot = service.snapshot();
  for (const collection of [
    snapshot.tasks,
    snapshot.runs,
    snapshot.evidence,
    snapshot.observations,
    snapshot.incidents,
    snapshot.promotions,
  ]) {
    for (const resource of collection) {
      const validation = validateControlResource(resource);
      assert.equal(
        validation.valid,
        true,
        validation.issues
          .map((entry) => `${entry.path} ${entry.message}`)
          .join("; "),
      );
    }
  }
  assert.equal(snapshot.auditValid, true);
  const resumed = new FactoryService({
    profilePath,
    stateDirectory: join(temporaryRoot, "state"),
    extraBindingPaths: [bindingPath],
  });
  assert.equal(resumed.snapshot().incidents.length, 1);
  console.log(
    "Private Application binding, seven-validator gate, local preview, incident, promotion, and restart checks passed.",
  );
} finally {
  const relativeTemporary = relative(tmpdir(), temporaryRoot);
  if (!relativeTemporary || relativeTemporary.startsWith("..")) {
    throw new Error(
      "Refusing to remove an unverified private-check directory.",
    );
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log("Local-only application checks passed.");
