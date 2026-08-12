# `@coga/factory`

`@coga/factory` turns one governed, exact COGA Artifact change into a verified
Application change and an optional GitHub Draft PR. It is deliberately a small
factory cell, not a general-purpose workflow engine.

Its package version is `0.2.0`; the independently versioned protocol is
`coga.dev/factory/v0.1`.

The controller:

1. loads a versioned Work Order from an exact Git commit;
2. validates the base COGA Instance and computes exact Application impact;
3. requires the Work Order to cover every affected Application;
4. applies a bounded domain patch and a bounded Agent proposal in an isolated Git
   worktree;
5. validates COGA closure and runs only registered test/build adapters in a
   digest-pinned, network-disabled Docker sandbox;
6. writes a content-addressed Evidence Bundle outside canonical Artifact files;
7. creates a commit and, only when requested, an idempotent GitHub Draft PR.

## Protocols

| Document             | Responsibility                                                                    |
| -------------------- | --------------------------------------------------------------------------------- |
| `WorkOrder`          | Exact base, changed Artifact, patch digests, complete impact targets, Policy set  |
| `ApplicationFactory` | Application-owned change paths and registered test/build adapters                 |
| `EvidenceBundle`     | Base/tree/plan/file hashes, impact, governance partition, receipts, sandbox facts |
| recovery state       | Content-addressed workspace, plan digest, contiguous step prefix, result binding  |

The controller recomputes COGA validation and impact rather than trusting a target
list supplied by an Agent. A resumed run must match the same Work Order digest,
base commit, branch, workspace, plan digest, step sequence, and Git worktree
identity. Evidence is stored at `.coga/evidence/<sha256>.json`; changing its payload
without changing the address is rejected.

Node verification uses a digest-pinned image with no network, read-only root and
repository mounts, no capabilities, no-new-privileges, a non-root user, and bounded
CPU, memory, processes, output, and time. The Evidence Bundle records those sandbox
facts. Unit-test doubles are explicitly labeled and cannot masquerade as Docker
evidence.

Work Orders cannot contain shell commands. Docker receives no GitHub credentials,
the repository is mounted read-only during tests/builds, and build output uses a
separate ephemeral mount. Approval records may remain pending for Draft PR review;
the factory never merges, publishes, deploys, or fabricates an approval.

The 0.2 Agent adapter consumes a pre-authored, digest-bound unified patch. Model
invocation, prompt/context assembly, and proposal generation are intentionally not
part of this first cell; adding them requires a separately versioned adapter and
evidence contract.

```powershell
npm run build --workspace @coga/factory
node packages/factory/dist/cli.js adapters
node packages/factory/dist/cli.js run .coga/work-orders/cedar-status/work-order.yaml --delivery local
npm run factory:e2e
```

The repository must be clean and the Work Order must already exist in the exact
base commit. `factory:e2e` also requires Docker. The reference Work Order changes
`web.h5.responsive.shell@0.2.0`, proves that impact resolves exactly to
`application.cedar.insight.h5@0.2.0`, updates the real Cedar H5 source, and runs
its tests and build in the sandbox.

Use `--delivery github` only when the exact base branch is already available on
the configured GitHub remote and a Draft PR is intended.
