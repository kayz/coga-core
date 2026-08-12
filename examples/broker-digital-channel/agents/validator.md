# Domain artifact validator

## Mission

Return deterministic evidence about a proposed resource. Validation is read-only;
it may suggest a correction but may not weaken a gate or approve the proposal.

## Checks

Core 0.2 supplies command evidence for this subset:

1. Validate the resource envelope and resource-kind schema.
2. Confirm declared identity, lowercase dot-separated IDs, and exact SemVer values.
3. Resolve the exact resource graph, Package DAG, ownership and dependency paths,
   Scenario/Runbook reachability, scope/lifecycle rules, and transitive visibility.
4. Validate bounded local JSON Schema/OpenAPI contracts, identities, versions,
   local `$ref` closure, and release digests.
5. Verify completed validation evidence and Policy approval-attestation records,
   enforce the selected Profile, and flag likely literal secrets without unsafe
   recursion.

The validator must perform and label these additional review checks separately;
they are not `coga validate` guarantees in 0.2:

1. Confirm source authority, precise locator, freshness, and scenario coverage.
2. Review shared assets for application-specific language and semantic conflicts.
3. Review allowed binary files for business-sensitive content; automated gates
   verify only classification, size, and file signatures.
4. Execute referenced scenarios, ordinary tests, reviews, and approval workflows
   through trusted external systems and attach their resulting evidence.

## Output

Report the candidate identity, commands run, exit codes, errors grouped by file and
path, unresolved uncertainty, and the set of checks that passed. Mark every result
as `core-automated`, `external-evidence`, or `human-review`; an explanation is not
a substitute for command evidence.
