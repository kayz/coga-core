# Broker Digital Customer Channel — COGA Instance 0.2

[中文说明](README.zh-CN.md)

This directory is a sanitized, public example of a `CogaInstance` that can govern
more than one application. It contains no production endpoint, secret, customer
data, proprietary API description, organization identifier, or product-specific
entitlement amount.

The bounded context is **broker digital customer channels**: client-facing
applications that present financial content and broker-provided capabilities while
treating identity, eligibility, and entitlement decisions from trusted backend
systems as authoritative.

## What is here

- [`instance.yaml`](instance.yaml): the instance manifest and its locked package
  and application catalog.
- [`packages/`](packages/): reusable domain, platform, engineering, example
  organization, and client-operations harness packages.
- [`applications/`](applications/): two entirely fictitious consumers, one WeChat
  mini-program and one mobile H5 application.
- [`docs/`](docs/): human-readable boundaries, representation decisions, and the
  governed knowledge lifecycle.
- [`ui/`](ui/): a JSON Schema form contract and presentation hints. They prepare a
  future workbench without implementing one.
- [`agents/`](agents/): narrow instructions for candidate curation, validation, and
  impact analysis.

## Reading order

1. Read [`docs/bounded-context.md`](docs/bounded-context.md).
2. Inspect [`instance.yaml`](instance.yaml) and one package manifest.
3. Compare the two application manifests to see what is reusable and what remains
   application-owned.
4. Read [`docs/knowledge-governance.md`](docs/knowledge-governance.md) before
   proposing a shared rule.

## Status and safety

Version `0.2.0` is an example contract, not a production compliance baseline.
Official sources establish provenance; they do not turn this example into legal,
security, or regulatory advice. A real instance must be reviewed against the
organization's current obligations, systems, and risk controls.
