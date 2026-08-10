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

## Consequences

Local operation and restart recovery stay simple. Repository interfaces and domain records must not
expose SQLite-specific types so PostgreSQL can be added later. The persistence adapter does not own
agent execution, filesystem observation, Git integration, or cross-process write fencing.
