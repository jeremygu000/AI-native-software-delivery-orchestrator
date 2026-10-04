# Independent review: restricted-role membership compatibility

## Review baseline and intended scope

Review this increment against accepted baseline
`921abb1e416126e5439ff36a90e96abf07c3699c` on
`m4/postgres-durable-authority`. The preceding preflight evidence is independently
accepted, but live Neon deployment remains open. Its configured roles have
incoming ADMIN-only grants to the actual database owner from an inaccessible
platform grantor. Existing setup/trust/issuer/recovery audits rejected these rows.

Implement only the approved compatibility predicate for restricted roles, with
an explicit database-owner trust rationale. Do not change schema owner
provisioning, obtain cloud_admin, repair roles, add roles or require a dedicated
database. No live Neon operation occurred during this code increment.

## Contract and architecture constraints

On PG16–18, an incoming membership row is allowed only if member OID equals the
current database's actual pg_database.datdba, ADMIN=true, INHERIT=false and
SET=false. All rows must satisfy this rule. Every outbound membership and every
other incoming shape remains rejected. No configured operator name, schema-owner
identity or platform grantor name is an alternative source of trust.

ADMIN is an escalation capability: its holder can grant the role to another
principal or grant SET/INHERIT back to itself. The exception is justified solely
by the exact database owner's existing deployment trust. It is not justified by
calling ADMIN-only grants non-escalating. This is explicitly documented in code,
tests and deployment guidance, following the
[PostgreSQL role-attribute warning](https://www.postgresql.org/docs/18/role-attributes.html).

PG14/15 retain complete incoming/outgoing rejection. Their branch does not
reference set_option or inherit_option. Existing supported-major validation
still rejects future unsupported majors. The small helper is internal to the
PostgreSQL package and is not exported through its deliberate public entry point.
There is no new domain configuration field or membership policy layer.

No migration statement/checksum, authority identity, workflow command/patch,
provider transport/selection, telemetry or approval/run semantics changed.
forge_owner incoming/outgoing rules, database CREATE requirement and deployment
SET prerequisite remain separate and unchanged. Existing role attributes,
effective table/function/schema ACLs, MAINTAIN, search-path and TLS audits remain.

## Changed executable areas

- `postgres-role-membership.ts`: shared read-only catalog predicate. Queries
  actual datdba OID and rejects incompatible rows rather than repairing them.
- `postgres-authority-schema.ts`: installer runtime gate, setup installation,
  recovery/setup/trust/issuer function audits and runtime startup use the predicate.
  The installer now explicitly rejects incompatible runtime memberships before
  schema creation. Existing outgoing/transitive runtime checks remain.
- `postgres-trust-writers.ts`: trust/issuer login gate uses the same predicate;
  existing identity/outbound/effective-privilege checks remain.
- `postgres-workspace-setup-admission.ts`: setup login uses the same predicate
  without changing admission, signing, function access or durable operations.

## Regression evidence

Focused real Docker fixtures completed on both pinned supported majors:

- PG16: 159 passed, five existing PG17/18 feature tests skipped, 164 total.
- PG18: 164 passed, no skips.
- Five focused membership unit tests passed; they check legacy SQL column
  compatibility and rejection of absent/unknown audit results.
- `pnpm build`, TypeScript and type-aware lint passed.

New real regressions cover:

1. A non-superuser database owner with an arbitrary fixture name, separate from
   schema owner, holds ADMIN-only incoming grants on all five restricted roles.
   Existing shared-schema preparation, existing-empty migration, runtime audit,
   trust/issuer/setup connections, GLOBAL_READY cutover and migration rerun pass.
   Membership rows and ledger checksums/timestamps remain unchanged.
2. That owner initially cannot SET ROLE to the trust writer, then uses ADMIN to
   grant SET to itself under a second grantor and successfully SETs ROLE. Runtime
   and installer reject the resulting grants, retaining both rows and the ledger.
   This is real administrative escalation evidence, not an assertion that ADMIN
   cannot escalate or a simulated driver result.
3. For each of five restricted roles, startup and installer reject other members,
   owner INHERIT, owner SET, owner without ADMIN, outbound ADMIN-only membership
   and another restricted principal as member. Trust/issuer/setup direct login
   gates are also exercised. Catalog rows remain unchanged after rejection.
4. The PG14 and PG15 branches reject owner incoming membership in real queries
   against the PG16/18 fixtures. Unit tests separately verify that these legacy
   branches use no newer columns. This is branch coverage, not a claim of running
   complete PG14/15 server matrices.

Full image-enabled `pnpm check` passed: 1132/1132 tests in 108 files, no skips,
including PG18/Docker/Temporal fixtures. Coverage exceeds the unchanged gates:
statements 90.65%, branches 85.24%, functions 94.30% and lines 90.58%.
Formatting, TypeScript, type-aware lint and `git diff --check` pass. The historical
migration array, schema versions, writer configuration type and checksum function
were also compared with the baseline and are unchanged.

## Known limitations and deployment state

This increment does not touch online Neon, create a live schema/authority/run,
make model requests, launch a production worker or establish a new Tempo trace.
The accepted seven-role TLS/preflight evidence remains separate. Live acceptance
still needs independent code review, followed by explicit owner prerequisites,
shared schema preparation, bootstrap/GLOBAL_READY, preflight and traced coding E2E.

No GRANT, REVOKE or role repair is added to production paths. Grants in tests are
explicit fixture operations inside disposable local databases. Do not interpret
the passing fixture as permission to silently change online memberships or
forge_owner provisioning.

## Specific review questions

1. Does the predicate bind solely to actual datdba OID and require all three
   exact option values for every incoming grant row, including multiple grantors?
2. Do all outbound and non-owner incoming paths remain closed across installer,
   runtime, writer and setup login checks, including ADMIN-only grants?
3. Does PG14/15 remain fail closed without referencing PG16 catalog columns?
4. Does the real self-grant regression clearly prove the trusted-owner rationale
   rather than treating ADMIN as a non-escalating capability?
5. Are existing authority ACLs, schema owner prerequisites, migration ledger,
   identity, provider/workflow contracts and live deployment boundaries preserved?
