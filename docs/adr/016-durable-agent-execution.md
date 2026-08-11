# ADR-016: Durable agent dispatch and lease plans

## Status

Accepted

## Decision

Scheduler `READY -> RUNNING` authorizes dispatch; it is not proof that an external agent exists. Every
Scheduler start decision is persisted with an `AgentExecutionAttempt` in `PREPARING` state through one
`persistDispatch` transaction. Therefore a persisted running task always has durable evidence that
preparation must be reconciled after a crash.

An attempt has a stable ID, run/task/agent/workspace identity, revision CAS, optional provider-neutral
session reference, canonical lease-plan fingerprint, timestamps, and typed failure evidence. The runtime advances it:

```text
PREPARING -> STARTING -> RUNNING -> COMPLETED | FAILED
                         |
process restart ----------> UNKNOWN
```

`PREPARING` is safe to resume: recovery reconstructs its workspace and lease preparation without
invoking an external agent again, but only after its persisted agent, workspace, and lease-plan
fingerprint match the supplied recovery binding. `STARTING` means invocation was sent but no durable backend
establishment evidence exists. An `AgentRunner` calls `onStarted` when it can provide that evidence;
only then does the attempt become `RUNNING`. On restart, `STARTING` and `RUNNING` attempts become
`UNKNOWN` with `unknown-outcome` evidence. The first fake backend cannot inspect an external process,
so it fails safe rather than claiming exactly-once execution.

Task bindings use `TaskLeasePlan`, not one resource. Plans have a source and canonical resource order:
project, file, symbol, then shared resource; each rank uses stable resource identity. The runtime
acquires in that order. If any acquire blocks, it releases resources acquired by that attempt in reverse
order, persists those release records, then emits `lease-blocked`; partial ownership is not retained.

Predicted symbol writes currently become conservative file leases because `PredictedTaskImpact` contains
symbol-derived file IDs but not the complete ancestor chain needed for a safe symbol lease. A later
runtime-derived plan may use a precise symbol resource only when Repository Knowledge Graph evidence
supplies its full containment path. The conversion intentionally uses the supplied symbol-derived file
IDs rather than parsing symbol ID strings, whose file paths may contain delimiters.

Execution write leases protect agent mutation while an attempt runs. They are released after the agent
outcome is durable and before verification. This does not reserve integration ordering: Git rebase and
fast-forward integration remain the current ordering boundary. A future concurrent runtime may add an
explicit integration reservation rather than silently extending execution leases.

## Consequences

The runtime can distinguish dispatch authorization from durable external execution evidence and can
recover uncertain starts without guessing. It still has no backend inspection/resume capability, no
automatic retry for `UNKNOWN` attempts or externally owned lease blockers, no observed impact capture,
and no concurrent execution. Pi is not added in this stage; any Pi session must implement the existing
provider-neutral attempt/session contract and must use future orchestrator-controlled tools.

If an `AgentRunner` throws before `onStarted`, the runtime records a definite `FAILED` attempt and task
failure, releases leases, and marks the run failed. If it throws after `onStarted`, the runtime records
an `UNKNOWN` attempt, retains its ACTIVE leases because the external actor may still mutate the
workspace, marks the run failed, and never continues to verification or integration. A completed
result without `onStarted` is a durable protocol failure: the runtime records `FAILED`, releases
leases, and marks the run failed.
