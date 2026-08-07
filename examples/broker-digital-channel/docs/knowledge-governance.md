# Knowledge governance

## Files are the authority; forms and agents are interfaces

Published artifacts live in versioned files so that a rule can be diffed, reviewed,
validated, pinned by an application, and rolled back with its history intact. A
form or conversation creates a proposal; it does not write directly to the
published registry. The form contract in [`../ui/`](../ui/) targets the same
resource envelope, avoiding a second source of truth.

## Candidate-to-publish workflow

1. **Observe** — a person or agent identifies a possible concept, invariant,
   platform constraint, operational lesson, or conflict from an allowed source.
2. **Draft** — the curator records a stable ID, bounded statement, provenance,
   relations, and proposed validation. Uncertain claims remain explicit.
3. **Candidate** — an agent normalizes the proposal, detects duplicates, proposes
   scenarios, and opens a file change for review. It may not publish.
4. **Review** — a domain owner checks meaning and sources; platform, security,
   compliance, or operations owners join when their layer is affected.
5. **Validate** — deterministic schema/reference checks run, followed by the
   referenced scenarios. Agent commentary is supporting evidence, never the gate.
6. **Approve** — the responsible human accepts the semantic diff and blast radius.
7. **Publish** — the package receives a SemVer update, applications continue on
   their exact locks, and impact analysis proposes opt-in upgrade changes.
8. **Learn** — incidents and application feedback create new candidates. They do
   not mutate published knowledge automatically.

## Promotion rules

An artifact may move to `published` only when all of the following are true:

- Its ID and meaning are application-neutral inside the bounded context.
- Its scope and exclusions are understandable without reading implementation code.
- Each normative claim has authoritative or clearly identified provenance.
- Its relations resolve and at least one observable scenario covers the rule or
  policy; high-risk invariants include a denial or failure scenario.
- Impact analysis lists all package and application consumers with exact versions.
- A human owner for the affected domain approves the semantic change.
- Legal or compliance applicability is reviewed by the responsible organization;
  an agent may not infer approval from the existence of a public source.

Deprecation preserves the old ID and version history, names the replacement when
one exists, and does not silently rewrite an application's dependency lock.

## Agent authority

The concrete roles are in [`../agents/`](../agents/):

- The **curator** extracts and normalizes candidates.
- The **validator** checks structure, references, provenance, and scenario coverage.
- The **impact analyst** calculates consumers and explains upgrade risk.

Agents may propose YAML, semantic diffs, test scenarios, and upgrade pull requests.
They may not invent a missing rule, approve their own proposal, expose private
material, or bypass a deterministic validation failure.
