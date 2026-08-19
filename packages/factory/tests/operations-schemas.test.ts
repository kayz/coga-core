import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";
import { createFactorySloReport, loadFactorySloPolicy } from "../src/slo.js";

const names = [
  "factory-task",
  "evidence-archive-receipt",
  "slo-policy",
  "slo-report",
  "merge-authorization",
  "test-environment-authorization",
  "platform-evidence",
] as const;

function compile(name: (typeof names)[number]): ValidateFunction {
  const schema = JSON.parse(
    readFileSync(
      new URL(`../schemas/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  ) as object;
  const require = createRequire(import.meta.url);
  const addFormats = require("ajv-formats") as FormatsPlugin;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("Factory Operations schemas", () => {
  it("strictly compiles every exported operations schema", () => {
    for (const name of names) {
      expect(() => compile(name), name).not.toThrow();
    }
  });

  it("accepts the tracked policy and its insufficient-data report", () => {
    const policy = loadFactorySloPolicy(
      fileURLToPath(
        new URL("../../../.coga/factory-slo-policy.json", import.meta.url),
      ),
    );
    const report = createFactorySloReport(policy, [], {
      measuredAt: "2026-09-01T00:00:00.000Z",
    });
    const validatePolicy = compile("slo-policy");
    const validateReport = compile("slo-report");
    expect(validatePolicy(policy), JSON.stringify(validatePolicy.errors)).toBe(
      true,
    );
    expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(
      true,
    );
    expect(report.compliant).toBe(false);
  });
});
