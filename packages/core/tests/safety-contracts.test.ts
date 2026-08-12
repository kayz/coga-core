import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { load, validate } from "../src/index.js";
import type {
  ContractReference,
  ExactReference,
  ValidationResult,
} from "../src/types.js";

const VERSION = "0.2.0";
const INSTANCE = { id: "test.safety.instance", version: VERSION } as const;
const PACKAGE = { id: "test.safety.package", version: VERSION } as const;
const ARTIFACT = { id: "test.safety.artifact", version: VERSION } as const;
const APPLICATION = {
  id: "test.safety.application",
  version: VERSION,
} as const;

let sandbox = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "coga-safety-contracts-"));
});

afterEach(() => {
  rmSync(sandbox, { force: true, recursive: true });
});

function metadata(id: string, scope: "core" | "instance" | "application") {
  return {
    id,
    title: id,
    version: VERSION,
    lifecycle: "draft",
    scope,
    visibility: "public",
    attestations: [],
  };
}

function jsonSource(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeText(root: string, relativePath: string, source: string): string {
  const path = resolve(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source, "utf8");
  return path;
}

function writeJson(
  root: string,
  relativePath: string,
  value: unknown,
): { path: string; source: string } {
  const source = jsonSource(value);
  return { path: writeText(root, relativePath, source), source };
}

interface FixtureOptions {
  artifactContracts?: ContractReference[];
  applicationChoices?: Record<string, unknown>;
  applicationContracts?: ContractReference[];
}

function createFixture(
  root: string,
  options: FixtureOptions = {},
): { manifest: string; artifact: string; application?: string } {
  const artifactReference = {
    ...ARTIFACT,
    path: "artifact.json",
  };
  const artifact = writeJson(root, artifactReference.path, {
    schemaVersion: "coga.dev/v0.2",
    kind: "DomainArtifact",
    metadata: metadata(ARTIFACT.id, "core"),
    spec: {
      artifactType: "concept",
      summary: "Safety and contract test artifact.",
      provenance: [],
      relations: [],
      validation: [],
      contractRefs: options.artifactContracts ?? [],
    },
  }).path;

  const packageReference = {
    ...PACKAGE,
    path: "package.json",
  };
  writeJson(root, packageReference.path, {
    schemaVersion: "coga.dev/v0.2",
    kind: "HarnessPackage",
    metadata: metadata(PACKAGE.id, "core"),
    spec: {
      layer: "domain",
      description: "Safety test harness package.",
      dependencies: [],
      artifacts: [artifactReference],
    },
  });

  const applications: Array<ExactReference & { path: string }> = [];
  let application: string | undefined;
  if (
    options.applicationChoices !== undefined ||
    options.applicationContracts !== undefined
  ) {
    const applicationReference = {
      ...APPLICATION,
      path: "application.json",
    };
    application = writeJson(root, applicationReference.path, {
      schemaVersion: "coga.dev/v0.2",
      kind: "Application",
      metadata: metadata(APPLICATION.id, "application"),
      spec: {
        deliveryTargets: ["test-runtime"],
        harnessDependencies: [PACKAGE],
        contracts: options.applicationContracts ?? [],
        scenarios: [],
        operations: { runbooks: [], settings: {} },
        choices: options.applicationChoices ?? {},
      },
    }).path;
    applications.push(applicationReference);
  }

  const manifest = writeJson(root, "instance.json", {
    schemaVersion: "coga.dev/v0.2",
    kind: "CogaInstance",
    metadata: metadata(INSTANCE.id, "instance"),
    spec: {
      domain: {
        name: "Safety tests",
        boundary: "Ephemeral validation fixture.",
        nonGoals: [],
      },
      packages: [packageReference],
      applications,
      governance: { approvalRules: [], releaseEvidence: [] },
    },
  }).path;

  return application === undefined
    ? { manifest, artifact }
    : { manifest, artifact, application };
}

function contractReference(
  format: ContractReference["format"],
  overrides: Partial<ContractReference> = {},
): ContractReference {
  return {
    id: "contract.safety.example",
    version: VERSION,
    path: "contracts/root.json",
    format,
    ...overrides,
  };
}

function jsonSchemaContract(overrides: Record<string, unknown> = {}) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://example.test/contracts/safety.json",
    "x-coga-contract": {
      id: "contract.safety.example",
      version: VERSION,
    },
    type: "object",
    properties: { value: { type: "string" } },
    ...overrides,
  };
}

function openApiContract(overrides: Record<string, unknown> = {}) {
  return {
    openapi: "3.1.0",
    info: { title: "Safety API", version: VERSION },
    paths: {},
    "x-coga-contract": {
      id: "contract.safety.example",
      version: VERSION,
    },
    ...overrides,
  };
}

function issueCodes(result: ValidationResult): string[] {
  return result.issues.map((entry) => entry.code);
}

describe("safe canonical loading", () => {
  it("reports a cyclic YAML alias without throwing or overflowing the stack", () => {
    const manifest = writeText(
      sandbox,
      "cyclic.yaml",
      [
        "schemaVersion: coga.dev/v0.2",
        "kind: CogaInstance",
        "metadata:",
        "  id: test.safety.instance",
        "  title: cyclic",
        `  version: ${VERSION}`,
        "  lifecycle: draft",
        "  scope: instance",
        "  visibility: public",
        "  attestations: []",
        "spec:",
        "  domain:",
        "    name: cyclic",
        "    boundary: test",
        "    nonGoals: []",
        "  packages: &packages",
        "    - *packages",
        "  applications: []",
        "  governance:",
        "    approvalRules: []",
        "    releaseEvidence: []",
        "",
      ].join("\n"),
    );

    expect(() => load(manifest)).not.toThrow();
    expect(load(manifest).loadIssues.map((entry) => entry.code)).toContain(
      "load.circular-reference",
    );
  });

  it("returns a stable issue when YAML aliases exceed the budget", () => {
    const manifest = writeText(
      sandbox,
      "alias-limit.yaml",
      [
        "schemaVersion: coga.dev/v0.2",
        "kind: CogaInstance",
        "metadata:",
        "  id: test.safety.instance",
        "  title: alias limit",
        `  version: ${VERSION}`,
        "  lifecycle: draft",
        "  scope: instance",
        "  visibility: public",
        "  attestations: []",
        "spec:",
        "  domain:",
        "    name: alias limit",
        "    boundary: test",
        "    nonGoals:",
        "      - &value repeated",
        "      - *value",
        "      - *value",
        "      - *value",
        "  packages: []",
        "  applications: []",
        "  governance:",
        "    approvalRules: []",
        "    releaseEvidence: []",
        "",
      ].join("\n"),
    );

    expect(
      load(manifest, { limits: { maxAliases: 2 } }).loadIssues.map(
        (entry) => entry.code,
      ),
    ).toContain("load.alias-limit");
  });

  it("rejects an oversized canonical file using an overridden tiny limit", () => {
    const { manifest } = createFixture(sandbox);
    const loaded = load(manifest, {
      limits: { canonicalFileBytes: 16 },
    });

    expect(loaded.loadIssues.map((entry) => entry.code)).toContain(
      "load.file-too-large",
    );
  });

  it.each([
    {
      name: "depth",
      limits: { maxDepth: 2 },
      code: "load.depth-limit",
    },
    {
      name: "node",
      limits: { maxNodes: 5 },
      code: "load.node-limit",
    },
  ])("enforces the canonical $name limit", ({ limits, code }) => {
    const { manifest } = createFixture(sandbox);
    const loaded = load(manifest, { limits });

    expect(loaded.loadIssues.map((entry) => entry.code)).toContain(code);
  });

  it("rejects invalid UTF-8 before canonical parsing", () => {
    const { manifest, artifact } = createFixture(sandbox);
    writeFileSync(artifact, Buffer.from([0xff, 0xfe, 0xfd]));

    expect(load(manifest).loadIssues.map((entry) => entry.code)).toContain(
      "load.invalid-utf8",
    );
  });

  it("rejects a public resource path that escapes the instance root", () => {
    const project = join(sandbox, "project");
    const packagePath = writeJson(sandbox, "outside-package.json", {
      schemaVersion: "coga.dev/v0.2",
      kind: "HarnessPackage",
      metadata: metadata(PACKAGE.id, "core"),
      spec: {
        layer: "domain",
        description: "Outside package.",
        dependencies: [],
        artifacts: [],
      },
    }).path;
    const manifest = writeJson(project, "instance.json", {
      schemaVersion: "coga.dev/v0.2",
      kind: "CogaInstance",
      metadata: metadata(INSTANCE.id, "instance"),
      spec: {
        domain: {
          name: "Public path boundary",
          boundary: "test",
          nonGoals: [],
        },
        packages: [
          {
            ...PACKAGE,
            path: `../${packagePath.split(/[\\/]/u).at(-1)}`,
          },
        ],
        applications: [],
        governance: { approvalRules: [], releaseEvidence: [] },
      },
    }).path;

    const publicLoad = load(manifest, { profile: "public", rootDir: project });
    expect(publicLoad.loadIssues.map((entry) => entry.code)).toContain(
      "load.path-outside-root",
    );
    expect(
      load(manifest, { profile: "local", rootDir: project }).loadIssues,
    ).toEqual([]);
  });

  it("resolves directory links before enforcing the public root", () => {
    const project = join(sandbox, "project");
    const outside = join(sandbox, "outside");
    mkdirSync(project, { recursive: true });
    createFixture(outside);
    symlinkSync(outside, join(project, "linked"), "junction");
    const manifest = writeJson(project, "instance.json", {
      schemaVersion: "coga.dev/v0.2",
      kind: "CogaInstance",
      metadata: metadata(INSTANCE.id, "instance"),
      spec: {
        domain: {
          name: "Linked path test",
          boundary: "Reject a directory link that escapes the public root.",
          nonGoals: [],
        },
        packages: [{ ...PACKAGE, path: "linked/package.json" }],
        applications: [],
        governance: { approvalRules: [], releaseEvidence: [] },
      },
    }).path;

    expect(
      load(manifest, { profile: "public", rootDir: project }).loadIssues.map(
        (entry) => entry.code,
      ),
    ).toContain("load.path-outside-root");
  });
});

describe("cycle-safe secret scanning", () => {
  it.each([
    ["apiKey.value", { apiKey: { value: "literal-api-key" } }],
    ["authorization", { authorization: "Bearer literal-token" }],
    ["credential", { credential: "literal-credential" }],
  ])("inherits sensitive context through %s", (_name, choices) => {
    const { manifest } = createFixture(sandbox, {
      applicationChoices: choices,
    });

    expect(issueCodes(validate(manifest))).toContain(
      "secret.literal-sensitive-field",
    );
  });

  it("continues to allow external secret references in sensitive fields", () => {
    const { manifest } = createFixture(sandbox, {
      applicationChoices: {
        apiKey: { value: "vault://applications/safety/api-key" },
        authorization: "${AUTHORIZATION_HEADER}",
        credential: "${{ secrets.SERVICE_CREDENTIAL }}",
      },
    });

    expect(validate(manifest)).toMatchObject({ valid: true, issues: [] });
  });
});

describe("contract validation", () => {
  it("accepts a valid JSON Schema Draft 2020-12 contract", () => {
    writeJson(sandbox, "contracts/root.json", jsonSchemaContract());
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(validate(manifest)).toMatchObject({ valid: true, issues: [] });
  });

  it("rejects a malformed JSON Schema contract", () => {
    writeJson(
      sandbox,
      "contracts/root.json",
      jsonSchemaContract({ type: "not-a-json-schema-type" }),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(issueCodes(validate(manifest))).toContain(
      "contract.json-schema-invalid",
    );
  });

  it("rejects invalid UTF-8 before contract parsing", () => {
    const contractPath = resolve(sandbox, "contracts/root.json");
    mkdirSync(dirname(contractPath), { recursive: true });
    writeFileSync(contractPath, Buffer.from([0xff, 0xfe, 0xfd]));
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(issueCodes(validate(manifest))).toContain("contract.invalid-utf8");
  });

  it("bounds individual contract files and the shared reference closure", () => {
    const fileRoot = join(sandbox, "file-limit");
    writeText(fileRoot, "contracts/root.json", "x".repeat(256));
    const { manifest: fileManifest } = createFixture(fileRoot, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });
    expect(
      issueCodes(
        validate(fileManifest, { limits: { contractFileBytes: 128 } }),
      ),
    ).toContain("contract.file-too-large");

    const closureRoot = join(sandbox, "closure-limit");
    const referenced = writeJson(closureRoot, "contracts/value.json", {
      type: "string",
    });
    const root = writeJson(
      closureRoot,
      "contracts/root.json",
      jsonSchemaContract({ $ref: "value.json" }),
    );
    const { manifest: closureManifest } = createFixture(closureRoot, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });
    const perFileLimit = Math.max(
      Buffer.byteLength(root.source),
      Buffer.byteLength(referenced.source),
    );
    expect(
      issueCodes(
        validate(closureManifest, {
          limits: { contractFileBytes: perFileLimit },
        }),
      ),
    ).toContain("contract.closure-too-large");
  });

  it("returns a stable issue for a circular YAML contract value", () => {
    writeText(
      sandbox,
      "contracts/root.yaml",
      [
        "$schema: https://json-schema.org/draft/2020-12/schema",
        "x-coga-contract:",
        "  id: contract.safety.example",
        `  version: ${VERSION}`,
        "type: object",
        "properties: &cycle",
        "  self: *cycle",
        "",
      ].join("\n"),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [
        contractReference("json-schema-2020-12", {
          path: "contracts/root.yaml",
        }),
      ],
    });

    expect(() => validate(manifest)).not.toThrow();
    expect(issueCodes(validate(manifest))).toContain("contract.circular-value");
  });

  it("shares the YAML alias budget with contract loading", () => {
    writeText(
      sandbox,
      "contracts/root.yaml",
      [
        "$schema: https://json-schema.org/draft/2020-12/schema",
        "x-coga-contract:",
        "  id: contract.safety.example",
        `  version: ${VERSION}`,
        "type: object",
        "properties:",
        "  first: &value",
        "    type: string",
        "  second: *value",
        "  third: *value",
        "  fourth: *value",
        "",
      ].join("\n"),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [
        contractReference("json-schema-2020-12", {
          path: "contracts/root.yaml",
        }),
      ],
    });

    expect(
      issueCodes(validate(manifest, { limits: { maxAliases: 2 } })),
    ).toContain("contract.alias-limit");
  });

  it("accepts a valid OpenAPI 3.1 contract", () => {
    writeJson(sandbox, "contracts/root.json", openApiContract());
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("openapi-3.1")],
    });

    expect(validate(manifest)).toMatchObject({ valid: true, issues: [] });
  });

  it("rejects a malformed or non-3.1 OpenAPI contract", () => {
    writeJson(
      sandbox,
      "contracts/root.json",
      openApiContract({ openapi: "3.0.3" }),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("openapi-3.1")],
    });

    expect(issueCodes(validate(manifest))).toContain(
      "contract.openapi-invalid",
    );
  });

  it("requires the root contract identity", () => {
    const document = jsonSchemaContract();
    delete document["x-coga-contract"];
    writeJson(sandbox, "contracts/root.json", document);
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(issueCodes(validate(manifest))).toContain(
      "contract.identity-required",
    );
  });

  it("reports exact contract identity and version mismatches", () => {
    writeJson(
      sandbox,
      "contracts/root.json",
      jsonSchemaContract({
        "x-coga-contract": {
          id: "contract.safety.other",
          version: "0.2.1",
        },
      }),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(issueCodes(validate(manifest))).toEqual(
      expect.arrayContaining([
        "contract.identity-mismatch",
        "contract.version-mismatch",
      ]),
    );
  });

  it("accepts a matching digest and rejects a mismatched digest", () => {
    const validRoot = join(sandbox, "valid-digest");
    const validContract = writeJson(
      validRoot,
      "contracts/root.json",
      jsonSchemaContract(),
    );
    const digest = `sha256:${createHash("sha256")
      .update(validContract.source)
      .digest("hex")}`;
    const { manifest: validManifest } = createFixture(validRoot, {
      artifactContracts: [contractReference("json-schema-2020-12", { digest })],
    });
    expect(validate(validManifest, { profile: "release" })).toMatchObject({
      valid: true,
      issues: [],
    });

    const mismatchRoot = join(sandbox, "mismatched-digest");
    writeJson(mismatchRoot, "contracts/root.json", jsonSchemaContract());
    const { manifest: mismatchManifest } = createFixture(mismatchRoot, {
      artifactContracts: [
        contractReference("json-schema-2020-12", {
          digest: `sha256:${"0".repeat(64)}`,
        }),
      ],
    });
    expect(issueCodes(validate(mismatchManifest))).toContain(
      "contract.digest-mismatch",
    );
  });

  it("resolves a valid local file reference within the instance root", () => {
    writeJson(sandbox, "contracts/definitions.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { Value: { type: "string", minLength: 1 } },
    });
    writeJson(
      sandbox,
      "contracts/root.json",
      jsonSchemaContract({
        properties: {
          value: { $ref: "definitions.json#/$defs/Value" },
        },
      }),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(validate(manifest)).toMatchObject({ valid: true, issues: [] });
  });

  it("reports a malformed local fragment without throwing", () => {
    writeJson(
      sandbox,
      "contracts/root.json",
      jsonSchemaContract({
        properties: {
          value: { $ref: "#/%ZZ" },
        },
      }),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(() => validate(manifest)).not.toThrow();
    expect(issueCodes(validate(manifest))).toContain("contract.dangling-ref");
  });

  it("bounds local reference-chain depth without recursive traversal", () => {
    writeJson(
      sandbox,
      "contracts/root.json",
      jsonSchemaContract({ $ref: "ref-0.json" }),
    );
    for (let index = 0; index <= 64; index += 1) {
      writeJson(
        sandbox,
        `contracts/ref-${index}.json`,
        index === 64 ? { type: "string" } : { $ref: `ref-${index + 1}.json` },
      );
    }
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(() => validate(manifest)).not.toThrow();
    expect(issueCodes(validate(manifest))).toContain(
      "contract.ref-depth-limit",
    );
  });

  it("rejects remote contract references", () => {
    writeJson(
      sandbox,
      "contracts/root.json",
      jsonSchemaContract({
        properties: {
          value: { $ref: "https://example.test/contracts/value.json" },
        },
      }),
    );
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(issueCodes(validate(manifest))).toContain("contract.remote-ref");
  });

  it("rejects local contract references that escape the instance root", () => {
    const project = join(sandbox, "project");
    writeJson(sandbox, "outside.json", {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "string",
    });
    writeJson(
      project,
      "contracts/root.json",
      jsonSchemaContract({
        properties: {
          value: { $ref: "../../outside.json" },
        },
      }),
    );
    const { manifest } = createFixture(project, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(issueCodes(validate(manifest))).toContain(
      "contract.ref-outside-root",
    );
  });

  it("requires a digest in the release profile", () => {
    writeJson(sandbox, "contracts/root.json", jsonSchemaContract());
    const { manifest } = createFixture(sandbox, {
      artifactContracts: [contractReference("json-schema-2020-12")],
    });

    expect(issueCodes(validate(manifest, { profile: "release" }))).toContain(
      "contract.digest-required",
    );
  });
});

describe("loaded-instance option identity", () => {
  it("allows identical options but throws when a loaded instance is reused with different options", () => {
    const { manifest } = createFixture(sandbox);
    const loaded = load(manifest, { profile: "local" });

    expect(() => validate(loaded, { profile: "local" })).not.toThrow();
    expect(() => validate(loaded, { profile: "public" })).toThrow(
      "cannot be reused with different validation options",
    );
    expect(() =>
      validate(loaded, {
        profile: "local",
        limits: { maxNodes: loaded.context.limits.maxNodes - 1 },
      }),
    ).toThrow("cannot be reused with different validation options");
  });
});
