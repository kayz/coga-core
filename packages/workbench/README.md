# @coga/workbench

The COGA Workbench is a localhost-only governance interface over the same
file-backed control records used by the factory CLI. It shows candidate assets,
structured intent, semantic diff, provenance, impact paths, model and
deterministic evidence, human approvals, runtime observations, incidents,
promotion proposals, and the tamper-evident audit timeline.

It binds to `127.0.0.1`, enforces a per-process action token and same-origin
checks, stores no credentials in the browser, and exposes no production upload
or release endpoint.

```powershell
npm run build --workspace @coga/workbench
node packages/workbench/dist/cli.js --profile examples/broker-digital-channel/factory/profile.yaml
```

When a private local Application is present, pass its ignored binding with
`--binding private/application/factory.binding.yaml`.
