# ADR-027: Runtime V2 Temporal Migration

## Status

Accepted for `migration/runtime-v2-temporal`. The archived legacy checkpoint is
`stage22r-legacy-runtime-2486fe0` at commit `2486fe0`.

## Context

The Stage 22R legacy runtime provides a verified self-managed execution loop: builder execution,
reconciliation, verification, semantic review, bounded repair, exact admission, integration, and blocked
repair continuation. Its local SQLite durability and process-local recovery are a stable archive point, but
not the desired long-term execution substrate.

Runtime V2 replaces commodity execution infrastructure while preserving Forge's deterministic authority.
Temporal supplies durable execution, waiting, worker operation, cancellation, timers, and workflow history.
PostgreSQL supplies Forge authority and evidence truth. A provider-neutral `AgentRunner` remains the only
agent capability boundary. OpenTelemetry supplies correlated operational visibility.

Repository and team memory may improve reasoning, but cannot become execution authority or a correctness
dependency. It is deferred until Runtime V2 authority parity is complete.

## Decision

### Ownership boundaries

Forge owns repository and impact analysis, conflicts, scheduler decisions, lease and write authority,
workspace and Git authority, plan and approval authority, verification/review/repair evidence, runtime
conflicts, and exact integration admission.

Temporal owns workflow and child-workflow execution, durable waiting and signals, worker dispatch,
cancellation, timers, activity retry infrastructure, and workflow history. Temporal Task Queues are not
Forge Scheduler authority.

PostgreSQL is the Forge authority/evidence truth for run authority, attempts, leases, verification evidence,
review evidence, repair attempts, runtime conflicts, and integration admission. Temporal and Forge must use
separate logical databases or schemas, roles, credentials, migration chains, and backup policies. A shared
physical PostgreSQL instance is permitted only when this logical isolation remains enforceable.

> Temporal history is execution history, not Forge business evidence.

### Workflow and Activity boundary

Workflow code is deterministic and has no direct external side effects. Git, filesystem, Docker, agent/LLM
execution, PostgreSQL, repository analysis, workspace mutation, verification, and integration run through
Activities or application services invoked by Activities.

```text
Temporal Workflow
  -> Activity adapter
  -> Forge application service
  -> Forge domain and ports
  -> PostgreSQL / Git / AgentRunner / Docker
```

Workflow history contains compact references only: Forge IDs, fingerprints, small status/result
discriminators, and Temporal identifiers. It must not contain repository source, diffs, raw prompts, model
responses, tool transcripts, secrets, credentials, tokens, large review subjects, or full plan artifacts.

### Dispatch authority and retries

Temporal scheduling, Signals, and Activity invocation do not grant permission to perform unsafe external side

```text
Temporal Signal wakes TaskWorkflow
  -> Forge PostgreSQL CAS BLOCKED -> PREPARING
  -> only CAS winner dispatches the agent
```

Activity retry is explicit per side-effect class. Pure reads and idempotent preparation may retry.
Verification and semantic review retry only with explicit idempotency/evidence identity. Agent mutation uses
`maximumAttempts = 1`; Git integration also uses one attempt unless exact idempotency is proven. Memory
capture may retry and is non-blocking.

After durable `onStarted`, lost contact with an agent becomes `UNKNOWN` and fails closed. Temporal retry never

### Agent boundary, identity, and telemetry

Forge depends only on its provider-neutral `AgentRunner` port. No Pi, Temporal, or provider SDK types may
appear in Forge domain contracts. The concrete Runtime V2 backend remains undecided until candidate packages
and the existing adapter are validated for API stability, license, maintenance, provider support, tool
interception, context/session behavior, telemetry hooks, and sandbox compatibility.

Temporal identities derive from Forge IDs:

```text
RunWorkflow:  forge-run:<runId>
TaskWorkflow: forge-run:<runId>:task:<taskId>
```

OpenTelemetry starts with the Temporal skeleton. Worker and Activity spans propagate Forge run, task, attempt,
repair attempt, workflow, activity, workspace, lease, plan, verification, and review-subject identifiers or
fingerprints.

### Migration, read model, UI, and memory

Legacy/Temporal runtime selection is allowed only in the migration branch and isolated differential parity
harness. It must be removed at cutover. Differential tests use isolated fixtures, workspaces, and authority

Runtime V2 produces a Temporal-neutral Forge read model before product UI implementation. It uses Forge
concepts such as `RunStatus`, `TaskStatus`, `BlockingReason`, `EvidenceRef`, and timeline entries. Temporal
data is optional diagnostics/deep-link information, not the core product model. UI visualizes execution,
reasoning, and authority; it does not make scheduler, lease, review, repair, or admission decisions.

After Runtime V2 cutover, Forge adds a provider-neutral `RepositoryMemoryPort`. A TencentDB adapter may be an
initial implementation. Memory is advisory, scoped, provenance-bearing, non-blocking, and derived after
authority evidence is finalized. It may influence planner/reviewer reasoning but never grants authority.

## Migration sequence

1. Archive and tag the verified Stage 22R legacy checkpoint.
2. Define this Runtime V2 boundary.
3. Add PostgreSQL Forge evidence-store contract parity with SQLite.
4. Add Temporal and OpenTelemetry skeletons with stable workflow identities.
5. Validate and select an `AgentRunner` backend.
6. Move builder TaskWorkflow execution to Temporal Activities.
7. Bind Forge Scheduler decisions to Temporal task execution.
8. Move review and bounded repair execution.
9. Move durable blocked-repair waiting while retaining Forge CAS and `UNKNOWN` semantics.
10. Move exact integration admission.
11. Add run inspect, status, cancellation, and operational read APIs.
12. Complete isolated differential parity, remove the migration-only legacy switch, and delete legacy runtime.
13. Add memory port and adapter only after Runtime V2 cutover.

## Consequences

- Existing deterministic domain and evidence rules are preserved rather than delegated to infrastructure.
- PostgreSQL parity and Temporal workflow foundations are separate quality-gated milestones.
- UI data binding waits for the Forge read-model/API contract; only information architecture and presentation
  contracts are safe to prototype earlier.
