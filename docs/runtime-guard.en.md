---
title: Runtime Guard and Write Leases - Training Guide
tags:
  - coding-orchestrator
  - runtime-guard
  - write-lease
  - concurrency
status: implemented
---

# Runtime Guard and Write Leases - Training Guide

This guide explains the Milestone 8 Runtime Guard: the component that grants or blocks an exclusive
write lease before work may modify a repository resource. It is written for readers without prior
experience of leases, locks, or concurrent agent execution.

For task prediction and pre-execution conflict analysis, read [Task Impact and Conflict
Analysis](./task-impact-analysis.en.md). For dispatch decisions, read
[Scheduler Dispatch](./scheduler-dispatch.en.md).

## The short version

The Runtime Guard answers a different question from the Scheduler:

```text
Scheduler:    Which task may start now, based on plans and known conflicts?
Runtime Guard: May this concrete owner hold exclusive write authority now?
```

The Scheduler works from predicted task impact. Predictions can be incomplete or stale. The Runtime
Guard is the later, concrete ownership check.

```text
Task Contract -> Predicted Impact -> Conflict Engine -> Scheduler decision
                                                       |
                                                       v
                                            Runtime Guard acquire request
                                                       |
                                              granted or blocked lease
```

Milestone 8 implements `InMemoryWriteGuard` in
`libs/runtime-guard/src/lib/in-memory-write-guard.ts`. It is live behavior for one Node.js process,
not a persistent distributed lock service.

## Why a scheduler is not enough

A Scheduler can decide that two tasks are safe enough to begin together based on declared scope and
known repository facts. At runtime, an agent may retry, request a broader resource, or encounter a
scope that was not predicted.

For example:

```text
Task A predicts a write to Service.search
Task B predicts a write to Service.get

Scheduler result: guarded parallel may be acceptable
```

Later, Task A needs to rewrite the complete `service.ts` file. A symbol prediction is not permission
to rewrite that file. It must request a file lease:

```text
Task A requests lease(file: service.ts)
Task B holds lease(symbol: Service.get in service.ts)

Result: blocked
```

The future outer runtime must stop or escalate the unexpected write. This milestone supplies the
lease decision, but it does not intercept filesystem APIs or observe actual writes yet.

## Writable resource hierarchy

Every lease resource is self-contained. It includes enough ancestry to compare two leases without
loading `RepositoryGraph` again.

```text
Project
└── File
    └── Symbol
        └── Child symbol

Shared resource (a separate named namespace)
```

The types are:

```text
project:         { projectId }
file:            { projectId, fileId }
symbol:          { projectId, fileId, symbolId, ancestorSymbolIds }
shared-resource: { resourceId }
```

The deterministic conflict rules are:

| First lease               | Second lease                    | Result   | Why                          |
| ------------------------- | ------------------------------- | -------- | ---------------------------- |
| Project                   | Any file/symbol in that project | conflict | project contains descendants |
| File                      | Any symbol in that file         | conflict | file contains symbols        |
| Parent symbol             | Descendant symbol               | conflict | ancestor contains descendant |
| Same symbol               | Same symbol                     | conflict | same identity                |
| Sibling symbols           | Sibling symbols                 | allowed  | neither contains the other   |
| Different project files   | Different project files         | allowed  | independent repository scope |
| Equal shared resource IDs | Equal shared resource IDs       | conflict | same coordination namespace  |
| Repository resource       | Shared resource                 | allowed  | separate namespaces          |

`ancestorSymbolIds` is treated as a set for lease identity. It is sorted when stored, so equivalent
ancestor collections in a different caller order remain an idempotent retry rather than looking like
a new conflicting request.

## Lease lifecycle

```text
acquire
  |
  +--> ACTIVE -- heartbeat --> ACTIVE (version increases)
  |      |
  |      +-- external evidence --> STALE
  |      |
  |      +-- release -----------> RELEASED
  |
  +--> blocked (no lease created)
```

Only `ACTIVE` leases block a new request. `STALE` and `RELEASED` leases remain as lifecycle records
inside the in-memory guard but do not prevent a replacement from acquiring the same resource.

### Acquire

A request identifies the owner and exact resource:

```json
{
  "runId": "run-42",
  "agentId": "agent-a",
  "taskId": "update-search",
  "resource": {
    "type": "symbol",
    "projectId": "catalog",
    "fileId": "catalog:service.ts",
    "symbolId": "SearchService.query",
    "ancestorSymbolIds": ["SearchService"]
  },
  "mode": "exclusive"
}
```

The guard validates non-empty identity fields and valid symbol ancestry, then examines every active
lease in one serialized critical section.

```text
same active owner and exact resource?
        |
        +--> yes: return that existing lease unchanged
        |
        +--> no: does any active lease conflict?
                     |
                     +--> yes: blocked + stable conflicting lease IDs
                     |
                     +--> no: create ACTIVE lease at version 1
```

The exact-owner retry rule requires all four parts to match:

```text
runId + agentId + taskId + resource identity
```

Changing the resource is not an idempotent retry. For example, an owner with a project lease that
requests a contained file lease receives `blocked`; the broader lease is not silently converted into
a narrower lease.

### Why acquire is serialized

Without an atomic boundary, two agents could both do this:

```text
1. inspect active leases: none conflict
2. create a lease
```

If both inspections happen before either write, both agents receive authority incorrectly.

`InMemoryWriteGuard` chains every public operation through one in-process promise queue:

```text
acquire A ----+
heartbeat B --+--> one linear operation order
release C ----+
mark stale D -+
```

Twenty simultaneous conflicting acquire requests are tested. Exactly one receives a granted lease;
on the same lease.

This is not cross-process atomicity. A second Node.js process would have a different in-memory map.
Milestone 9 must provide persistent atomic storage before the project claims multi-process safety.

## Versions and heartbeat

Every active lease starts with version 1:

```text
ACTIVE, version 1
        |
heartbeat(expectedVersion = 1)
        |
        v
ACTIVE, version 2
```

The expected version prevents an obsolete worker from updating a lease after another operation has
already changed it.

| Condition                                               | Heartbeat result                       |
| ------------------------------------------------------- | -------------------------------------- |
| Active lease and matching version                       | `active` with updated lease            |
| Active lease but old version                            | `version-conflict` with actual version |
| Missing, released, or stale lease                       | `not-found`                            |
| Zero, negative, non-integer, `NaN`, or infinite version | input error                            |

Heartbeat time is supplied by an injectable clock. Production uses a normal current-time clock;

## Evidence-based stale recovery

There is deliberately no rule such as:

```text
no heartbeat for 60 seconds -> automatically STALE
```

A timer alone cannot distinguish a slow agent from a crashed one. Marking a lease stale requires an
outer runtime to collect recovery evidence, for example:

```text
agent process exited
workspace has no unintegrated write
last heartbeat is old
recovery policy permits reclamation
```

Then it sends:

```json
{
  "leaseId": "lease-1",
  "expectedVersion": 2,
  "evidence": "Agent exited and workspace is unchanged"
}
```

The guard validates the version and non-empty evidence, then:

```text
ACTIVE version 2
        |
        v
STALE version 3
staleDetectedAt recorded
staleEvidence recorded
```

The stale lease no longer blocks replacement acquisition. Repeating stale marking on the same lease
returns `not-found`, so recovery retries cannot change a historical stale record.

## Release and cleanup

Release is intentionally idempotent:

```text
ACTIVE lease -> release -> released
RELEASED/STALE/missing lease -> release -> not-found
```

The first successful release increments version, records `releasedAt`, and changes state to
`RELEASED`. An outer runtime can retry cleanup after a crash without treating the already-finished
cleanup as an error.

## Defensive input validation

The guard rejects malformed requests rather than creating ambiguous lease identity:

```text
empty run, agent, task, project, file, symbol, shared-resource, or ancestor ID
duplicate ancestor symbol IDs
ancestor list contains the symbol itself
invalid expected version
duplicate generated lease ID
```

Lease IDs and time sources are injectable. This keeps tests deterministic and lets an outer adapter
choose its own production ID generation later without embedding provider or persistence concerns in
the domain model.

## Relationship to Scheduler events

The guard does not import the Scheduler or mutate task state. A future outer runtime connects them:

```text
guard acquire blocked
        |
        v
emit Scheduler lease-blocked event
        |
        v
task RUNNING -> BLOCKED

guard release or stale recovery
        |
        v
emit Scheduler lease-released or lease-stale event
        |
        v
matching blocked tasks reenter Scheduler selection
```

The Scheduler's release events broadcast by blocker identity. Several tasks waiting for the same
released lease may all reenter `READY` and compete under normal scheduling constraints. The Guard
does not choose a winner; its next serialized acquire operation decides concrete ownership.

## What Milestone 8 does not do

It does not:

- persist leases, heartbeats, stale evidence, or release records;
- coordinate leases between processes, hosts, or orchestration runs after restart;
- share one guard instance across unrelated repository/workspace namespaces with colliding resource IDs;
- observe a real filesystem write or intercept an agent write call;
- resolve a filesystem path or symbol name through `RepositoryGraph`;
- infer stale evidence from a timeout;
- automatically emit Scheduler events;
- create worktrees, rebase, merge, or invoke Git;
- run agents or verification commands;
- integrate `forge plan` with a live runtime.

The exact in-memory lifecycle behavior is real and tested. The storage, observation, and integration
boundaries are deliberately deferred rather than silently claimed.

## Verification and current limits

The Runtime Guard package has 23 passing tests with 100% statements, functions, and lines, plus
96.15% branches. The repository quality gate has 154 passing tests with 97.07% statements, 92.04%
branches, 99.64% functions, and 97.00% lines. `pnpm check`, `pnpm build`, and `git diff --check`
pass.

The immediate next architecture concern is Milestone 9 persistence. Before storing Scheduler events
for replay, the project must finalize whether each event is a state observation whose snapshot already
contains the resulting state, or runtime evidence that the Scheduler applies. The in-memory guard is
intentionally not a substitute for that persistent replay contract.
