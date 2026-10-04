# Independent review request: PostgreSQL compatibility and Neon preparation

> Historical review request for the PostgreSQL compatibility stage. Compatibility and explicit TLS have since been accepted. The current shared-database deployment model and review request are in `docs/postgres-shared-database-review.en.md`.

Review the increment against accepted commit
`06aa678a555f871bd557fee5714d77069745a050` on
`m4/postgres-durable-authority`. The earlier deferred integration task-span P1 is
closed.

## Intended scope and constraints

Support explicitly enumerated PostgreSQL majors 14–18, while rejecting 13 and
future 19. Preserve migration SQL, checksums, schema version, authority/fencing
contracts, provider neutrality, workflow commands and the existing
`forge-observability-v1` boundary. Keep database-owner hardening separate from
runtime/setup/recovery and fresh authority bootstrap. Never reuse or repair an
existing authority to make this comparison run.

## Changed areas

- `postgres-server-version.ts` and its public package entry define one explicit
  compatibility contract used by the adapter and Neon bootstrap.
- `postgres-authority-schema.ts` rejects effective MAINTAIN on authority tables
  for all restricted roles on PG17/18. PG18 schema checks account for NOT NULL
  catalog entries and still reject inheritance, validation and enforcement drift.
- `durable-authority-parity.spec.ts` adds a disposable digest-pinned Docker
  backend, checks actual major and retains the native backend. It adds real
  privilege/catalog drift regressions and a database-owner hardening regression.
- `neon-database-hardening.mjs` provides read-only inspect and explicit dedicated
  database apply. It verifies the actual owner login, performs grants/revokes in
  one transaction and rolls back if effective privileges remain incompatible.
  Private URL parse failures do not print their input.
- Ordinary and comparison wrappers strip the database-owner credential and
  private hardening-file pointer. Comparison subprocess tests verify isolation.
- Neon bootstrap rejects startup query parameters and missing verified TLS
  before connecting, and writes verified TLS into private runtime configuration.
- `.env.local.example`, deployment/tracing guides and both onboarding progress
  summaries describe these prerequisites and correct the accepted commit status.

## Verification performed

`pnpm build` and full image-enabled `pnpm check` pass. The latter uses PostgreSQL
18 for the authority fixture and includes existing compiled CLI/worker and
Temporal acceptance. Coverage is 90.79% statements, 85.81% branches, 94.72%
functions and 90.67% lines, above unchanged gates.

The final PG16 authority suite passes 148 tests, with five PG17/18 feature tests
explicitly skipped. PG18 exercises all 153 authority tests. These retain real
migrations/upgrades/reruns, schema audit, restricted writer ACL, GLOBAL_READY,
fencing, concurrency and advisory-lock coverage. New tests cover direct and
PUBLIC MAINTAIN for runtime/trust/issuer/setup/recovery, grant option, base/global
NOT NULL inheritance drift, NOT VALID and NOT ENFORCED constraints, owner
identity, explicit acknowledgement, rollback on inherited TEMP and preserved
pre-existing data. Targeted checks verify private URL redaction and comparison
credential isolation. Final format, typecheck, lint and diff checks pass.

Live Neon inspection was read-only: actual owner `neondb_owner`, PostgreSQL 18,
effective TEMP on all six Forge roles. Bootstrap with the current query-bearing
role URLs fails before connecting. No live privileges or authority were changed.

## Known limits and remaining work

No new Neon authority is GLOBAL_READY and no new traced GroundGraph comparison
has run. PUBLIC revocation still awaits confirmation that the database is
dedicated to Forge. Authority URLs need query-free configuration with separate
verified TLS. PG14/15/17 do not have a new full release matrix; application
acceptance retains native PostgreSQL. Previous provider timings and the one-span
Tempo smoke trace are historical evidence, not proof of this live deployment.

## Review questions

1. Is the explicit version gate consistent across installation, runtime and
   bootstrap, without accepting future majors?
2. Does MAINTAIN auditing cover ledger/base/global tables and every restricted
   role, including PUBLIC and grant-option effects, without startup mutation?
3. Do PG18 NOT NULL catalog checks preserve strict drift rejection on every
   migration version, including unvalidated or unenforced constraints?
4. Is the hardening operation correctly bound to an explicitly named dedicated
   database and its actual owner, with full rollback and preserved existing data?
5. Are database-owner credentials and private file pointers excluded from every
   ordinary CLI/worker path, including comparison children?
6. Are migration checksums, durable commands and provider/domain boundaries
   unchanged, and are deployment evidence claims limited to what actually ran?

Please report new P0/P1 blockers separately from non-blocking improvements.
