# ADR-029: Production Temporal Workflow Topology

## Status

**Draft — M3.1**

## Context

ADR-028 selected Temporal as the durable execution substrate for Runtime V2. This ADR defines the production workflow topology: what Temporal owns, what Forge retains, how workflows and activities are structured, and how the existing runtime components map to the new design.

The current production runtime (`OrchestrationRuntime`, ~1,600 lines) is a monolithic in-process pump (`#drain` loop) that interleaves task dispatch, repair dispatch, lease acquisition/release, agent execution, verification, review, and integration. All state is persisted to SQLite via `OrchestrationPersistence`. Process restart recovery marks in-flight attempts as `UNKNOWN` and reconstructs state by replaying persisted dispatches.

Runtime V2 replaces this with Temporal workflows and activities while preserving all Forge authority semantics.

## Decision 1: Authority Boundary

This is the first principle of the production topology.

```
Temporal owns execution durability:
  when / retry / wait / resume / continuation / cancellation propagation

Forge owns authorization:
  whether an action is allowed to happen
```

Concrete implications:

- **Temporal signal wakes → Forge validates.** A signal (or durable promise resolution) does NOT grant authority. After wake, the activity must reload Forge state from SQLite, validate the exact blocker lease, perform CAS, and only the CAS winner may dispatch.

- **Temporal retry does NOT re-authorize.** If an activity fails due to infrastructure, Temporal may retry the activity. But the activity must re-check Forge state on each attempt. A retry that skips Forge validation would be a correctness bug.

- **Temporal history is NOT Forge evidence.** Workflow history stores compact coordination references (IDs, enums, fingerprints). All authority evidence (leases, verification, review, integration admission) lives in SQLite via Forge persistence.

- **Temporal replay does NOT grant new authority.** Replay reconstructs the workflow's execution position. It does not re-authorize any side effect. Activities must be idempotent and re-validate on each invocation.

## Decision 2: Workflow Topology

### One Run-Level Workflow

```
ForgeRunWorkflow(runId)
  │
  ├── for each task (sequentially or bounded-concurrent):
  │     ├── acquireTaskLeases activity
  │     ├── executeBuilder activity
  │     ├── releaseTaskLeases activity
  │     ├── evaluateBuilderOutput activity
  │     │
  │     ├── if recommendation === 'repair':
  │     │     └── repairLoop (inline, not child workflow):
  │     │           ├── admitRepair activity
  │     │           ├── executeRepair activity
  │     │           ├── releaseRepairLeases activity
  │     │           ├── verifyRepairOutput activity
  │     │           ├── reviewRepair activity
  │     │           │
  │     │           ├── if BLOCKED:
  │     │           │     └── awaitBlockedRepair signal/promise
  │     │           │
  │     │           └── if recommendation === 'repair' (multi-repair):
  │     │                 └── admitRepair → executeRepair → ... (loop)
  │     │
  │     └── integrateAcceptedOutput activity
  │
  └── finalize run state
```

### Why One Workflow Per Run (Not Per Task or Per Repair)

- The current system processes tasks within a run sequentially or with bounded concurrency (`maxConcurrency`). A single run-level workflow preserves this.
- Repair loops are inline (not child workflows) because they share lease context and workspace with their parent task. Spawning child workflows would require cross-workflow lease coordination.
- Child workflows are a future optimization if history size or parallelism demands it, not a starting topology.

### Why Not拆分 Into More Granular Workflows

- The spike demonstrated that a single workflow with activities is sufficient for both Scenario A and B.
- Over-decomposing increases cross-workflow signal complexity and makes authority boundaries harder to reason about.
- The existing `ForgeScenarioAServiceRunner` already composes the four services (builder, evaluator, repair, integration) in sequence — this maps directly to a single workflow.

## Decision 3: Activity Boundaries

Activities map to **existing Forge application service seams** — the durable continuation boundaries already identified in the current codebase. Each activity is one meaningful Forge application operation that owns its own transaction, CAS, and validation.

### Activity Inventory

| Activity | Maps To | Forge Service | Authority Owned |
|----------|---------|---------------|-----------------|
| `acquireTaskLeases` | `OrchestrationRuntime.#acquireLeasePlan` | `WriteGuard` | Lease acquisition, conflict detection |
| `executeBuilder` | `ForgeBuilderExecutionService.execute()` | `AgentRunner` + `WorkspaceManager` | Agent dispatch, workspace mutation, impact reconciliation, lease release |
| `evaluateBuilderOutput` | `ForgeBuilderOutputEvaluationService.evaluate()` | `TaskOutputAdmissionCoordinator` | Verification evidence, review subject, code review collection |
| `admitRepair` | `TaskRepairCoordinator.prepare()` | `TaskRepairAdmissionStore` | Budget enforcement, repair admission, work item creation |
| `executeRepair` | `RepairExecutionCoordinator.execute()` | `TaskRepairRunner` + `AgentRunner` | Repair agent dispatch, verification, review, lease management |
| `awaitBlockedRepair` | Signal/promise wait | Forge (via activity re-validation) | Wake → reload → CAS → only winner dispatches |
| `integrateAcceptedOutput` | `ForgeAcceptedOutputIntegrationService.integrate()` | `WorkspaceManager` | Integration admission, workspace commit, merge |
| `finalizeRunState` | `OrchestrationRuntime.#finalizeRunState` | `OrchestrationPersistence` | Run state transition |

### What Activities Must NOT Be

- **CRUD wrappers.** `persistAttemptActivity`, `readLeaseActivity`, `updateRevisionActivity` are NOT activities. These belong inside Forge application service transactions.
- **Authority-bypassing.** An activity must never trust Temporal state as authorization. Every side-effecting activity must re-validate Forge state.
- **Stateful.** Activities are stateless functions. All state lives in SQLite (Forge) or Temporal workflow state (execution position).

### Activity Implementation Pattern

Each activity implementation:

1. Receives compact IDs from the workflow (runId, taskId, attemptId, etc.)
2. Loads full context from Forge persistence (SQLite)
3. Performs Forge authority checks (lease validation, CAS, budget)
4. Executes the side effect (agent run, workspace mutation, verification, etc.)
5. Persists results to Forge persistence
6. Returns compact result to workflow (IDs, enums, status — never large objects)

## Decision 4: Forge Authority Boundaries

The following MUST remain Forge-owned and MUST NOT be replaced by Temporal primitives:

| Forge Authority | Why Temporal Cannot Replace It |
|-----------------|-------------------------------|
| Scheduler reevaluation | Domain state machine, not execution timing |
| Write lease acquisition/release | Exclusive resource access requires CAS |
| Repair admission + budget | Domain constraint, not durability concern |
| Blocker lease validation | Must reload from SQLite after wake, not trust signal payload |
| CAS before dispatch | Compare-and-swap is the authorization gate |
| Verification evidence | Business evidence, not coordination data |
| Review evidence | Business evidence, not coordination data |
| Integration admission | Workspace fingerprint matching, not timing |
| Agent attempt identity | Forge assigns attempt IDs, not Temporal |
| Tenant/ownership semantics | Domain concept, not execution concept |

The invariant that must never break:

```
signal wakes
  → activity reloads Forge state from SQLite
  → Forge checks exact blocker lease
  → Forge performs CAS
  → only CAS winner may dispatch
```

## Decision 5: Signal / Wake Semantics

### Scenario B: BLOCKED Repair Wake

Two implementation options, to be evaluated during M3.2 bootstrap:

**Option A: Temporal Signal (current spike approach)**
- Workflow defines a signal channel (`repairWake`)
- External process (lease release callback) sends signal with `{ repairAttemptId }`
- Workflow validates `repairAttemptId` matches the blocked repair before dispatching activity
- Pro: Direct, explicit, proven in spike
- Con: Signal is fire-and-forget; no delivery guarantee without retry

**Option B: Durable Promise / Selector (Restate-style, adapted)**
- Workflow awaits a Temporal query or timer-based poll
- Less natural for Temporal; signals are the idiomatic pattern
- Not recommended unless signals prove insufficient

**Recommendation:** Start with Option A (signals). The spike proved this works. If delivery guarantees become a concern, add an activity that polls Forge for released leases on a timer.

### Wake Isolation

Each signal must be scoped to a specific `repairAttemptId`. The workflow MUST NOT process a wake for `repairAttemptId: R2` if it is waiting on `repairAttemptId: R1`. This was proven by the wrong-wake regression test in the spike.

### Cross-Entity Wake (Lease Release → Repair Wake)

In the current system, `#enqueueEligibleBlockedRepairs` is called whenever any lease is released — including leases released by task execution or by other repair execution. In the Temporal topology:

- The workflow knows which repairs are BLOCKED (from workflow state).
- When a lease is released (activity returns), the workflow can check if any BLOCKED repair's blocker matches the released lease.
- This check happens inside the workflow (deterministic), not in a signal handler.

## Decision 6: Payload / History Policy

### What Goes Into Workflow History

Workflow input, signals, and activity results MUST contain only compact coordination references:

```
Allowed:
  runId, taskId, attemptId, repairAttemptId
  revision, fingerprint (short hash)
  small enums: 'accept' | 'repair' | 'reject'
  small enums: 'completed' | 'blocked' | 'unknown'
  workspaceId (reference, not content)
  leaseId (reference, not full lease)
  timestamp (ISO string)
  maxRepairs (number)
```

### What MUST NOT Go Into Workflow History

```
Prohibited:
  prompt / system instructions
  diff / patch content
  source files / repository content
  tool transcripts / agent output
  model responses / LLM completions
  full ReviewEvidence object
  full VerificationEvidence object
  secrets / API keys / tokens
  large domain objects (>1KB)
  workspace file content
  Git commit content
```

### Why This Matters

- Workflow history is replicated across Temporal nodes and retained for the workflow's lifetime.
- Large payloads cause history bloat, increased memory usage, and slower replay.
- Forge business evidence must remain in SQLite where Forge controls retention, access, and audit.

## Decision 7: Retry Semantics

### Infrastructure Failures (Retryable)

Activities that fail due to infrastructure issues (network timeout, Temporal server hiccup, Docker start failure) may be retried by Temporal. The activity must re-validate Forge state on each attempt.

| Activity | Retry Policy | Rationale |
|----------|-------------|-----------|
| `acquireTaskLeases` | Retryable (max 3) | Lease acquisition is idempotent via CAS |
| `evaluateBuilderOutput` | Retryable (max 2) | Read-only evaluation, idempotent |
| `admitRepair` | Retryable (max 2) | Budget check is idempotent |
| `integrateAcceptedOutput` | Retryable (max 2) | Admission check is idempotent |
| `finalizeRunState` | Retryable (max 3) | State transition is idempotent |

### Agent Execution (NOT Blindly Retryable)

| Activity | Retry Policy | Rationale |
|----------|-------------|-----------|
| `executeBuilder` | No automatic retry after `onStarted` | Agent may have started mutating workspace |
| `executeRepair` | No automatic retry after `onStarted` | Agent may have started mutating workspace |

After `onStarted`, if the activity fails, the attempt is marked `UNKNOWN` and the Forge recovery path handles reconciliation. Temporal must NOT automatically retry agent execution because:

1. The agent may have partially mutated the workspace.
2. A retry would start a new agent session with a stale workspace state.
3. The `UNKNOWN → fail-closed` invariant from ADR-027 must be preserved.

### BLOCKED Repair (Not Retryable)

| Activity | Retry Policy | Rationale |
|----------|-------------|-----------|
| `awaitBlockedRepair` | No retry; waits for signal | This is a durable wait, not a failure |

## Decision 8: Cancellation Semantics

### Cancel Flow

```
forge cancel --run-id <id>
  │
  ├── Forge persists CANCELLED state to SQLite
  │
  └── Temporal requestCancellation(workflowId)
        │
        ├── Workflow stops scheduling new activities
        │
        ├── In-flight activities receive cancellation:
        │     ├── acquireTaskLeases → safe to cancel (no side effects yet)
        │     ├── executeBuilder → check onStarted:
        │     │     ├── before onStarted → safe to cancel
        │     │     └── after onStarted → activity cooperates or times out
        │     ├── evaluateBuilderOutput → safe to cancel (read-only)
        │     ├── executeRepair → same as executeBuilder
        │     └── integrateAcceptedOutput → safe to cancel (admission-gated)
        │
        └── Workflow completes with cancellation status
```

### Four Distinct States (Must Not Conflate)

| State | Meaning | Triggered By |
|-------|---------|-------------|
| `CANCELLED` | User-initiated, graceful stop | `forge cancel` command |
| `FAILED` | Execution error or authority violation | Activity failure, assertion error |
| `COMPLETED` | All tasks integrated successfully | Normal completion |
| `UNKNOWN` | Lost contact with in-flight agent | Process crash after `onStarted` |

### Cancellation ≠ Termination

- `cancel`: Workflow finishes in-progress activities, cleans up, records outcome. Forge decides business state.
- `terminate`: Immediate kill. Use only for unrecoverable situations. Forge marks run as `FAILED`.

### Forge Decides Business State

Temporal cancellation does NOT automatically mean Forge task state is `CANCELLED`. The activity must:
1. Receive cancellation signal
2. Persist appropriate business state to Forge
3. Release any held leases
4. Return cancellation result

## Decision 9: Worker / Process Lifecycle

### Worker Startup

```
CLI / composition root:
  1. Create Temporal client (connect to Temporal server)
  2. Wire Forge services (persistence, workspace, agent, verifier, etc.)
  3. Create activities (inject Forge service dependencies)
  4. Register workflow + activities with Worker
  5. Start worker (worker.run())
  6. Wait for shutdown signal
  7. Graceful shutdown (worker.shutdown())
```

### Worker Shutdown

- On `SIGTERM`/`SIGINT`: Temporal worker stops polling for new tasks, finishes in-flight activities, then exits.
- Forge services must handle graceful shutdown (close SQLite connections, flush writes).
- No Forge state should be left inconsistent after graceful shutdown.

### Worker Restart / Crash

- Temporal automatically re-queues tasks from crashed workers.
- The new worker picks up where the old one left off (via workflow replay).
- Activities must be idempotent or re-validate on each invocation.

### Deployment Model

- Workers run as separate processes (not embedded in CLI).
- Multiple workers can poll the same task queue for horizontal scaling.
- Each worker hosts the same workflow and activity implementations.

## Decision 10: Legacy Component Mapping

| Existing Component | Lines | Production Temporal Decision | Rationale |
|-------------------|-------|------------------------------|-----------|
| `OrchestrationRuntime.#drain` | ~60 | **REPLACE** with Temporal workflow loop | Temporal workflow IS the drain loop |
| `OrchestrationRuntime.#startRun` | ~25 | **REPLACE** with workflow start | CLI starts workflow instead of in-process |
| `OrchestrationRuntime.#recoverAndResumeRun` | ~70 | **REPLACE** with Temporal replay | Workflow replay IS recovery |
| `OrchestrationRuntime.#enqueueEligibleBlockedRepairs` | ~50 | **REPLACE** with signal + workflow check | Workflow checks BLOCKED repairs after lease release |
| `OrchestrationRuntime.#driveRepairCycle` | ~70 | **REPLACE** with repair activity sequence | Activities compose existing services |
| `OrchestrationRuntime.#runTask` | ~280 | **REPLACE** with task activity sequence | Activities compose existing services |
| `OrchestrationRuntime.#finalizeRunState` | ~10 | **KEEP as activity** | Simple state transition, still Forge-owned |
| `ForgeBuilderExecutionService.execute()` | 260 | **KEEP as activity implementation** | Activity delegates to this service |
| `RepairExecutionCoordinator.execute()` | 292 | **KEEP as activity implementation** | Activity delegates to this service |
| `TaskRepairCoordinator` | 195 | **KEEP** | Repair state machine remains Forge-owned |
| `ForgeAcceptedOutputIntegrationService` | 73 | **KEEP as activity implementation** | Activity delegates to this service |
| `ForgeScenarioAServiceRunner` | 147 | **ABSORB** into workflow structure | Workflow replaces this runner's sequencing |
| `TaskOutputAdmissionCoordinator` | 156 | **KEEP** | Integration admission remains Forge-owned |
| `LocalRuntimeStarter` | 327 | **REPLACE** with Temporal worker bootstrap | Worker startup replaces runtime wiring |
| `DrizzleSqliteOrchestrationPersistence` | ~1,600 | **KEEP** (minus `repair_resume_dispatches` candidate) | Forge persistence remains; repair_resume_dispatches is candidate for removal |
| `repair_resume_dispatches` table | — | **CANDIDATE FOR REMOVAL** | Temporal workflow state may replace this, conditional on topology design preserving Forge CAS authority and audit evidence |
| `OrchestrationPersistence` interface | 279 | **KEEP** (minus repair resume dispatch methods) | Core persistence contract remains |
| `AgentRunner` interface | 32 | **KEEP** | Provider-neutral agent boundary, per ADR-027 |
| `PiAgentRunner` | 158 | **KEEP** | Production agent implementation, unchanged |
| `WorkspaceManager` | — | **KEEP** | Git/workspace operations, unchanged |
| `WriteGuard` | — | **KEEP** | Lease acquisition/release, unchanged |
| `Scheduler` | — | **KEEP** | Domain state machine, unchanged |

### What Gets Deleted at Cutover

After Temporal is the default runtime:

- `OrchestrationRuntime` class (replaced by Temporal workflow + activities)
- `LocalRuntimeStarter` (replaced by Temporal worker bootstrap)
- `ForgeScenarioAServiceRunner` (absorbed into workflow structure)
- `DurableExecutionSpikeDriver` interface and implementations (spike evidence only)
- `shared-harness.ts` files in spike packages (spike evidence only)
- `repair_resume_dispatches` persistence methods (if topology confirms removal is safe)

### What MUST NOT Be Deleted Because of Temporal

- `Scheduler` (domain state machine, not execution timing)
- `WriteGuard` / lease semantics (CAS authority, not durability)
- `TaskRepairCoordinator` (repair admission/budget, not execution)
- `TaskOutputAdmissionCoordinator` (integration authority, not timing)
- `AgentRunner` / `PiAgentRunner` (agent boundary, per ADR-027)
- All Forge persistence tables for evidence (verification, review, attempts, leases, etc.)

## Production Bootstrap Boundary

The production bootstrap (`libs/temporal-runtime/`) is a new package, separate from the spike packages:

```
libs/temporal-runtime/
  ├── src/
  │   ├── client.ts              # Temporal client creation
  │   ├── worker.ts              # Worker bootstrap, workflow/activity registration
  │   ├── config.ts              # Temporal server connection, task queue config
  │   ├── workflows/
  │   │   └── forge-run.ts       # ForgeRunWorkflow definition
  │   ├── activities/
  │   │   ├── acquire-task-leases.ts
  │   │   ├── execute-builder.ts
  │   │   ├── evaluate-builder-output.ts
  │   │   ├── admit-repair.ts
  │   │   ├── execute-repair.ts
  │   │   ├── await-blocked-repair.ts
  │   │   ├── integrate-accepted-output.ts
  │   │   └── finalize-run-state.ts
  │   └── codecs/                # Payload codecs if needed
  └── package.json
```

The CLI composition root wires:

```
Temporal client creation
  → Worker startup
  → Forge service wiring (persistence, workspace, agent, verifier)
  → Activity composition (inject Forge services into activities)
  → Graceful shutdown
```

The CLI does NOT contain workflow logic. Workflow logic lives in `libs/temporal-runtime/`.

## Acceptance Criteria

M3.1 is complete when this ADR defines:

1. ✅ Run/workflow topology (Decision 2)
2. ✅ Workflow ↔ Activity boundaries (Decision 3)
3. ✅ Forge authority boundaries (Decision 1, Decision 4)
4. ✅ Signal/wake semantics (Decision 5)
5. ✅ Payload/history policy (Decision 6)
6. ✅ Retry + UNKNOWN semantics (Decision 7)
7. ✅ Cancellation semantics (Decision 8)
8. ✅ Worker/process lifecycle (Decision 9)
9. ✅ Legacy component keep/replace/delete-candidate map (Decision 10)
10. ✅ Production bootstrap boundary (Production Bootstrap Boundary section)

## Next Step

M3.2 — Production Temporal Runtime Bootstrap: create `libs/temporal-runtime/` with worker startup, workflow registration, activity composition, and config. No business logic migration yet.
