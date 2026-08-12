import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";

test("factory verification has no network", async () => {
  await assert.rejects(
    fetch("https://example.com", { signal: AbortSignal.timeout(2_000) }),
  );
});

test("factory verification cannot mutate the repository mount", () => {
  assert.throws(() =>
    writeFileSync(
      "/workspace/examples/broker-digital-channel/applications/cedar-insight-h5/.sandbox-probe",
      "forbidden",
    ),
  );
});

test("factory verification receives no credential-shaped environment", () => {
  const names = Object.keys(process.env).filter((name) =>
    /(?:secret|token|password|credential|private.?key)/iu.test(name),
  );
  assert.deepEqual(names, []);
});
