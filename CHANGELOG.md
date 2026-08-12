# Changelog

All notable changes to COGA Core are recorded here. Versions follow Semantic
Versioning; `0.y.z` remains initial development.

## `@coga/factory` 0.3.0 — Unreleased

- Replace the Factory v0.1 protocol with `coga.dev/factory/v0.2`; v0.1 Factory
  documents are explicitly rejected while Core remains `0.2.0`.
- Add `ProposalCompilation` and content-addressed `AgentProposalReceipt`
  contracts binding model/provider/version, prompt template and digest, tool and
  network policy, budgets, the exact COGA Harness context closure, normalized
  unified-diff bytes, and authorized output paths.
- Fan one exact Artifact change out to every impacted Application, using an
  independent worktree, branch, recovery state, Evidence Bundle, commit and
  optional Draft PR per target. Aggregate results distinguish completed,
  partial and failed runs; retry reuses completed targets.
- Add the Birch H5 reference Application so the responsive-shell example proves
  two independent consumers and isolated candidates rather than a single-target
  special case.
- Add `RemoteEvidence` collection for the tracked Work Order/base, exact PR head,
  governed Patch path closure, check/attestation and authorized exact-head
  Policy-review bindings, plus a derived JSON/Markdown governance view. Promotion
  is limited to Draft-to-ready-for-review after a final identity check and can
  never merge or deploy.
- Add a least-privilege `workflow_run` attestation job that checks out and
  executes no repository code, accepts only a successful same-repository Draft
  PR, and attests its exact content-addressed Evidence Bundle. Its token grants
  only the explicit read scopes needed for Actions, PR metadata/files and
  contents plus the attestation write scopes; ordinary PRs without a Bundle are
  skipped with a diagnostic notice. Remote path checks operate on Unicode code
  points instead of an ambiguous escaped regular-expression character class.
- Add negative and recovery tests for proposal/input tampering, ignored and
  unbound source context, partial fan-out and failed-target retry, missing remote
  checks/approvals, undeclared or Patch-external PR files, raw binary evidence
  bytes, remote identity races, and workflow privilege boundaries.

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
- Add local Application conformance evidence for default-deny entitlements,
  registered telemetry envelopes, explicit view states, complete research
  fixtures, durable daily voting, scenario traceability, static accessibility,
  and complete mini-program build output.
- Include Apache-2.0 license text in the Core package and add deterministic
  CycloneDX/SHA-256 release assets plus a least-privilege, signed-tag-only GitHub
  attestation and draft-candidate workflow. Final immutable publication and npm
  publication remain intentionally gated; `@coga/core` has not yet received its
  separately authorized first publish.
- Add an empty-project tarball consumer test for the installed ESM API, CLI, and
  schema exports, with a Linux pull-request matrix on Node.js 20.20.2, 22.22.1,
  and 24.18.0.
- Add `@coga/factory` and the independently versioned `coga.dev/factory/v0.1`
  Work Order, Application Factory, recovery-state, adapter-receipt, and
  content-addressed Evidence Bundle protocols.
- Add exact impact-to-target planning, bounded and idempotent Git patching,
  tamper-evident recovery, and digest-pinned network-disabled Docker test/build
  adapters whose isolation facts are recorded in evidence.
- Add a real dependency-free Cedar H5 reference Application and a governed
  responsive-shell Work Order that deterministically produces its tested change,
  local candidate commit, and optional GitHub Draft PR without merging,
  publishing, or deploying.
- Extend the empty-project consumer test to install both Core and Factory
  tarballs and exercise both ESM APIs, CLIs, and schema exports.

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
