# Incremental review request: schema-owner incoming membership

Please review the owner-membership increment against `1ff6ee5a918bdd3a8eac64edf653b88ef460f879` on `m4/postgres-durable-authority`. That reviewed commit has one remaining P1: shared-schema preparation did not constrain incoming membership of the schema owner. The scope here is that guard and its regression, plus synchronized deployment/progress documentation.

## Intent and implementation

`forge_owner` owns the Forge schema, authority relations and SECURITY DEFINER functions. An unrelated member can acquire that owner's privileges via SET ROLE. Outgoing owner membership was already rejected. Preparation now also rejects every incoming member except the actual database owner whose login was explicitly verified for this operation.

The exception is derived from `pg_database.datdba`, not a configured or hardcoded operator name. Existing checks first establish current_user = session_user = database owner for the explicitly named database. The role audit then reads all `pg_auth_members` rows whose roleid is the configured schema owner's OID and rejects any member whose OID differs from that verified database-owner OID. It does not filter only login roles or depend on inheritance settings. The database owner may retain the AUTHORIZATION prerequisite. No other operator/application/Forge role is accepted as an owner member.

The check is read-only and precedes schema creation. Failure neither creates a schema nor revokes membership. Existing outbound membership rejection remains. No role definition, database/PUBLIC ACL, migration SQL/checksum, authority identity, workflow command/patch, provider adapter, tracing or domain contract changes. Shared TEMP, safe search paths and optional dedicated hardening remain as reviewed.

## Changed areas

- `libs/postgres-persistence/src/lib/postgres-schema-deployment.ts`: read the trusted database-owner OID, query unexpected incoming memberships and reject them before DDL.
- `libs/postgres-persistence/src/lib/durable-authority-parity.spec.ts`: extend the existing real shared-deployment operator regression with incoming and outgoing owner membership cases.
- `docs/postgres-neon-readiness.en.md` and both progress summaries: document the exact exception and the review/verification status.
- This self-contained narrow review request.

## Verification

The regression first reproduced the gap on `1ff6ee5a`: a NOINHERIT other-application login successfully SET ROLE forge_owner, and the real shared preparation command still created a schema instead of rejecting it. PostgreSQL distinguishes membership from automatic inheritance; see its [membership documentation](https://www.postgresql.org/docs/18/role-membership.html) and [membership catalog](https://www.postgresql.org/docs/16/catalog-pg-auth-members.html).

The corrected real operator regression passes on disposable PG16 and PG18. Each run selects one extended test, excluding 154 others by the filter. It proves:

- Verified database owner → forge_owner is allowed, preserving shared preparation, migrations and GLOBAL_READY.
- NOINHERIT other application → forge_owner is rejected despite demonstrated SET ROLE capability.
- forge_runtime → forge_owner is rejected despite demonstrated SET ROLE capability.
- forge_owner → unrelated role remains rejected.
- Failed cases create no schema, preserve the membership that caused rejection and leave database/public-schema ACLs unchanged.
- Existing optional dedicated-hardening rollback and unrelated-data preservation still pass in the same regression.

`pnpm build` and full image-enabled `pnpm check` pass with the authority fixture on PG18: 1053 tests in 101 files, no skips. Coverage is 90.77% statements, 85.85% branches, 94.69% functions and 90.66% lines, above unchanged gates. Formatting, TypeScript, lint and `git diff --check` pass. No online Neon query or mutation, new provider comparison or Tempo acceptance occurred.

## Limitations and review questions

This guard validates the graph at schema preparation, matching the requested scope. It does not introduce an ongoing membership monitor or alter runtime/installer role contracts. Privileged operators remain responsible for subsequent role changes. Actual Neon schema preparation and traced E2E remain pending; this correction is packaged as a separate commit for review at the user's request, with independent acceptance pending.

1. Is the incoming exception bound solely to the actual database-owner OID after the current/session login checks, with no allowance based on an arbitrary role name?
2. Are all other incoming members rejected irrespective of login/INHERIT flags, while the existing outbound restriction remains?
3. Do failure paths occur before DDL and preserve memberships/ACLs, without automatic revoke or broader deployment changes?
4. Do the real operator cases cover both allowed AUTHORIZATION and owner escalation, while preserving the reviewed shared-database behavior?
