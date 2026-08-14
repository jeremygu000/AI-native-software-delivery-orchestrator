# ADR-026: Repair Continuation and Resume

## Status

Accepted and implemented after the Stage 22 stable baseline (`2d041d3`).

## Context

Stage 22 composes the normal builder path through verification evidence, read-only code review, bounded
repair, re-verification, re-review, exact admission, and integration. It keeps repair attempts in a parallel
durable view rather than adding repair states to the builder scheduler snapshot.

A repair may still block on a dynamic write lease. The existing durable evidence is sufficient to preserve
that fact:

- `TaskRepairAttempt` records `BLOCKED`, its blocker lease ID, and a revision used for compare-and-swap;
- `TaskRepairWorkItem` binds the admitted repair to the builder attempt, workspace, lease-plan fingerprint,
  impact fingerprint, review iterations, and policy fingerprints;
- verification and review evidence bind each completed output before integration; and
- SQLite offers an exact compare-and-swap transition from `BLOCKED` to `PREPARING`.

The stable baseline deliberately does not automatically resume a blocked repair. Restarting only the coding
agent would be incomplete: the resumed output must continue through reconciliation, verification evidence,
new review evidence, exact admission, and integration. It must also behave the same when a lease release is
observed during a live run or is already durable when a process restarts.

## Decision

Stage 22R adds a repair-continuation closure without changing review, verification, or repair-admission
authorities. It will derive the next legal action from existing durable evidence rather than adding a second
mutable continuation-phase field.

### One continuation entry point

Live release handling and restart recovery must call one runtime operation conceptually equivalent to:

```text
resumeEligibleRepairs(runId, releasedLeaseId?)
```

It will:

1. Recover the durable repair-attempt and repair-work-item view for the run.
2. Select only attempts whose state is `BLOCKED` and whose recorded lease blocker matches the observed
   released or stale lease. During recovery, it must use durable lease evidence and must not infer release
   from absence in an in-memory guard.
3. Revalidate the immutable continuation inputs before dispatch:
   - repair attempt/work-item/run/task/workspace identities;
   - parent review iteration and exact parent review subject;
   - completed builder attempt identity;
   - current binding agent, workspace, and lease-plan fingerprint;
   - run verification and code-review policy fingerprints; and
   - the durable repair review evidence that originally authorized the repair.
4. Call the existing CAS resume operation with the exact persisted repair revision.
5. Dispatch only the caller that receives `resumed`. `not-found`, `not-blocked`, and version-conflict results
   are normal lost-race outcomes and must not invoke an agent.
6. Run the same complete repair cycle used by fresh repair admission:

```text
controlled agent execution
  -> reconciliation
  -> runtime-scope feedback
  -> verification
  -> verification evidence
  -> fresh repair-output subject
  -> re-review
  -> exact accepted-review admission
  -> integration
```

A fresh repair and a resumed repair may have different entry actions (`admit` versus CAS `resume`), but they
must share the complete post-dispatch cycle. A resume never allocates another repair iteration or consumes
additional repair budget merely because it was blocked.

### Derived continuation, not duplicate phase state

No new durable continuation enum will be added unless durable evidence proves insufficient to derive the
next legal action. In particular:

- `STARTING` and `RUNNING` become `UNKNOWN` on restart and are never automatically resumed;
- `BLOCKED` plus a matching durable released/stale blocker is eligible for CAS resume;
- `BLOCKED` plus an active blocker, missing durable blocker record, cross-run-unavailable evidence, or any
  otherwise unprovable release remains blocked;
- completed repair evidence without a subsequent accepted exact review is not integration authority; and
- an accepted review from a previous output never authorizes a resumed repair output.

This keeps `TaskRepairAttempt`, verification evidence, review evidence, and the immutable work item as the
only durable authorities. The builder `SchedulerSnapshot` remains repair-unaware.

### Lease observation boundary

The runtime must route only successful persisted `RELEASED` or `STALE` lease transitions to the common
continuation entry point. Builder lease release and repair-held lease release may use different mechanical
helpers, but both must publish the same durable lease evidence before continuation selection.

Restart recovery must account for the local guard's ownership visibility. If a blocker belongs to another
run and the current process cannot prove that lease's released/stale state from durable storage, the repair
must remain blocked. Stage 22R must not treat a lease absent from the current guard hydration as released.

## Required Regression Matrix

The following regression matrix governs the implementation and is covered by runtime recovery and live
multi-task continuation tests.

| Scenario                 | Required assertion                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Live matching release    | A repair blocked on `L1` is CAS-resumed once when durable `L1` release is observed, then completes the full repair cycle.           |
| Live unrelated release   | Releasing `L2` does not resume a repair blocked on `L1`.                                                                            |
| Concurrent observers     | Two callers observing `L1` release cause one CAS winner, one repair dispatch, and no extra budget consumption.                      |
| Live continuation        | A resumed repair records reconciliation, verification evidence, a fresh output subject, and a new review before integration.        |
| Exact admission          | An accepted review for the output before block cannot admit the resumed output.                                                     |
| Scope replay             | Scope expansion during resumed repair persists Stage 21 sequenced runtime conflicts and replays correctly.                          |
| Restart active blocker   | A recovered blocked repair remains blocked while its durable blocker is active.                                                     |
| Restart released blocker | A recovered blocked repair with durable released/stale blocker evidence is CAS-resumed and dispatches once.                         |
| Restart unknown          | `UNKNOWN` repairs are never automatically resumed.                                                                                  |
| Recovery mismatches      | Changed workspace, builder attempt, lease plan, policy, parent subject, or missing work item fails closed before runner invocation. |
| Cross-run blocker        | A blocker whose state cannot be proven by current durable evidence remains blocked.                                                 |
| Budget integrity         | `repairIteration` and the repair budget do not change across a successful or losing resume attempt.                                 |

## Consequences

- Stage 22R is deliberately narrow: it does not redesign semantic review, verification evidence, repair
  admission, or scheduler task states.
- The 90% branch-coverage gate remains mandatory. Resume code is state-machine code and must be covered by
  its own runtime and recovery regressions rather than excluded from coverage.
- The implemented coverage proves released/stale, active, CAS-loser, `PREPARING`, `UNKNOWN`, repeat
  repair-review, and re-blocked repair outcomes through the shared queue driver. A live multi-task test also
  proves that an unrelated release does not resume a blocked repair while its matching builder lease release
  produces exactly one CAS-resumed repair dispatch.
- A future lifecycle hardening pass may serialize repair-driven `#recordEvent` mutations with the same
  in-memory lifecycle mechanism used by builder execution. Durable repair dispatch uniqueness does not depend
  on this refinement: SQLite CAS remains the external-agent side-effect authority, and concurrent builder and
  repair continuation coverage passes.
- This ADR's regression matrix passes, so Stage 22 is closed. Work should move to product
  surface capabilities such as run inspection, cancellation, remote triggers, and publication workflows.
