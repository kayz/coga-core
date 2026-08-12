# `@coga/core` 0.2

`@coga/core` is the domain-neutral control contract for a COGA software factory. It safely loads canonical YAML or JSON resources, validates contracts and the versioned resource graph, produces a human-readable catalog, and traces an exact artifact version to direct, transitive, and older-pin application consumers.

Core deliberately does **not** interpret broker, mini-program, organization, or product rules. A COGA instance supplies that knowledge as versioned `DomainArtifact` and `HarnessPackage` resources. An application records exact harness dependencies and keeps application-only decisions in `spec.choices`.

## Resource contract

Every resource uses `schemaVersion: coga.dev/v0.2`, one of the four resource kinds, stable lowercase dot-separated IDs, exact SemVer versions, and explicit `metadata.lifecycle`, `metadata.scope`, `metadata.visibility`, and `metadata.attestations`. References to artifacts, policies, packages, applications, and contracts always include an exact version.

- `DomainArtifact` records a concept, rule, capability, scenario, policy, or runbook.
- `HarnessPackage` owns artifacts in one of the domain, platform, engineering, organization, or operations layers.
- `CogaInstance` registers exact package and application versions and defines its bounded domain.
- `Application` declares delivery targets and exact harness dependencies. `spec.choices` is intentionally opaque to Core.

Canonical manifests remain the source of truth. The schemas include titles, descriptions, defaults, and `x-coga-ui` annotations so a future workbench can render forms without creating a second source of truth.

## CLI

```console
coga validate ./instance.yaml --profile release
coga catalog ./instance.yaml --profile public
coga catalog ./instance.yaml --format json --profile public
coga impact ./instance.yaml domain.customer.identity@0.2.0 --profile public
```

The `local` profile applies resource budgets, Schema and contract validation, graph closure, and cycle-safe secret checks while allowing explicitly loaded local Harness files outside the Instance root. `public` adds root containment, explicit public visibility, and transitive visibility closure. `release` also verifies contract digests, completed validation evidence, approval attestations required by `governance.approvalRules`, and non-empty lifecycle entries in `governance.releaseEvidence`.

JSON Schema contracts must declare Draft 2020-12; OpenAPI contracts must use 3.1.x. Both carry `x-coga-contract: { id, version }`, and only bounded local `$ref` values are accepted. Core validates evidence records; it does not execute scenarios, tests, reviews, approvals, or arbitrary commands. Secret references such as `env://NAME`, `vault://path`, or `${NAME}` remain allowed; literal secret values do not.

## Library

```ts
import {
  load,
  validate,
  catalog,
  renderCatalogMarkdown,
  impact,
  checkLifecycleTransition,
} from "@coga/core";

const options = { profile: "release" } as const;
const loaded = load("./instance.yaml", options);
const result = validate(loaded, options);
if (!result.valid) throw new Error(result.issues[0]?.message);

console.log(renderCatalogMarkdown(catalog(loaded, options)));
console.log(
  impact(loaded, { id: "domain.customer.identity", version: "0.2.0" }, options),
);
console.log(checkLifecycleTransition("approved", "published"));
```

The load context records its profile, root directory, and safety limits. Passing different options to an already loaded Instance is rejected. Lifecycle progression remains explicit and monotonic: `draft → candidate → approved → published → deprecated`; remaining in the current state is valid, while skipping or moving backward is not.

## Release candidate integrity

The npm package includes the Apache-2.0 license. From the repository root,
`npm run release:test` checks a deterministic CycloneDX 1.5 SBOM against the
complete production dependency graph and verifies byte-reproducible package,
SBOM, and SHA-256 manifest generation. This release lane is pinned to Node.js
24.18.0 and npm 11.16.0; the Core library itself remains supported on Node.js
20+. The version workflow is intentionally
separate from ordinary CI and accepts only a signed `vMAJOR.MINOR.PATCH` tag that
identifies the exact `main` tip before creating GitHub attestations and an
administrator-reviewable draft release candidate. It does not publish a mutable
release; immutable-release enablement and final publication remain an external
administrator gate.

The workflow does not publish to npm. `@coga/core` has not yet received its
separately authorized first registry publish, which is required before an npm
trusted publisher can be configured.
