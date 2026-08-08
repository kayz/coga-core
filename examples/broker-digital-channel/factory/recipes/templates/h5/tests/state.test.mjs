import test from "node:test";
import assert from "node:assert/strict";
import { renderExplicitState } from "../src/state.mjs";

test("renders every declared state and rejects an implicit state", () => {
  for (const state of ["pending", "ready", "empty", "denied", "error"]) {
    assert.equal(typeof renderExplicitState(state), "string");
  }
  assert.throws(() => renderExplicitState("unknown"), /Unknown state/);
});
