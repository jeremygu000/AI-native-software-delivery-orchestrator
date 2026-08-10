# ADR-013: Scheduler event and snapshot replay semantics

## Status

Accepted

## Decision

Scheduler persistence stores an append-only reevaluation sequence. Every persisted reevaluation
contains the event, the Scheduler input snapshot, all requested task-state transitions, and the
resulting structured Scheduler decision under one run-local positive sequence number.

The stored snapshot is always the snapshot passed into `Scheduler.reevaluate`, not a vaguely named
post-decision snapshot. Observation events carry their deterministic post-event task state and require
the input snapshot to already contain that state:

```text
task-completed        -> COMPLETED
task-failed           -> FAILED
verification-completed -> INTEGRATING
workspace-integrated  -> COMPLETED
```

Runtime evidence events remain the explicit exception. `lease-blocked` and
`runtime-conflict-discovered` validate and apply `RUNNING -> BLOCKED`; lease and runtime-conflict
release evidence removes matching blockers and may apply `BLOCKED -> READY`. Their input snapshot is
therefore the state before the Scheduler applies that evidence.

Recovery replays every persisted event with its persisted input snapshot and immutable run inputs.
The recomputed decision must equal the stored decision. A missing decision or a mismatch is a replay
integrity failure, not a reason to silently continue with ambiguous state.

## Consequences

Event meaning is now explicit before it reaches SQLite. Persistence does not fossilize the former
implicit convention where some observation events were merely arbitrary reevaluation triggers. The
outer runtime remains responsible for applying and persisting the returned task transitions. Future
event versions must preserve this split or provide a deliberate migration.
