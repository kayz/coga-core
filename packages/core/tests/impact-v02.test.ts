import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { impact } from "../src/impact.js";
import { load } from "../src/loader.js";
import type {
  Application,
  CogaInstance,
  DomainArtifact,
  HarnessPackage,
  LoadedArtifact,
  LoadedCogaInstance,
  LoadedResource,
} from "../src/types.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const validManifest = resolve(
  testDirectory,
  "fixtures",
  "valid",
  "instance.yaml",
);
const identity = { id: "domain.customer.identity", version: "0.2.0" };

function fixture(): LoadedCogaInstance {
  return load(validManifest);
}

function addRegisteredOlderPin(loaded: LoadedCogaInstance): void {
  const currentPackage = loaded.packages.find(
    (entry) =>
      (entry.document as HarnessPackage).metadata.id ===
      "example.broker-channel.domain",
  )!;
  const currentArtifact = loaded.artifacts.find(
    (entry) =>
      (entry.document as DomainArtifact).metadata.id ===
      "domain.customer.identity",
  )!;
  const oldPackage: LoadedResource<HarnessPackage> = structuredClone(
    currentPackage,
  ) as LoadedResource<HarnessPackage>;
  oldPackage.path = `${currentPackage.path}.older-pin`;
  oldPackage.document.metadata.version = "0.1.0";
  oldPackage.document.spec.artifacts = [
    {
      id: "domain.customer.identity",
      version: "0.1.0",
      path: "../artifacts/customer-identity-v01.yaml",
    },
  ];
  const oldArtifact: LoadedArtifact = structuredClone(currentArtifact);
  (oldArtifact.document as DomainArtifact).metadata.version = "0.1.0";
  oldArtifact.path = `${currentArtifact.path}.older-pin`;
  oldArtifact.ownerPackage = {
    id: "example.broker-channel.domain",
    version: "0.1.0",
  };
  loaded.packages.push(oldPackage);
  loaded.artifacts.push(oldArtifact);
  (loaded.instance.document as CogaInstance).spec.packages.push({
    id: "example.broker-channel.domain",
    version: "0.1.0",
    path: "packages/domain-v01.yaml",
  });
  const application = loaded.applications[0]!.document as Application;
  application.spec.harnessDependencies = [
    { id: "example.broker-channel.domain", version: "0.1.0" },
  ];
}

describe("COGA 0.2 versioned impact", () => {
  it("returns direct and transitive reasons with exact reproducible paths", () => {
    const result = impact(fixture(), identity);
    expect(result.found).toBe(true);
    expect(result.packages).toMatchObject([
      {
        id: "example.broker-channel.domain",
        version: "0.2.0",
        layer: "domain",
      },
    ]);
    const application = result.affectedApplications[0]!;
    expect(application.reasons.map((entry) => entry.type)).toEqual([
      "direct",
      "transitive",
    ]);
    expect(application.reasons[0]!.path).toEqual([
      { kind: "artifact", ...identity },
      {
        kind: "package",
        id: "example.broker-channel.domain",
        version: "0.2.0",
      },
      {
        kind: "application",
        id: "example.application.demo",
        version: "0.2.0",
      },
    ]);
    expect(application.reasons[1]!.path).toEqual([
      { kind: "artifact", ...identity },
      {
        kind: "package",
        id: "example.broker-channel.domain",
        version: "0.2.0",
      },
      {
        kind: "package",
        id: "example.broker-channel.operations",
        version: "0.2.0",
      },
      {
        kind: "application",
        id: "example.application.demo",
        version: "0.2.0",
      },
    ]);
    expect(application.rerunScenarios).toEqual([
      { id: "scenario.customer.access-allowed", version: "0.2.0" },
    ]);
    expect(application.rerunRunbooks).toEqual([
      { id: "runbook.channel.api-degradation", version: "0.2.0" },
    ]);
  });

  it("finds only an exact artifact version", () => {
    expect(
      impact(fixture(), {
        id: "domain.customer.identity",
        version: "9.9.9",
      }),
    ).toEqual({
      artifact: { id: "domain.customer.identity", version: "9.9.9" },
      found: false,
      packages: [],
      affectedApplications: [],
    });
  });

  it("propagates impact through exact cross-package artifact relations", () => {
    const loaded = fixture();
    const operations = loaded.packages.find(
      (entry) =>
        (entry.document as HarnessPackage).metadata.id ===
        "example.broker-channel.operations",
    )!.document as HarnessPackage;
    operations.spec.dependencies = [];
    const runbook = loaded.artifacts.find(
      (entry) =>
        (entry.document as DomainArtifact).metadata.id ===
        "runbook.channel.api-degradation",
    )!.document as DomainArtifact;
    runbook.spec.relations = [{ type: "depends-on", target: identity }];
    const application = loaded.applications[0]!.document as Application;
    application.spec.harnessDependencies = [
      { id: "example.broker-channel.operations", version: "0.2.0" },
    ];

    const result = impact(loaded, identity);
    expect(result.affectedApplications[0]!.reasons).toEqual([
      {
        type: "transitive",
        path: [
          { kind: "artifact", ...identity },
          {
            kind: "package",
            id: "example.broker-channel.domain",
            version: "0.2.0",
          },
          {
            kind: "artifact",
            id: "runbook.channel.api-degradation",
            version: "0.2.0",
          },
          {
            kind: "package",
            id: "example.broker-channel.operations",
            version: "0.2.0",
          },
          {
            kind: "application",
            id: "example.application.demo",
            version: "0.2.0",
          },
        ],
      },
    ]);
  });

  it("reports registered older package pins with a fully versioned path", () => {
    const loaded = fixture();
    addRegisteredOlderPin(loaded);
    const result = impact(loaded, identity);
    expect(result.affectedApplications[0]!.reasons).toEqual([
      {
        type: "older-pin",
        path: [
          { kind: "artifact", ...identity },
          {
            kind: "package",
            id: "example.broker-channel.domain",
            version: "0.2.0",
          },
          {
            kind: "artifact",
            id: "domain.customer.identity",
            version: "0.1.0",
          },
          {
            kind: "package",
            id: "example.broker-channel.domain",
            version: "0.1.0",
          },
          {
            kind: "application",
            id: "example.application.demo",
            version: "0.2.0",
          },
        ],
      },
    ]);
  });

  it("deduplicates applications and sorts results independently of load order", () => {
    const loaded = fixture();
    const expected = impact(loaded, identity);
    loaded.packages.reverse();
    loaded.artifacts.reverse();
    loaded.applications.reverse();
    expect(impact(loaded, identity)).toEqual(expected);
    expect(expected.affectedApplications).toHaveLength(1);
    const reasonKeys = expected.affectedApplications[0]!.reasons.map((entry) =>
      JSON.stringify(entry),
    );
    expect(new Set(reasonKeys).size).toBe(reasonKeys.length);
  });

  it("rejects explicit options that differ from a loaded context", () => {
    const loaded = load(validManifest, { profile: "public" });
    expect(() => impact(loaded, identity, { profile: "local" })).toThrow(
      /cannot be reused with different validation options/i,
    );
  });
});
