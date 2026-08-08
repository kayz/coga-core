import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { digestJson } from "../src/canonical.js";
import { assertNoLiteralSecrets, resolveWithin } from "../src/security.js";
import { FileControlStore } from "../src/store.js";

const actor = {
  id: "human.test",
  type: "human" as const,
  roles: ["domain-steward"],
};

describe("workspace and secret boundaries", () => {
  test("rejects traversal, absolute paths, and literal secret fields", () => {
    const root = mkdtempSync(join(tmpdir(), "coga-security-"));
    expect(() => resolveWithin(root, "../escape")).toThrow(
      /relative|workspace/iu,
    );
    expect(() =>
      resolveWithin(
        root,
        process.platform === "win32" ? "C:\\escape" : "/escape",
      ),
    ).toThrow();
    expect(() =>
      assertNoLiteralSecrets({ apiKey: `sk-${"x".repeat(20)}` }),
    ).toThrow(/secret/iu);
    expect(() =>
      assertNoLiteralSecrets({ secretRef: "env://DEEPSEEK_API_KEY" }),
    ).not.toThrow();
  });
});

describe("file control store", () => {
  test("persists idempotently and detects journal tampering after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "coga-store-"));
    const clock = () => "2026-08-08T00:00:00.000Z";
    const store = new FileControlStore(root, {
      now: clock,
      nonce: () => "one",
    });
    const value = { id: "task.test", status: "created" };
    expect(store.put("tasks", "task.test", value, { createOnly: true })).toBe(
      digestJson(value),
    );
    expect(store.put("tasks", "task.test", value, { createOnly: true })).toBe(
      digestJson(value),
    );
    expect(() =>
      store.put(
        "tasks",
        "task.test",
        { ...value, status: "changed" },
        { createOnly: true },
      ),
    ).toThrow();
    store.appendAudit({
      runId: "run.test",
      type: "task.created",
      actor,
      payload: value,
    });
    store.appendAudit({
      runId: "run.test",
      type: "task.checked",
      actor,
      payload: { ok: true },
    });
    expect(store.verifyAudit()).toBe(true);
    const restarted = new FileControlStore(root, { now: clock });
    expect(restarted.get("tasks", "task.test")).toEqual(value);
    expect(restarted.verifyAudit()).toBe(true);

    const auditPath = join(root, "audit.jsonl");
    const lines = readFileSync(auditPath, "utf8").trim().split(/\r?\n/u);
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    event.type = "task.tampered";
    lines[0] = JSON.stringify(event);
    writeFileSync(auditPath, `${lines.join("\n")}\n`, "utf8");
    expect(restarted.verifyAudit()).toBe(false);
  });
});
