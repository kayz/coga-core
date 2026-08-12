import assert from "node:assert/strict";
import test from "node:test";
import { createViewModel, customerAccessState } from "../src/domain.mjs";
import { statusMessage } from "../src/app.mjs";

const now = new Date("2026-08-12T00:00:00.000Z");

test("defaults to a public summary without inventing customer authority", () => {
  assert.equal(customerAccessState({ authenticated: false }, now), "public");
  assert.deepEqual(createViewModel({ authenticated: false }, now), {
    accessState: "public",
    heading: "Cedar market context",
    sourceLabel: "Fictitious broker learning feed",
    accessLabel: "Public summary",
    canRequestSupport: false,
  });
});

test("announces access state and source as text", () => {
  assert.equal(
    statusMessage(createViewModel({ authenticated: false }, now)),
    "Access state: Public summary. Source: Fictitious broker learning feed.",
  );
});

test("accepts only an unexpired authoritative customer context", () => {
  const context = {
    subjectRef: "opaque-subject",
    authenticated: true,
    authorityVersion: "decision-7",
    expiresAt: "2026-08-12T01:00:00.000Z",
  };
  assert.equal(customerAccessState(context, now), "customer");
  assert.equal(createViewModel(context, now).canRequestSupport, true);
});

test("fails closed for expired and malformed context", () => {
  assert.equal(
    customerAccessState(
      { authenticated: true, expiresAt: "2026-08-11T23:59:59.000Z" },
      now,
    ),
    "expired",
  );
  assert.equal(
    customerAccessState({ authenticated: true, expiresAt: "not-a-date" }, now),
    "unavailable",
  );
  assert.equal(customerAccessState(null, now), "unavailable");
});
