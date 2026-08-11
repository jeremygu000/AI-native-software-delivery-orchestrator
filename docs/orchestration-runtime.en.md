# Orchestration Runtime

## Purpose

`libs/orchestration-runtime` is the application layer that coordinates existing deterministic ports.
It keeps the CLI thin and prevents Scheduler, Workspace/Git, Write Guard, and persistence adapters
from calling one another directly.

The first implementation is deliberately local and serial. It accepts `maxConcurrency: 1` only and
uses provider-neutral `AgentRunner` and `TaskVerifier` ports. `FakeAgentRunner` and
`FakeTaskVerifier` prove the state machine without starting a model, shell command, or real coding
agent.

## Runtime flow

```text
create persisted run
        |
        v
run-started Scheduler event
        |
        v
Scheduler start decision
        |
        v
create + persist workspace revision 1
        |
        v
acquire + persist write lease
        |
        +-- blocked --> persist lease-blocked event and Scheduler blocker
        |
        v
run fake agent
        |
        v
release + persist lease
        |
        v
agent-completed -> VERIFYING
        |
        v
verify
        |
        +-- failed --> task-failed -> Scheduler cancellation propagation
        |
        v
verification-completed -> INTEGRATING
        |
        v
integrate + persist workspace revision
        |
        +-- blocked --> retain INTEGRATING and INTEGRATION_BLOCKED evidence
        |
        v
workspace-integrated -> COMPLETED
```

For every event, the runtime persists the Scheduler input snapshot, event, decision, and all
non-deferred decision transitions in one persistence operation. The runtime then applies that decision
to its in-memory snapshot. Agent completion, verification completion, integration completion, and task
failure are observations whose required post-state is reflected in the snapshot before their Scheduler
event is persisted. This follows the Scheduler replay contract without making the Scheduler perform
side effects.

## Failure and recovery

The runtime persists the agent outcome before attempting lease release: success records
`agent-completed` with `VERIFYING`, while agent failure records `task-failed` with `FAILED`. If release
then fails, it persists `lease-release-failed`, marks the run `FAILED`, and stops before verification or
integration. Recovery therefore retains the real agent outcome and the still-active lease instead of
silently discarding evidence. A lease acquisition block is persisted as a runtime blocker. Agent or
verification failure emits `task-failed`, allowing the Scheduler to cancel dependent tasks
deterministically.

The first serial runtime has no retry entry point for a task blocked by a lease owned outside the run.
It returns with that task `BLOCKED` and its persisted lease blocker. A future runtime event loop must
observe that owner's release and invoke a deliberate retry policy; it must not infer an unsafe retry.

`recoverRun` reconstructs the latest runtime snapshot from persisted Scheduler events and decisions,
including lease blocker projection, and returns current workspace and lease records. It intentionally
does not restart an unknown in-flight agent, repair a Git conflict, reclaim a stale lease, or create an
integration checkout. Those require future durable agent identity, ownership fencing, and checkout
provisioning policies.

## What is not implemented

- real agent SDKs, prompts, streaming, or cancellation;
- subprocess command verification;
- observed filesystem impact and scope enforcement;
- concurrent dispatch or `maxConcurrency > 1`;
- cross-process leases and ownership-generation write fencing;
- automatic rebase conflict repair or blocked integration resume;
- CLI `forge run` input and integration-checkout provisioning.

The runtime is the future location for these workflows. They must not be added to `apps/cli` or hidden
inside the existing infrastructure adapters.

## Verification

The runtime tests cover successful dependency execution, fake-agent failure, verification failure,
lease blocking, lease-release failure, blocked integration, eventless recovery, persisted SQLite replay,
and invalid task bindings. The SQLite integration test uses the real persistence adapter together with
the in-memory guard and a provider-neutral workspace port.
