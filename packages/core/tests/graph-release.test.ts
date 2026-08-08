import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  impactWithReasons,
  load,
  planHarnessRelease,
  resolvePackageClosure,
  sha256,
  verifyHarnessRelease,
} from "../src/index.js";
import type {
  Application,
  DomainArtifact,
  EvidenceBundle,
  HarnessPackage,
  LoadedCogaInstance,
} from "../src/index.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(testDirectory, "fixtures", "valid", "instance.yaml");
const target = { id: "example.broker-channel.operations", version: "0.1.0" };
const resourceBytes = (path: string): Buffer =>
  Buffer.from(`resource:${path.replaceAll("\\", "/")}`);

function releasableFixture(): LoadedCogaInstance {
  const loaded = load(fixture);
  for (const resource of loaded.packages) {
    const document = resource.document as HarnessPackage;
    document.metadata.lifecycle = "published";
    document.metadata.visibility = "public";
  }
  for (const resource of loaded.artifacts) {
    const document = resource.document as DomainArtifact;
    document.metadata.lifecycle = "published";
    document.metadata.visibility = "public";
    if (document.spec.provenance.length === 0) {
      document.spec.provenance.push({
        source: `authority.${document.metadata.id}`,
        sourceType: "document",
      });
    }
    if (!document.spec.validation.some((entry) => entry.status === "passed")) {
      document.spec.validation.push({ type: "review", status: "passed" });
    }
    if (
      document.spec.artifactType === "rule" &&
      !document.spec.validation.some(
        (entry) => entry.type === "scenario" && entry.status === "passed",
      )
    ) {
      document.spec.validation.push({
        type: "scenario",
        status: "passed",
        target: "scenario.customer.access-allowed",
      });
    }
  }
  return loaded;
}

function releaseEvidence(loaded: LoadedCogaInstance): EvidenceBundle[] {
  return loaded.artifacts.map((resource, index) => {
    const document = resource.document as DomainArtifact;
    const digest = sha256(resourceBytes(resource.path));
    return {
      schemaVersion: "coga.dev/control/v0.1",
      kind: "EvidenceBundle",
      metadata: {
        id: `evidence.release.artifact-${index}`,
        title: `Release evidence for ${document.metadata.id}`,
        version: "0.1.0",
        lifecycle: "candidate",
        scope: "instance",
        visibility: "internal",
      },
      spec: {
        task: { id: "task.harness.release", version: "0.1.0" },
        runId: "release-run-1",
        producedBy: {
          kind: "system",
          id: "coga.core.release-planner",
          roles: ["release-planner"],
        },
        disposition: "candidate",
        subject: {
          path: resource.path,
          mediaType: "application/yaml",
          digest,
        },
        materials: [],
        claimResults: [
          {
            claim: "artifact.release-validated",
            status: "passed",
            validator: {
              kind: "validator",
              id: "adapter.validator.release",
              version: "0.1.0",
            },
            materialPaths: [resource.path],
          },
        ],
        execution: {
          validator: {
            kind: "validator",
            id: "adapter.validator.release",
            version: "0.1.0",
          },
        },
      },
    };
  });
}

describe("Harness dependency, impact, and release control", () => {
  it("resolves dependencies before dependents and reports the exact cycle path", () => {
    const loaded = load(fixture);
    expect(resolvePackageClosure(loaded, target).order).toEqual([
      { id: "example.broker-channel.domain", version: "0.1.0" },
      target,
    ]);

    const domain = loaded.packages.find(
      (entry) =>
        (entry.document as HarnessPackage).metadata.id ===
        "example.broker-channel.domain",
    )!.document as HarnessPackage;
    domain.spec.dependencies.push(target);
    expect(() => resolvePackageClosure(loaded, target)).toThrow(
      "example.broker-channel.operations@0.1.0 -> example.broker-channel.domain@0.1.0 -> example.broker-channel.operations@0.1.0",
    );
  });

  it("explains transitive artifact impact and rerun scenarios and runbooks", () => {
    const loaded = load(fixture);
    expect(
      impactWithReasons(loaded, "domain.customer.identity").reasons,
    ).toHaveLength(2);
    const application = loaded.applications[0]!.document as Application;
    application.spec.harnessDependencies =
      application.spec.harnessDependencies.filter(
        (entry) => entry.id === target.id,
      );

    const result = impactWithReasons(loaded, "domain.customer.identity");
    expect(result.found).toBe(true);
    expect(result.affectedPackages).toEqual([
      { id: "example.broker-channel.domain", version: "0.1.0" },
      target,
    ]);
    expect(result.affectedApplications).toEqual([
      { id: "example.application.demo", version: "0.1.0" },
    ]);
    expect(result.reasons[0]!.path).toEqual([
      "domain.customer.identity",
      "example.broker-channel.domain@0.1.0",
      "example.broker-channel.operations@0.1.0",
      "example.application.demo@0.1.0",
    ]);
    expect(result.rerun.scenarios).toEqual([
      { id: "scenario.customer.access-allowed", version: "0.1.0" },
    ]);
    expect(result.rerun.runbooks).toEqual([
      { id: "runbook.channel.api-degradation", version: "0.1.0" },
    ]);
  });

  it("builds and verifies a deterministic release plan with complete gates", () => {
    const loaded = releasableFixture();
    const evidence = releaseEvidence(loaded);
    const options = {
      visibility: "public" as const,
      evidence,
      readFile: resourceBytes,
      resolveProvenance: (source: string) => ({
        bytes: Buffer.from(`provenance:${source}`),
        visibility: "public" as const,
      }),
    };

    const first = planHarnessRelease(loaded, target, options);
    const second = planHarnessRelease(loaded, target, options);
    expect(second).toEqual(first);
    expect(first.packages).toEqual([
      { id: "example.broker-channel.domain", version: "0.1.0" },
      target,
    ]);
    expect(first.resources).toHaveLength(7);
    expect(first.provenance.length).toBeGreaterThan(0);
    expect(verifyHarnessRelease(first, loaded, options)).toEqual({
      valid: true,
    });

    const drifted = verifyHarnessRelease(first, loaded, {
      ...options,
      readFile: (path) =>
        path.endsWith("operations.yaml")
          ? Buffer.from("drifted-package")
          : resourceBytes(path),
    });
    expect(drifted).toMatchObject({
      valid: false,
      reason: "release plan or source digest drift",
    });
  });

  it("rejects lifecycle, evidence, and provenance visibility gate failures", () => {
    const loaded = releasableFixture();
    const evidence = releaseEvidence(loaded);
    const base = {
      visibility: "public" as const,
      evidence,
      readFile: resourceBytes,
      resolveProvenance: (source: string) => ({
        bytes: Buffer.from(source),
        visibility: "public" as const,
      }),
    };

    (loaded.packages[1]!.document as HarnessPackage).metadata.lifecycle =
      "approved";
    expect(() => planHarnessRelease(loaded, target, base)).toThrow(
      /is not published/,
    );
    (loaded.packages[1]!.document as HarnessPackage).metadata.lifecycle =
      "published";

    expect(() =>
      planHarnessRelease(loaded, target, {
        ...base,
        evidence: evidence.slice(1),
      }),
    ).toThrow(/lacks digest-bound evidence/);

    expect(() =>
      planHarnessRelease(loaded, target, {
        ...base,
        resolveProvenance: (source: string) => ({
          bytes: Buffer.from(source),
          visibility: "restricted" as const,
        }),
      }),
    ).toThrow(/is not 'public'/);
  });
});
