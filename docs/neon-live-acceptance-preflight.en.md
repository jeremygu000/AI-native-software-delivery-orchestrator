# Live Neon acceptance: preflight and role prerequisite blocker

## Scope and baseline

The user requested live Neon deployment acceptance after independently accepting
`38812e4ca259cf4301dd5d5beccb7f64a6825519` on
`m4/postgres-durable-authority`. The intended sequence is shared-database schema
preparation, existing bootstrap/installer, GLOBAL_READY, preflight and a real
bare interactive GroundGraph run with a fresh tracing queue.

This report records an incomplete deployment attempt on 2026-10-04. No production
code, test, migration/checksum, Temporal history, authority contract or provider
adapter changed. The successful local full-workflow tracing stage remains accepted;
its evidence is not Neon deployment evidence.

## Private configuration preparation

Seven already configured Neon role URLs were normalized to query-free URLs after
checking the endpoint, database and recognized transport parameters. The previous
private configuration was saved with mode 0600. Local runtime connection settings
and its schema remain unchanged. Neon commands pass explicit
`FORGE_POSTGRES_SSL=verify-full`; no ambient PGSSL fallback is relied upon and no
global setting was added that would break the separate plaintext loopback deployment.

Private configuration, URL credentials, probe scripts and raw evidence remain
ignored. No password, endpoint URL, model content or signing key belongs in this
report or tracked files.

## Observed preflight evidence

Read-only queries using the accepted connection helper confirmed:

- PostgreSQL major 18 and database `neondb`.
- `current_user`, `session_user` and the actual database owner are `neondb_owner`;
  its observed catalog OID is 16392. This is an observation, not a hardcoded identity rule.
- Six Forge roles are unprivileged login roles: no SUPERUSER, CREATEDB,
  CREATEROLE, REPLICATION or BYPASSRLS attributes.
- All six have CONNECT and TEMP; TEMP is allowed by the accepted shared-database model.
- None has CREATE on the public schema. Restricted roles lack database CREATE.
- `forge_owner` still has a direct database CREATE grant, incompatible with
  the accepted shared-schema preparation contract.
- The proposed `forge_comparison_20261004_neon_acceptance` schema does not exist.
- The three prepared GroundGraph checkouts are clean at the same accepted
  `1e8835d37a0827c111291fa8a6cf4f12cc2caa68` baseline.

A fresh probe deliberately set `PGSSL=false`. All seven actual clients received
`ssl=verify-full`, and their Node TLS sockets reported `authorized=true`, no
certificate authorization error and TLSv1.3. Each backend `pg_stat_ssl` row reported
`ssl=false` and a null TLS version. Client-to-Neon certificate verification is
verified; backend TLS is not claimed. Proxy termination remains an inference,
not a measurement of Neon's internal transport.

## Role membership facts

All six observed incoming grants have grantor `cloud_admin`:

| Granted role   | Member       | ADMIN | INHERIT | SET   |
| -------------- | ------------ | ----- | ------- | ----- |
| forge_owner    | neondb_owner | true  | false   | false |
| forge_runtime  | neondb_owner | true  | false   | false |
| forge_trust    | neondb_owner | true  | false   | false |
| forge_issuer   | neondb_owner | true  | false   | false |
| forge_setup    | neondb_owner | true  | false   | false |
| forge_recovery | neondb_owner | true  | false   | false |

No outgoing Forge role membership was observed. The member is the actual verified
database owner, not another application role. ADMIN permits administering the
granted role; with INHERIT and SET false this grant does not itself permit
inheriting object privileges or SET ROLE. It is still an administrative capability,
so this observation alone does not justify deleting membership checks.
[PostgreSQL 18 GRANT documentation](https://www.postgresql.org/docs/18/sql-grant.html).

Current installer/audits reject any incoming or outgoing membership on setup,
trust/issuer and recovery principals. The setup installer checks this explicitly
before granting its function execution surface. Runtime startup separately checks
outgoing membership. This is a compatibility problem with the observed role
configuration, distinct from the already accepted forge_owner exception for the
actual database owner.

## Explicitly approved operator attempt and rollback

A guarded prerequisite transaction was made concrete and received execution
approval. Its intended operations were to revoke only forge_owner's direct
database CREATE, enable the database owner's SET capability for forge_owner and
remove the five restricted roles' incoming ADMIN-only memberships. It asserted
exact identity and initial catalog state, and required unrelated database ACLs
and the public schema ACL to remain unchanged. It included no schema DDL and
no CASCADE or automatic role repair in accepted bootstrap tools.

The first attempt failed its membership postcondition and rolled back. A second
attempt specified the actual grantor and INHERIT=false explicitly. PostgreSQL
rejected the grant with SQLSTATE 42501:

```text
permission denied to grant privileges as role "cloud_admin"
Only roles with privileges of role "cloud_admin" may grant privileges as this role.
```

That transaction also rolled back. Grantor attribution is privilege constrained;
ordinary administrative membership is not authority to impersonate the original
grantor. No cloud_admin credential was sought and no elevated role was invented.
[PostgreSQL 18 role grant rules](https://www.postgresql.org/docs/18/sql-grant.html)
and [revocation rules](https://www.postgresql.org/docs/18/sql-revoke.html).

A final read-only readback compared the original and current database ACL,
public schema ACL and all Forge memberships and found them identical. The target
schema remains absent, and no private bootstrap output or successful prerequisite
evidence was created. These comparisons use observed catalog facts, not an
assumption that a thrown exception proves rollback.

## Current status and next decision

Live TLS and role/configuration inspection are complete. Shared schema preparation,
migrations, GLOBAL_READY, Neon worker preflight, real provider requests, coding
execution and a new Tempo trace have not occurred. No online authority or run
state was created. The milestone is not complete.

The next decision is a narrow independent review of whether the already trusted,
actual database owner may retain incoming ADMIN-only membership on restricted
roles on PG16+, with INHERIT=false and SET=false. Any implementation would need
actual datdba OID binding, continued rejection of other members and every outbound
membership, feature-aware checks on older supported majors, and focused real
PostgreSQL regressions. This report does not implement or approve that exception.
An alternative is grantor-authorized platform administration of the existing
memberships. No dedicated database, new role hierarchy or replacement authority
is proposed.

The separate schema owner prerequisites remain: forge_owner must lose database
CREATE, and the deployment owner must obtain SET capability to forge_owner before
CREATE SCHEMA AUTHORIZATION. No further online mutation should occur until the
restricted-role decision is resolved.

## Self-contained independent review request

Review the evidence-only increment against accepted baseline
`38812e4ca259cf4301dd5d5beccb7f64a6825519`. Changed tracked areas are this report and
the synchronized English/Chinese onboarding summaries. Private configuration was
normalized and live read-only probes plus two approved, rolled-back operator
transactions were performed; there are no production or test changes.

Review questions:

1. Does the report distinguish client certificate verification from the observed
   backend pg_stat_ssl result without claiming unmeasured internal transport?
2. Are the membership direction, grantor and ADMIN/INHERIT/SET observations stated
   accurately, without calling ADMIN-only membership harmless in general?
3. Is an exception bound to the actual trusted database owner, with INHERIT/SET
   false and all other escalation paths rejected, a justified compatibility change?
   This question requires review; current accepted checks have not been relaxed.
4. Does the scope preserve the accepted shared schema, PUBLIC TEMP, credential,
   migration, workflow and provider boundaries and disclose the incomplete milestone?

Verification for this increment: live seven-role TLS readback, read-only catalog
identity/privilege/membership queries, post-rollback catalog equality and secret
file permissions. Formatting and git diff --check are run for the tracked docs.
Before the user-requested commit, full image-enabled pnpm check passed: 1118/1118
tests in 107 files, no skips, including PG18/Docker/Temporal fixtures. Coverage is
90.63% statements, 85.23% branches, 94.30% functions and 90.56% lines, above
unchanged gates. No executable repository code or build configuration changed.
These repository regressions do not establish live Neon deployment acceptance.
