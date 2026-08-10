# ADR-012: In-memory runtime write guard

## Status

Accepted

## Decision

Milestone 8 provides `InMemoryWriteGuard`, a live, process-local implementation of the domain
`WriteGuard` port. It grants only exclusive leases and evaluates the accepted self-contained
project/file/symbol/shared-resource hierarchy with `areWritableResourcesConflicting`.

Every guard operation passes through one serialized critical section. Concurrent acquisition attempts
therefore observe one linear order: at most one conflicting request can create an active lease; later
requests receive the stable IDs of the active conflicting leases. This is in-process safety only. It
does not claim to coordinate multiple processes or survive a restart.

A repeated acquire by the same run, agent, task, and exact resource returns the existing active lease
without incrementing its version. A different owner remains blocked by normal resource conflict rules.
This makes agent retries idempotent without granting concurrent write access.

Heartbeat, stale marking, and release require the lease's current positive version. Heartbeat
increments the version and refreshes liveness time. Marking stale requires non-empty evidence
supplied by an outer runtime, increments the version, and records evidence with the stale timestamp.
Release also increments the version and rejects a stale request with `version-conflict`. The guard
never uses a fixed timeout or `Date.now()` to decide that a lease is stale. `STALE` and `RELEASED`
leases are not active blockers. An absent or non-active lease returns `not-found`.

One `InMemoryWriteGuard` instance serves exactly one repository/workspace namespace. Resource IDs are
therefore compared only within that instance; it must not be shared across unrelated workspaces whose
project, file, or symbol identifiers may coincide. A future multi-workspace persistent guard must add
an explicit workspace or repository identity to its resource key before sharing storage.

## Consequences

The Runtime Guard supplies tested live lease behavior for one Node.js process and one workspace while
leaving storage, cross-process atomicity, recovery, event persistence, and replay to Milestone 9. It
does not inspect files, resolve repository identities, authorize a real filesystem write, change
scheduler state, run agents, or invoke Git. The outer runtime must resolve resources before
requesting a lease and must apply resulting block/release events to the Scheduler. Before an agent
runtime performs a real write, a later milestone must carry a lease version as a true fencing token
to the write authorization boundary; the current version only protects guard lifecycle operations.
