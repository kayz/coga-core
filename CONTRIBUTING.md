# Contributing

COGA changes are knowledge changes as well as code changes. Keep proposals small,
traceable, and independently verifiable.

## Development

```console
npm ci
npm run check:public
```

Use Node.js 22 or newer. Format changes with Prettier before opening a pull request.

## Where a change belongs

Ask these questions in order:

1. Would it remain unchanged if the industry were replaced? It may belong in Core.
2. Should multiple applications in one bounded domain inherit it? It may belong in
   an Instance Harness package.
3. Can products reasonably choose differently? Keep it in the Application.

Do not put domain terminology or organization policy into Core. Do not promote an
application observation to a shared Instance asset until it is generalized,
source-backed, validated by a scenario, and reviewed by a human domain authority.

## Asset proposal checklist

- Use a stable lowercase dot-separated identifier and an exact SemVer version.
- State one bounded meaning and record its scope and visibility.
- Cite authoritative provenance without copying restricted source text.
- Add typed relations and deterministic validation evidence.
- Add a scenario for every published rule and a contract reference for every
  published capability.
- Explain affected packages and applications.
- Keep credentials, customer data, private endpoints, and proprietary materials out
  of commits, fixtures, screenshots, logs, and generated output.

Agents may prepare a candidate patch and evidence. Approval and publication remain
human decisions.

## Pull requests

Describe the problem, the chosen layer, provenance, validation evidence, impact,
and rollback or replacement path. A pull request must pass the public checks. A
semantic change to a released resource requires a version change; do not silently
rewrite approved meaning.
