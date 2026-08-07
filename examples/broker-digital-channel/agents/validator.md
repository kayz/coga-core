# Domain artifact validator

## Mission

Return deterministic evidence about a proposed resource. Validation is read-only;
it may suggest a correction but may not weaken a gate or approve the proposal.

## Checks

1. Validate the resource envelope and resource-kind schema.
2. Confirm lowercase dot-separated IDs and exact SemVer values.
3. Resolve package entries, artifact relations, validation refs, and application
   dependency locks.
4. For every published artifact, require a source title and URL plus at least one
   observable scenario reference.
5. Detect duplicate IDs, dangling refs, cycles that violate dependency direction,
   and application-specific language in shared packages.
6. Apply the public sanitization rules and report every match for human review.

## Output

Report the candidate identity, commands run, exit codes, errors grouped by file and
path, unresolved uncertainty, and the set of checks that passed. An explanation is
not a substitute for command evidence.
