# M4.1A: Durable Persistence Contract and Parity Audit

## Baseline and scope

M4 starts from the frozen M3 closure commit `e58564010593d65d58f749c4dd74125368f31092` on
`m4/postgres-durable-authority`. SQLite is the **reference for current Forge run authority behavior**,
not a prescribed PostgreSQL implementation. M4.1A identifies parity gaps and extracts executable
behavioral contracts; it does not change M3 authority semantics or enable PostgreSQL in the worker.
Cross-run repository fencing, globally distributed write leases, and multi-run concurrency belong to
M4.2/M4.3, not this audit.

## Adapter inventory

| Capability                  | SQLite (`DrizzleSqliteOrchestrationPersistence`)                            | PostgreSQL (`postgres-persistence`)                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forge run authority adapter | Implements `OrchestrationPersistence` and the activity/control-plane stores | **Missing.** `PostgresEvidenceStore` is only a TypeScript intersection describing a future adapter; no implementation or factory exists.                                                                                                             |
| Connection                  | Opens a real SQLite database; can open two connections to the same file     | `connectPostgresEvidenceStore()` validates a connection-string prefix, schema identifier and nonblank role, then creates a `postgres` client with a bounded `close()`; opening does not establish a schema or role and does not verify connectivity. |
| Durable schema              | SQLite tables, constraints and migration-on-open in the adapter             | No Forge tables, schema migration, row locking, indexes, search-path or role-isolation enforcement.                                                                                                                                                  |
| Test database               | Local temporary file shared by two independent connections                  | No provisioned PostgreSQL service, schema lifecycle, or test role.                                                                                                                                                                                   |
| Production route            | Worker and CLI explicitly use configured SQLite authority                   | No PostgreSQL selection/wiring.                                                                                                                                                                                                                      |

The existing PostgreSQL configuration tests verify metadata validation and closing a candidate handle.
They do **not** establish any Forge durability or authority parity.
The candidate `PostgresEvidenceStore` type is itself incomplete: it does not yet include
`ActiveMutationClaimPersistence`, `CancellationPersistence`, `CancellationSettlementPersistence`,
`IntegrationMutationClaimPersistence`, `TaskRepairWorkItemAdmissionStore`, or
`TaskRepairResumeStore`. The eventual adapter must implement the complete worker authority surface.

## Shared executable contract

`libs/persistence/src/lib/durable-authority.contract.test.ts` defines one backend-neutral suite against
the domain persistence interfaces. The SQLite instantiation opens **two independent connections to the
same temporary database** in `durable-authority-parity.spec.ts`. The PostgreSQL instantiation in
`libs/postgres-persistence/src/lib/durable-authority-parity.spec.ts` imports the **same suite**, but is
explicitly skipped until an adapter and real PostgreSQL fixture exist. Skipped means **not verified**, not
PASS; it does not fall back to SQLite or a fake PostgreSQL adapter. The existing detailed SQLite tests
remain in place, and this suite is the common parity baseline for a subsequent M4.1 implementation.

| Behavioral contract                                                             | SQLite reference                                                                                                                       | PostgreSQL gap                                                                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact run authority creation, duplicate-ID rejection, task binding recovery     | Shared contract exercises creation/recovery and rejects replacement with different authority                                           | No run/binding tables or transactional creation.                                                                                                                              |
| Sequence-one `run-started` initial dispatch; exact retry after attempt advanced | Shared contract requires `ensureInitialDispatch`, one event/decision, immutable attempt authority, and rejection of different evidence | No initial-dispatch transaction or immutable evidence comparison.                                                                                                             |
| Builder PREPARING -> STARTING claim with revision CAS                           | Two connections compete for the same attempt; exactly one claims                                                                       | Must implement conditional update (e.g. `UPDATE ... WHERE state='PREPARING' AND revision=? RETURNING ...`) and transactional lease evidence; read-then-write is insufficient. |
| Repair admission, immutable work item and bounded history                       | Competing connections return the same admitted attempt for the same review, one work item; next review exceeds budget                  | No per-task transactional budget gate or exact-review idempotency.                                                                                                            |
| BLOCKED repair resume, revision CAS, lease release, unique dispatch             | Competing connections yield one resume, one version conflict, one revision-three dispatch                                              | Needs conditional update and unique `(run,repair,revision)` dispatch in the same transaction.                                                                                 |
| Review and verification evidence                                                | Exact retries recover one record; conflicting subject or evidence rejects                                                              | No exact-subject/fingerprint validation or immutable evidence tables.                                                                                                         |
| Workspace and impact recovery                                                   | Distinct connection recovers blocked workspace and structured `Set` impact                                                             | No durable encoding/decoding or corruption validation.                                                                                                                        |
| Integration claim and cancellation settlement                                   | Claim identity is stable; cancellation remains visible, wrong settlement rejects; exact settlement clears claim                        | No integration claim CAS, identity validation or cancellation settlement transaction.                                                                                         |
| Cancellation and normal terminal state                                          | ACTIVE -> CANCEL_REQUESTED -> CANCELLED and ACTIVE -> COMPLETED; terminal run cannot be overwritten                                    | No state-transition CAS / terminalization model.                                                                                                                              |
| `ForgeReadModel` recovery prerequisites                                         | `recoverRun`, reviews, repair attempts, verification evidence and leases supplied by the SQLite adapter                                | No compatible recovery APIs or reconstructed durable collections.                                                                                                             |

Two further **same-run authority** contracts are now executable in this shared suite:

- `claimRepairStart` moves an admitted repair from PREPARING revision N to STARTING revision N+1.
  Two independent connections attempt the same claim; exactly one succeeds, and the loser leaves
  no extra attempt or work item. PostgreSQL needs conditional CAS of the repair revision **and**
  an ACTIVE-run check in one transaction.
- Once `requestCancellation()` has durably changed the run to CANCEL_REQUESTED, subsequent
  `claimBuilderStart`, `claimRepairStart`, and `claimIntegrationStart` all reject without new mutation
  evidence. The builder claim carries a nonempty lease plan; its rejection leaves both the builder
  PREPARING and the proposed lease absent, while the run remains CANCEL_REQUESTED. PostgreSQL must
  serialize **all three** ACTIVE-run mutation claims atomically against
  cancellation. Reading ACTIVE before another transaction cancels and then unconditionally writing
  a claim would violate frozen M3 authority.

The shared contract is an initial executable subset of the complete SQLite behavior; it does not
supersede SQLite's detailed tests. In particular, additional PostgreSQL parity tests must also cover
partial initial evidence, builder/repair UNKNOWN settlement, lease version regressions, persisted
reevaluation replay and runtime-conflict sequencing, verification fingerprint integrity and corruption,
integration claim release versus settlement, and exact repair history across reopen. The current
SQLite `finalizeCancellation()` itself transitions `CANCEL_REQUESTED` to `CANCELLED` even while an
integration claim remains active; callers separately inspect/settle claims. M4.1 must preserve the
observed contract rather than silently imposing different SQL semantics.
The two SQLite connections establish observable single-winner/loser and cancellation-first behavior,
but SQLite's synchronous transactions mean `Promise.all` here does **not** prove two database
transactions overlap. PostgreSQL parity needs deliberately overlapping independent transactions
at both claim-versus-claim and cancellation-versus-claim windows, with one durable winner and a
deterministic loser. This is same-run authority parity, not M4.2 cross-run repository fencing.

## Exit conditions for PostgreSQL parity

1. Define a concrete PostgreSQL adapter implementing the complete required domain persistence stores;
   wire neither CLI nor worker until parity is established.
2. Provision an isolated real PostgreSQL database/schema/role per test and verify search-path and role
   isolation, migrations, uniqueness, and corruption handling.
3. Replace the explicit PostgreSQL skip with an adapter factory that runs **this same contract suite**
   against two independent PostgreSQL connections. No mock/in-memory substitute counts as parity.
4. Extend the common contract to close the remaining listed gaps; enforce transaction and CAS guarantees
   using PostgreSQL constraints, conditional updates, `RETURNING`, and locking where appropriate.
   Add a controlled overlapping-transaction test seam for builder, repair, and integration claims
   racing cancellation: when cancellation wins first, later claims leave no durable mutation authority.
5. Preserve frozen M3 SQLite semantics; defer cross-run repository fencing and multi-run acceptance to
   M4.2 and M4.3 respectively.

M4.1A status after independent review of `348f823`: **PASS / CLOSED**. The SQLite reference
passes all 10 shared authority contracts. PostgreSQL reports 10 skipped contracts and one pending
fixture requirement: its authority adapter is **NOT IMPLEMENTED / NOT VERIFIED**, and parity remains
blocked on M4.1B. This closes the audit only, not PostgreSQL parity or M4.1 as a whole.

## M4.1B: Real PostgreSQL authority adapter and fixture (awaiting review)

`PostgresOrchestrationPersistence` implements Forge run, dispatch, attempt, repair, review,
verification, workspace, integration, and cancellation stores without replacing the separate
candidate `connectPostgresEvidenceStore()` API. Connection checks the configured role against
`current_user` and verifies the schema before creating run and keyed-evidence tables. Each same-run
mutation locks the run row using `SELECT ... FOR UPDATE` inside a transaction, so state checks,
revision checks, and writes share a serialization boundary. Exact initial-dispatch retries validate
immutable attempt authority even after its lifecycle advances. `recoverRun` uses a consistent
`REPEATABLE READ READ ONLY` snapshot and validates reconstructed authority evidence.

The PostgreSQL fixture starts a real isolated local server using `initdb` and `pg_ctl`, gives each
case its own schema, and opens two independent connections. It executes the **same 10 shared
contracts** as SQLite without skips or fallback. Five additional PostgreSQL tests reject wrong
roles, missing schemas, corrupted runs, and partial initial authority; prove replay and recovery
after reopening; and establish one winner from two genuinely blocked builder claims and zero
mutation side effects when cancellation commits before three blocked claims. `pg_blocking_pids`
confirms real transaction overlap.

This is **single-run adapter evidence**, not a production cutover. CLI and worker remain SQLite-backed;
M4.2 cross-run repository fencing and M4.3 multi-run concurrency remain separate. The M4.1A gap table
above is a historical audit snapshot. Before selecting a PostgreSQL production route, review schema
ownership/migrations and role privileges; broaden common parity around UNKNOWN settlement,
corruption of other evidence, conflict sequencing/replay, and ForgeReadModel recovery. M4.1B is
**IMPLEMENTED / AWAITING INDEPENDENT REVIEW**.

### Review remediation: evidence validation and fresh-connection recovery

The same backend-neutral contract now exercises **16 cases on each backend**, using test-only direct
corruption of binding and verification records to prove recovery fails closed. New cases reject
malformed scheduler events, snapshots, task decisions, and runtime conflicts with an incorrect
effective sequence; impact, conflict, and workspace identities that disagree with their run or task;
missing or key-mismatched bindings; and verification evidence whose self-fingerprint disagrees with
otherwise schema-valid content. The PostgreSQL adapter validates these values before writing and
requires recovered bindings to match both their row keys and the complete task set of a run.

The shared suite also exercises cancellation settlement for both builder and repair attempts marked
UNKNOWN. Settlement before cancellation rejects; an incorrect attempt revision cannot mutate leases;
the exact revision marks the matching attempt CANCELLED and releases its matching active lease while
an unrelated lease remains active. A PostgreSQL-only test opens a fresh adapter/connection against
the persisted schema, then projects the recovered run through `ForgeReadModel`, checking builder and repair lineage, review and
verification references, leases, blocking reason, timeline, and correlation identifiers. Together
with the existing five PostgreSQL-only tests, the focused run passes **38 tests** (16 shared cases
per backend and six PostgreSQL-only cases). The SQLite production route and frozen M3 semantics are
unchanged.

This is not permission to deploy PostgreSQL. The adapter currently creates two tables on connect;
there is no versioned, migration-owner-managed schema or startup compatibility check. Before a
production route, introduce reviewed migrations and a recorded schema version, verify that the
application rejects unsupported versions, and separate the migration-owner role from a least-
privileged runtime role with only the necessary data permissions and no startup DDL. Test that
schema installation, role privileges, and upgrades work on a real database. The PostgreSQL
`recoverRun` transaction provides a consistent snapshot for that single call, **not** an atomic
snapshot across the four separate recovery calls made by `ForgeReadModel`. Independent review of
`a6c1884` found no P0/P1: **M4.1B is PASS / CLOSED**. CLI and worker continue to use SQLite;
the PostgreSQL production route is **NOT READY / NOT ENABLED**, and M4.1 overall is **NOT CLOSED**.
The versioned migration system, schema compatibility gate, migration-owner/runtime-role separation,
least-privilege grants, and real upgrade acceptance remain prerequisites for a future M4.1C
operational-schema stage. M4.2/M4.3 remain outside this stage.

## M4.1C: Operational schema and restricted runtime (awaiting independent review)

Schema installation is now an explicit migration-owner operation, separate from opening an authority
adapter. `migratePostgresAuthoritySchema()` creates a versioned ledger with checksums: version 1
installs the run and evidence tables, and version 2 adds the evidence lookup index. Installation and
upgrade run in a transaction protected by a schema-specific advisory lock. Repeating a completed
migration is a no-op; a downgrade, unknown or altered ledger entry, pre-existing unmanaged tables,
and the wrong schema owner fail closed. The installer grants a distinct runtime role schema usage,
read-only access to the ledger, and the required data-table operations. It does not grant the
runtime role schema ownership or DDL privileges.

`PostgresOrchestrationPersistence.connect()` no longer creates tables or repairs schemas. Its
read-only startup gate checks the configured PostgreSQL identity, schema and table ownership,
column types/nullability, primary and foreign key constraints, the required index definition,
exact ledger version/checksums, and effective runtime permissions. The runtime role must
not be superuser, migration-owner member, database/schema creator, or able to create temporary
tables. Missing schema objects, a future or tampered ledger, a missing index, or missing data-table
privileges reject startup without DDL. The migration-owner credential is never used by the
authority adapter.

The real PostgreSQL fixture now provisions separate migration-owner and restricted runtime roles,
installs a fresh schema for each case, and opens two independent runtime connections. All **16
shared backend-neutral authority contracts** and the existing PostgreSQL-specific recovery and
controlled-transaction-overlap tests run under that restricted role. Additional real-server tests
cover version-1 installation followed by version-2 upgrade with preserved run data, repeated
installation and downgrade rejection, missing/future/tampered ledger, denied DDL and ledger writes,
revoked runtime UPDATE, a dropped required index, changed column nullability, a removed primary
key, and a same-named index on the wrong columns. The PostgreSQL-specific suite has **29
passing tests**, including the 16 shared cases; the separate SQLite instantiation also remains
executable. This stage changes neither the frozen M3 authority semantics nor the production route:
CLI and worker still use SQLite. M4.1C is **IMPLEMENTED / AWAITING INDEPENDENT REVIEW** and M4.1
overall remains **OPEN**. Explicit application routing belongs to M4.1D; cross-run fencing and
multi-run concurrency remain M4.2/M4.3.

### M4.1C review hardening (awaiting independent review)

The migration API now rejects unsupported runtime target versions (including zero, a future
version, and non-numeric input) before connecting or creating a schema. Migration reruns revoke
all table grants from `PUBLIC` and the runtime role before granting the exact required set:
ledger `SELECT`; run table `SELECT/INSERT/UPDATE`; evidence table
`SELECT/INSERT/UPDATE/DELETE`. Startup rejects excess `DELETE`, `TRUNCATE`, `REFERENCES`, or
`TRIGGER` privileges, as well as missing required privileges. A real PostgreSQL test first grants
excess authority, checks startup rejects it, reruns the migration, and checks the grants are
removed and startup succeeds.

Both migration verification and normal startup also require ordinary permanent tables with RLS
and FORCE RLS disabled, the ledger timestamp's `now()` default, and no user-defined triggers or
rewrite rules on authority tables. Real-database tests change each of these properties and prove
both paths reject the tampered schema without repair. The PostgreSQL-specific suite now has **39
passing tests**; the shared backend-neutral contracts are unchanged. M4.1C remains
**IMPLEMENTED / AWAITING INDEPENDENT REVIEW**; the CLI and worker continue to use SQLite.

### M4.1C effective-privilege review hardening (awaiting independent review)

The runtime startup gate now checks the **effective** authority available to its credential, not
only table-level grants. It rejects column-level `INSERT`, `UPDATE`, or `REFERENCES` on the
read-only ledger, column-level `REFERENCES` on either data table, `WITH GRANT OPTION` on every
allowed table operation and schema `USAGE`, and any membership in another role (including a
non-inherited membership that permits `SET ROLE`). Migration reruns still canonicalize direct
runtime/PUBLIC grants; membership must be removed from the runtime credential separately.

The supported server-major range is explicitly **PostgreSQL 14–16**. Both migration and adapter
startup reject other majors; supporting PostgreSQL 17 or newer first requires extending the
effective-privilege gate for its `MAINTAIN` privilege. Real PostgreSQL 14 regressions prove a
column-only ledger `UPDATE(checksum)` can change the ledger despite a false table-level UPDATE
probe, that startup rejects it, and that a migration rerun removes it. The suite also covers other
forbidden column grants, table/column grant options, schema grant option, and role membership.
The PostgreSQL-specific suite now has **50 passing tests** (16 shared contracts and 34 PG-only
cases). M4.1C remains **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**; CLI and worker still use
SQLite, and M4.1D routing is not enabled.

### M4.1C session identity review remediation (awaiting independent review)

PostgreSQL distinguishes the normally initial session identity (`session_user`) from the effective
identity (`current_user`). A privileged login can assume the restricted runtime role with `SET ROLE` and
later regain its login privileges with `SET ROLE NONE`. The read-only runtime startup gate now
requires **both** identities to equal the configured runtime role before checking its grants. It
does not support a login-wrapper role that assumes the runtime role.

In a real PostgreSQL 14 fixture, a separate LOGIN role with `CREATEDB` assumes the runtime role:
the test confirms the different session/effective identities, proves the login can be restored,
and verifies that both the startup gate and adapter connection reject the assumed-role session.
The role-membership regression also sets `NOINHERIT` on the **member** runtime role, verifies
`USAGE=false` and `MEMBER=true`, and proves `SET ROLE` can still activate the membership before
startup rejects it. The PostgreSQL suite now has **51 passing tests** (16 shared and 35 PG-only).
M4.1C remains **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**; CLI and worker still use SQLite,
and M4.1D routing has not begun.

### M4.1C authenticated-credential review remediation (awaiting independent review)

`session_user` is mutable too: a superuser can use `SET SESSION AUTHORIZATION` to make both SQL
identities appear to be the restricted runtime, then `RESET SESSION AUTHORIZATION` to regain its
original privileges. Therefore the runtime adapter now validates its connection URL **before
opening a pool**: the URL must explicitly name the configured runtime role as its username, and
must have no query parameters (including PostgreSQL startup options that could assume a role).
The startup schema gate independently enforces the same URL rule, checks the PostgreSQL client
pool's effective login option, and still checks both SQL identities. This deliberately does not
support proxy logins or connection startup overrides.

The PostgreSQL 14 regression demonstrates a superuser login making both SQL identities look
like runtime, then restoring its superuser identity. The schema gate rejects the proxy credential,
and adapter startup rejects the equivalent URL startup-option attempt. Missing runtime usernames
and any URL startup parameters also fail closed. The suite now has **53 PostgreSQL cases** (16
shared contracts plus 37 PG-only). M4.1C remains **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**;
CLI and worker still use SQLite, and M4.1D production routing has not begun.
