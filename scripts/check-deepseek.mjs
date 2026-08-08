import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  DeepSeekAssetEvaluator,
  loadFactoryProfile,
  sha256,
} from "../packages/factory/dist/index.js";

const workspaceRoot = resolve(import.meta.dirname, "..");
const profilePath = resolve(
  workspaceRoot,
  "examples/broker-digital-channel/factory/profile.yaml",
);
const profile = loadFactoryProfile(profilePath).document;
const descriptor = profile.spec.adapters.find(
  (entry) => entry.runtime === "deepseek",
);

assert.ok(descriptor, "The example FactoryProfile has no DeepSeek adapter.");
assert.ok(
  process.env.DEEPSEEK_API_KEY,
  "Set DEEPSEEK_API_KEY in the process environment for this opt-in smoke test.",
);

const sourceMaterial = [
  "Public, sanitized candidate summary:",
  "The client uses a fresh backend entitlement snapshot as the authority for gated content.",
  "Missing, stale, or denied snapshots keep gated content hidden.",
  "The change alters failure behavior to default-deny and never grants a permission.",
].join("\n");

const result = await new DeepSeekAssetEvaluator(descriptor).assess({
  taskId: "provider-smoke.asset-evaluation",
  prompt:
    "Assess this candidate as a reusable Domain Harness rule. Identify semantic change classes, risks, and regression scenarios. Human approval remains mandatory.",
  sourceMaterial,
  sourceVisibility: "public",
  candidateDigest: sha256(sourceMaterial),
  timeoutMs: descriptor.config?.timeoutMs,
});

assert.equal(result.provider, "deepseek");
assert.match(result.promptDigest, /^[a-f0-9]{64}$/u);
assert.match(result.outputDigest, /^[a-f0-9]{64}$/u);
assert.ok(result.responseId.length > 0);
assert.ok(result.assessment.summary.length > 0);
assert.ok(
  !JSON.stringify(result).includes(process.env.DEEPSEEK_API_KEY),
  "Provider credential leaked into the assessment result.",
);

process.stdout.write(
  `${JSON.stringify(
    {
      provider: result.provider,
      model: result.model,
      responseId: result.responseId.slice(0, 32),
      recommendation: result.assessment.recommendation,
      confidence: result.assessment.confidence,
      changeClasses: result.assessment.changeClasses,
      usage: result.usage ?? {},
      credentialPersisted: false,
      approvalGranted: false,
    },
    null,
    2,
  )}\n`,
);
