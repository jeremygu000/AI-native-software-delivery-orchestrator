# PostgreSQL compatibility and Neon deployment

Forge authority explicitly accepts PostgreSQL majors 14, 15, 16, 17 and 18. Major
13 and future major 19 remain rejected. The adapter and Neon preflight use the same
version contract; a newer server is not automatically considered compatible.
The migration SQL and checksums remain unchanged.

PostgreSQL 17 added the `MAINTAIN` table privilege. Forge rejects it on authority
tables for runtime, trust, issuer, setup and recovery roles, including effective
grants through `PUBLIC`. PostgreSQL 18 represents NOT NULL constraints in
`pg_constraint`. The schema audit includes the expected constraints and rejects
inheritance drift, unvalidated constraints and unenforced constraints. These
checks preserve the existing authority boundary while accepting the new catalog.
See the official [PostgreSQL 17 release notes](https://www.postgresql.org/docs/17/release-17.html)
and [PostgreSQL 18 ALTER TABLE reference](https://www.postgresql.org/docs/18/sql-altertable.html).

## Regression matrix

The durable authority suite can use either native PostgreSQL or a disposable,
digest-pinned Docker server. The fixture checks the actual server major, binds
only to localhost and removes its own container on completion.

```sh
FORGE_TEST_POSTGRES_IMAGE=postgres@sha256:YOUR_PG16_DIGEST \
FORGE_TEST_POSTGRES_MAJOR=16 \
pnpm exec vitest run libs/postgres-persistence/src/lib/durable-authority-parity.spec.ts --config vitest.config.ts

FORGE_TEST_POSTGRES_IMAGE=postgres@sha256:YOUR_PG18_DIGEST \
FORGE_TEST_POSTGRES_MAJOR=18 \
pnpm check
```

Use PG16 and PG18 for PR verification. A release or scheduled matrix can use the
same fixture for majors 14–18; that automated five-major matrix is not added by
this stage. Tests for privileges or catalog features absent from the selected
major are explicitly skipped. PG18 exercises all of them. Existing application
acceptance fixtures retain their native PostgreSQL backend.

## Separate database-owner hardening

PostgreSQL grants database `CONNECT` and `TEMPORARY` to `PUBLIC` by default. Thus a
role can have effective TEMP even without a direct grant. Forge's restricted
roles must lack TEMP, database CREATE and public-schema CREATE. See the official
[privilege reference](https://www.postgresql.org/docs/18/ddl-priv.html).

Configure the actual deployment-owner URL in ignored, mode-600 `.env.local` as
`FORGE_DATABASE_OWNER_CONNECTION_STRING`. This must be the database's owner login,
such as `neondb_owner`, rather than `forge_owner`. Configure six distinct Forge
role URLs at the same endpoint and database. Ordinary CLI, worker and comparison
children never receive the deployment-owner credential.

Inspect before making a change:

```sh
node apps/temporal-worker/local/neon-database-hardening.mjs inspect neondb
```

The output contains role privileges, schema names and server major, with no
connection strings or passwords. Apply only after confirming that this database
is dedicated to Forge. Revoking PUBLIC privileges affects all database users.

```sh
node apps/temporal-worker/local/neon-database-hardening.mjs apply neondb --dedicated-forge-database
```

The owner performs one transaction: revoke PUBLIC database TEMP/CREATE and public
schema CREATE, grant CONNECT to the Forge roles, revoke restricted-role database
TEMP/CREATE and Forge-role public schema CREATE, and grant database CREATE only
to `forge_owner`. Effective privileges are checked again before commit. If an
inherited grant still violates the boundary, the entire transaction rolls back.
The tool does not create or alter roles, authority schemas, ledgers or persisted
authority rows. Runtime, setup and recovery processes never perform this step.

For a separate private operator configuration, set
`FORGE_DATABASE_HARDENING_ENV_FILE` to an ignored, mode-600 file with the same keys.

## Fresh comparison bootstrap

Authority login URLs still forbid startup query parameters, including `options`,
`user` and `role` overrides. For Neon, use query-free role URLs and configure
verified TLS through Forge's explicit `FORGE_POSTGRES_SSL=verify-full` setting.
Configure it in the private operator environment for hardening and bootstrap/setup;
bootstrap writes it into the
private environment passed to CLI/workers. It rejects query parameters or missing
verified TLS before any database connection or schema migration. Every persistence,
migration and operator client uses the same connection helper, which passes
`ssl: 'verify-full'` directly to Postgres.js. Non-loopback connections without that
explicit setting are rejected before client creation. Loopback development uses
explicit `ssl: false` when the setting is omitted. Forge does not rely on driver
environment fallbacks. A copied Neon URL with `sslmode` or
`channel_binding` query parameters does not satisfy the current authority login
contract. Supply query-free URLs for all seven configured logins, including the
actual database owner; no transport setting permits startup query overrides.

The pinned Postgres.js 3.4.9 implementation does dynamically read `PGSSL` through
its generic option fallback, although the README's environment table does not
list it. This correction replaces that implicit dependency with a configuration
field and tests the real client's resolved options. See the pinned
[option parser](https://github.com/porsager/postgres/blob/v3.4.9/src/index.js) and
[TLS implementation](https://github.com/porsager/postgres/blob/v3.4.9/src/connection.js).

After hardening, follow `docs/forge-observability.en.md`: bootstrap only a new
`forge_comparison_*` schema, retain three clean clones at the same baseline, use
fresh traced Temporal queues, then perform preflight, planning, immutable
approval, operator setup and sequential execution. The bootstrap checks TEMP and
schema absence before migration. It never reuses or repairs an old authority.

The live Neon inspection found PG18, the actual `neondb_owner` login and TEMP on
all six Forge roles. No live database privileges were changed during that
inspection. Dedicated-database confirmation, live hardening/bootstrap and the
new traced GroundGraph comparison remain pending; the earlier provider
comparison and the one-span Tempo smoke trace do not prove those steps.

## Read-only TLS evidence

On 2026-10-04, a private probe used the shared helper with query-free URLs,
explicit `ssl: 'verify-full'` and deliberately conflicting `PGSSL=false`.
All seven configured logins (database owner, Forge owner, runtime, trust,
issuer, setup and recovery) connected successfully. Their actual Node TLS sockets
reported `authorized=true`, no authorization error and `TLSv1.3`; each real
Postgres.js client reported `options.ssl='verify-full'`.

The requested `pg_stat_ssl` query returned `ssl=false` and a null TLS version for
every backend. That observation is preserved; it is not reported as a backend
TLS pass. Client-side verified TLS with a non-TLS backend observation is consistent
with termination at Neon's connection proxy. This interpretation is an inference,
supported by Neon's [proxy implementation overview](https://github.com/neondatabase/neon/blob/main/proxy/README.md).
The probe confirms the client-to-endpoint transport, not encryption within
Neon's infrastructure. All queries ran in read-only transactions. No live
hardening, bootstrap, GLOBAL_READY or provider execution was performed.
