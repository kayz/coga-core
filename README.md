# COGA Core

[中文说明](README.zh-CN.md) · [Vision](VISION.md) · [Design audit](设计方案及差异.md) · [Current adjustment](本次项目调整.md) · [Public example](examples/broker-digital-channel/README.md) · [Changelog](CHANGELOG.md)

COGA Core is the open, domain-neutral contract layer for a human-governed,
agent-operated software factory. It helps a team **calibrate a bounded domain**
once, package its durable knowledge as a Domain Harness, and use that harness to
build and evolve multiple applications.

The 0.2 candidate closes the model's semantic graph. Human-readable, versioned files
carry domain rules, platform constraints, engineering practices, organization
policy, and operating knowledge; Core validates their contracts and graph closure;
and an exact artifact version can be traced through package and artifact edges to
direct, transitive, and older-pin application consumers.

The repository also contains one deliberately narrow Factory Cell. It turns a
digest-bound Work Order for an exact Artifact version into independently tested
candidates for every affected Application and, when explicitly requested, one
GitHub Draft PR per target. Versioned proposal, local execution, remote CI,
attestation, and human Policy receipts keep that path auditable without turning
Core resource files into executable instructions.

## The boundary

```text
COGA Core                         COGA Instance                       Application
generic schemas and mechanics -> calibrated, reusable harnesses -> product choices and code
open source                       public/private by asset             independently deliverable
no broker or product meaning      serves multiple applications       exact harness version locks
```

- **Core** owns resource schemas, lifecycle rules, validation, catalogs, and
  impact analysis. It does not know what a broker client or a mini-program means.
- An **Instance** combines a bounded domain with reusable domain, platform,
  engineering, organization, and operations packages.
- An **Application** owns its user experience, product policy, implementation,
  application-only scenarios, and runtime. It consumes exact Harness versions.

Read [the vision](VISION.md) for the full intent and
[the knowledge model](docs/knowledge-model.md) for the representation and
governance decisions.

## Included in 0.2

- [`@coga/core`](packages/core/README.md), a TypeScript library and `coga` CLI;
- [`@coga/factory`](packages/factory/README.md) `0.3.0`, with versioned Work
  Order, Agent Proposal Receipt, Application Factory, per-target recovery,
  Evidence Bundle, Remote Evidence and governance-view contracts plus the
  `coga-factory` CLI;
- JSON Schema 2020-12 contracts for four resource kinds;
- bounded canonical loading, JSON Schema validation, exact resource-graph closure,
  contract identity/content validation, lifecycle and governance-record checks,
  transitive visibility checks, and cycle-safe literal-secret detection;
- `local`, `public`, and `release` validation profiles, with strict public-root and
  release-evidence requirements;
- Markdown/JSON catalogs and versioned reverse-impact paths from an artifact to
  direct, transitive, and older-pin application consumers;
- a sanitized
  [Broker Digital Customer Channel example](examples/broker-digital-channel/README.md)
  with five Harness layers, three fictitious consuming manifests, and two real,
  dependency-free Cedar/Birch H5 reference Applications used by the Factory Cell;
- exact impact-to-target fan-out, versioned model/prompt/context/output receipts,
  bounded Git patches, a digest-pinned network-disabled Docker test/build
  sandbox, content-addressed local/remote evidence, isolated retry, and
  idempotent Draft-PR delivery;
- form-ready schema hints and narrow agent playbooks, while keeping versioned
  files and pull requests as the source of truth;
- explicit public-release and privacy checks;
- a license-complete, byte-reproducible Core package payload with a normalized
  CycloneDX SBOM, SHA-256 release manifest, and a fail-closed signed-tag
  workflow that creates GitHub artifact attestations and a reviewable draft
  release candidate.

The example is educational. It contains no production endpoint, secret, customer
data, proprietary contract, or organization-specific compliance baseline.

## Quick start

Requirements: Node.js 22 or newer and npm 11 or newer.

```console
npm ci
npm run check:public
npm run catalog:example
npm run impact:example
npm run factory:e2e
```

`factory:e2e` needs Docker and uses the exact image digest recorded by the
Factory. The included Work Order contains two `AgentProposalReceipt` documents
that bind model identity, prompt, tool policy, budgets, exact input hashes and
normalized output Patches. The example records already-produced proposals; the
Factory does not give a model Git write access or silently invoke one. To inspect
the registered adapter surface after building:

```console
node packages/factory/dist/cli.js adapters
node packages/factory/dist/cli.js run .coga/work-orders/cedar-status/work-order.yaml --delivery local
node packages/factory/dist/cli.js governance .coga/work-orders/cedar-status/work-order.yaml --format markdown
```

Release-payload generation is a separate, stricter lane pinned to Node.js
24.18.0 and npm 11.16.0. On that exact toolchain, run `npm run release:test`;
ordinary public checks remain supported on Node.js 22+.
`npm run package:consumer-test` builds fresh Core and Factory tarballs, installs
both into an empty project, and exercises their public ESM APIs, CLIs, and exported
schemas. Pull request CI repeats that consumer test on Node.js 20.20.2, 22.22.1,
and 24.18.0.

After the build, the CLI can inspect another Instance:

```console
node packages/core/dist/cli.js validate path/to/instance.yaml --profile release
node packages/core/dist/cli.js catalog path/to/instance.yaml --format markdown --profile public
node packages/core/dist/cli.js impact path/to/instance.yaml artifact.id@0.2.0 --profile public
```

Every canonical resource uses this envelope:

```yaml
schemaVersion: coga.dev/v0.2
kind: DomainArtifact
metadata:
  id: example.domain.rule
  title: Example rule
  version: 0.2.0
  lifecycle: candidate
  scope: instance
  visibility: public
  attestations: []
spec:
  artifactType: rule
  summary: A short human-readable explanation.
  statement: The normative statement to validate.
  provenance: []
  relations: []
  validation: []
  contractRefs: []
```

## Knowledge authoring and future UI

YAML files are canonical because they are readable, diffable, versionable, and
easy for agents to propose without hiding state. JSON Schema provides deterministic
validation and is also the contract for a future form interface. Markdown catalogs,
graphs, and forms are derived views; a form submission should create a file patch
and review request, not a second database.

Agents may research and draft candidate assets. Humans remain responsible for
domain meaning, risk acceptance, exceptions, and publication. The intended model
is **human-governed, unattended execution**, not unowned automation.

## Repository map

```text
packages/core/                       domain-neutral library, CLI, and schemas
packages/factory/                    governed Factory Cell controller and protocols
.coga/work-orders/                   reviewable, digest-bound example work orders
examples/broker-digital-channel/     sanitized, reusable COGA Instance
docs/                                cross-cutting architecture decisions
scripts/                             privacy and public-boundary gates
设计方案及差异.md                    audited current/target design boundary
本次项目调整.md                      current alignment scope and verification
```

Private applications and source material are intentionally outside the public
release allowlist and ignored by Git. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md) before proposing an asset.

## Status

`0.2.0` is an initial-development contract and intentionally rejects the v0.1
envelope. Exact Harness, artifact, policy, and contract versions are required;
backward compatibility is not promised before 1.0. Core verifies declarations and
recorded evidence but does not execute scenarios, tests, reviews, or arbitrary
commands. The separate Factory package runs only registered adapters behind a
bounded Work Order. Its strongest mutation is changing an exactly verified Draft
PR to ready for review; it never merges, publishes, tags, releases or deploys. The project is licensed
under Apache License 2.0. The private local
Application now has executable conformance evidence, while DevTools/device
acceptance remains manual. Release tooling prepares attestable GitHub assets but
does not publish to npm; the currently unclaimed `@coga/core` package requires a
separately authorized first-publish bootstrap before trusted publishing can be
configured. See the [design audit](设计方案及差异.md) for the exact boundary.
