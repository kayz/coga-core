import assert from "node:assert/strict";
import test from "node:test";
import { accessState, viewModel } from "../src/domain.mjs";

const now = new Date("2026-08-12T00:00:00.000Z");

test("keeps the public brief separate from customer authority", () => {
  assert.equal(accessState({ authenticated: false }, now), "public");
  assert.deepEqual(viewModel({ authenticated: false }, now), {
    state: "public",
    heading: "Birch research brief",
    source: "Fictitious learning desk",
    access: "Public learning brief",
    supportEnabled: false,
  });
});

test("enables support only for a current authenticated context", () => {
  const current = {
    authenticated: true,
    expiresAt: "2026-08-12T01:00:00.000Z",
  };
  assert.equal(accessState(current, now), "customer");
  assert.equal(viewModel(current, now).supportEnabled, true);
  assert.equal(
    accessState({ ...current, expiresAt: "2026-08-11T23:59:59.000Z" }, now),
    "expired",
  );
});

test("fails closed for malformed customer context", () => {
  assert.equal(accessState(null, now), "unavailable");
  assert.equal(
    accessState({ authenticated: true, expiresAt: "invalid" }, now),
    "unavailable",
  );
  assert.doesNotThrow(() =>
    accessState({
      authenticated: true,
      expiresAt: {
        toString() {
          throw new Error("must not coerce hostile input");
        },
      },
    }),
  );
  assert.equal(
    accessState({ authenticated: true, expiresAt: {} }, now),
    "unavailable",
  );
});
