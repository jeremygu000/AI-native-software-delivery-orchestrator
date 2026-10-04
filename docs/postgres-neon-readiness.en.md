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

## Shared database: normal deployment

Forge can coexist with other applications in `neondb`. Its authority boundary is
an isolated `forge_comparison_*` schema owned by `forge_owner`, with exact
relation/function ACLs and separate runtime, trust, issuer, setup and recovery
logins. PostgreSQL grants database CONNECT and TEMPORARY to PUBLIC by default.
TEMP is reported as deployment metadata and is allowed; it is not authority-table
mutation permission. See the official
[privilege reference](https://www.postgresql.org/docs/18/ddl-priv.html).

Forge rejects CREATE on its schema or pg_catalog for restricted roles, direct
writes outside their existing approved table/function surfaces, grant options,
role membership/SET ROLE escalation and MAINTAIN. CREATE in an unrelated
application schema, including PUBLIC CREATE on the public schema, does not fail
the Forge schema boundary. Existing restricted-role database CREATE and privileged
role-attribute restrictions remain. Runtime's deliberately permitted DML remains
unchanged; this stage does not redesign its accepted mutation contract.

Allowing TEMP requires safe object resolution. A real PG18 regression reproduced
a temporary `jsonb` domain being used inside the generation SECURITY DEFINER
function with the old `search_path=pg_catalog`. Functions now explicitly use
`pg_catalog, pg_temp`, so the temporary namespace is last. PostgreSQL documents
this ordering for [SECURITY DEFINER functions](https://www.postgresql.org/docs/18/sql-createfunction.html).
Authority relations remain schema-qualified, catalog reads are qualified, and the
shared client helper sets the same safe startup path. No migration statement,
checksum or schema version changes. The installer applies validated function
configuration after migrations, just as it installs ACLs. It recognizes only the
previous exact `pg_catalog` setting or the new safe setting, rejects other drift,
and sets the safe path. Runtime refuses the old setting until an operator runs
the existing installer; startup never changes it.
Older workers that require the old exact function setting cannot start against
the updated configuration. Coordinate installer and worker rollout for an
existing authority; a fresh comparison schema uses the new configuration from
its first installation.

Configure seven query-free role URLs at the same endpoint/database in ignored,
mode-600 operator configuration. `FORGE_DATABASE_OWNER_CONNECTION_STRING` is the
actual database-owner login, such as `neondb_owner`; it is distinct from
`FORGE_OWNER_CONNECTION_STRING` (`forge_owner`). Ordinary CLI, worker and
comparison children do not receive the deployment-owner credential. Explicit
shell `FORGE_POSTGRES_SSL` overrides the private file in both deployment tools.

Read-only inspection reports TEMP without rejecting it:

```sh
export FORGE_POSTGRES_SSL=verify-full
node apps/temporal-worker/local/neon-database-hardening.mjs inspect neondb
```

Prepare a new empty Forge schema in the shared database:

```sh
node apps/temporal-worker/local/neon-database-hardening.mjs apply neondb --shared-database forge_comparison_YYYYMMDD
```

This shared operation only creates that schema with `AUTHORIZATION forge_owner`.
It does not revoke database/public-schema privileges, change role definitions or
grant database CREATE to Forge. The actual deployment owner must already be able
to SET ROLE to `forge_owner` for PostgreSQL's AUTHORIZATION operation; the tool
never grants that capability. `forge_owner` must be an unprivileged login with no
outgoing role membership or effective database CREATE. Incoming membership is
also restricted: only the database-owner OID from the database whose owner login
was verified against current_user and session_user may be a member of forge_owner.
Every other member, including another application or restricted Forge login,
causes rejection before schema creation. The tool does not revoke memberships. See the
[CREATE SCHEMA reference](https://www.postgresql.org/docs/18/sql-createschema.html).
The owner identity, supported server major, schema name and absence are checked;
a transaction and the existing schema advisory lock protect creation. Pre-existing
schemas, including empty ones, are refused by this preparation command. New
schemas must have owner-only privileges and no dependent objects before commit.
Default ACL drift causes rollback rather than silent privilege repair.

For a separate private operator configuration, set
`FORGE_DATABASE_HARDENING_ENV_FILE` to an ignored, mode-600 file with the same keys.
Schema provisioning remains in this existing operator tool; no new Forge CLI
command, service, registry or authority layer is introduced.

## Restricted-role membership auditing

The schema owner provisioning rule above remains separate from restricted-role
membership auditing. On PostgreSQL 16–18, runtime, trust, issuer, setup and recovery
roles may have an incoming membership only when every grant row has exactly:

```text
member OID = pg_database.datdba for the current database
ADMIN = true
INHERIT = false
SET = false
```

The database owner is an already trusted deployment principal. ADMIN can grant
the role to others or back to its holder with SET/INHERIT enabled; disabling those
options prevents immediate privilege use, not escalation. The exception accepts
that operator trust explicitly. It does not classify ADMIN as harmless. See the
[PostgreSQL role-attribute warning](https://www.postgresql.org/docs/18/role-attributes.html).

The predicate reads the actual database owner's OID on each audit. It uses no
configured operator name, schema-owner name or Neon grantor requirement. All
other incoming grants, any grant with INHERIT/SET enabled or ADMIN disabled,
and every outbound membership are rejected, including ADMIN-only grants to
another application or restricted Forge principal. Multiple grantors are checked
row by row; one permitted grant never hides a second incompatible grant.
PostgreSQL 14/15 retain rejection of every incoming/outgoing membership and never
query the newer membership columns.

The same read-only predicate is used by the installer, runtime startup,
restricted writer audits and trust/issuer/setup connections. It never GRANTs,
REVOKEs or repairs memberships. Table/function/schema ACLs and all existing
principal, MAINTAIN, TLS and search-path checks remain in force. In particular,
this rule does not grant SET to forge_owner or remove its database CREATE; those
schema preparation prerequisites remain explicit operator actions.

This compatibility increment requires independent review before resuming live
Neon deployment. Its regressions use isolated local PostgreSQL fixtures;
they do not establish Neon schema preparation, GLOBAL_READY or traced E2E.

## Dedicated database: optional hardening

Only when the operator explicitly chooses a database dedicated to Forge:

```sh
node apps/temporal-worker/local/neon-database-hardening.mjs apply neondb --dedicated-forge-database
```

This retains the previous database-wide transaction: revoke PUBLIC TEMP/CREATE
and public schema CREATE, grant Forge CONNECT, remove restricted-role database
TEMP/CREATE and grant schema-creation capability to `forge_owner`. Effective
privileges are checked before commit; surviving inherited grants roll back the
whole operation. Existing schemas, rows and role definitions remain untouched.
This optional mode affects all database users and must not run on a shared
database. Its database CREATE grant is for the legacy owner-created-schema
installation path; shared bootstrap requires a pre-created schema and no owner
database CREATE. Dedicated hardening is not a worker startup prerequisite.

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

After shared schema preparation, follow `docs/forge-observability.en.md`.
Keep three clean clones at the same baseline and fresh traced Temporal queues.
Neon bootstrap requires the named schema to exist, be owned by `forge_owner`,
contain no dependent objects (including sequences/types/functions), and have
owner-only ACLs. The same checks run under the migration transaction's advisory
lock with `existing-empty` mode; `forge_owner` must lack database CREATE. A wrong
owner, wrong name, missing schema or pre-existing authority is refused. No old
ledger is reused, repaired or deleted. TEMP no longer blocks this path. Run
preflight, planning, immutable approval, operator setup and sequential traced
execution after the independent deployment-model review accepts this increment.

The prior live inspection found PG18, `neondb_owner` and effective TEMP. This
stage performs no online Neon inspection or mutation. No live schema has been
prepared, no new authority is GLOBAL_READY and no new traced GroundGraph
comparison ran. Dedicated-database confirmation is no longer needed for shared
schema deployment. Query-free role configuration, owner/schema provisioning and
real Neon acceptance still remain; historical provider comparison and the
one-span Tempo smoke trace do not prove those steps.

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
