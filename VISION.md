# COGA Vision

**Cognition · Organization · Growth · Architecture**

COGA is an open-source foundation for growing domain-rooted, AI-native software
factories.

Its purpose is not to generate one application from one prompt. Its purpose is to
**calibrate a bounded domain** so that a governed AI organization can repeatedly
build, verify, deliver, operate, repair, and evolve many applications in that
domain.

## The shift

As application code becomes cheaper to produce, the scarce assets move upward:

- a precise model of the domain;
- rules that distinguish correct behavior from plausible behavior;
- capabilities and contracts that agents can safely invoke;
- scenarios and evaluators that can prove an outcome;
- delivery and operating knowledge that keeps software alive;
- governance that tells machines when to act and when to stop.

COGA makes those assets explicit, versioned, executable where possible, and
traceable to human authority. Applications remain important, but they become
consumers of a durable **Domain Harness** rather than the only place where domain
knowledge can live.

## The three boundaries

### COGA Core — the open mechanism

COGA Core is domain-independent. It defines the protocols and control-plane
mechanisms for:

- artifact schemas, lifecycle, provenance, and publication;
- task contracts, evidence, policies, approvals, and audit;
- Harness packages, dependency locks, catalogs, and impact analysis;
- agent, tool, workspace, and validator adapters;
- repeatable application production and operating loops.

Core knows how a factory works. It does not know what a brokerage customer, a
clinical encounter, or a manufacturing order means.

### COGA Instance — a domain-rooted factory

A COGA Instance combines Core with a bounded domain, an organization, delivery
platforms, real tools, environments, and operating knowledge. It answers:

- What exists in this domain?
- What must always be true?
- What capabilities may be used?
- Which sources are authoritative?
- How is correctness demonstrated?
- Which changes require human judgment?
- Which applications are affected by a domain change?
- How are applications observed, repaired, and upgraded?

One Instance should sustain multiple applications. An Instance that only explains
one product has not yet proved that its knowledge has risen above the application
layer.

### Application — an independently useful product

An Application owns its user problem, journeys, interface, product policy, code,
application-specific scenarios, and runtime objectives. It declares exact
dependencies on Instance Harness packages and is independently buildable and
deployable.

Normal user traffic must not depend on the factory control plane being online.
COGA produces and maintains applications; it is not secretly inserted into every
application request path.

## The factory loop

```text
Authoritative sources and human intent
                 ↓
      Agent-assisted domain calibration
                 ↓
    Human review of meaning and blast radius
                 ↓
 Versioned Domain / Platform / Operations Harness
                 ↓
        Application production loop
                 ↓
   Tests · evidence · preview · release decision
                 ↓
        Runtime signals and incidents
                 ↓
 Candidate scenarios, rules, and capabilities
                 └───────────────────────────────↺
```

The system grows by promotion, not by unreviewed memory. Runtime observations begin
as local evidence. They become shared assets only after they are generalized,
validated, traced to a source, and approved at the appropriate risk level.

## Human governance

COGA does not define “autonomous” as “nobody is responsible.” It aims for
**human-governed, unattended execution**:

- people own goals, domain meaning, exceptions, risk acceptance, and irreversible
  production decisions;
- agents research, model, implement, test, diagnose, and prepare evidence;
- deterministic systems enforce schemas, contracts, quality gates, permissions,
  deployment provenance, and rollback conditions.

The human interface is therefore a governance surface, not a chat transcript. A
future COGA Workbench will expose candidate assets, structured forms, semantic
diffs, provenance, impact graphs, validation evidence, and approval actions. The
underlying versioned files remain the source of truth.

## Open and private growth

COGA Core is open source. Reusable public domain and platform packages may also be
open. A real Instance can mix them with private organization policy, restricted
sources, credentials held outside Git, and confidential application knowledge.

Publication is an allowlist operation: only explicitly public Core and Instance
assets, whose full dependency and provenance closure is also public, may enter an
open distribution. Private applications are never used as an implicit source for
public artifacts.

## What 0.1 must prove

Version 0.1 is intentionally small but end-to-end. It must prove that:

1. Core can validate and catalog versioned Harness assets.
2. A bounded example Instance can express domain, platform, engineering,
   organization, and operations knowledge without embedding one product.
3. Multiple Application manifests can consume exact Instance package versions.
4. A domain change can produce a deterministic impact report.
5. A real local-only Application can consume the same contracts without leaking
   private material into the public distribution.
6. The final public candidate is reproducible, self-tested, and safe to clone.

## What COGA is not

COGA is not a universal ontology, a general-purpose policy language, a replacement
for GitHub or CI, an infrastructure orchestrator, a production shell for an LLM,
or a promise that all software work can be automated. It composes existing tools
behind explicit contracts and makes the domain-specific feedback loop governable.

## The long ambition

The long-term test is not whether an agent can generate the first application. It
is whether the fifth and twentieth changes become faster, safer, more explainable,
and less dependent on human execution because the factory has learned without
losing control.

When that becomes true across several applications, the Domain Harness is no
longer documentation. It is a compounding software-production asset.
