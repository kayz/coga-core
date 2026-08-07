import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  catalog,
  checkLifecycleTransition,
  impact,
  load,
  renderCatalogMarkdown,
  validate,
} from "../src/index.js";
import type { DomainArtifact } from "../src/types.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(testDirectory, "..");
const fixture = (name: string) =>
  resolve(testDirectory, "fixtures", name, "instance.yaml");

describe("COGA Core 0.1", () => {
  it("loads and validates a complete canonical fixture", () => {
    const loaded = load(fixture("valid"));
    expect(loaded.packages).toHaveLength(2);
    expect(loaded.artifacts).toHaveLength(5);
    expect(loaded.applications).toHaveLength(1);

    const result = validate(loaded);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a published rule without provenance or scenario validation", () => {
    const result = validate(fixture("invalid-published-rule"));
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "publication.provenance-required",
        "publication.validation-required",
        "publication.rule-scenario-required",
      ]),
    );
  });

  it("reports dangling artifact relations and application harness dependencies", () => {
    const result = validate(fixture("dangling"));
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "relation.dangling",
        "dependency.dangling-application-harness",
      ]),
    );
  });

  it("finds affected applications only through exact harness package dependencies", () => {
    const result = impact(fixture("valid"), "domain.customer.identity");
    expect(result.found).toBe(true);
    expect(result.packages).toMatchObject([
      {
        id: "example.broker-channel.domain",
        version: "0.1.0",
        layer: "domain",
      },
    ]);
    expect(result.affectedApplications.map((entry) => entry.id)).toEqual([
      "example.application.demo",
    ]);
    expect(impact(fixture("valid"), "domain.unknown.artifact")).toMatchObject({
      found: false,
      affectedApplications: [],
    });
  });

  it("builds deterministic JSON and human-readable catalogs", () => {
    const value = catalog(fixture("valid"));
    expect(value.instance.id).toBe("example.broker-channel.instance");
    expect(value.packages.flatMap((entry) => entry.artifacts)).toHaveLength(5);
    expect(renderCatalogMarkdown(value)).toContain(
      "`domain.customer.identity`",
    );
  });

  it("allows only same-state or adjacent forward lifecycle transitions", () => {
    expect(checkLifecycleTransition("draft", "candidate").allowed).toBe(true);
    expect(checkLifecycleTransition("published", "deprecated").allowed).toBe(
      true,
    );
    expect(checkLifecycleTransition("approved", "approved").allowed).toBe(true);
    expect(checkLifecycleTransition("draft", "published").allowed).toBe(false);
    expect(checkLifecycleTransition("published", "candidate").allowed).toBe(
      false,
    );
  });

  it("rejects public resources that directly reference loaded non-public resources", () => {
    const loaded = load(fixture("valid"));
    const identity = loaded.artifacts.find(
      (entry) =>
        (entry.document as DomainArtifact).metadata?.id ===
        "domain.customer.identity",
    );
    expect(identity).toBeDefined();
    (identity!.document as DomainArtifact).metadata.visibility = "restricted";
    const result = validate(loaded);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "visibility.public-to-non-public",
    );
  });

  it("rejects literal secret-like values inside otherwise opaque application choices", () => {
    const loaded = load(fixture("valid"));
    const application = loaded.applications[0]!.document as {
      spec: { choices: Record<string, unknown> };
    };
    application.spec.choices.apiKey = "literal-value-must-not-be-stored";
    const result = validate(loaded);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "secret.literal-sensitive-field",
    );
  });

  it("rejects non-exact SemVer values even when a broad schema pattern could match", () => {
    const loaded = load(fixture("valid"));
    const application = loaded.applications[0]!.document as {
      spec: { harnessDependencies: Array<{ id: string; version: string }> };
    };
    application.spec.harnessDependencies[0]!.version = "1.0.0-01";
    const result = validate(loaded);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "version.not-exact-semver",
    );
  });

  it("does not interpret versions inside opaque application settings and choices", () => {
    const loaded = load(fixture("valid"));
    const application = loaded.applications[0]!.document as {
      spec: {
        choices: Record<string, unknown>;
        operations: { settings: Record<string, unknown> };
      };
    };
    application.spec.choices.presentation = { version: "spring-campaign" };
    application.spec.operations.settings = { version: "runtime-owned" };

    const result = validate(loaded);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("exposes a working CLI for validation, catalog, and impact", () => {
    const cli = resolve(packageDirectory, "dist", "cli.js");
    const manifest = fixture("valid");
    const validation = spawnSync(
      process.execPath,
      [cli, "validate", manifest],
      {
        encoding: "utf8",
      },
    );
    expect(validation.status).toBe(0);
    expect(validation.stdout).toContain("Valid COGA instance");

    const catalogResult = spawnSync(
      process.execPath,
      [cli, "catalog", manifest, "--format", "json"],
      { encoding: "utf8" },
    );
    expect(catalogResult.status).toBe(0);
    expect(JSON.parse(catalogResult.stdout).instance.id).toBe(
      "example.broker-channel.instance",
    );

    const impactResult = spawnSync(
      process.execPath,
      [cli, "impact", manifest, "domain.customer.identity"],
      { encoding: "utf8" },
    );
    expect(impactResult.status).toBe(0);
    expect(JSON.parse(impactResult.stdout).affectedApplications).toHaveLength(
      1,
    );
  });
});
