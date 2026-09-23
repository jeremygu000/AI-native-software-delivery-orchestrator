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
