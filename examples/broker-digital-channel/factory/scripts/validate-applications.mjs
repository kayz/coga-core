import assert from "node:assert/strict";
import { checkGolden, renderCandidate } from "./materialize.mjs";

const candidates = [
  "examples/broker-digital-channel/factory/recipes/candidates/aster-miniapp.candidate.json",
  "examples/broker-digital-channel/factory/recipes/candidates/cedar-h5.candidate.json",
];

for (const candidate of candidates) {
  const rendered = renderCandidate(candidate);
  checkGolden(rendered);
  const lock = JSON.parse(rendered.files.get("application-lock.json"));
  assert.deepEqual(
    lock.spec.harnessDependencies,
    rendered.recipe.spec.harnessDependencies,
  );
  assert.deepEqual(lock.spec.choices, rendered.candidate.spec.choices);
  process.stdout.write(
    `PASS ${rendered.candidate.spec.parameters.applicationId}: ${rendered.files.size} deterministic files\n`,
  );
}
