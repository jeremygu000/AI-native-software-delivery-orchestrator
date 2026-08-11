# Orchestration Runtime

## Purpose

`libs/orchestration-runtime` is the application layer that coordinates existing deterministic ports.
It keeps the CLI thin and prevents Scheduler, Workspace/Git, Write Guard, and persistence adapters
from calling one another directly.

The first implementation is deliberately local and serial. It accepts `maxConcurrency: 1` only and
uses provider-neutral `AgentRunner` and `TaskVerifier` ports. `FakeAgentRunner` and
`FakeTaskVerifier` prove the state machine without starting a model, shell command, or real coding
agent.

## Durable attempts

`TaskState.RUNNING` means Scheduler authorization for dispatch. It does not prove an external agent is
running. The runtime persists each Scheduler start decision with a separate revisioned
`AgentExecutionAttempt` in the same SQLite transaction:

```text
PREPARING -> STARTING -> RUNNING -> COMPLETED | FAILED
                         |
restart -----------------> UNKNOWN
```

`PREPARING` is durable evidence that workspace and lease preparation must be reconciled. `STARTING`
means the runner invocation was issued. A runner calls `onStarted` with optional provider-neutral
session evidence before the attempt becomes `RUNNING`. On restart, unresolved `STARTING` or `RUNNING`
attempts become `UNKNOWN`; the local fake backend does not guess whether an external process exists.
Attempts use revision CAS: stale evidence and same-revision conflicting evidence are rejected.

Recovery safely re-enqueues `PREPARING` attempts because no external agent invocation has occurred.
If a runner throws before `onStarted`, the attempt and task become `FAILED`; after `onStarted`, the
attempt becomes `UNKNOWN`. In both cases the run is marked `FAILED`, leases are released where possible,
and verification/integration do not run.

## Lease plans

Each binding has a `TaskLeasePlan`, not one resource. Resources acquire in canonical order: project,
file, symbol, then shared resource, with stable identity ordering within each type. A blocked acquire
releases earlier leases in reverse order and persists those releases before emitting `lease-blocked`.

Plans derived from predicted impact use project, file, shared-resource writes, and conservatively turn
symbol writes into file leases. Predicted symbol impact lacks the complete ancestor path needed to issue
a safe precise symbol lease. A future runtime-derived plan may use symbol leases only when repository
knowledge supplies full containment evidence.

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

Execution write leases protect an active agent's mutations. They are released after agent outcome
evidence and before verification. They are not integration reservations: Git rebase and fast-forward
remain the current integration ordering boundary. A future concurrent runtime needs an explicit
integration reservation if that ordering must be protected beyond Git conflict handling.

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
- a Pi adapter, unrestricted agent tools, or filesystem mutation tools;
- cross-process leases and ownership-generation write fencing;
- automatic rebase conflict repair or blocked integration resume;
- CLI `forge run` input and integration-checkout provisioning.

The attempt schema validates representative valid and invalid state combinations, but does not yet
exhaustively enumerate every optional-field combination. A future Pi backend must add backend-specific
attempt/session invariant tests rather than weakening the provider-neutral boundary.

The runtime is the future location for these workflows. They must not be added to `apps/cli` or hidden
inside the existing infrastructure adapters.

## Next backend

Pi is not integrated. A future `PiAgentRunner` must implement the existing provider-neutral
`AgentRunner` port, call `onStarted` with durable session evidence, and remain behind the runtime's
attempt, lease, workspace, persistence, verification, and Git lifecycle policies. Pi must not receive
unrestricted `bash`, `edit`, or `write` tools. Future mutations must pass through an
orchestrator-controlled `AgentToolRuntime` that owns workspace scoping, resource resolution, lease
enforcement, and durable observed-impact evidence.

## Verification

The runtime tests cover successful dependency execution, fake-agent failure, verification failure,
lease blocking, lease-release failure, blocked integration, eventless recovery, persisted SQLite replay,
unknown-attempt recovery, multi-resource rollback, and invalid task bindings. A vertical integration
test uses real SQLite persistence, InMemoryWriteGuard, GitWorkspaceManager, a temporary Git repository,
and a deterministic writing agent to prove a committed workspace edit reaches the integration branch.
