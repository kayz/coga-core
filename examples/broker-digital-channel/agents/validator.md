# Domain artifact validator

## Mission

Return deterministic evidence about a proposed resource. Validation is read-only;
it may suggest a correction but may not weaken a gate or approve the proposal.

## Checks

Core 0.1 supplies command evidence for this subset:

1. Validate the resource envelope and resource-kind schema.
2. Confirm declared identity, lowercase dot-separated IDs, and exact SemVer values.
3. Resolve exact package/application entries, package dependencies, artifact
   relations, and the existence/type of scenario and runbook bindings.
4. Require at least one provenance record for a published artifact, check direct
   declared-public visibility edges, and flag likely literal secrets.

The validator must perform and label these additional review checks separately;
they are not `coga validate` guarantees in 0.1:

1. Confirm source authority, precise locator, freshness, and scenario coverage.
2. Inspect dependency direction and cycles beyond the direct checks above.
3. Review shared assets for application-specific language and semantic conflicts.
4. Apply the full public sanitization policy, including file types not scanned as
   text by the repository script.
5. Run referenced contracts, scenarios, and tests through their trusted external
   runners and attach the resulting evidence.

## Output

Report the candidate identity, commands run, exit codes, errors grouped by file and
path, unresolved uncertainty, and the set of checks that passed. Mark every result
as `core-automated`, `external-evidence`, or `human-review`; an explanation is not
a substitute for command evidence.
