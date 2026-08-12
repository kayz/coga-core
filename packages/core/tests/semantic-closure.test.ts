import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { load } from "../src/loader.js";
import { validate } from "../src/validation.js";
import type {
  Application,
  CogaInstance,
  DomainArtifact,
  HarnessPackage,
  LoadedCogaInstance,
} from "../src/types.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const validManifest = resolve(
  testDirectory,
  "fixtures",
  "valid",
  "instance.yaml",
);

function fixture(profile: "local" | "public" | "release" = "local") {
  return load(validManifest, { profile });
}

function issueCodes(loaded: LoadedCogaInstance): string[] {
  return validate(loaded).issues.map((entry) => entry.code);
}

function packageDocument(
  loaded: LoadedCogaInstance,
  id: string,
): HarnessPackage {
  return loaded.packages.find(
    (entry) => (entry.document as HarnessPackage).metadata.id === id,
  )!.document as HarnessPackage;
}

function artifactDocument(
  loaded: LoadedCogaInstance,
  id: string,
): DomainArtifact {
  return loaded.artifacts.find(
    (entry) => (entry.document as DomainArtifact).metadata.id === id,
  )!.document as DomainArtifact;
}

describe("COGA 0.2 semantic closure", () => {
  it("accepts the complete fixture in local and release profiles", () => {
    expect(validate(fixture()).issues).toEqual([]);
    expect(validate(fixture("release")).issues).toEqual([]);
  });

  it("rejects the v0.1 envelope instead of dual-reading it", () => {
    const loaded = fixture();
    (
      loaded.instance.document as unknown as Record<string, unknown>
    ).schemaVersion = "coga.dev/v0.1";

    expect(issueCodes(loaded)).toEqual(
      expect.arrayContaining(["instance.kind-required", "schema.const"]),
    );
  });

  it("reports package cycles and unreachable cross-package relations", () => {
    const cycled = fixture();
    packageDocument(cycled, "example.broker-channel.domain").spec.dependencies =
      [{ id: "example.broker-channel.operations", version: "0.2.0" }];
    expect(issueCodes(cycled)).toContain("dependency.package-cycle");

    const unreachable = fixture();
    packageDocument(
      unreachable,
      "example.broker-channel.operations",
    ).spec.dependencies = [];
    artifactDocument(
      unreachable,
      "runbook.channel.api-degradation",
    ).spec.relations = [
      {
        type: "depends-on",
        target: { id: "domain.customer.identity", version: "0.2.0" },
      },
    ];
    expect(issueCodes(unreachable)).toContain(
      "dependency.artifact-relation-unreachable",
    );
  });

  it("requires application artifact bindings to be in its Harness closure", () => {
    const loaded = fixture();
    const application = loaded.applications[0]!.document as Application;
    application.spec.harnessDependencies = [
      { id: "example.broker-channel.domain", version: "0.2.0" },
    ];
    expect(issueCodes(loaded)).toContain(
      "dependency.application-artifact-unreachable",
    );
  });

  it("enforces the scope matrix including owner-package scope", () => {
    const applicationScope = fixture();
    (applicationScope.applications[0]!.document as Application).metadata.scope =
      "core";
    expect(issueCodes(applicationScope)).toContain("scope.invalid-for-kind");

    const artifactScope = fixture();
    artifactDocument(artifactScope, "domain.customer.identity").metadata.scope =
      "core";
    expect(issueCodes(artifactScope)).toContain("scope.invalid-for-kind");
  });

  it("validates governance Policy existence and artifact type", () => {
    const dangling = fixture();
    (
      dangling.instance.document as CogaInstance
    ).spec.governance.approvalRules[0]!.policies = [
      { id: "policy.missing", version: "0.2.0" },
    ];
    expect(issueCodes(dangling)).toContain("governance.policy-dangling");

    const wrongType = fixture();
    (
      wrongType.instance.document as CogaInstance
    ).spec.governance.approvalRules[0]!.policies = [
      { id: "domain.customer.identity", version: "0.2.0" },
    ];
    expect(issueCodes(wrongType)).toContain("governance.policy-type");
  });

  it("requires release approval attestations for every governed lifecycle", () => {
    const loaded = fixture("release");
    artifactDocument(
      loaded,
      "domain.customer.access-rule",
    ).metadata.attestations = [];
    expect(issueCodes(loaded)).toContain("governance.approval-required");
  });

  it("requires lifecycle release evidence in the release profile", () => {
    const loaded = fixture("release");
    (loaded.instance.document as CogaInstance).spec.governance.releaseEvidence =
      [];
    expect(issueCodes(loaded)).toContain(
      "governance.release-evidence-required",
    );
  });

  it("rejects less-mature dependencies and warns on deprecated dependencies", () => {
    const registration = fixture();
    (registration.instance.document as CogaInstance).metadata.lifecycle =
      "published";
    expect(issueCodes(registration)).toContain(
      "lifecycle.dependency-too-early",
    );

    const immature = fixture();
    packageDocument(
      immature,
      "example.broker-channel.operations",
    ).metadata.lifecycle = "published";
    expect(issueCodes(immature)).toContain("lifecycle.dependency-too-early");

    const packageContents = fixture();
    packageDocument(
      packageContents,
      "example.broker-channel.domain",
    ).metadata.lifecycle = "published";
    artifactDocument(
      packageContents,
      "capability.customer.profile",
    ).metadata.lifecycle = "candidate";
    expect(issueCodes(packageContents)).toContain(
      "lifecycle.dependency-too-early",
    );

    artifactDocument(
      packageContents,
      "capability.customer.profile",
    ).metadata.lifecycle = "approved";
    expect(issueCodes(packageContents)).not.toContain(
      "lifecycle.dependency-too-early",
    );

    const deprecated = fixture();
    packageDocument(
      deprecated,
      "example.broker-channel.domain",
    ).metadata.lifecycle = "deprecated";
    const result = validate(deprecated);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "lifecycle.deprecated-dependency",
          severity: "warning",
        }),
      ]),
    );
  });

  it("checks visibility transitively and makes public profile strict", () => {
    const local = fixture();
    artifactDocument(local, "domain.customer.identity").metadata.visibility =
      "restricted";
    expect(issueCodes(local)).not.toContain("visibility.public-to-non-public");

    const transitive = fixture("public");
    artifactDocument(
      transitive,
      "domain.customer.identity",
    ).metadata.visibility = "restricted";
    expect(issueCodes(transitive)).toContain("visibility.public-to-non-public");

    const strict = fixture("public");
    artifactDocument(strict, "domain.customer.identity").metadata.visibility =
      "internal";
    expect(issueCodes(strict)).toContain("visibility.profile-requires-public");
  });

  it("inherits sensitive-key context through nested objects", () => {
    const loaded = fixture();
    const application = loaded.applications[0]!.document as Application;
    application.spec.choices = {
      apiKey: { value: "literal-value-must-not-be-stored" },
      credential: { nested: { value: "also-literal" } },
      authorizationHeader: { value: "Bearer literal-authorization" },
    };
    expect(issueCodes(loaded)).toContain("secret.literal-sensitive-field");
  });

  it("does not recurse forever on a cyclic opaque value", () => {
    const loaded = fixture();
    const cycle: Record<string, unknown> = {
      value: "literal-inside-cyclic-sensitive-context",
    };
    cycle.self = cycle;
    (loaded.applications[0]!.document as Application).spec.choices = {
      apiKey: cycle,
    };
    expect(() => validate(loaded)).not.toThrow();
    expect(issueCodes(loaded)).toContain("secret.literal-sensitive-field");
  });

  it("reports malformed v0.2 resources without semantic-layer exceptions", () => {
    const loaded = fixture("release");
    const artifact = artifactDocument(
      loaded,
      "domain.customer.access-rule",
    ) as unknown as {
      metadata: Record<string, unknown>;
      spec: Record<string, unknown>;
    };
    delete artifact.metadata.attestations;
    artifact.spec.relations = {};
    artifact.spec.validation = null;
    artifact.spec.contractRefs = { path: 42 };
    const instance = loaded.instance.document as unknown as {
      spec: Record<string, unknown>;
    };
    instance.spec.governance = {
      approvalRules: null,
      releaseEvidence: {},
    };

    expect(() => validate(loaded)).not.toThrow();
    const result = validate(loaded);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["schema.required", "schema.type"]),
    );
  });

  it("rejects completed validation without evidence and pending completion metadata", () => {
    const completed = fixture();
    artifactDocument(
      completed,
      "domain.customer.identity",
    ).spec.validation[0]!.evidence = [];
    expect(issueCodes(completed)).toContain(
      "validation.completed-evidence-required",
    );

    const pending = fixture();
    artifactDocument(
      pending,
      "fixture.release.approval-policy",
    ).spec.validation[0]!.validator = "must-not-be-present";
    expect(issueCodes(pending)).toContain(
      "validation.pending-evidence-forbidden",
    );
  });

  it("rejects explicit options that differ from a loaded context", () => {
    const loaded = fixture("public");
    expect(() => validate(loaded, { profile: "local" })).toThrow(
      /cannot be reused with different validation options/i,
    );
  });
});
