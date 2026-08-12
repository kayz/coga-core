# `@coga/factory`

`@coga/factory` turns one governed, exact COGA Artifact change into an isolated
candidate for every affected Application. It is a bounded factory cell, not a
general-purpose workflow engine.

The package version is `0.4.0`. Its independently versioned documents use
`coga.dev/factory/v0.3`; v0.1 and v0.2 Factory documents are intentionally
rejected. Core resources remain `coga.dev/v0.2` and `@coga/core` remains
`0.2.0`.

The controller:

1. loads a versioned Work Order from an exact Git commit;
2. validates the base COGA Instance and recomputes exact Application impact;
3. requires one target for every affected Application;
4. verifies each `AgentProposalReceipt`, including model identity, prompt digest,
   tool/network/filesystem policy, budgets, the exact Harness context closure,
   normalized Patch bytes, and authorized output paths;
5. runs each Application in its own worktree and recovery state, applying the
   shared domain Patch idempotently;
6. validates COGA closure and runs only registered test/build adapters in a
   digest-pinned, network-disabled Docker sandbox;
7. writes one content-addressed Evidence Bundle and commit per Application, then
   optionally uses the exact declared GitHub App installation to push a branch
   and create or reuse a machine-owned Draft PR;
8. records partial fan-out outcomes and retries only failed targets;
9. can collect exact remote CI, artifact-attestation, and human Policy-review
   evidence before changing an eligible Draft PR to ready for review.

## Protocols

| Document               | Responsibility                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| `WorkOrder`            | Exact base/change/targets, Policy rules, GitHub App delivery identity and human approvers      |
| `ProposalCompilation`  | Human-reviewed input to compile a pre-authored normalized Patch into a receipt                 |
| `AgentProposalReceipt` | Model/provider/prompt/tools/budgets, exact input hashes, normalized Patch and output paths     |
| `ApplicationFactory`   | Application-owned source/change paths and registered test/build adapters                       |
| `EvidenceBundle`       | Per-target base/tree/plan/file hashes, impact, receipts and sandbox facts                      |
| `RemoteEvidence`       | Exact Work Order/base/PR head/Patch closure, successful checks, attestation and Policy reviews |
| `GovernanceView`       | Derived, read-only status across local and remote evidence for every target                    |
| recovery state         | Per-target workspace, freshly derived exact plan, contiguous step prefix and result binding    |

The model and verification sandbox do not receive Git credentials or write the
repository. A proposal is accepted only as normalized unified-diff bytes, then
compiled into a versioned receipt. `compile-proposal` does not call a model; it
records and validates an already produced candidate against an explicit
compilation request. An ignored build directory cannot enter the context closure,
while an untracked, non-ignored source file must be included and hashed or
planning fails.

Every target owns a distinct branch, worktree, recovery state, Evidence Bundle,
commit and Draft PR. A target failure produces an aggregate `partial` result and
does not prevent other targets from completing. Rerunning the same Work Order
reuses completed results and resumes only failed steps.

Node verification uses a digest-pinned image with no network, read-only root and
repository mounts, no capabilities, no-new-privileges, a non-root user, and
bounded CPU, memory, processes, output, and time. Test doubles are explicitly
labeled and cannot masquerade as Docker evidence.

The default-branch `factory-evidence-attestation` workflow examines only a
successful `public-checks` PR run from the same repository. Ordinary PRs without
a Factory Evidence Bundle exit without attestation. When exactly one Bundle is
present, the workflow performs no checkout and executes no repository code; it
binds the content-addressed Bundle to the exact open Draft PR head and creates a
GitHub artifact attestation.
GitHub delivery uses `github.app-draft-pr/v3`. The Work Order fixes an App slug
and the only accepted credential entry point,
`COGA_FACTORY_GITHUB_TOKEN`. Before any push, the adapter proves that this is an
installation token whose repository set contains the exact target repository.
The token is supplied only through scrubbed child-process environments, never a
command argument, remote URL, Work Order or evidence file. The adapter then
requires the created or reused PR author to equal `<app-slug>[bot]`. That machine
identity and its bot login are forbidden from the human approver allowlist.
Credentialed Git also disables inherited system/global configuration,
credential helpers, askpass, interactive prompts, hooks and tracing; it rejects
local URL rewrites that apply to the exact endpoint and binds the local
branch/head plus both PR repositories and refs before accepting delivery. The
bounded token form supports GitHub's legacy and stateless `ghs_APPID_JWT`
installation tokens. Collector commands pin `github.com` and remove inherited
`gh` host, API-routing, config-directory and debug overrides. Their `--repo`
argument remains exact `owner/name`; `gh attestation verify` and `gh pr ready`
do not accept a duplicated hostname in that field.

The local collector independently verifies the declared PR author, attestation,
configured check set, exact remote Proposal Receipt, and an authorized
`APPROVED` review for every Policy. It also re-downloads the governed domain and
proposal Patches and requires the PR/Evidence Bundle file set to equal their exact
path closure. Delivery and collection use the same REST PR identity; GitHub
CLI's GraphQL `app/<slug>` display form is not accepted as the canonical
`<slug>[bot]` login. A review body must contain:

```text
[coga-policy:<policy-id>@<version>]
```

and the review must be bound to the current head commit. `--promote` performs a
fresh PR identity check, including author, and can only change Draft to ready for
review. It never merges, publishes, releases, tags or deploys.

## Commands

```powershell
npm run build --workspace @coga/factory
node packages/factory/dist/cli.js adapters
node packages/factory/dist/cli.js compile-proposal .coga/work-orders/cedar-status/proposal-compilation.yaml --repo-root .
node packages/factory/dist/cli.js run .coga/work-orders/cedar-status/work-order.yaml --delivery local
node packages/factory/dist/cli.js governance .coga/work-orders/cedar-status/work-order.yaml --format markdown
npm run factory:e2e
```

For an existing Draft PR whose Evidence Bundle has been attested:

```powershell
node packages/factory/dist/cli.js collect-remote `
  .coga/work-orders/cedar-status/work-order.yaml `
  application.cedar.insight.h5@0.2.0 `
  42 `
  .coga/evidence/<bundle-digest>.json
```

Add `--promote` only after the exact-head human Policy review exists. Omit it to
collect append-only evidence without mutating the PR.

The repository must be clean and the Work Order must already exist byte-for-byte
in the exact base commit. `collect-remote` resolves and verifies that same tracked
Work Order before trusting its remote base or governance rules. `factory:e2e`
requires Docker. The reference Work Order changes
`web.h5.responsive.shell@0.2.0`; impact resolves exactly to the independent Cedar
and Birch H5 Applications, each receives its own proposal, sandbox verification,
candidate and evidence.

Use `--delivery github` only when the exact base branch is already available on
the configured remote and Draft PR creation is intended. Supply a short-lived
installation token for the declared App through `COGA_FACTORY_GITHUB_TOKEN`.
The reference repository also requires a CODEOWNER human review and the five
Work Order checks on `main`; those server-side rules remain administrator
responsibilities. App creation, installation and token minting are deliberately
outside the Work Order and are never performed by proposal code.
