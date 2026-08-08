import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

import { validateControlResource } from "../packages/core/dist/index.js";
import { FactoryService } from "../packages/factory/dist/index.js";

const workspaceRoot = resolve(import.meta.dirname, "..");
const exampleRoot = join(workspaceRoot, "examples", "broker-digital-channel");
const factoryRoot = join(exampleRoot, "factory");
const profilePath = join(factoryRoot, "profile.yaml");
const temporaryRoot = mkdtempSync(join(tmpdir(), "coga-factory-check-"));

function readDocument(path) {
  const source = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(source) : YAML.parse(source);
}

function run(executable, args, cwd = workspaceRoot) {
  const result = spawnSync(executable, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed with exit ${result.status ?? "unknown"}.`,
    );
  }
}

function writeRendered(files, target) {
  for (const [path, content] of files) {
    const destination = join(target, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, "utf8");
  }
}

async function verifyApplicationProduction() {
  const materializer = await import(
    pathToFileURL(join(factoryRoot, "scripts", "materialize.mjs")).href
  );
  const candidates = [
    "examples/broker-digital-channel/factory/recipes/candidates/aster-miniapp.candidate.json",
    "examples/broker-digital-channel/factory/recipes/candidates/cedar-h5.candidate.json",
  ];
  const npmExecPath = process.env.npm_execpath;
  assert.ok(
    npmExecPath,
    "The factory gate must run through npm so generated candidates can execute their scripts.",
  );
  for (const [index, candidatePath] of candidates.entries()) {
    const rendered = materializer.renderCandidate(candidatePath);
    materializer.checkGolden(rendered);
    const target = join(temporaryRoot, `application-${index + 1}`);
    writeRendered(rendered.files, target);
    run(process.execPath, [npmExecPath, "test"], target);
    run(process.execPath, [npmExecPath, "run", "build"], target);
  }
}

async function verifyGovernedLoop() {
  const changeRoot = join(
    factoryRoot,
    "changes",
    "entitlement-deny-by-default",
  );
  const change = readDocument(join(changeRoot, "change.yaml"));
  const before = readDocument(join(changeRoot, "before.yaml"));
  const after = readDocument(join(changeRoot, "after.yaml"));
  const excerpts = readDocument(
    join(
      factoryRoot,
      "fixtures",
      "sources",
      "entitlement-authority.excerpts.json",
    ),
  );
  const service = new FactoryService({
    profilePath,
    stateDirectory: join(temporaryRoot, "state"),
    now: () => "2026-08-08T00:00:00.000Z",
  });
  const created = service.createIntent(
    {
      mode: "calibrate",
      goal: change.spec.intent,
      acceptanceCriteria: [
        "All configured deterministic validators pass.",
        "Both locked example Applications appear in transitive impact.",
      ],
      nonGoals: ["Do not move backend authorization authority into a client."],
      risk: change.spec.risk,
      sources: excerpts.spec.excerpts.map((entry) => ({
        uri: entry.url,
        sourceType: "standard",
        authority: entry.sourceId,
        visibility: "public",
        excerpt: entry.text,
      })),
      application: { id: "application.aster.mini.program", version: "0.1.0" },
      candidate: {
        artifactId: after.metadata.id,
        before,
        after,
      },
    },
    {
      id: "human.example.change.requester",
      type: "human",
      roles: ["requester"],
    },
  );
  const repeated = service.createIntent(
    {
      mode: "calibrate",
      goal: change.spec.intent,
      acceptanceCriteria: [
        "All configured deterministic validators pass.",
        "Both locked example Applications appear in transitive impact.",
      ],
      nonGoals: ["Do not move backend authorization authority into a client."],
      risk: change.spec.risk,
      sources: excerpts.spec.excerpts.map((entry) => ({
        uri: entry.url,
        sourceType: "standard",
        authority: entry.sourceId,
        visibility: "public",
        excerpt: entry.text,
      })),
      application: { id: "application.aster.mini.program", version: "0.1.0" },
      candidate: { artifactId: after.metadata.id, before, after },
    },
    {
      id: "human.example.change.requester",
      type: "human",
      roles: ["requester"],
    },
  );
  assert.equal(
    repeated.task.metadata.id,
    created.task.metadata.id,
    "Intent replay must be idempotent.",
  );
  const policy = service.evaluatePolicy(created.task.metadata.id);
  assert.equal(policy.decision, "requireApproval");
  await service.assessTask(created.task.metadata.id, "offline");
  const validatorEvidence = await service.runValidators(
    created.task.metadata.id,
  );
  assert.equal(
    validatorEvidence.length,
    3,
    "Every public process validator must emit evidence.",
  );
  const impact = service.impactFor(after.metadata.id);
  const impactText = JSON.stringify(impact);
  assert.match(impactText, /application\.aster\.mini\.program/u);
  assert.match(impactText, /application\.cedar\.insight\.h5/u);
  service.approve({
    taskId: created.task.metadata.id,
    actor: {
      id: "human.example.domain.reviewer",
      type: "human",
      roles: ["example.domain.reviewer"],
    },
    roles: ["example.domain.reviewer"],
    decision: "approve",
    reason:
      "Reviewed authority, semantic change, transitive impact, and all digest-bound evidence.",
    impactDigest: service.impactDigestFor(after.metadata.id),
  });
  assert.deepEqual(service.previewDecision(created.task.metadata.id), {
    taskId: created.task.metadata.id,
    status: "ready-for-human-preview",
    scope: "local-only",
    release: "blocked",
    reason:
      "The reference adapter has no upload or production-release capability.",
    decidedAt: "2026-08-08T00:00:00.000Z",
  });
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
        validation.issues.map((entry) => entry.message).join("; "),
      );
    }
  }
  assert.equal(
    snapshot.auditValid,
    true,
    "Append-only local journal must verify.",
  );
  const resumed = new FactoryService({
    profilePath,
    stateDirectory: join(temporaryRoot, "state"),
  });
  assert.equal(
    resumed.snapshot().tasks.length,
    1,
    "Restart must resume the same task journal.",
  );
}

try {
  run(process.execPath, [join(factoryRoot, "scripts", "validate-factory.mjs")]);
  run(process.execPath, [join(factoryRoot, "scripts", "run-scenarios.mjs")]);
  run(process.execPath, [
    join(factoryRoot, "scripts", "validate-applications.mjs"),
  ]);
  await verifyApplicationProduction();
  await verifyGovernedLoop();
  process.stdout.write(
    "Factory, dual-Application production, governed evidence, approval, and restart checks passed.\n",
  );
} finally {
  const relativeTemporary = relative(tmpdir(), temporaryRoot);
  if (!relativeTemporary || relativeTemporary.startsWith("..")) {
    throw new Error("Refusing to remove an unverified temporary directory.");
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
