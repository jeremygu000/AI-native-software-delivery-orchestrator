# ADR-015: Application orchestration runtime

## Status

Accepted

## Decision

Add `libs/orchestration-runtime` as the only application-layer component that composes Scheduler,
WorkspaceManager, WriteGuard, OrchestrationPersistence, task verification, and an agent runner. The
CLI remains a thin adapter and must not implement cross-component lifecycle choreography.

The runtime production package depends only on `domain` ports. Scheduler, SQLite persistence,
in-memory guard, and Workspace/Git adapters are integration-test fixtures, not runtime implementation
dependencies. This keeps provider selection in a future composition root rather than coupling the
application workflow to a local adapter.

The first runtime is intentionally local, single-process, and serial. It uses a provider-neutral
`AgentRunner` port and a deterministic `FakeAgentRunner` test implementation rather than a coding-agent
SDK. Durable external dispatch, attempt recovery, and multi-resource lease-plan policy are defined by
ADR-016. Pi remains a future backend implementation of this port and cannot own orchestration policy.

For every runtime event, the runtime persists the Scheduler input snapshot, event, Scheduler decision,
and non-deferred decision transitions atomically through `OrchestrationPersistence`. The runtime applies
the resulting transitions to its current snapshot. Observation stages that the current Scheduler treats
as pre-applied state (`VERIFYING`, `INTEGRATING`, `COMPLETED`, or `FAILED`) are reflected in the next
persisted input snapshot before their observation event is emitted. This preserves the existing replay
contract without making the Scheduler execute agents, Git commands, or verification.

Before an agent runs, the runtime creates and persists its workspace, acquires and persists a lease,
then invokes the agent. It releases and persists the lease before verification. Successful verification
enters integration; a successful integration enters completion. Failures emit task-failed evidence.
Lease contention emits lease-blocked evidence. Workspace records use their revision CAS protection on
every persisted update.

Recovery reconstructs the latest Scheduler snapshot from persisted decision input snapshots and
transitions, and returns current workspace and lease evidence. It does not resume an unknown in-flight
agent or automatically repair Git conflicts; a future durable agent protocol must prove that doing so
is safe.

## Consequences

The runtime centralizes partial-failure ordering without coupling Scheduler, Persistence, WriteGuard, or
WorkspaceManager to one another. The first implementation intentionally has no real agent SDK,
subprocess verification, concurrent dispatch, cross-process ownership, automatic Git conflict repair,
or integration-checkout provisioning. Those extend the runtime after its fake-agent state machine is
proven.
