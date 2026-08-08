# COGA governed factory reference

Status: implementation contract for the first executable reference factory.

This document turns the long-term COGA vision into a finite, testable reference
implementation. It does not claim that every organization, domain, model, or
delivery platform can run unattended. It proves that the protocol has a real
control plane, a human governance surface, and a repeatable feedback loop while
keeping product traffic independent from the factory.

## Product boundary

The reference subject is the public, fictitious Broker Digital Customer Channel
Instance. Its audience is a domain steward who must decide whether a proposed
change is safe to turn into a shared Harness candidate and which Applications
must be re-verified.

The public repository contains Core, the reference factory, Workbench, sanitized
Instance knowledge, and two fictitious generated consumers. A real mini-program
may be attached from the ignored `private/` overlay. FICANT, real brokerage
systems, credentials, production mini-program upload, and real deployment are
outside this reference boundary.

## Frozen protocol boundary

Existing `coga.dev/v0.1` knowledge resources remain compatible. The runtime
control plane uses `coga.dev/control/v0.1` and separates immutable intent from
execution records:

- `TaskContract` records goal, authority sources, acceptance criteria, risk,
  exact adapters, budgets, validators, and approval gates.
- `EvidenceBundle` binds claims to real subjects and SHA-256 digests. A model
  opinion is evidence, never approval.
- `PolicyDecision` and `ApprovalDecision` bind decisions to the task, candidate,
  impact, and evidence digests. A changed candidate invalidates old approval.
- `RunRecord` checkpoints an idempotent state machine. Completed side effects are
  not repeated after restart.
- `AuditEvent` forms a forward SHA-256 chain so deletion, mutation, or reordering
  is detectable.
- `Observation`, `Incident`, and `PromotionProposal` carry application-local
  runtime evidence back toward a governed Harness candidate.

Core defines these contracts and pure mechanisms. `@coga/factory` supplies a
local file-backed reference engine and safe adapters. `@coga/workbench` is the
human interface over that same control plane. Instance files own prompts,
policies, forms, scenarios, recipes, and runbooks. Applications own executable
bindings, previews, telemetry schemas, critical journeys, and product choices.

## Invariants

1. Published Harness files are never edited by a running Agent. All writes go to
   a candidate workspace.
2. Literal credentials are rejected. Provider secrets enter only through named
   process-environment references and never enter evidence, logs, browser
   storage, or release material.
3. Agent authors cannot approve their own output. Promotion and release always
   require a human role declared by the Instance.
4. A command adapter uses an executable plus an argument array, no shell string;
   its working directory is confined to an allowlisted workspace, with time,
   output, environment, and invocation limits.
5. Evidence is verified from bytes, not trusted from a `passed` label.
6. Public release requires the transitive dependency, source, prompt, evidence,
   and visibility closure to be public and allowlisted.
7. Runtime observations remain Application-scoped until they are generalized,
   independently validated, linked to authority, sanitized, and approved.
8. Normal Application requests never call the factory control plane.

## DeepSeek asset evaluator

The Instance owns a versioned asset-evaluation prompt and output schema. The
reference adapter calls the current DeepSeek OpenAI-compatible chat completion
endpoint using a model declared by the profile. It requests JSON and validates
the response before accepting it as `EvaluationEvidence`.

The adapter receives only allowlisted or sanitized source material. It records
provider, model, response identifier, token usage, prompt digest, and output
digest, but never the API key, raw hidden reasoning, or an unbounded prompt. The
default test path is a deterministic offline adapter. A real-network smoke test
is opt-in and must receive `DEEPSEEK_API_KEY` through the process environment:

```console
npm run build
npm run check:deepseek
```

The smoke test sends only a fixed public, sanitized example and prints bounded
provider metadata. It never prints or persists the credential or raw model
response, and it cannot grant approval.

The evaluator may recommend `ready`, `revise`, or `reject` and may identify
semantic risks or scenarios to rerun. It cannot transition lifecycle, approve,
publish, upload, or deploy anything.

## Human workflow

Workbench implements one connected workflow:

```text
Intent → candidate → structural + model assessment → transitive impact
      → deterministic validators → digest-bound human decision → local preview
      → observation → incident → repair evidence → promotion candidate
```

The interface renders the Instance catalog, structured forms, semantic diff,
source provenance, impact paths, required and observed evidence, approval gates,
runtime events, incidents, and the audit chain. Versioned files and append-only
control records remain the source of truth; the browser does not own a second
database.

## Executable acceptance matrix

| Vision promise                                   | Reference proof                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset schema, lifecycle, provenance, publication | Existing resources plus digest-bound release planning and visibility/source closure                                                                                             |
| Task, evidence, policy, approval, audit          | Validated control documents, deterministic state transitions, real validator output, human separation of duties, tamper-evident journal                                         |
| Harness package, locks, catalog, impact          | Exact locks, topological closure, deterministic bundle digest, direct and transitive reason paths                                                                               |
| Agent/tool/workspace/validator adapters          | Exact-version registry, offline evaluator, opt-in DeepSeek evaluator, confined workspace, no-shell validator, policy and preview adapters                                       |
| Repeatable Application production                | One Harness release drives independent mini-program and H5 recipes and repeatable builds                                                                                        |
| Governed unattended execution                    | Runs proceed without a human until a declared risk gate, then pause and resume from disk exactly once                                                                           |
| Development and release decision                 | Candidate work, tests, build evidence, local preview decision, and explicit production-release block                                                                            |
| Runtime operation and repair                     | Registered observations create an unclassified incident, bind a runbook, require journey/monitoring/regression proof, and produce only a candidate promotion                    |
| Workbench                                        | A real localhost UI invokes the same API and files used by CLI tests; refresh/restart reconstructs state                                                                        |
| Public/private overlay                           | Public CI works without `private/`; local checks attach the restricted mini-program without copying it into public release material                                             |
| Compounding change quality                       | Every completed change records duration, attempts, reused artifacts/scenarios, incidents, and manual gates so fifth/twentieth-change trends are measurable rather than asserted |

## Completion gate

The reference is complete only when all public tests, local private tests, factory
fault-injection tests, Workbench browser flow, accessibility checks, public
boundary scans, secret scans, deterministic rebuild checks, and audit-tamper
checks pass from a clean install. Real provider connectivity is reported
separately because availability and account balance are external state; the
offline protocol test remains mandatory.
