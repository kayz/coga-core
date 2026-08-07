# Representation choices and form readiness

## Why this shape

The resource envelope uses `schemaVersion`, `kind`, `metadata`, and `spec`. This is
similar to the proven catalog-descriptor pattern documented by Backstage: YAML is
human-maintainable while the same semantic structure can be represented as JSON.
Stable dot-separated IDs make cross-file relations independent of filenames, and
exact SemVer locks keep an application's knowledge inputs reproducible.

Different knowledge retains its native representation:

- COGA YAML describes governed concepts, rules, policies, capabilities, scenarios,
  runbooks, packages, instances, and application dependencies.
- OpenAPI remains the preferred description for HTTP interfaces; this example uses
  only fictitious contract IDs and intentionally includes no API operations.
- Observable Given/When/Then statements make rules reviewable by domain experts and
  are compatible with the executable-specification style described by Cucumber.
- JSON Schema Draft 2020-12 describes the future candidate form and can validate
  form output before YAML serialization.

This keeps knowledge close to the best tool for its semantics rather than inventing
one universal DSL.

## Form-ready, without a UI

[`../ui/artifact-candidate.form.schema.json`](../ui/artifact-candidate.form.schema.json)
defines the editable resource. [`../ui/artifact-candidate.ui.json`](../ui/artifact-candidate.ui.json)
adds ordering, widgets, and review help without changing the stored artifact.

A future workbench should:

1. Load these schemas and an existing YAML artifact.
2. Show source links, semantic relations, validation scenarios, and package impact.
3. Serialize a candidate resource to a branch or patch.
4. Run deterministic checks and show semantic diff plus affected applications.
5. Require human approval before the published registry changes.

It must not introduce a database-only representation. An optional index may cache
relations for search, but the versioned files remain recoverable authority.

## Referenced practices

- [Backstage descriptor format](https://backstage.io/docs/features/software-catalog/descriptor-format/)
  informs the common human-readable envelope.
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
  provides a portable form and validation contract.
- [OpenAPI Specification](https://spec.openapis.org/oas/)
  preserves interface contracts in a standard, language-neutral format.
- [Cucumber Gherkin reference](https://cucumber.io/docs/gherkin/reference/)
  informs observable scenario statements.
- [Google SRE incident response](https://sre.google/workbook/incident-response/)
  informs the separation of coordinated response, mitigation, and learning.
