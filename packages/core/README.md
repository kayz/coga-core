# `@coga/core` 0.1

`@coga/core` is the domain-neutral control contract for a COGA software factory. It loads canonical YAML or JSON resources, validates their schemas and semantics, produces a human-readable catalog, and traces an artifact to applications that consume its exact harness package version.

Core deliberately does **not** interpret broker, mini-program, organization, or product rules. A COGA instance supplies that knowledge as versioned `DomainArtifact` and `HarnessPackage` resources. An application records exact harness dependencies and keeps application-only decisions in `spec.choices`.

## Resource contract

Every resource uses `schemaVersion: coga.dev/v0.1`, one of the four resource kinds, stable lowercase dot-separated IDs, exact SemVer versions, and `metadata.lifecycle`. Optional `metadata.scope` (`core`, `instance`, or `application`) and `metadata.visibility` (`public`, `internal`, or `restricted`) make ownership and publication boundaries machine-checkable. A public resource cannot directly depend on a loaded non-public resource.

- `DomainArtifact` records a concept, rule, capability, scenario, policy, or runbook.
- `HarnessPackage` owns artifacts in one of the domain, platform, engineering, organization, or operations layers.
- `CogaInstance` registers exact package and application versions and defines its bounded domain.
- `Application` declares delivery targets and exact harness dependencies. `spec.choices` is intentionally opaque to Core.

Canonical manifests remain the source of truth. The schemas include titles, descriptions, defaults, and `x-coga-ui` annotations so a future workbench can render forms without creating a second source of truth.

## CLI

```console
coga validate ./instance.yaml
coga catalog ./instance.yaml
coga catalog ./instance.yaml --format json
coga impact ./instance.yaml domain.customer.identity
```

Validation covers JSON Schema, referenced file identity, exact package dependencies, artifact relations, scenario/runbook bindings, lifecycle publication rules, capability contracts, and likely literal secrets. Secret references such as `env://NAME`, `vault://path`, or `${NAME}` are allowed; secret values are not.

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

const loaded = load("./instance.yaml");
const result = validate(loaded);
if (!result.valid) throw new Error(result.issues[0]?.message);

console.log(renderCatalogMarkdown(catalog(loaded)));
console.log(impact(loaded, "domain.customer.identity"));
console.log(checkLifecycleTransition("approved", "published"));
```

Lifecycle progression is deliberately explicit and monotonic in 0.1: `draft → candidate → approved → published → deprecated`. Remaining in the current state is valid; skipping or moving backward is not.

## Control plane contract

The original four Harness resource kinds remain on `coga.dev/v0.1`. Factory execution uses the separate `coga.dev/control/v0.1` contract for `TaskContract`, `EvidenceBundle`, `RunRecord`, `Observation`, `Incident`, and `PromotionProposal`, plus typed policy/approval decisions and hash-chained audit events.

Every top-level control resource has exactly `{ schemaVersion, kind, metadata, spec }`; `metadata` uses the same canonical `{ id, title, version, lifecycle, owners?, tags?, scope?, visibility? }` shape as Harness resources. Digests are `sha256:` plus 64 lowercase hexadecimal characters, and all resource/adapter references use exact `{ id, version }` SemVer bindings.

- `TaskContract.spec`: `mode`, `risk`, `requestedBy`, `instance`, optional `application`, `intent`, `workspace`, ordered `steps`, `policies`, `approvals`, and `budget`.
- `EvidenceBundle.spec`: `task`, `runId`, `producedBy`, fixed `disposition: candidate`, one `subject`, `materials`, `claimResults`, and safe `execution` metadata.
- `RunRecord.spec`: exact task/idempotency and review digests, `state`, requester, per-step state/digests, embedded policy and approval decisions, evidence refs, audit trail/head, budget usage, and optional heartbeat/checkpoint/cancellation.
- `Observation.spec`: a CloudEvents 1.0 envelope plus classification, retention, exact schema ref, and application ref.
- `Incident.spec`: application, status, summary, observation refs, and optional human closure with non-deploy verification.
- `PromotionProposal.spec`: proposer, observations, source applications/authorities, target package/type, generalized candidate, scenarios, and candidate digest; lifecycle is always `candidate`.

`PolicyDecision`, `ApprovalDecision`, and `AuditEvent` are canonical embedded contracts in `$defs`, validated through their dedicated APIs; they are not additional top-level resource kinds.

Adapters are injected by exact kind, stable ID, and SemVer. Core defines agent, tool, workspace, validator, policy, observation, and preview interfaces but provides no shell or deployment adapter. Agent and model output is always candidate evidence: only a human actor with the required role and digest-bound review context may approve it. Model evidence stores provider/model/response identifiers, usage, and prompt/output digests only—never credentials, raw prompts, or reasoning.

The deterministic control APIs also provide semantic structural diffing, package dependency closure, transitive impact reasons, evidence verification, and Harness release planning/verification. They prepare local evidence and decisions; they do not perform GitHub, CI, deployment, or production operations.

```ts
import {
  AdapterRegistry,
  createControlEngine,
  executeTask,
  impactWithReasons,
  planHarnessRelease,
  reduceRunState,
  resolvePackageClosure,
  validateControlDocument,
  validateControlResource,
  verifyEvidenceBundle,
  verifyHarnessRelease,
} from "@coga/core";
```

The form-ready control schema is exported as `@coga/core/schemas/control.schema.json`. `validateControlResource` is the canonical top-level validator (`validateControlDocument` remains an equivalent name). `createControlEngine({ registry, now })` binds an exact adapter registry and injected clock around `execute`/`resume`. `executeTask` is the lower-level equivalent. Credentials remain the caller's in-memory responsibility and are not fields in any Core contract.
