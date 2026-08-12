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
  with five Harness layers and two fictitious consuming applications;
- form-ready schema hints and narrow agent playbooks, while keeping versioned
  files and pull requests as the source of truth;
- explicit public-release and privacy checks.

The example is educational. It contains no production endpoint, secret, customer
data, proprietary contract, or organization-specific compliance baseline.

## Quick start

Requirements: Node.js 22 or newer and npm 11 or newer.

```console
npm ci
npm run check:public
npm run catalog:example
npm run impact:example
```

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
commands. The project is licensed under Apache License 2.0. See the
[design audit](设计方案及差异.md) for the remaining Application and release risks.
