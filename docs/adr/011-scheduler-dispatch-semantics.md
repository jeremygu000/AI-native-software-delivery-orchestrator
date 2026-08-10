# ADR-011: Deterministic scheduler dispatch semantics

## Status

Accepted

## Decision

The Scheduler is a pure, event-driven decision engine. It receives validated task contracts,
functional dependencies, hard conflicts, risk conflicts, a serializable runtime snapshot, and one
structured event. It returns structured per-task decisions; it does not execute agents, acquire
leases, mutate Git worktrees, persist data, or modify the input snapshot.

`SchedulerEvent`, runtime blockers, snapshots, decision reasons, and state-transition decisions use
discriminated structured payloads. Events that block or release work carry the exact lease or runtime
conflict identity. A snapshot records each `BLOCKED` task's active blockers, so a release only moves
matching tasks through `BLOCKED -> READY`; unrelated blocked work remains blocked.

Release events use blocker identity as a broadcast wake-up signal. Their `taskId` identifies the task
that reports or triggers the lease release, stale recovery, or runtime-conflict resolution; it does
not identify a task that must be awakened. Every blocked task whose recorded blocker matches the
released `leaseId` or `conflictId` has that blocker removed. If no blockers remain, each such task
receives `BLOCKED -> READY` and competes normally in the next selection. This allows several waiters
for one released resource to reenter scheduling without inventing one preferred waiter.

Except for runtime blocking events, the caller supplies a snapshot that already reflects the event's
state transition. Events are auditable reasons to reevaluate, not a general state-transition command.
For example, `task-failed` requires its task to already be `FAILED` in the snapshot or the Scheduler
rejects the inconsistent input. `lease-blocked` and `runtime-conflict-discovered` are the explicit
exceptions: they validate and apply `RUNNING -> BLOCKED` because their blocker identity becomes part
of the Scheduler snapshot.

The deterministic greedy selection order is task priority descending, then locale-independent task
ID ordering. Functional dependencies must be `COMPLETED`. A directional
`producer-consumer` constraint adds a separate completion requirement without mutating the original
functional DAG. All hard constraints apply regardless of their score. `parallel` and
`guarded-parallel` risk recommendations may overlap; `stagger` and `serialize` recommendations defer
the later candidate while its conflict peer is running or selected. Static capacity, priority, and
conflict deferral do not change task state.

When a task is `FAILED`, all nonterminal transitive functional dependants and directional producer
consumers are cancelled with `dependency-failed` evidence. A pre-existing `CANCELLED` prerequisite
also transitively cancels dependants with distinct `dependency-cancelled` evidence. This prevents
dependants from silently remaining pending regardless of which terminal prerequisite state the
snapshot contains. The caller applies the legal state transitions returned by the Scheduler; the
Scheduler does not claim to have performed them.

`createInitialPlan` is an explanatory preview calculated with the same ordering policy. Its waves are
not runtime state and never delay a task whose actual dependencies, constraints, and capacity permit
starting after a new event.

## Consequences

Dispatch is deterministic, inspectable, replay-ready, and remains separate from execution and
persistence. A future Runtime Guard can give `guarded-parallel` operational meaning without changing
this selection policy. A future persistence layer can store events, snapshots, and decisions without
parsing text. The current scheduler cannot collect runtime events itself, enforce leases, resume
worktrees, or recover after a process restart.
