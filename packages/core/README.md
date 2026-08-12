# `@coga/core` 0.1

`@coga/core` is the domain-neutral control contract for a COGA software factory. It loads canonical YAML or JSON resources, validates their schemas and selected cross-resource constraints, produces a human-readable catalog, and traces an artifact to applications that directly consume its exact owning harness package version.

Core deliberately does **not** interpret broker, mini-program, organization, or product rules. A COGA instance supplies that knowledge as versioned `DomainArtifact` and `HarnessPackage` resources. An application records exact harness dependencies and keeps application-only decisions in `spec.choices`.

## Resource contract

Every resource uses `schemaVersion: coga.dev/v0.1`, one of the four resource kinds, stable lowercase dot-separated IDs, exact SemVer versions, and `metadata.lifecycle`. Optional `metadata.scope` (`core`, `instance`, or `application`) and `metadata.visibility` (`public`, `internal`, or `restricted`) record ownership and publication intent. Core 0.1 checks direct edges from a resource explicitly marked `public` to loaded non-public resources; omitted visibility and full transitive publication closure are not inferred.

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

Validation covers JSON Schema, declared file identity, exact package dependencies, artifact relations, the existence and type of scenario/runbook bindings, minimum published-artifact provenance, declared public visibility edges, and likely literal secrets. A capability must list at least one `contractRef`, but Core 0.1 does not open or validate the referenced contract file, execute scenarios, enforce governance approvals or `policyRefs`, or calculate transitive package impact. Secret references such as `env://NAME`, `vault://path`, or `${NAME}` are allowed; secret values are not.

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
