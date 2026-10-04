# Forge OpenTelemetry tracing

The local `forge.startup` smoke trace established the OTLP connection, Grafana Cloud
ingestion and Tempo query path. Formal tracing is opt-in for new Forge runs. It uses
OpenTelemetry in the CLI and worker, plus the Temporal OpenTelemetry interceptor to
carry trace context from a workflow to its activities. The workflow creates
`forge.run` and `forge.task` spans. The production global worker creates
`forge.verification`, `forge.review`, `forge.repair` and `forge.integration` spans
around the corresponding operations. Planning and the host model proxy create
`forge.model.request` spans. Span duration is measured by OpenTelemetry from start
to end; no prompt, response, reasoning or source content is recorded.

## Enable on a new comparison run

Configure the OTLP endpoint and `Authorization=Basic ...` header in ignored,
mode-600 `.env.local`, as described in `docs/local-groundgraph-validation.en.md`.
The CLI exports planning spans whenever `OTEL_TRACES_EXPORTER=otlp` and an endpoint
are configured. To trace a worker, set `FORGE_OTEL_INSTRUMENTATION=1` when starting
it. Use a **fresh Temporal task queue and authority** for that worker. Temporal's
tracing plugin is experimental and changes workflow history. Do not route an
in-progress workflow created without the plugin to a tracing-enabled worker.

For a Neon comparison, configure six separate role URLs in ignored `.env.local`
(`FORGE_OWNER_CONNECTION_STRING`, `FORGE_RUNTIME_CONNECTION_STRING`,
`FORGE_TRUST_CONNECTION_STRING`, `FORGE_ISSUER_CONNECTION_STRING`,
`FORGE_SETUP_CONNECTION_STRING` and `FORGE_RECOVERY_CONNECTION_STRING`). Keep
the same endpoint and database for all six roles. Prepare three clean clones at
the same GroundGraph commit under `.local/neon-comparison-{deepseek,copilot,codex}`.
The bootstrap refuses a dirty clone, a nonempty or wrongly owned schema, or a
PostgreSQL server outside Forge's supported 14–18 range. The deployment owner
first prepares a new empty schema owned by forge_owner in the shared database,
as described in `docs/postgres-neon-readiness.en.md`. Bootstrap installs only in
that schema and writes ignored mode-600 runtime configuration; it does not
rewrite an existing authority ledger. Database-wide hardening is optional. Use query-free authority role URLs and explicit `FORGE_POSTGRES_SSL=verify-full`
in the operator shell and private comparison environment.

```sh
export FORGE_POSTGRES_SSL=verify-full
node apps/temporal-worker/local/neon-database-hardening.mjs apply neondb --shared-database forge_comparison_YYYYMMDD
node apps/temporal-worker/local/neon-comparison-authority.mjs prepare forge_comparison_YYYYMMDD
export FORGE_COMPARISON_ENV_FILE="$PWD/.local/neon-comparison.env"
node apps/temporal-worker/local/comparison-run.mjs deepseek register
```

After planning and approving each candidate, use the existing operator setup
procedure with `FORGE_COMPARISON_ENV_FILE` exported. That process loads the
separate issuer, setup and recovery URLs; ordinary CLI and worker wrappers
receive only the runtime URL. Start each candidate worker on its separate
`forge-neon-comparison-*` queue, then execute its approved run. For example:

```sh
node apps/temporal-worker/local/comparison-run.mjs deepseek worker
```

Use the same opt-in for the Copilot and Codex comparison workers. The current
standalone smoke command remains `pnpm local:otel-check` and does not enable the
worker. Preflight never creates a telemetry exporter.

## Attributes and disclosure boundary

Only `run_id`, `task_id`, `attempt_id`, `provider`, `model`, `reasoning_effort`,
`role` and `outcome` are exported as span attributes. Planning runs before a
Forge run or task exists, so planner and semantic plan reviewer model spans have
no run or task ID; their attempt ID is the planning attempt number. The host model
proxy's builder, reviewer and repair spans use the approved deployment model
identity and their real run, task and attempt IDs. Each host proxy call is timed
individually. A failed request records `outcome=error` without
an exception message or body.

The worker filters **all** exported spans, including spans produced by Temporal's
interceptor. In particular it drops workflow memo, search attributes, failure
details, span events, links and status messages. It never puts prompts, model
responses, reasoning content, credentials, database URLs, source code or diffs
into Forge attributes. Trace IDs and approved attributes can be queried in Tempo
to compare timing and outcomes across DeepSeek, Copilot and Codex runs.

## Real workflow acceptance evidence

The successful local GroundGraph run `8c7449d0-54fd-436a-b924-b97003c303b1`
used a new schema `forge_comparison_20261004_full_trace` in the existing local
database and a fresh queue `forge-full-trace-20261004`. Production Temporal
tracing was enabled only for that deployment. Tempo trace
`4f59f4801eb67abc02d9709461687301` contains 26 spans, including forge.run,
forge.task, six model requests, verification, review and integration. Exported
JSON confirms exact run/task/profile attributes, activity-context ancestry,
task lifetime and safe filtering across all spans. The run completed with three
released claims and zero unresolved permits. See
`docs/full-workflow-trace-acceptance.en.md` for exact identities, durations,
private evidence and review questions.

Repair was not needed and is not claimed as observed live. Deferred integration,
error and cancellation were not induced in this run; their existing integration
regressions remain separate evidence. Planning requests are separate traces
because they precede run allocation. This local successful-path acceptance closes
the full workflow trace evidence gap independently of the accepted Interactive
Coding CLI. It does not establish a new three-provider comparison or live Neon
acceptance.

The earlier read-only Neon inspection found PostgreSQL 18 and inherited TEMP;
no Neon schema or privilege was changed. PostgreSQL 14–18, explicit verified TLS,
shared-database schema isolation and owner membership checks are accepted.
Real Neon schema preparation, bootstrap and traced execution remain pending.
