# ADR-027: Runtime V2 Durable Execution Migration

## Status

Accepted for `migration/runtime-v2-temporal`. The archived legacy checkpoint is
`stage22r-legacy-runtime-2486fe0` at commit `2486fe0`.

## Context

The Stage 22R legacy runtime provides a verified self-managed execution loop: builder execution,
reconciliation, verification, semantic review, bounded repair, exact admission, integration, and blocked
repair continuation. Its local SQLite durability and process-local recovery are a stable archive point, but
not the desired long-term execution substrate.

Runtime V2 replaces commodity execution infrastructure while preserving Forge's deterministic authority. The
current proven Forge authority store remains SQLite during this migration. The durable execution substrate
will be selected through a narrow Temporal-versus-Restate spike. PostgreSQL is a production scaling candidate
for Forge evidence rather than a Runtime V2 prerequisite. A provider-neutral `AgentRunner` remains the only
agent capability boundary. OpenTelemetry supplies correlated operational visibility.

Repository and team memory may improve reasoning, but cannot become execution authority or a correctness
dependency. It is deferred until Runtime V2 authority parity is complete.

## Decision

### Ownership boundaries

Forge owns repository and impact analysis, conflicts, scheduler decisions, lease and write authority,
workspace and Git authority, plan and approval authority, verification/review/repair evidence, runtime
conflicts, and exact integration admission.

The selected durable execution substrate owns workflow execution, durable waiting, worker dispatch,
cancellation, timers, retry infrastructure, and execution history. Its queues are not Forge Scheduler
authority.

Forge owns an independent authority/evidence store for run authority, attempts, leases, verification evidence,
review evidence, repair attempts, runtime conflicts, and integration admission. SQLite is the current proven
implementation. PostgreSQL becomes the preferred production candidate only when shared writers, remote
workers, high availability, or SQLite write contention justify it.

> Durable-execution history is execution history, not Forge business evidence.

### Workflow and Activity boundary

Workflow code is deterministic and has no direct external side effects. Git, filesystem, Docker, agent/LLM
execution, authority-store access, repository analysis, workspace mutation, verification, and integration run
through Activities or application services invoked by Activities.

```text
Durable Workflow
  -> Activity adapter
  -> Forge application service
  -> Forge domain and ports
  -> SQLite or PostgreSQL / Git / AgentRunner / Docker
```

Workflow history contains compact references only: Forge IDs, fingerprints, small status/result

### Dispatch authority and retries

Durable-execution scheduling, signals, and activity invocation do not grant permission to perform unsafe
external side effects. Forge authority-store compare-and-swap remains the authority before every externally
side-effecting dispatch whose duplicate execution is unsafe.

```text
Durable signal wakes TaskWorkflow
  -> Forge authority-store CAS BLOCKED -> PREPARING
  -> only CAS winner dispatches the agent
```

Activity retry is explicit per side-effect class. Pure reads and idempotent preparation may retry.
Verification and semantic review retry only with explicit idempotency/evidence identity. Agent mutation uses
`maximumAttempts = 1`; Git integration also uses one attempt unless exact idempotency is proven. Memory
capture may retry and is non-blocking.

After durable `onStarted`, lost contact with an agent becomes `UNKNOWN` and fails closed. Infrastructure retry
never authorizes repeating that agent mutation.

### Agent boundary, identity, and telemetry

Forge depends only on its provider-neutral `AgentRunner` port. No Pi, durable-execution, or provider SDK types
may appear in Forge domain contracts. The concrete Runtime V2 backend remains undecided until candidate
packages and the existing adapter are validated for API stability, license, maintenance, provider support,
tool interception, context/session behavior, telemetry hooks, and sandbox compatibility.

Durable execution identities derive from Forge IDs:

```text
RunWorkflow:  forge-run:<runId>
TaskWorkflow: forge-run:<runId>:task:<taskId>
```

OpenTelemetry starts with the durable-execution skeleton. Worker and Activity spans propagate Forge run, task,
identifiers or fingerprints.

### Migration, read model, UI, and memory

Legacy/durable-runtime selection is allowed only in the migration branch and isolated differential parity
harness. It must be removed at cutover. Differential tests use isolated fixtures, workspaces, and authority

Runtime V2 produces a durable-execution-neutral Forge read model before product UI implementation. It uses
Forge concepts such as `RunStatus`, `TaskStatus`, `BlockingReason`, `EvidenceRef`, and timeline entries.
Execution-substrate data is optional diagnostics/deep-link information, not the core product model. UI
visualizes execution, reasoning, and authority; it does not make scheduler, lease, review, repair, or
admission decisions.

After Runtime V2 cutover, Forge adds a provider-neutral `RepositoryMemoryPort`. A TencentDB adapter may be an
initial implementation. Memory is advisory, scoped, provenance-bearing, non-blocking, and derived after

## Migration sequence

1. Archive and tag the verified Stage 22R legacy checkpoint.
2. Define this Runtime V2 boundary.
3. Correct and retain the PostgreSQL candidate foundation without beginning schema, migration, or full parity
   work.
4. Run narrow Temporal and Restate spikes against Build -> Review -> Repair -> Integrate and blocked-repair
   restart/resume scenarios, while preserving SQLite, the current agent adapter, and all Forge authority rules.
5. Select the durable execution substrate using code removed, authority intrusion, recovery semantics,
   observability, worker complexity, and operational complexity.
6. Add the selected durable execution skeleton and OpenTelemetry with stable workflow identities.
7. Validate and select an `AgentRunner` backend only if the current adapter is proven limiting.
8. Move builder execution and Forge Scheduler-to-runtime dispatch while retaining SQLite authority evidence.
9. Move review, bounded repair, durable blocked wait, exact integration, and Stage 22R parity.
10. Add run inspect, status, cancellation, and operational read APIs.
11. Complete isolated differential parity, remove the migration-only legacy switch, and delete legacy runtime.
12. Decide on a PostgreSQL evidence-store migration only when scaling requirements justify it.
13. Add memory port and adapter only after Runtime V2 cutover.

## Consequences

- Existing deterministic domain and evidence rules are preserved rather than delegated to infrastructure.
- Durable-execution selection and PostgreSQL evidence migration are independent quality-gated milestones.
- UI data binding waits for the Forge read-model/API contract; only information architecture and presentation
  contracts are safe to prototype earlier.
