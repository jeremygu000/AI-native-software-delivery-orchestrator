---
title: Persistence and Replay - Training Guide
tags:
  - coding-orchestrator
  - persistence
  - replay
  - sqlite
status: implemented
---

# Persistence and Replay - Training Guide

This guide explains how Milestone 9 stores enough deterministic orchestration evidence to recover a
local run after a process restart and prove that saved Scheduler decisions can be replayed. It is
written for readers without prior experience of event logs, SQLite, or recovery systems.

For scheduling semantics, read [Scheduler Dispatch](./scheduler-dispatch.en.md). For concrete write
authority, read [Runtime Guard and Write Leases](./runtime-guard.en.md).

## The short version

Persistence answers:

> After a process stops, can the system reconstruct what it knew, what event happened, what decision
> it made, and whether that decision still follows from the saved inputs?

The answer is not “save arbitrary JavaScript objects.” The implementation stores validated,
reconstructable domain evidence:

```text
run inputs + task contracts + conflicts + schedule options
        +
events + Scheduler input snapshots + transitions + decisions
        +
current impacts + conflicts + leases
        |
        v
SQLite
        |
        v
validated recovery + decision replay
```

`libs/persistence` provides `DrizzleSqliteOrchestrationPersistence`. It uses SQLite through Drizzle
and `better-sqlite3`, while all database and driver types remain in that adapter.

## Replay contract before tables

Saving an event is useful only when its meaning is unambiguous.

### Observation events

These report a transition that the outer runtime already applied to the Scheduler input snapshot:

| Event                    | Required state in input snapshot |
| ------------------------ | -------------------------------- |
| `task-completed`         | `COMPLETED`                      |
| `task-failed`            | `FAILED`                         |
| `verification-completed` | `INTEGRATING`                    |
| `workspace-integrated`   | `COMPLETED`                      |

```text
outer runtime applies task A -> COMPLETED
        |
        v
input snapshot records A = COMPLETED
        |
        v
persist task-completed(A, COMPLETED) + input snapshot
        |
        v
Scheduler reevaluates
```

If an observation event and input snapshot disagree, Scheduler rejects the record. Persistence cannot
therefore fossilize an event whose claimed outcome contradicts saved state.

### Runtime evidence events

Blocker events are different. Scheduler applies their evidence to the input snapshot:

```text
lease-blocked(A, lease-1)
        |
        v
Scheduler verifies A = RUNNING
        |
        v
Scheduler requests RUNNING -> BLOCKED and records lease-1
```

Release or resolved-conflict evidence removes matching blockers and can move all matching waiters to
`READY`. This distinction is recorded in [ADR-013](./adr/013-scheduler-event-replay.md).

## Atomic reevaluation evidence

One reevaluation saves four related records inside one SQLite transaction:

```text
event + input snapshot + requested transitions + decision
        |
        v
one positive sequence number per run
        |
        v
all rows commit or all rows roll back
```

A later failed transition insert rolls back the earlier event insert and the decision insert. Recovery
never sees a half-written reevaluation.

Run sequences are contiguous:

```text
saved:        1, 2, 3
next allowed: 4
```

The persistence adapter serializes reevaluation writes with an explicit promise mutex. This remains
safe if a future check or driver operation becomes asynchronous.

## Stored model

One run stores the immutable inputs needed to replay decisions:

```text
run identity and state
task contracts
hard conflicts
risk conflicts
schedule options
```

Append-only scheduling evidence uses run ID and sequence keys:

```text
scheduler_events
task_transitions
scheduler_decisions
```

Current records upsert by stable run-local key:

```text
task_impacts:   run ID + task ID
task_conflicts: run ID + task A + task B
write_leases:   run ID + lease ID
```

The same task or lease ID in another run remains independent because every key includes the run ID.

## JSON that preserves domain data

Domain records contain `Set` values. Normal JSON would silently turn a Set into `{}`. The adapter uses
an explicit round-trip representation:

```text
Set(["core", "consumer"])
        |
        v
{ "$set": ["core", "consumer"] }
        |
        v
Set(["core", "consumer"])
```

Lease lifecycle dates are restored as `Date` values. Every recovered record then passes domain-owned
Zod schemas:

```text
TaskContract
TaskConflict discriminated union
TaskImpact with required Set fields
WritableResource discriminated union
WriteLease lifecycle fields
ScheduleOptions
SchedulerEvent
SchedulerSnapshot
SchedulerDecision
```

Malformed JSON, invalid run state, a hard conflict without constraints, a truncated impact, or an
invalid lease is rejected as `PersistenceInputError`. A top-level JSON parse is never enough to make a
record valid.

## Recovery and replay

Recovery loads stable run inputs and sequence-ordered evidence, then validates replay:

```text
SQLite file
   |
   v
validate every record
   |
   v
for each event:
  Scheduler.reevaluate(saved event, saved input snapshot, saved inputs)
   |
   v
canonical structural comparison with saved decision
```

Object keys are canonically sorted before comparison. Array order remains meaningful because
Scheduler emits deterministically ordered decisions and reasons. A missing decision or mismatch is a
`PersistenceReplayError`, not an excuse to continue with ambiguous history.

Canonical comparison handles lease `Date` values as ISO timestamps before inspecting object fields.
Consequently, a same-version lease retry whose only changed evidence is `lastHeartbeatAt` is rejected
rather than being mistaken for an identical retry. The canonical comparator is intentionally limited
to the evidence shapes used here; `Set` values use the explicit persistence encoding above instead of
being compared as arbitrary JavaScript objects.

An empty run has no events and replays to `[]`.

## Restart example

```text
process 1:
  create SQLite file
  create run
  persist sequence 1
  close database

process 2:
  reopen file
  validate run evidence
  replay sequence 1
  verify decision
```

This is local restart recovery, not distributed consensus or multi-process write fencing.

## What Milestone 9 does not do

It does not:

- coordinate writes across processes or hosts;
- provide deployed database migration tooling;
- execute agents, commands, or verification;
- observe filesystem writes;
- create or integrate Git worktrees;
- use a lease lifecycle version as a true write fencing token;
- expose a `forge plan` persistence workflow.

The future agent runtime needs a separate ownership-generation fencing token at the actual write
authorization boundary. Current lease versions only fence lifecycle operations.

## Verification and limits

The persistence package has 15 passing tests with 97.63% statements, 94.36% branches, 98.33%
functions, and 97.78% lines. The repository quality gate has 242 passing tests with 96.83%
statements, 91.77% branches, 99.12% functions, and 96.80% lines. `pnpm check`, `pnpm build`, and
`git diff --check` pass.

The O(n) next-sequence lookup is accepted for local runs and is protected by the adapter mutex. A
future high-volume workload can use a run counter or `MAX(sequence)` query after measurement proves a
need.
