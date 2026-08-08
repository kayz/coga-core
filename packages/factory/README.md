# @coga/factory

`@coga/factory` is the local, domain-neutral reference engine behind the COGA
Workbench. It consumes Core control contracts and Instance-owned profiles,
executes only exact allowlisted adapters, persists append-only records, and
stops at human approval gates.

The package is intentionally not a production shell or deployment system. Its
process adapter receives an executable and argument array from a validated
profile, confines the working directory, filters the environment, enforces
budgets, and returns digest-bound evidence. Production upload and release APIs
are not part of the reference implementation.

Provider credentials are read from process environment variables only. The
DeepSeek evaluator stores prompt/output digests and usage metadata, never the
credential or hidden reasoning.
