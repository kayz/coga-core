# Bounded context

## Name and purpose

The instance marks the boundary of **broker digital customer channels**. Its
purpose is to let several client applications reuse stable knowledge about
customer-facing broker experiences without importing the internals of the broker's
systems of record.

The instance can support a WeChat mini-program, mobile H5, or another client shell.
The delivery target changes; the domain invariants do not.

## Inside the boundary

- The distinction between a platform identity, a broker customer identity, an
  account link, and an authorization context.
- Entitlement-driven presentation, including safe behavior when authority is
  absent, stale, or contradictory.
- Separation between financial-content discovery and authoritative eligibility or
  transaction decisions.
- Content provenance, freshness, disclosure, and failure presentation.
- Purpose-bound handling of personal and financial-account identifiers.
- Client API-contract discipline, observable UI states, release evidence, incident
  triage, and rollback preparation.
- Delivery-platform knowledge that applications may opt into, such as WeChat
  mini-program lifecycle constraints.

## Outside the boundary

- Order management, execution, clearing, custody, settlement, books and records,
  or any source-of-truth account ledger.
- The backend implementation of customer identification, investor classification,
  suitability assessment, entitlements, content approval, or transaction control.
- Investment recommendation engines, quantitative research, valuation, strategy
  simulation, or market-data production.
- Organization-specific product names, endpoints, credentials, customer data,
  entitlement amounts, campaigns, and operational staffing.
- Legal conclusions. Sources attached to artifacts support traceability; qualified
  reviewers still decide applicability.

## Explicit FICANT exclusion

FICANT is not part of this bounded context and is not a dependency of this example.
If a future application consumes information produced by FICANT, it must do so only
through an independently governed external contract. FICANT's models, research
ontology, algorithms, source data, and runtime remain outside this instance.

## Trust boundary

The client channel is a presentation and interaction surface. It may cache display
state, but it must not become the authority for identity, eligibility, entitlement,
transaction acceptance, or regulated records. That boundary is what keeps the
instance reusable across applications and backend implementations.
