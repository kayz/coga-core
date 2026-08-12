# `@coga/factory`

`@coga/factory` turns one governed, exact COGA Artifact change into a verified
Application change and an optional GitHub Draft PR. It is deliberately a small
factory cell, not a general-purpose workflow engine.

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

Work Orders cannot contain shell commands. Docker receives no GitHub credentials,
the repository is mounted read-only during tests/builds, and build output uses a
separate ephemeral mount. Approval records may remain pending for Draft PR review;
the factory never merges, publishes, deploys, or fabricates an approval.

```powershell
npm run build --workspace @coga/factory
node packages/factory/dist/cli.js run .coga/work-orders/cedar-status/work-order.yaml --delivery local
```

Use `--delivery github` only when the exact base branch is already available on
the configured GitHub remote and a Draft PR is intended.
