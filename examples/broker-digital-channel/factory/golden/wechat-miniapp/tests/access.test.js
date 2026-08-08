const test = require("node:test");
const assert = require("node:assert/strict");
const { canPresentEntitledCapability } = require("../src/domain/access.js");

test("denies unless authoritative entitlement evidence is current and positive", () => {
  assert.equal(canPresentEntitledCapability(undefined), false);
  assert.equal(
    canPresentEntitledCapability({
      authenticated: true,
      entitlementDecision: "allow",
      entitlementFresh: false,
    }),
    false,
  );
  assert.equal(
    canPresentEntitledCapability({
      authenticated: true,
      entitlementDecision: "deny",
      entitlementFresh: true,
    }),
    false,
  );
  assert.equal(
    canPresentEntitledCapability({
      authenticated: true,
      entitlementDecision: "allow",
      entitlementFresh: true,
    }),
    true,
  );
});
