---
title: Scheduler Dispatch - Training Guide
tags:
  - coding-orchestrator
  - scheduler
  - dispatch
  - architecture
status: implemented
---

# Scheduler Dispatch - Training Guide

This guide explains how the Milestone 7 Scheduler turns already-known task dependencies, predicted
conflicts, runtime state, and one runtime event into a deterministic decision about what may start
next. It is written for readers without previous experience of schedulers, concurrent systems, or
the earlier project milestones.

For the evidence that supplies conflict inputs, first read [Task Impact and Conflict
Analysis](./task-impact-analysis.en.md). For the repository facts beneath that layer, read
[RepositoryGraph Analysis](./repository-graph-analysis.en.md).

## The short version

The Scheduler answers one narrow question:

> Given the current state and this new event, which tasks may start now, which must wait, and why?

It does not start a coding agent. It does not write a file, obtain a lease, create a worktree, run
Git, call an LLM, or save a database record. It only produces deterministic decisions for a future
outer runtime to apply.

```text
Task Contracts + Functional DAG
            +
Hard Conflicts + Risk Conflicts
            +
Serializable Runtime Snapshot
            +
One Scheduler Event
            |
            v
Structured Task Decisions
```

The implementation is `DeterministicScheduler` in
`libs/scheduler/src/lib/deterministic-scheduler.ts`.

## Why another layer is needed

Earlier layers answer different questions:

```text
RepositoryGraph    What projects, files, symbols, and dependencies exist?
Task Impact        What might one task read, write, or coordinate through?
Conflict Engine    Which task pairs are risky or structurally incompatible?
Scheduler          Which task may start at this moment?
Runtime Guard      Is a concrete write allowed right now?            [future]
```

The Scheduler does not recompute repository facts or conflict scores. It receives already-produced
`HardTaskConflict[]` and `RiskTaskConflict[]` separately. That separation is important: a numeric
risk score is useful context, but it must never weaken a structural safety constraint.

## Inputs

### Task contracts and the functional DAG

Every task has a stable ID, optional priority, and a list of functional dependencies:

```text
A = generate schema
B = update API, depends on A
C = update UI, depends on A
```

```text
A -----> B
 \
  +-----> C
```

The Scheduler validates duplicate task IDs, duplicate dependencies, missing dependencies,
self-dependencies, and cycles before making any decision. A malformed functional graph is rejected;

### Conflict inputs

The Conflict Engine produces two intentionally different collections:

```text
HardTaskConflict   Structural rule that must be enforced
RiskTaskConflict   Scored recommendation that policy may interpret
```

Hard constraints include same-symbol writes, exclusive resources, ordered resources, competing
producer-controlled writes, and directional producer-consumer access. They apply even when their
explanatory `score` is zero.

Risk conflicts may recommend one of four actions:

| Recommendation     | Scheduler policy in Milestone 7              |
| ------------------ | -------------------------------------------- |
| `parallel`         | May overlap with the other task              |
| `guarded-parallel` | May overlap; decision retains audit evidence |
| `stagger`          | Must not overlap with the other task         |
| `serialize`        | Must not overlap with the other task         |

`guarded-parallel` does not acquire a real guard yet. The Runtime Guard belongs to Milestone 8. It is
still recorded so a future runtime can apply stronger operational protection without changing the
meaning of a historical decision.

### Snapshot

The Scheduler does not keep hidden mutable progress. The caller provides a serializable snapshot:

```json
{
  "taskStates": [
    { "taskId": "generate", "state": "COMPLETED" },
    { "taskId": "api", "state": "RUNNING" },
    { "taskId": "ui", "state": "READY" }
  ],
  "runtimeBlocks": []
}
```

The snapshot has every task state. A `BLOCKED` task also records one or more concrete blockers:

```json
{
  "taskId": "api",
  "blockers": [
    { "type": "lease", "leaseId": "lease-42" },
    { "type": "runtime-conflict", "conflictId": "conflict-9" }
  ]
}
```

This data is ordinary structured data rather than JavaScript `Map` or `Set` objects. A future
persistence service can save it, and a recovery process can provide the same snapshot to reproduce a
decision.

### Event

Each reevaluation receives exactly one structured event. Current event meanings include:

```text
task-completed
task-failed
verification-completed
workspace-integrated
lease-blocked
lease-released
lease-stale
runtime-conflict-discovered
runtime-conflict-resolved
```

Events that create or resolve runtime blocking carry the exact identity required for replay:

```json
{ "type": "lease-blocked", "taskId": "api", "leaseId": "lease-42" }
{ "type": "runtime-conflict-resolved", "taskId": "api", "conflictId": "conflict-9" }
```

The Scheduler validates unknown event task IDs, duplicate snapshot task state records, duplicate
runtime-block records, unknown snapshot tasks, and runtime blocks attached to a task that is not
`BLOCKED`.

## Selection algorithm

The algorithm is greedy on purpose. It does not attempt to solve an optimization problem or estimate
durations. Its predictable sequence is:

```text
validate task graph, conflicts, snapshot, and positive maxConcurrency
        |
        v
apply runtime blocking or blocker-release event evidence
        |
        v
propagate FAILED and CANCELLED prerequisite outcomes
        |
        v
derive eligible candidates from functional and producer completion
        |
        v
sort by priority descending, then stable task ID
        |
        v
for every candidate:
  enforce capacity
  enforce all hard constraints against running and selected work
  apply risk recommendation policy
  select or defer the task with structured reasons
```

Task IDs use direct string comparison rather than host-locale collation. Therefore two machines with

### Functional readiness

A task cannot start until each declared dependency is `COMPLETED`:

```text
A = COMPLETED
B = RUNNING
C depends on A and B

Result: C is deferred with dependency-incomplete(B)
```

Only `COMPLETED` satisfies a dependency. `RUNNING`, `PENDING`, `READY`, `BLOCKED`, `VERIFYING`, and
`INTEGRATING` are incomplete.

### Producer readiness is separate from the functional DAG

A producer-controlled shared resource can produce a directional hard constraint:

```text
producer writes generated output
consumer reads generated output

producer ------ must complete before ------> consumer
```

The Scheduler treats that as an additional readiness requirement. It does not mutate
`TaskContract.dependencies`, because the two meanings remain distinct:

```text
functional dependency     Product/task-plan fact
producer constraint       Conflict/resource-policy fact
```

Direction comes from writer/read access, never alphabetical task IDs. For example:

```text
Z-producer -> A-consumer
```

still requires `Z-producer` first even though `A-consumer` sorts first.

The combined functional and producer ordering graph is validated for cycles. A producer-only cycle
such as `A -> B` and `B -> A` is rejected before scheduling; otherwise both tasks would wait forever.

### Priority and capacity

Candidates sort by higher numeric priority and then task ID:

```text
task      priority
API       10
Docs      10
Tests      5

selection order: API, Docs, Tests
```

Already-running tasks count toward `maxConcurrency`:

```text
maxConcurrency = 2
running = [A]
ready = [B, C]

Result: B may start, C is deferred with max-concurrency-reached
```

Capacity and priority are selection facts, not runtime failures. They produce `defer` decisions and

## Hard constraints and risk policy

### Hard always means hard

```text
A and B write the same symbol
HardTaskConflict.score = 0

A is RUNNING
B is READY

Result: B is deferred with hard-conflict
```

The score is explanation metadata. The Scheduler never reads it to decide whether to enforce the
constraint.

Hard constraints are compared against both:

```text
tasks already RUNNING
        +
tasks selected earlier in this same decision
```

This prevents a batch from selecting two conflicting tasks merely because neither was running at the
start of the call.

### Risk action examples

```text
A and B: guarded-parallel
Result: both may start; B records risk-policy-allowed

A and B: stagger
Result: first candidate may start; second records risk-policy-deferred
```

The first candidate follows priority and task-ID order. The Scheduler does not invent an ordering
edge for an undirected risk conflict.

## Runtime blocking and release

Static scheduling deferral is not blocking. A task is truly `BLOCKED` only after runtime evidence:

```text
RUNNING
  |
  +-- lease-blocked or runtime-conflict-discovered --> BLOCKED
```

The caller records the blocker with the task. A release removes only the matching blocker:

```text
api blockers = [lease-42, conflict-9]

lease-42 released
        |
        v
api remains BLOCKED because conflict-9 remains

conflict-9 resolved
        |
        v
api moves BLOCKED -> READY
```

This prevents an unrelated release event from waking work that is still unsafe to resume.

## Terminal prerequisite propagation

The Scheduler prevents a dependent task from silently waiting forever after a prerequisite reaches a
terminal state.

### Failure

```text
A FAILED
|
+--> B depends on A
       |
       +--> C depends on B

Result:
B -> CANCELLED, dependency-failed(A)
C -> CANCELLED, dependency-failed(A)
```

The reason identifies terminal root causes, not unrelated failures elsewhere in the snapshot. If two
independent roots fail, each dependant records only the root connected to it.

### Existing cancellation

An externally cancelled prerequisite has distinct semantics:

```text
A CANCELLED
|
+--> B depends on A

Result:
B -> CANCELLED, dependency-cancelled(A)
```

The Scheduler does not report this as `dependency-failed`, because a caller may cancel work for a
reason unrelated to an execution failure. The propagation rule applies to functional dependants and
directional producer consumers.

## Decisions and reasons

Every result is a per-task decision rather than a pair of loose ID lists and free-form strings.

Possible actions are:

| Action    | Meaning                                             |
| --------- | --------------------------------------------------- |
| `ready`   | Request legal `PENDING -> READY` transition         |
| `start`   | Request legal `READY -> RUNNING` transition         |
| `block`   | Request legal `RUNNING -> BLOCKED` transition       |
| `unblock` | Request legal `BLOCKED -> READY` transition         |
| `cancel`  | Request legal nonterminal `-> CANCELLED` transition |
| `defer`   | Explain why no state transition is requested now    |

Typical structured reasons are:

```text
dependencies-completed
dependency-incomplete
dependency-failed
dependency-cancelled
producer-must-complete
hard-conflict
risk-policy-allowed
risk-policy-deferred
max-concurrency-reached
runtime-blocked
runtime-blocker-released
task-state-not-runnable
selected-by-priority
```

The Scheduler returns decisions. An outer runtime applies state changes only after validating and
recording them. This avoids a pure scheduling calculation pretending that it has executed work.

## Waves are explanations, not barriers

`createInitialPlan` creates a static wave-shaped preview:

```text
wave 0 = [A, B]
wave 1 = [C]
```

It uses the same priority, conflict, and capacity policy as scheduling, but it does not own runtime
progress. Consider:

```text
C depends only on A
A and B appear in wave 0
A completes while B is still RUNNING
C does not conflict with B
capacity remains
```

The correct runtime result is:

```text
C may start immediately
```

Waiting for B simply because it shared an earlier preview wave would waste useful parallelism and
would violate the Scheduler architecture.

## Defensive validation

The Scheduler rejects instead of guessing when inputs are inconsistent:

```text
invalid functional task graph
non-positive or non-integer concurrency
conflict references an unknown task or the same task twice
producer-consumer endpoint not in its conflict pair
unknown producer or consumer task
cycle across functional and producer ordering
duplicate task state or runtime-block record
runtime block on a non-BLOCKED task
snapshot missing a task or containing an unknown task
event for an unknown task
runtime block event for a task not RUNNING
```

This prevents malformed persisted data, adapter bugs, or manually constructed test objects from
silently producing a misleading dispatch decision.

## Worked example

Assume these tasks:

```text
generate       writes generated API output, priority 10
api            reads generated API output, priority 8
ui             depends on generate, priority 5
documentation  independent, priority 1
```

The Conflict Engine adds a producer constraint:

```text
generate -> api
```

Initial preview with `maxConcurrency = 2`:

```text
wave 0: [generate, documentation]
wave 1: [api, ui]
```

After `generate` completes while `documentation` still runs:

```text
snapshot:
generate      COMPLETED
documentation RUNNING
api           READY
ui            PENDING

result:
api may start because its producer completed
ui may start only if capacity remains after priority selection
```

Neither task waits for `documentation` merely because the preview placed it in wave 0.

If `generate` instead fails:

```text
api -> CANCELLED, dependency-failed(generate)
ui  -> CANCELLED, dependency-failed(generate)
```

## What Milestone 7 does not implement

It does not:

- observe real process, filesystem, lease, or conflict events;
- execute agents or commands;
- acquire, heartbeat, release, or enforce Write Leases;
- authorize actual writes;
- compare predicted impact with observed changes;
- save or recover snapshots, events, or decisions;
- create isolated Git worktrees;
- rebase, merge, or integrate changes;
- add a usable `forge plan` CLI workflow.

These are deliberate later boundaries. Scheduler decisions are ready for a future Runtime Guard,
Persistence layer, and Workspace/Git runtime to consume, but those systems are not claimed to exist.

## Verification and current limits

The Scheduler tests cover stable selection, capacity with running work, functional and directional
readiness, zero-score hard enforcement, exclusive and ordered resources, risk policy, producer order
in both lexical directions, failure and cancellation propagation, exact blocker release, malformed
input rejection, deterministic repeated calls, and the no-wave-barrier counterexample.

The final repository quality gate has 125 passing tests. Overall coverage is 96.95% statements,
91.92% branches, 99.60% functions, and 96.88% lines. Scheduler-only coverage is 98.06% statements,
95.00% branches, 100% functions, and 98.00% lines. `pnpm check`, `pnpm build`, and
`git diff --check` pass.

Known limits remain intentionally narrow:

- the Scheduler recomputes from the supplied snapshot; it does not maintain a live queue;
- it does not estimate duration, fairness across runs, or optimal throughput;
- a caller is responsible for applying and persisting returned transition decisions;
- Runtime Guard behavior for `guarded-parallel` is not implemented yet;
- current performance validation is for deterministic core behavior, not very large scheduling
  graphs or long-lived runtime recovery.
