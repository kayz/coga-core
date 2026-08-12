# Changelog

All notable changes to COGA Core are recorded here. Versions follow Semantic
Versioning; `0.y.z` remains initial development.

## 0.2.0 — Unreleased

- Replace the v0.1 envelope with `coga.dev/v0.2`; require explicit scope,
  visibility, attestations, exact relation/validation targets, typed contract
  references, and lifecycle-bound approval rules.
- Add bounded, cycle-safe canonical loading and inherited-context literal-secret
  detection.
- Add `local`, `public`, and `release` validation profiles with root containment,
  transitive visibility, contract digests, validation evidence, and Policy
  attestation checks.
- Validate bounded local JSON Schema Draft 2020-12 and OpenAPI 3.1 contract graphs,
  including declared contract identity/version and local `$ref` closure.
- Validate Package DAGs, scope/lifecycle compatibility, cross-Package dependency
  paths, and Application Scenario/Runbook reachability.
- Replace ID-only impact queries with exact `id@version` analysis returning
  deterministic direct, transitive, and older-pin paths plus Scenario/Runbook
  rerun sets.
- Harden the public-release boundary with shared candidate classification, bounded
  UTF-8 text scanning, binary signature checks, and fail-closed unknown types.
- Migrate the public example and local manifests to 0.2.0. Unsupported public
  validation claims are now `pending`; the Core release fixture uses real local
  contract, validation, and approval evidence.

## 0.1.0 — 2026-08-08

- Define the `coga.dev/v0.1` resource envelope and four canonical resource kinds.
- Add form-ready JSON Schema contracts, lifecycle checks, visibility boundaries,
  publication rules, exact dependency validation, and literal-secret detection.
- Add the `@coga/core` TypeScript API and `coga validate`, `catalog`, and `impact`
  commands.
- Add the sanitized Broker Digital Customer Channel Instance with five Harness
  layers, 30 artifacts, six contracts, and two fictitious application consumers.
- Document the full Domain Harness vision, knowledge model, governance workflow,
  form readiness, and public/private boundary.
- Add reproducible public, privacy, documentation, and release-boundary checks.
