import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");

function read(path) {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

function document(path) {
  const source = read(path);
  return path.endsWith(".json") ? JSON.parse(source) : YAML.parse(source);
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestFile(path) {
  return digestText(read(path));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function digestJson(value) {
  return digestText(JSON.stringify(canonical(value)));
}

function schema(path) {
  return JSON.parse(read(path));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema("packages/core/schemas/common.schema.json"));
const validators = new Map();

function validate(path, schemaPath) {
  let validator = validators.get(schemaPath);
  if (!validator) {
    validator = ajv.compile(schema(schemaPath));
    validators.set(schemaPath, validator);
  }
  const value = document(path);
  if (!validator(value)) {
    const detail = (validator.errors ?? [])
      .map((entry) => `${entry.instancePath || "/"} ${entry.message}`)
      .join("; ");
    throw new Error(`${path} violates ${schemaPath}: ${detail}`);
  }
  return value;
}

const profile = validate(
  "examples/broker-digital-channel/factory/profile.yaml",
  "packages/factory/schemas/factory-profile.schema.json",
);
const instance = document("examples/broker-digital-channel/instance.yaml");
const expectedLayers = [
  "domain",
  "platform",
  "engineering",
  "organization",
  "operations",
];
const actualLayers = instance.spec.packages
  .map(
    (entry) =>
      document(`examples/broker-digital-channel/${entry.path}`).spec.layer,
  )
  .sort();
assert.deepEqual(
  actualLayers,
  [...expectedLayers].sort(),
  "Factory profile must retain all five layers",
);
assert.equal(profile.spec.workspaceRoot, "..");
assert.equal(profile.spec.policies.publishedMutation, "deny");
assert.equal(profile.spec.policies.promotionRequiresHuman, true);
assert.equal(profile.spec.policies.releaseRequiresHuman, true);
assert.equal(profile.spec.policies.separationOfDuties, true);

const deepseek = profile.spec.adapters.find(
  (entry) => entry.runtime === "deepseek",
);
assert(deepseek, "Factory profile must bind the DeepSeek evaluator");
assert.equal(deepseek.config.model, "deepseek-v4-pro");
assert.equal(deepseek.config.secretRef, "env://DEEPSEEK_API_KEY");
assert.equal(deepseek.config.allowRestrictedInput, false);
assert(deepseek.actions.includes("assess-asset"));

const evaluationProfile = validate(
  "examples/broker-digital-channel/factory/evaluation/asset-evaluator.profile.yaml",
  "examples/broker-digital-channel/factory/schemas/agent-evaluation-profile.schema.json",
);
assert.equal(evaluationProfile.spec.authority.mayApprove, false);
assert.equal(evaluationProfile.spec.authority.mayPublish, false);
assert.equal(evaluationProfile.spec.inputPolicy.restrictedInput, "deny");

const assessment = validate(
  "examples/broker-digital-channel/factory/fixtures/evaluation/entitlement-change.output.json",
  "packages/factory/schemas/asset-assessment.schema.json",
);
assert.equal(assessment.recommendation, "ready");

for (const candidate of [
  "examples/broker-digital-channel/factory/recipes/candidates/aster-miniapp.candidate.json",
  "examples/broker-digital-channel/factory/recipes/candidates/cedar-h5.candidate.json",
]) {
  validate(
    candidate,
    "examples/broker-digital-channel/factory/schemas/application-recipe-candidate.schema.json",
  );
}

for (const recipe of [
  "examples/broker-digital-channel/factory/recipes/wechat-miniapp.recipe.yaml",
  "examples/broker-digital-channel/factory/recipes/h5.recipe.yaml",
]) {
  validate(recipe, "packages/factory/schemas/application-recipe.schema.json");
}

validate(
  "examples/broker-digital-channel/factory/scenarios/executable-scenarios.yaml",
  "examples/broker-digital-channel/factory/schemas/executable-scenario-suite.schema.json",
);
validate(
  "examples/broker-digital-channel/factory/changes/entitlement-deny-by-default/before.yaml",
  "packages/core/schemas/domain-artifact.schema.json",
);
const after = validate(
  "examples/broker-digital-channel/factory/changes/entitlement-deny-by-default/after.yaml",
  "packages/core/schemas/domain-artifact.schema.json",
);
assert.equal(after.metadata.lifecycle, "candidate");

const controlFiles = [
  "examples/broker-digital-channel/factory/fixtures/control/evaluate-entitlement-change.task.yaml",
  "examples/broker-digital-channel/factory/fixtures/control/evaluate-entitlement-change.evidence.yaml",
  "examples/broker-digital-channel/factory/fixtures/control/evaluate-entitlement-change.run.yaml",
  "examples/broker-digital-channel/factory/fixtures/control/aster-entitlement.observation.yaml",
  "examples/broker-digital-channel/factory/fixtures/control/cedar-entitlement.observation.yaml",
  "examples/broker-digital-channel/factory/fixtures/control/entitlement-evidence.incident.yaml",
  "examples/broker-digital-channel/factory/fixtures/control/single-app.promotion.yaml",
  "examples/broker-digital-channel/factory/fixtures/control/qualified.promotion.yaml",
];
for (const path of controlFiles)
  validate(path, "packages/core/schemas/control.schema.json");

const sourceSet = document(
  "examples/broker-digital-channel/factory/fixtures/sources/entitlement-authority.excerpts.json",
);
for (const excerpt of sourceSet.spec.excerpts) {
  assert(
    profile.spec.sourceAllowlist.some((prefix) =>
      excerpt.url.startsWith(prefix),
    ),
    `Source is outside the Instance allowlist: ${excerpt.url}`,
  );
  assert.equal(
    excerpt.digest,
    digestText(excerpt.text),
    `Excerpt digest differs: ${excerpt.sourceId}`,
  );
}

const evidencePath =
  "examples/broker-digital-channel/factory/fixtures/control/evaluate-entitlement-change.evidence.yaml";
const evidence = document(evidencePath);
assert.equal(evidence.spec.disposition, "candidate");
assert.equal(evidence.spec.producedBy.kind, "agent");
for (const material of [evidence.spec.subject, ...evidence.spec.materials]) {
  assert.equal(
    material.digest,
    digestFile(material.path),
    `Evidence material differs: ${material.path}`,
  );
}
assert.equal(
  evidence.spec.execution.model.promptDigest,
  digestFile(
    "examples/broker-digital-channel/factory/prompts/asset-evaluator.v1.md",
  ),
);
assert.equal(
  evidence.spec.execution.model.outputDigest,
  digestFile(
    "examples/broker-digital-channel/factory/fixtures/evaluation/entitlement-change.output.json",
  ),
);

const taskPath =
  "examples/broker-digital-channel/factory/fixtures/control/evaluate-entitlement-change.task.yaml";
const candidatePath =
  "examples/broker-digital-channel/factory/changes/entitlement-deny-by-default/after.yaml";
const impactPath =
  "examples/broker-digital-channel/factory/changes/entitlement-deny-by-default/expected-impact.json";
const run = document(
  "examples/broker-digital-channel/factory/fixtures/control/evaluate-entitlement-change.run.yaml",
);
assert.equal(run.spec.taskDigest, digestFile(taskPath));
assert.equal(run.spec.candidateDigest, digestFile(candidatePath));
assert.equal(run.spec.evidenceDigest, digestFile(evidencePath));
assert.equal(run.spec.impactDigest, digestFile(impactPath));
assert.equal(run.spec.policyDecisions[0].decision, "requireApproval");
assert.equal(run.spec.approvalDecisions.length, 2);
for (const decision of run.spec.approvalDecisions) {
  assert.equal(decision.actor.kind, "human");
  assert.notEqual(decision.actor.id, evidence.spec.producedBy.id);
  assert.equal(decision.candidateDigest, run.spec.candidateDigest);
  assert.equal(decision.taskDigest, run.spec.taskDigest);
  assert.equal(decision.evidenceDigest, run.spec.evidenceDigest);
  assert.equal(decision.impactDigest, run.spec.impactDigest);
}

const deniedPromotion = document(
  "examples/broker-digital-channel/factory/fixtures/control/single-app.promotion.yaml",
);
const qualifiedPromotion = document(
  "examples/broker-digital-channel/factory/fixtures/control/qualified.promotion.yaml",
);
assert.equal(deniedPromotion.spec.sourceApplications.length, 1);
assert.equal(deniedPromotion.spec.authoritativeSources.length, 0);
assert.equal(qualifiedPromotion.metadata.lifecycle, "candidate");
assert(qualifiedPromotion.spec.sourceApplications.length >= 2);
assert(qualifiedPromotion.spec.authoritativeSources.length >= 1);

const impact = document(impactPath);
assert.deepEqual(
  impact.affectedApplications.map((entry) => entry.id).sort(),
  instance.spec.applications.map((entry) => entry.id).sort(),
  "Expected impact must include both registered applications",
);
assert(
  impact.rerunScenarios.includes("client.operations.scenario.release@0.1.0"),
);
assert(
  impact.rerunRunbooks.includes("client.operations.release.rollback@0.1.0"),
);

const releaseInputsPath =
  "examples/broker-digital-channel/factory/releases/broker-channel-0.1.0.inputs.yaml";
const releaseInputs = validate(
  releaseInputsPath,
  "examples/broker-digital-channel/factory/schemas/harness-release-inputs.schema.json",
);
assert.equal(releaseInputs.spec.packages.length, 5);
for (const [category, entries] of Object.entries(
  releaseInputs.spec.materials,
)) {
  for (const material of entries) {
    const path = `examples/broker-digital-channel/${material.path}`;
    assert.equal(
      material.digest,
      digestFile(path),
      `${category} material differs: ${material.path}`,
    );
    assert.equal(material.visibility, "public");
  }
}

const planPath =
  "examples/broker-digital-channel/factory/releases/broker-channel-0.1.0.plan.yaml";
const plan = document(planPath);
assert.equal(plan.schemaVersion, "coga.dev/release/v0.1");
assert.deepEqual(plan.packages, releaseInputs.spec.packages);
const plannedInputMaterials = [
  ...releaseInputs.spec.materials.packages,
  ...releaseInputs.spec.materials.artifacts,
  ...releaseInputs.spec.materials.contracts,
  ...releaseInputs.spec.materials.scenarios,
  ...releaseInputs.spec.materials.prompts,
];
assert.deepEqual(plan.resources, plannedInputMaterials);
assert.deepEqual(
  plan.provenance.map((entry) => entry.digest),
  sourceSet.spec.excerpts.map((entry) => entry.digest),
);
assert.deepEqual(plan.evidenceDigests, [
  digestFile(evidencePath),
  digestFile(
    "examples/broker-digital-channel/factory/fixtures/control/evaluate-entitlement-change.run.yaml",
  ),
]);
const { releaseDigest, ...releaseContent } = plan;
assert.equal(releaseDigest, digestJson(releaseContent));

validate(
  "examples/broker-digital-channel/factory/fixtures/control/aster-entitlement.observation.yaml",
  "packages/core/schemas/control.schema.json",
);
const observation = document(
  "examples/broker-digital-channel/factory/fixtures/control/aster-entitlement.observation.yaml",
);
const observationValidator = ajv.compile(
  schema(
    "examples/broker-digital-channel/factory/schemas/sanitized-observation.schema.json",
  ),
);
assert(observationValidator(observation.spec.cloudEvent.data));

for (const form of [
  "examples/broker-digital-channel/ui/artifact-candidate.form.schema.json",
  "examples/broker-digital-channel/ui/factory-change.form.schema.json",
]) {
  ajv.compile(schema(form));
}

const factoryText = read(
  "examples/broker-digital-channel/factory/evaluation/asset-evaluator.profile.yaml",
);
assert(
  !/deepseek-(?:chat|reasoner|v3)/iu.test(factoryText),
  "Retired model binding is forbidden",
);
assert(
  !/(?:sk-|Bearer\s+)[A-Za-z0-9_-]{12,}/u.test(factoryText),
  "Literal credential detected",
);
assert.equal((factoryText.match(/env:\/\/DEEPSEEK_API_KEY/gu) ?? []).length, 1);

process.stdout.write(
  "Factory slice valid: five layers, governed evaluation, control fixtures, public closure, and two application consumers\n",
);
