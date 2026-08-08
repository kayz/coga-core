# Executable factory slice

This directory turns the sanitized Instance into a small executable factory slice.
It is not a production broker implementation and contains no private application
knowledge, backend interface, customer record, credential value, or FICANT asset.

## Boundaries

- [`profile.yaml`](profile.yaml) binds the five-layer Instance, exact application
  manifests, allowlisted adapters, public sources, and human governance policy.
- [`evaluation/`](evaluation/) and [`prompts/`](prompts/) are Instance-owned. The
  DeepSeek adapter uses `deepseek-v4-pro`, allows a recorded runtime model override,
  and stores only `env://DEEPSEEK_API_KEY`; no credential value belongs here.
- [`recipes/`](recipes/) materialize two independent consumers from exact Harness
  locks. Candidate parameters retain application-specific choices.
- [`scenarios/`](scenarios/) use ordinary fixtures and bounded JavaScript oracles;
  they deliberately do not invent a general rule language.
- [`fixtures/control/`](fixtures/control/) uses Core `coga.dev/control/v0.1`
  contracts. Model assessment is candidate `EvidenceBundle` material. Human
  approval is digest-bound in a `RunRecord`; the model cannot approve or publish.
- [`releases/`](releases/) maps Instance-owned closure inputs to the deterministic
  Core `coga.dev/release/v0.1` plan shape.

## Local deterministic checks

After the workspace packages are built, run:

```text
node packages/factory/dist/cli.js profile validate examples/broker-digital-channel/factory/profile.yaml
node examples/broker-digital-channel/factory/scripts/validate-factory.mjs
node examples/broker-digital-channel/factory/scripts/run-scenarios.mjs
node examples/broker-digital-channel/factory/scripts/materialize.mjs examples/broker-digital-channel/factory/recipes/candidates/aster-miniapp.candidate.json --check
node examples/broker-digital-channel/factory/scripts/materialize.mjs examples/broker-digital-channel/factory/recipes/candidates/cedar-h5.candidate.json --check
npm test --prefix examples/broker-digital-channel/factory/golden/wechat-miniapp
npm run build --prefix examples/broker-digital-channel/factory/golden/wechat-miniapp
npm test --prefix examples/broker-digital-channel/factory/golden/h5
npm run build --prefix examples/broker-digital-channel/factory/golden/h5
```

The default tests are offline. A live DeepSeek evaluation is an explicitly selected
runtime operation and is not a release prerequisite; deterministic schema, source,
risk, scenario, impact, approval, and closure gates remain authoritative.

## Promotion invariant

Sanitized observations first become application evidence and may be grouped into an
Incident. A single application without an authoritative source is blocked from
promotion. Evidence from multiple applications plus an allowed authoritative source
may create a `PromotionProposal`, but Core fixes its maximum lifecycle at
`candidate`. A separate human-governed task is required before any shared Harness
asset or release changes.
