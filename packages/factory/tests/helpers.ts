import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

import type { FactoryProfile } from "../src/types.js";

export function createFixtureWorkspace(root: string): {
  profilePath: string;
  statePath: string;
} {
  const fixture = fileURLToPath(
    new URL("../../core/tests/fixtures/valid/", import.meta.url),
  );
  cpSync(fixture, root, { recursive: true });
  const profile: FactoryProfile = {
    schemaVersion: "coga.dev/factory/v0.1",
    kind: "FactoryProfile",
    metadata: {
      id: "factory.test.reference",
      title: "Factory test reference",
      version: "0.1.0",
    },
    spec: {
      workspaceRoot: ".",
      instanceManifest: "instance.yaml",
      stateDirectory: ".coga",
      candidateDirectory: ".coga/candidates",
      adapters: [
        {
          ref: {
            kind: "workspace",
            id: "workspace.test.files",
            version: "0.1.0",
          },
          runtime: "builtin",
          actions: ["candidate.patch"],
        },
        {
          ref: {
            kind: "agent",
            id: "agent.offline.asset.evaluator",
            version: "0.1.0",
          },
          runtime: "builtin",
          actions: ["assess-asset"],
        },
        {
          ref: {
            kind: "validator",
            id: "validator.test.pass",
            version: "0.1.0",
          },
          runtime: "process",
          actions: ["validate"],
          config: {
            cwd: ".",
            executable: process.execPath,
            args: ["-e", "process.stdout.write('validator passed')"],
            timeoutMs: 5_000,
            outputLimitBytes: 16_384,
            envAllowlist: [],
          },
        },
        {
          ref: { kind: "preview", id: "preview.local.only", version: "0.1.0" },
          runtime: "builtin",
          actions: ["open-local-preview"],
        },
        {
          ref: {
            kind: "policy",
            id: "policy.test.governance",
            version: "0.1.0",
          },
          runtime: "builtin",
          actions: ["risk-evaluate"],
        },
      ],
      policies: {
        maxAutonomousRisk: "low",
        promotionRequiresHuman: true,
        releaseRequiresHuman: true,
        separationOfDuties: true,
        publishedMutation: "deny",
        requiredRoles: { candidate: ["domain-steward"] },
      },
      sourceAllowlist: ["https://example.com/"],
      workbench: { host: "127.0.0.1", port: 4376, locale: "zh-CN" },
    },
  };
  const profilePath = join(root, "profile.yaml");
  writeFileSync(profilePath, stringify(profile), "utf8");
  const statePath = join(root, ".state");
  mkdirSync(statePath, { recursive: true });
  return { profilePath, statePath };
}

export function testIntent() {
  return {
    mode: "calibrate" as const,
    goal: "Clarify default-deny behavior for an expired authorization snapshot.",
    acceptanceCriteria: [
      "Denied access is proven by a negative-path scenario.",
    ],
    nonGoals: ["Do not change backend authority."],
    risk: "high" as const,
    sources: [
      {
        uri: "https://example.com/authority",
        sourceType: "standard" as const,
        authority: "Public test authority",
        visibility: "public" as const,
        excerpt:
          "Authorization remains server-owned and stale evidence denies access.",
      },
    ],
    candidate: {
      artifactId: "domain.customer.identity",
      before: {
        metadata: {
          id: "domain.customer.identity",
          version: "0.1.0",
          lifecycle: "published",
        },
        spec: { statement: "Identity assertions are server-owned." },
      },
      after: {
        metadata: {
          id: "domain.customer.identity",
          version: "0.2.0",
          lifecycle: "candidate",
        },
        spec: {
          statement:
            "Identity assertions are server-owned; stale authorization evidence denies access.",
        },
      },
    },
  };
}
