import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  EXPECTED_REPOSITORY,
  RELEASE_NODE_VERSION,
  RELEASE_NPM_VERSION,
  buildProductionGraph,
  buildSbom,
  canonicalJson,
  readPackageState,
  validateReleaseTag,
  verifySbom,
} from "../release/lib.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const source = {
  repository: EXPECTED_REPOSITORY,
  commit: "a".repeat(40),
  tag: null,
};

test("production graph contains all five direct dependencies and their closure", async () => {
  assert.equal(process.versions.node, RELEASE_NODE_VERSION);
  assert.equal(
    process.env.npm_config_user_agent.split(" ")[0],
    `npm/${RELEASE_NPM_VERSION}`,
  );
  const { packageJson, lock } = await readPackageState(rootDir);
  const graph = buildProductionGraph(packageJson, lock);
  assert.deepEqual([...graph.get("@coga/core@0.2.0")].sort(), [
    "@apidevtools/openapi-schemas@2.1.0",
    "ajv-formats@3.0.1",
    "ajv@8.20.0",
    "semver@7.8.5",
    "yaml@2.9.0",
  ]);
  assert.ok(graph.has("fast-uri@3.1.5"));
  assert.ok(!graph.has("vitest@3.2.7"));
  assert.ok(!graph.has("typescript@5.9.3"));
});

test("normalized CycloneDX SBOM is deterministic and lock-complete", async () => {
  const first = await buildSbom(rootDir, source);
  const second = await buildSbom(rootDir, source);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.serialNumber, undefined);
  assert.equal(first.metadata.timestamp, undefined);
  assert.ok(
    first.components.some((component) => component["bom-ref"] === "yaml@2.9.0"),
  );
  await verifySbom(rootDir, first, source);
});

test("release tag is exact and agrees with the package version", () => {
  assert.doesNotThrow(() => validateReleaseTag("v0.2.0", "0.2.0"));
  assert.throws(
    () => validateReleaseTag("v0.2", "0.2.0"),
    /exact vMAJOR\.MINOR\.PATCH/u,
  );
  assert.throws(() => validateReleaseTag("v0.2.1", "0.2.0"), /does not match/u);
});

test("release workflow is version-only, least-privilege, draft-only, and exactly pinned", async () => {
  const workflowText = await readFile(
    path.join(rootDir, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const workflow = parse(workflowText);
  assert.deepEqual(workflow.on, { push: { tags: ["v*"] } });
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.jobs.build["runs-on"], "ubuntu-24.04");
  assert.deepEqual(workflow.jobs.build.permissions, { contents: "read" });
  assert.equal(workflow.jobs["attest-draft"].needs, "build");
  assert.deepEqual(workflow.jobs["attest-draft"].permissions, {
    contents: "write",
    "id-token": "write",
    attestations: "write",
    "artifact-metadata": "write",
  });
  assert.match(
    workflowText,
    /\+refs\/heads\/main:refs\/remotes\/origin\/main/u,
  );
  assert.match(workflowText, /\.verification\.verified/u);
  assert.match(workflowText, /\.verification\.reason/u);
  assert.match(workflowText, /gh release create[\s\S]*--draft/u);
  assert.match(workflowText, /gh release upload/u);
  assert.match(workflowText, /--jq '\.draft'/u);
  assert.doesNotMatch(workflowText, /immutable-releases|--draft=false/u);
  assert.doesNotMatch(workflowText, /npm publish|NPM_TOKEN|secrets\./u);
  assert.doesNotMatch(
    workflowText,
    /ubuntu-latest|node-version:\s*(?:latest|current)/u,
  );
  const buildText = JSON.stringify(workflow.jobs.build);
  const privilegedText = JSON.stringify(workflow.jobs["attest-draft"]);
  assert.match(buildText, /persist-credentials.*false/u);
  assert.doesNotMatch(buildText, /id-token|contents.*write|actions\/attest/u);
  assert.doesNotMatch(
    privilegedText,
    /actions\/checkout|setup-node|npm (?:ci|run)|scripts\/release/u,
  );
  assert.match(privilegedText, /commits\/main/u);
  assert.match(privilegedText, /verification\.verified/u);
  assert.match(privilegedText, /verification\.reason/u);
  assert.match(privilegedText, /SHA256SUMS/u);
  assert.ok(
    privilegedText.lastIndexOf("commits/main") >
      privilegedText.lastIndexOf("actions/attest"),
  );
  const uses = [
    ...workflowText.matchAll(/^\s*uses:\s*(\S+)\s*(?:#.*)?$/gmu),
  ].map((match) => match[1]);
  assert.equal(uses.length, 6);
  for (const action of uses) assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/u);
});

test("release CLIs reject a dangling tag option", async () => {
  for (const script of [
    "generate.mjs",
    "verify.mjs",
    "reproducibility-check.mjs",
  ]) {
    const text = await readFile(
      path.join(rootDir, "scripts", "release", script),
      "utf8",
    );
    assert.match(text, /tagIndex >= 0 && !args\[tagIndex \+ 1\]/u);
  }
});
