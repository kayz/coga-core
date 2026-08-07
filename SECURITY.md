# Security Policy

## Supported version

COGA is in initial development. Security fixes target the latest `0.1.x` release;
older snapshots are not maintained.

## Reporting

Do not open a public issue for a suspected vulnerability, leaked credential,
private endpoint, customer data, or restricted source. Use GitHub's private
security-advisory reporting for this repository. If that channel is unavailable,
contact the repository owner through their GitHub profile without including the
sensitive details in a public message.

Include the affected version, a minimal reproduction, expected impact, and any
known workaround. Remove real data and secrets from evidence.

## Trust boundary

COGA manifests and agent instructions are untrusted input until validated and
reviewed. The 0.1 CLI reads local files; it must not be given a workspace containing
credentials that it does not need. Example Instance material is educational and is
not a production authorization, suitability, compliance, or security baseline.

Public release is allowlist-based. Private applications, `.env` files, local source
material, customer data, production endpoints, and credentials must never be added
to this repository. Refer to secrets by an external provider URI or environment
variable name; never store their values in a manifest.
