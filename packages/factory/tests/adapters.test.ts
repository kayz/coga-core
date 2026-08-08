import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DeepSeekAssetEvaluator,
  DeterministicAssetEvaluator,
} from "../src/adapters/asset-evaluator.js";
import { runCommandAdapter } from "../src/adapters/command-validator.js";
import type { AdapterDescriptor } from "../src/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.COGA_TEST_PROVIDER_KEY;
  vi.restoreAllMocks();
});

describe("command validator", () => {
  test("runs an exact executable without a shell and redacts output", async () => {
    const root = mkdtempSync(join(tmpdir(), "coga-command-"));
    const descriptor: AdapterDescriptor = {
      ref: { kind: "validator", id: "validator.test", version: "0.1.0" },
      runtime: "process",
      actions: ["validate"],
      config: {
        cwd: ".",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('api_key=temporary-value')"],
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
        envAllowlist: [],
      },
    };
    const result = await runCommandAdapter(descriptor, {
      root,
      action: "validate",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("temporary-value");
    expect(result.timedOut).toBe(false);
  });

  test("rejects shell runtimes and undeclared actions", async () => {
    const root = mkdtempSync(join(tmpdir(), "coga-command-"));
    const descriptor: AdapterDescriptor = {
      ref: { kind: "validator", id: "validator.test", version: "0.1.0" },
      runtime: "process",
      actions: ["validate"],
      config: {
        cwd: ".",
        executable: process.platform === "win32" ? "cmd.exe" : "sh",
      },
    };
    await expect(
      runCommandAdapter(descriptor, { root, action: "validate" }),
    ).rejects.toThrow(/shell/iu);
    descriptor.config!.executable = process.execPath;
    await expect(
      runCommandAdapter(descriptor, { root, action: "publish" }),
    ).rejects.toThrow(/does not allow/iu);
  });
});

describe("asset evaluators", () => {
  const request = {
    taskId: "task.test",
    prompt: "Assess authorization scope expansion.",
    sourceMaterial: "The public authority says backend permission is required.",
    sourceVisibility: "public" as const,
    candidateDigest: "a".repeat(64),
  };

  test("offline evaluator returns deterministic candidate evidence", async () => {
    const evaluator = new DeterministicAssetEvaluator();
    const first = await evaluator.assess(request);
    const second = await evaluator.assess(request);
    expect(first).toEqual(second);
    expect(first.assessment.changeClasses).toContain("scope-expanded");
    expect(first.provider).toBe("deterministic");
  });

  test("DeepSeek adapter validates JSON and never returns the credential", async () => {
    process.env.COGA_TEST_PROVIDER_KEY = "temporary-test-value";
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(
        String((init?.headers as Record<string, string>).authorization),
      ).toContain("temporary-test-value");
      return new Response(
        JSON.stringify({
          id: "response-test",
          model: "deepseek-v4-pro",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  summary: "Authority boundary preserved.",
                  changeClasses: ["permission-expanded"],
                  risks: [
                    {
                      severity: "high",
                      description: "Permission semantics changed.",
                      mitigation: "Run negative-path scenarios.",
                    },
                  ],
                  questions: [],
                  recommendedScenarios: ["scenario.permission.denied"],
                  recommendation: "revise",
                  confidence: 0.82,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const descriptor: AdapterDescriptor = {
      ref: { kind: "agent", id: "agent.deepseek.asset", version: "0.1.0" },
      runtime: "deepseek",
      actions: ["assess-asset"],
      config: {
        baseUrl: "https://api.deepseek.com/",
        model: "deepseek-v4-pro",
        secretRef: "env://COGA_TEST_PROVIDER_KEY",
        maxTokens: 1_024,
        allowRestrictedInput: false,
      },
    };
    const result = await new DeepSeekAssetEvaluator(descriptor).assess(request);
    expect(result.provider).toBe("deepseek");
    expect(result.model).toBe("deepseek-v4-pro");
    expect(JSON.stringify(result)).not.toContain("temporary-test-value");
  });

  test("DeepSeek adapter rejects non-public material before a request", async () => {
    process.env.COGA_TEST_PROVIDER_KEY = "temporary-test-value";
    const descriptor: AdapterDescriptor = {
      ref: { kind: "agent", id: "agent.deepseek.asset", version: "0.1.0" },
      runtime: "deepseek",
      actions: ["assess-asset"],
      config: {
        baseUrl: "https://api.deepseek.com/",
        model: "deepseek-v4-pro",
        secretRef: "env://COGA_TEST_PROVIDER_KEY",
        allowRestrictedInput: false,
      },
    };
    await expect(
      new DeepSeekAssetEvaluator(descriptor).assess({
        ...request,
        sourceVisibility: "restricted",
      }),
    ).rejects.toThrow(/public|sanitized/iu);
  });
});
