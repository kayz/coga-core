import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const suitePath = resolve(
  workspaceRoot,
  "examples/broker-digital-channel/factory/scenarios/executable-scenarios.yaml",
);
const suite = YAML.parse(readFileSync(suitePath, "utf8"));

function load(path) {
  const absolute = resolve(workspaceRoot, path);
  const text = readFileSync(absolute, "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
}

function entitlementDecision(input) {
  return input.authenticated === true &&
    input.entitlementDecision === "allow" &&
    input.entitlementFresh === true
    ? "allowed"
    : "denied";
}

function explicitState(state) {
  const states = {
    pending: "Checking authoritative context…",
    ready: "Current context is available.",
    empty: "No content is available.",
    denied: "This capability is not available.",
    error: "Context could not be loaded. Try again.",
  };
  if (!Object.hasOwn(states, state)) throw new Error("unknown-state");
  return states[state];
}

function releaseDecision(input) {
  if (input.health === "degraded" && !input.rollbackAvailable)
    return "block-and-escalate";
  if (!input.requiredChecksPassed || input.health === "degraded")
    return "rollback";
  return "continue";
}

function runIdentity(fixture) {
  for (const item of fixture.cases)
    assert.equal(entitlementDecision(item.input), item.expected, item.name);
}

function runFrontend(fixture) {
  for (const item of fixture.cases)
    assert.equal(explicitState(item.input), item.expected);
  assert.throws(
    () => explicitState(fixture.unknownState.input),
    /unknown-state/u,
  );
}

function runRelease(fixture) {
  for (const item of fixture.cases)
    assert.equal(releaseDecision(item.input), item.expected, item.name);
}

function promotionDecision(proposal) {
  if (
    proposal.spec.sourceApplications.length < 2 &&
    proposal.spec.authoritativeSources.length === 0
  ) {
    return "deny";
  }
  return "candidate";
}

function runPromotion(expected) {
  const firstObservation = load(
    "examples/broker-digital-channel/factory/fixtures/control/aster-entitlement.observation.yaml",
  );
  const secondObservation = load(
    "examples/broker-digital-channel/factory/fixtures/control/cedar-entitlement.observation.yaml",
  );
  const incident = load(
    "examples/broker-digital-channel/factory/fixtures/control/entitlement-evidence.incident.yaml",
  );
  const denied = load(
    "examples/broker-digital-channel/factory/fixtures/control/single-app.promotion.yaml",
  );
  const qualified = load(
    "examples/broker-digital-channel/factory/fixtures/control/qualified.promotion.yaml",
  );
  assert.equal(
    firstObservation.spec.cloudEvent.data.containsPersonalData,
    false,
  );
  assert.equal(
    secondObservation.spec.cloudEvent.data.containsPersonalData,
    false,
  );
  assert.deepEqual(incident.spec.observations[0], {
    id: firstObservation.metadata.id,
    version: firstObservation.metadata.version,
  });
  assert.equal(
    promotionDecision(denied),
    expected.singleApplicationWithoutAuthority.decision,
  );
  assert.equal(
    promotionDecision(qualified),
    expected.multiApplicationWithAuthority.decision,
  );
  assert.equal(
    qualified.metadata.lifecycle,
    expected.multiApplicationWithAuthority.maximumLifecycle,
  );
  assert.equal(
    expected.multiApplicationWithAuthority.requiresHumanApproval,
    true,
  );
}

const oracles = {
  "identity-entitlement-denial-first": runIdentity,
  "frontend-explicit-state": runFrontend,
  "release-rollback": runRelease,
  "incident-promotion": runPromotion,
};

for (const scenario of suite.spec.scenarios) {
  const oracle = oracles[scenario.oracle];
  if (!oracle) throw new Error(`Unknown bounded oracle: ${scenario.oracle}`);
  oracle(load(scenario.fixture));
  process.stdout.write(
    `PASS ${scenario.id}@${scenario.version} (${scenario.oracle})\n`,
  );
}
