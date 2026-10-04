# Incremental review request: explicit PostgreSQL TLS

> Historical review: accepted as `db24cb592db0c593e23373e8c560672adb8b1f12`. The subsequent shared-database correction is described in `docs/postgres-shared-database-review.en.md`; it supersedes the dedicated-database prerequisite below.

Please review the TLS increment following compatibility baseline `6a0710bcdc5fe9bc210689a5956d66af5f857908` on `m4/postgres-durable-authority`. The user requested a separate commit and push for this correction; independent acceptance remains pending. The review scope is the remaining TLS P1 from the PostgreSQL 14–18 and Neon preparation stage.

## Intent and constraints

Make verified TLS an explicit Postgres.js connection option across PostgreSQL persistence and deployment paths. Keep authority URLs query-free. Keep PostgreSQL transport settings outside domain and engine contracts. Preserve authority identity, migration statements and checksums, durable workflow commands, provider neutrality, credential isolation and existing database-owner hardening semantics.

The pinned Postgres.js 3.4.9 implementation actually recognizes PGSSL through its generic environment fallback; a real lazy-client probe confirmed this. The previous review's claim that this version ignores PGSSL is inaccurate. This increment still removes reliance on that implicit fallback. See the [pinned option parser](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js) and [TLS connection implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js).

## Changed areas

- `libs/postgres-persistence/src/lib/postgres-connection.ts` defines the transport configuration and shared connection helper. Remote connections require explicit `ssl: 'verify-full'` before client creation. Loopback development permits omitted/false TLS and passes explicit `ssl: false`. Query parameters and weakened TLS values are rejected. The final constructor option overrides ambient PGSSL and caller options.
- PostgreSQL migration, evidence, runtime persistence, global mutation authority, trust, issuer and setup constructors use that helper. Their configuration carries the optional PostgreSQL transport field.
- Deployment composition resolves `FORGE_POSTGRES_SSL`. CLI and worker receive it through their existing configuration flow. The authority fingerprint excludes transport and remains unchanged.
- Neon comparison bootstrap, database-owner hardening, workspace preparation and recovery/evidence utilities propagate explicit TLS. The privileged recovery connection uses the same helper. Bootstrap writes `FORGE_POSTGRES_SSL=verify-full` into private comparison configuration. Local Docker provisioning remains local development.
- `.env.local.example`, observability/readiness guidance and both progress summaries explain the setting, evidence and remaining deployment steps.

No domain, engine, provider, migration SQL, migration ledger, workflow patch, activity ordering or telemetry behavior changed. No new dependency was introduced. Database-owner credentials remain excluded from ordinary CLI/worker environments.

## Verification

- 36 targeted tests pass, including 27 new transport/configuration regressions. They inspect actual lazy Postgres.js client options without opening sockets, reject missing remote TLS before constructor invocation even under PGSSL=verify-full, and prove explicit verified TLS survives PGSSL=false.
- Seven constructor-entry tests cover migration owner, runtime persistence, global authority, trust, issuer, setup and evidence. Deployment routing tests verify unchanged durable authority identity and reject inconsistent/weak configuration.
- `pnpm build` passes. Full image-enabled `pnpm check` passes with the durable authority fixture on PostgreSQL 18: 1050 tests in 101 files, no skips. Coverage is 90.81% statements, 85.86% branches, 94.73% functions and 90.69% lines. Existing gates remain unchanged. Formatting, TypeScript, lint and `git diff --check` pass.
- A private read-only live probe used the compiled shared helper for all seven Neon logins with PGSSL=false. Actual client options were verify-full; every observed Node TLS socket had authorized=true, no authorization error and TLSv1.3. Only known provider transport query parameters were normalized in memory for this probe; private role URLs were not rewritten. Deployment tooling still rejects query-bearing URLs.
- The requested `pg_stat_ssl` query returned ssl=false and a null TLS version for every backend. This is reported as observed, not as a backend TLS pass. Verified client TLS plus these backend values is consistent with proxy TLS termination, but that explanation is an inference. The probe establishes client-to-endpoint verified TLS, not Neon's internal transport topology. Private metadata contains no URL, password or credential.

## Limitations and withheld work

No live privilege change, authority schema creation, migration, GLOBAL_READY cutover, bootstrap or traced provider comparison ran. The live database still requires dedicated-database confirmation and effective-privilege hardening before deployment. Operator role URLs must be supplied query-free with explicit Forge TLS configuration. A full live authority execution remains the next independently accepted stage. This correction is submitted as a separate increment for review at the user's request.

## Review questions

1. Does every PostgreSQL authority/operator connection receive explicit verified TLS for non-loopback deployments, including migration, worker runtime and privileged recovery?
2. Do missing/weak settings and query-bearing URLs fail before client creation, without revealing private input or relying on ambient driver configuration?
3. Do constructor and configuration regressions prove actual Postgres.js options and unchanged authority identity?
4. Are transport settings confined to PostgreSQL/deployment boundaries, with unchanged durable commands, migration checksums and credential isolation?
5. Are live TLS claims limited to measured client-to-endpoint evidence, with backend pg_stat_ssl=false and withheld online operations stated accurately?
