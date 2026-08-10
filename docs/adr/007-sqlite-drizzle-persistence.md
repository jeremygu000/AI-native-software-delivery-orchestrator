# ADR-007: SQLite and Drizzle persistence

## Status

Accepted

## Decision

Start with SQLite through Drizzle behind persistence repository interfaces. The first implementation
uses `better-sqlite3` inside `libs/persistence`; SQLite, Drizzle, and driver types never enter domain
contracts. Persist reconstructable runs, task contracts/dependencies, schedule options, append-only
events, input snapshots, requested transitions, decisions, impacts, conflicts, and leases—not
complete ASTs.

Each reevaluation writes its event, input snapshot, transitions, and decision atomically under a
contiguous run-local sequence number. Current impact, conflict, and lease records upsert by their
stable run-local keys. Recovery validates stored JSON against domain shapes and replays events through
the Scheduler to verify the persisted decision rather than trusting arbitrary database text. Conflict,
impact, and lease persistence schemas are domain-owned and validate their complete discriminated or
collection shapes on recovery. A persistence-instance mutex serializes sequence allocation and
reevaluation writes even if future validation or driver work becomes asynchronous. Replay compares a
canonical structural representation, not incidental JavaScript object key insertion order.

Persisted transitions must exactly equal the non-deferred state-transition decisions in the persisted
Scheduler decision. The adapter validates this before writing and again during replay, so a corrupted
transition row cannot pass decision replay merely because the decision itself still matches. A retry of
an already-recorded sequence is idempotent only when its event timestamp, event payload, input
snapshot, transitions, and decision all match saved evidence; different evidence at the same sequence
is rejected. Outer relational keys must equal payload identities, and lease persistence rejects version
regression or same-version records with different content. Canonical comparison serializes `Date`
values as ISO timestamps before structural object handling, so a timestamp-only difference in a
same-version lease remains observable and is rejected.

A task may legitimately receive more than one requested transition in one reevaluation, such as
`PENDING -> READY` followed by `READY -> RUNNING`. Transition rows therefore use a run ID, sequence,
and transition ordinal key rather than task ID as their final key component. The ordinal preserves
write order while replay consistency compares the semantic task/from/to transition set independently
of its stored row ordinal.

## Consequences

Local operation and restart recovery stay simple. Repository interfaces and domain records must not
expose SQLite-specific types so PostgreSQL can be added later. The persistence adapter does not own
agent execution, filesystem observation, Git integration, or cross-process write fencing.
