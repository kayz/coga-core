# Knowledge and Domain Asset Model

This document records why COGA 0.1 uses a file-first, schema-driven model for
domain knowledge. It is a design decision, not a claim that every kind of domain
knowledge can already be automated.

## Decision summary

COGA 0.1 uses:

- YAML 1.2 files as the canonical authored representation;
- JSON Schema Draft 2020-12 for structural validation and future form generation;
- Markdown for human explanation and generated catalogs, not as a duplicate
  normative database;
- Git commits and pull requests for versioning, review, and publication;
- stable namespaced identifiers and exact `0.x` SemVer dependency locks;
- lightweight W3C PROV-inspired provenance fields;
- SKOS-inspired labels, definitions, broader/related links, and examples;
- OpenAPI 3.1 for HTTP contracts rather than a COGA-specific API language;
- scenarios and ordinary tests as rule enforcement before introducing a general
  policy DSL.

This follows the useful part of the Backstage Software Catalog model: repository
YAML is the source of truth, while catalogs and graphs are derived read models.
Backstage also recommends that editing interfaces create pull requests rather than
silently mutating a second database. See the official [Software Catalog
documentation](https://backstage.io/docs/features/software-catalog/) and [descriptor
format](https://backstage.io/docs/next/features/software-catalog/descriptor-format/).

## Core resource envelope

Every COGA resource uses a common envelope:

```yaml
schemaVersion: coga.dev/v0.1
kind: DomainArtifact
metadata:
  id: broker.digital.channel.rule.backend-entitlement-authority
  title: Backend entitlements are authoritative
  version: 0.1.0
  lifecycle: candidate
  scope: instance
  visibility: public
  owners:
    - role.domain-steward
spec:
  artifactType: rule
  summary: The client renders capabilities returned by the trusted backend.
  statement: The client must never promote its own entitlement.
  provenance: []
  relations: []
  validation: []
```

The `schemaVersion` governs the file format. `metadata.version` governs the
resource's consumer-visible version. Git commits identify an exact source
revision. A future package digest will identify an immutable build. Business
effective dates are separate from all four.

SemVer explicitly treats `0.y.z` as initial development, so 0.1 consumers use
exact versions rather than permissive ranges. See [Semantic Versioning
2.0.0](https://semver.org/).

## Minimal asset types

COGA Core 0.1 recognizes a deliberately small set:

| Type         | Purpose                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `concept`    | A stable term, definition, boundary, examples, and relations             |
| `rule`       | A normative statement, applicability, exception, source, and enforcement |
| `capability` | A callable or composable domain ability with contract references         |
| `scenario`   | Given/When/Then evidence and an automated or manual oracle               |
| `policy`     | Organization or factory governance, not arbitrary business code          |
| `runbook`    | A bounded operating response with preconditions and success checks       |

API and data contracts stay in their native OpenAPI/JSON Schema files and are
referenced by capabilities. Harness packages collect assets into a versioned
consumer boundary.

## Provenance

The provenance model borrows only the useful core of [W3C
PROV](https://www.w3.org/TR/prov-primer/):

- an **Entity** is a source or COGA asset;
- an **Activity** is extraction, revision, validation, approval, or publication;
- an **Agent** is a human, software agent, tool, or organization;
- `used`, `wasGeneratedBy`, `wasDerivedFrom`, and `wasAttributedTo` describe why an
  asset exists.

COGA stores source title, URI or repository locator, retrieval time, authority,
confidentiality, and an optional digest. It does not copy long source documents
into public assets. Provenance proves what was used; it does not prove that the
source itself is correct.

## Concepts without a full ontology stack

Concept fields are inspired by [SKOS](https://www.w3.org/TR/skos-reference/):
preferred and alternative labels, definitions, scope notes, examples,
broader/narrower links, related links, and optional exact/close matches to an
external vocabulary.

COGA 0.1 does not require RDF or OWL. Stable identifiers and typed relations keep
a future export path open without imposing an open-world reasoner on application
validation. Formal industry ontologies such as [FIBO](https://spec.edmcouncil.org/fibo/index.html)
remain valuable external references when their bounded subject actually applies;
they are not imported merely because an Instance happens to operate in financial
services.

## Rules and execution

A rule is first a human-reviewable normative statement. Its `validation` entries
connect it to one or more deterministic enforcement mechanisms:

- JSON Schema;
- OpenAPI contract validation;
- scenario evaluation;
- an ordinary automated test;
- explicit manual review.

[Open Policy Agent](https://www.openpolicyagent.org/docs/policy-language) is a
mature policy-as-code system and may later enforce factory authorization or release
gates that must be evaluated in several runtimes. COGA 0.1 does not add a general
rule DSL: rule conflict, precedence, time, exceptions, explanation, sandboxing, and
testing would otherwise become a second major product before real use has proved
the need.

## Human-readable and form-ready

JSON Schema annotation fields (`title`, `description`, `examples`, `default`,
`readOnly`, and `deprecated`) make the same contract useful to validation,
documentation, and future forms. See the official [JSON Schema 2020-12
meta-schema](https://json-schema.org/draft/2020-12) and [annotation
reference](https://json-schema.org/understanding-json-schema/reference/annotations).

Structure and presentation remain separate. A future Workbench can follow the
[JSON Forms](https://jsonforms.io/docs/) pattern: JSON Schema defines data while a
UI schema defines order, grouping, visibility, and controls. A form submission
must produce a candidate file patch and pull request; it must not create a second
authoritative database.

## Lifecycle and agent authority

COGA 0.1 uses:

```text
draft → candidate → approved → published → deprecated
```

- Agents may create and revise `draft` and `candidate` assets.
- Deterministic validation must pass before approval.
- A human authority approves domain meaning and high-risk policy.
- `published` means the asset is included in a released Harness package.
- Replacement uses a relation and a new identifier/version; approved meaning is
  not silently rewritten.

Application observations remain application evidence until promotion. Promotion
requires either more than one consumer or an authoritative public source, removal
of product-specific details, an independent scenario proving the abstraction, and
human approval.

## Scope placement

Use these tests in order:

1. If the asset remains unchanged when the industry is replaced, it is a Core
   mechanism candidate.
2. If several applications inside the bounded domain should inherit it, it is an
   Instance asset candidate.
3. If different products can reasonably choose differently, it stays in the
   Application.

Visibility is independent from scope. A real Instance may contain public,
internal, and restricted assets. An open distribution is built from an explicit
public allowlist and only when every transitive dependency and provenance source is
also public.

## Deferred infrastructure

### Graph database

Typed file references are enough to build a deterministic adjacency index,
reverse links, impact report, and static graph at 0.1 scale. A graph database would
introduce a second persisted state, synchronization, migration, backup, and access
control. If multi-hop query load later proves the need, it should remain a derived
read model.

### RDF/OWL and a complete ontology

OWL is designed for open-world knowledge representation, not closed-world
application validation. COGA first needs explicit contracts, failure on missing
required facts, and human-readable diffs. RDF export can be added when multiple
organizations need semantic interchange and there are concrete competency
questions plus an ontology steward.

### General rule DSL

JSON Schema, OpenAPI, scenarios, and normal tests cover the first deterministic
checks. A DSL becomes justified only when the same stable decision must be
evaluated across several applications or runtimes and a tested conflict and
explanation model exists.

## Consequence

Files are the durable facts. Agents help discover and compile them. Humans govern
meaning and risk. Forms, catalogs, and graphs are replaceable views. Applications
consume exact Harness releases and never rely on an unversioned conversation as
domain truth.
