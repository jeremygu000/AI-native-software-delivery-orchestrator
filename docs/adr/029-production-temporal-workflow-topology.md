# ADR-029: Production Temporal Workflow Topology

## Status

**Accepted — M3.1 Complete**

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
  ├── reevaluateRun activity  ← FIRST: Forge scheduler authority
  │     (returns: runnable task IDs + attempt IDs)
  │
  ├── for each authorized task:
  │     ├── executeBuilder activity
  │     │     (includes workspace creation, lease lifecycle, impact reconciliation)
  │     │
  │     ├── reevaluateRun activity  ← post-build: advance Forge task state
  │     │
  │     ├── evaluateBuilderOutput activity
  │     │     (verification + code review; returns recommendation: accept | repair)
  │     │
  │     ├── if recommendation === 'repair':
  │     │     └── repairLoop (inline, not child workflow):
  │     │           ├── admitRepair activity  ← Forge repair admission authority
  │     │           │     (budget check → persisted PREPARING RepairAttempt)
  │     │           │
  │     │           ├── executeRepair activity  ← dispatches on PREPARING repair
  │     │           │     (execution + lease release + verify + review)
  │     │           │
  │     │           ├── if BLOCKED:
  │     │           │     ├── Workflow: await signal (condition/signal wait)
  │     │           │     └── resumeBlockedRepair activity
  │     │           │           (lease validation + CAS → PREPARING)
  │     │           │     └── executeRepair(same repairAttemptId)
  │     │           │
  │     │           └── if recommendation === 'repair' (multi-repair):
  │     │                 └── admitRepair → executeRepair → ... (loop)
  │     │
  │     └── integrateAcceptedOutput activity
  │
  └── finalizeRunState activity
```

### Two Dispatch Authority Paths

The workflow MUST NOT self-authorize any dispatch. But not all dispatches go through the Scheduler. There are two distinct authority paths:

**Path 1: Task/builder dispatch → Scheduler authority**

```
reevaluateRun activity
  → Scheduler.reevaluate()
  → persisted PREPARING AgentExecutionAttempt
  → executeBuilder
```

**Path 2: Repair dispatch → Repair admission/resume authority**

```
admitRepair activity
  → TaskRepairCoordinator.prepare()
  → persisted PREPARING RepairAttempt
  → executeRepair

BLOCKED repair continuation:
signal wakes
  → resumeBlockedRepair activity
  → exact lease validation + CAS
  → same RepairAttempt → PREPARING
  → executeRepair(same repairAttemptId)
```

The Scheduler owns **task scheduling authority**. `TaskRepairCoordinator` owns **repair admission/resume authority**. The workflow consumes both but authorizes neither.

## Decision 2b: Workflow Cannot Self-Authorize Dispatch

The workflow MUST NOT:

- Decide which task to run next based on workflow state alone
- Create attempt IDs (Forge assigns these in `reevaluateRun` or `admitRepair`)
- Dispatch `executeBuilder` without a preceding `reevaluateRun` returning that task's attempt ID
- Dispatch `executeRepair` without a preceding `admitRepair` (or `resumeBlockedRepair`) returning that repair's attempt ID
- Use activity return values to determine task ordering

**Task/builder dispatch:** Every builder dispatch must be preceded by a `reevaluateRun` call that returns the authorized task and attempt IDs. This is the Scheduler's authority.

**Repair dispatch:** Every repair dispatch must be preceded by either:

- `admitRepair` — creates a new PREPARING repair attempt (repair admission authority), or
- `resumeBlockedRepair` — resumes a BLOCKED repair to PREPARING via CAS (repair resume authority)

This is the concrete implementation of Decision 1 (authority boundary). The workflow is a consumer of Forge authorization decisions; it does not produce them.

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

Activities map to **coarse Forge application service seams** — one activity per meaningful Forge operation. Activities do NOT split existing service responsibilities; they delegate to the existing service which owns its full transaction boundary.

| Activity                  | Maps To                                                                 | Forge Service                                          | Authority Owned                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `reevaluateRun`           | `Scheduler.reevaluate()` + `OrchestrationPersistence.persistDispatch()` | `Scheduler` + `Persistence`                            | **Scheduler authority**: reevaluates state machine, persists transitions + attempts atomically, returns runnable IDs                    |
| `executeBuilder`          | `ForgeBuilderExecutionService.execute()`                                | `AgentRunner` + `WorkspaceManager` + `WriteGuard`      | Workspace creation, lease acquisition, agent dispatch, impact reconciliation, lease release — all in one service boundary               |
| `evaluateBuilderOutput`   | `TaskOutputAdmissionCoordinator.reviewBuilder()`                        | `TaskOutputAdmissionCoordinator`                       | Verification evidence + code review collection only. MUST NOT inject `TaskRepairCoordinator` (repair admission is a separate activity)  |
| `admitRepair`             | `TaskRepairCoordinator.prepare()`                                       | `TaskRepairAdmissionStore`                             | Repair admission gate: budget enforcement, work item creation. Separate from evaluation to avoid double budget consumption              |
| `executeRepair`           | `RepairExecutionCoordinator.execute()`                                  | `AgentRunner` + `WriteGuard` + `TaskVerifier` + review | Full repair lifecycle: agent dispatch, lease management, impact reconciliation, verification, code review — all in one service boundary |
| `resumeBlockedRepair`     | `TaskRepairCoordinator.tryResume()` + lease/CAS reload                  | `TaskRepairResumeStore` + `WriteGuard`                 | After workflow signal wake: reload Forge state, validate released lease, CAS resume. Only CAS winner dispatches                         |
| `integrateAcceptedOutput` | `ForgeAcceptedOutputIntegrationService.integrate()`                     | `WorkspaceManager`                                     | Integration admission assertion, workspace commit, merge                                                                                |
| `finalizeRunState`        | `OrchestrationRuntime.#finalizeRunState`                                | `OrchestrationPersistence`                             | Run state transition based on final task states                                                                                         |

### What Activities Must NOT Be

- **CRUD wrappers.** `persistAttemptActivity`, `readLeaseActivity`, `updateRevisionActivity` are NOT activities. These belong inside Forge application service transactions.
- **Authority-bypassing.** An activity must never trust Temporal state as authorization. Every side-effecting activity must re-validate Forge state.
- **Stateful.** Activities are stateless functions. All state lives in SQLite (Forge) or Temporal workflow state (execution position).
- **Splitting an existing service boundary.** Do NOT create `acquireTaskLeases` + `executeBuilder` + `releaseTaskLeases` as separate activities when `ForgeBuilderExecutionService.execute()` already does all three atomically. Splitting creates double acquire/release risk and undermines Forge transaction boundaries.

### Workflow: Signal Wait (NOT an Activity)

`awaitBlockedRepair` is NOT an activity. It is a workflow-level signal wait:

```
Workflow (deterministic):
  if repair is BLOCKED:
    await signal(repairAttemptId: <id>)   ← durable wait, no activity
    // signal arrives, workflow continues

Activity:
  resumeBlockedRepair(repairAttemptId)    ← Forge reloads state, CAS
```

This matches the invariant: signal wakes → activity reloads Forge state → CAS → only winner dispatches.

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

| Forge Authority                 | Concrete Seam                                                                       | Why Temporal Cannot Replace It                               |
| ------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Scheduler reevaluation          | `reevaluateRun` activity (calls `Scheduler.reevaluate()`, persists atomically)      | Domain state machine, not execution timing                   |
| Write lease acquisition/release | Inside `executeBuilder` / `executeRepair` activities (via `WriteGuard`)             | Exclusive resource access requires CAS                       |
| Repair admission + budget       | `admitRepair` activity (via `TaskRepairCoordinator.prepare()`)                      | Domain constraint, not durability concern                    |
| Blocker lease validation        | `resumeBlockedRepair` activity (reloads from SQLite after signal wake)              | Must reload from SQLite after wake, not trust signal payload |
| CAS before dispatch             | `resumeBlockedRepair` activity (optimistic concurrency via `TaskRepairResumeStore`) | Compare-and-swap is the authorization gate                   |
| Verification evidence           | Inside `executeBuilder` / `executeRepair` / `evaluateBuilderOutput` activities      | Business evidence, not coordination data                     |
| Review evidence                 | Inside `evaluateBuilderOutput` / `executeRepair` activities                         | Business evidence, not coordination data                     |
| Integration admission           | `integrateAcceptedOutput` activity (workspace fingerprint matching)                 | Workspace fingerprint matching, not timing                   |
| Agent attempt identity          | Inside `reevaluateRun` activity (Forge assigns attempt IDs)                         | Forge assigns attempt IDs, not Temporal                      |
| Tenant/ownership semantics      | Inside all Forge activities                                                         | Domain concept, not execution concept                        |

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
- Con: Sender needs safe retry / idempotent wake semantics for RPC failure cases (Temporal signals are durable once recorded by the server; the failure window is client-side RPC)

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

| Activity                  | Retry Policy      | Rationale                                   |
| ------------------------- | ----------------- | ------------------------------------------- |
| `reevaluateRun`           | Retryable (max 3) | Read-only reevaluation + idempotent persist |
| `evaluateBuilderOutput`   | Retryable (max 2) | Read-only evaluation, idempotent            |
| `admitRepair`             | Retryable (max 2) | Budget check is idempotent                  |
| `integrateAcceptedOutput` | Retryable (max 2) | Admission check is idempotent               |
| `finalizeRunState`        | Retryable (max 3) | State transition is idempotent              |

### Agent Execution (NOT Blindly Retryable)

| Activity         | Retry Policy                         | Rationale                                 |
| ---------------- | ------------------------------------ | ----------------------------------------- |
| `executeBuilder` | No automatic retry after `onStarted` | Agent may have started mutating workspace |
| `executeRepair`  | No automatic retry after `onStarted` | Agent may have started mutating workspace |

After `onStarted`, if the activity fails, the attempt is marked `UNKNOWN` and the Forge recovery path handles reconciliation. Temporal must NOT automatically retry agent execution because:

1. The agent may have partially mutated the workspace.
2. A retry would start a new agent session with a stale workspace state.
3. The `UNKNOWN → fail-closed` invariant from ADR-027 must be preserved.

### BLOCKED Repair (Workflow Wait, Not Activity)

| Component               | Retry Policy           | Rationale                                                  |
| ----------------------- | ---------------------- | ---------------------------------------------------------- |
| Signal wait in workflow | No retry; durable wait | This is a workflow-level `await signal()`, not an activity |
| `resumeBlockedRepair`   | Retryable (max 2)      | CAS-gated; re-validates on each attempt                    |

## Decision 8: Cancellation Semantics

### Cancel Flow (Intent → Reconcile → Final State)

Cancellation is a **two-phase** process. Forge never persists final `CANCELLED` until in-flight work is reconciled and authority state permits.

```
forge cancel --run-id <id>
  │
  ├── Phase 1: Record user intent
  │     Forge persists CANCEL_REQUESTED to SQLite
  │     (NOT final CANCELLED — work may still be in-flight)
  │
  ├── Phase 2: Request Temporal cancellation
  │     Temporal cancelWorkflow(workflowId)
  │     → workflow stops scheduling new activities (no new reevaluateRun)
  │     → in-flight activities receive cancellation token
  │
  ├── Phase 3: Reconcile in-flight work
  │     ├── executeBuilder (before onStarted): safe to cancel, no side effects
  │     ├── executeBuilder (after onStarted): activity cooperates or times out;
  │     │     Forge marks attempt UNKNOWN, releases leases
  │     ├── executeRepair: same as executeBuilder
  │     ├── evaluateBuilderOutput: safe to cancel (read-only)
  │     ├── resumeBlockedRepair: safe to cancel (CAS-gated)
  │     └── integrateAcceptedOutput: safe to cancel (admission-gated)
  │
  └── Phase 4: Forge persists final CANCELLED
        Only after all in-flight work is reconciled:
        - All leases released
        - All UNKNOWN attempts resolved
        - Authority state permits transition to CANCELLED
```

### Why Not Persist CANCELLED Immediately

If Forge persists `CANCELLED` before stopping the workflow:

1. Builder may already be `onStarted` and mutating workspace.
2. The business state says "done/cancelled" while mutation is still running.
3. Lease holders see a `CANCELLED` run but can't determine if workspace is clean.

With `CANCEL_REQUESTED`:

1. `CANCEL_REQUESTED` is the **user intent**, not the business state.
2. The workflow sees the cancellation and stops scheduling.
3. In-flight activities complete or time out, releasing leases.
4. Only then does Forge persist final `CANCELLED`.

### CANCEL_REQUESTED State

If the current domain does not have a `CANCEL_REQUESTED` state, this ADR requires it to be added. It is:

- A **request intent**, not a final business state.
- Triggered by `forge cancel`.
- Consumed by the workflow (stops scheduling) and by `reevaluateRun` (returns no runnable tasks).
- Transitions to `CANCELLED` only after reconciliation completes.

### Five Distinct States (Must Not Conflate)

| State              | Meaning                                          | Triggered By                              |
| ------------------ | ------------------------------------------------ | ----------------------------------------- |
| `CANCEL_REQUESTED` | User intent to stop; work may still be in-flight | `forge cancel` command                    |
| `CANCELLED`        | Graceful stop complete; all work reconciled      | `reevaluateRun` after all work reconciled |
| `FAILED`           | Execution error or authority violation           | Activity failure, assertion error         |
| `COMPLETED`        | All tasks integrated successfully                | Normal completion                         |
| `UNKNOWN`          | Lost contact with in-flight agent                | Process crash after `onStarted`           |

### Cancellation ≠ Termination

- `cancel`: Two-phase intent → reconcile → Forge decides final business state.
- `terminate`: Immediate kill. Use only for unrecoverable situations. Forge marks run as `FAILED`.

## Decision 9: Worker / Process Lifecycle

### Two Composition Roots

```
forge CLI (composition root 1):
  1. Create Temporal client (connect to Temporal server)
  2. start/query/cancel workflows via Temporal Client API
  3. Does NOT start or host a Worker
  4. Does NOT wire Forge services (no persistence, no AgentRunner)

Temporal Worker process (composition root 2):
  1. Wire Forge services (persistence, workspace, agent, verifier, scheduler)
  2. Create activities (inject Forge service dependencies)
  3. Register workflow + activities with Worker
  4. Start worker (worker.run())
  5. Wait for shutdown signal
  6. Graceful shutdown (worker.shutdown())
```

**CLI cannot be responsible for Worker startup.** The CLI is a command-line tool that starts and exits. The Worker is a long-running process that polls Temporal for tasks. These have different lifecycles, different signal handling, and different process models.

### `libs/temporal-runtime/` provides:

- Worker factory/bootstrap API
- Activity type registrations (injectable dependencies)
- Workflow registrations
- Config (Temporal server connection, task queue)

### Independent process executable calls:

- `libs/temporal-runtime` worker factory
- Wires Forge services
- Starts the Worker

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

| Existing Component                                    | Lines  | Production Temporal Decision                          | Rationale                                                                                                                  |
| ----------------------------------------------------- | ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `OrchestrationRuntime.#drain`                         | ~60    | **REPLACE** with Temporal workflow loop               | Temporal workflow IS the drain loop                                                                                        |
| `OrchestrationRuntime.#startRun`                      | ~25    | **REPLACE** with workflow start                       | CLI starts workflow instead of in-process                                                                                  |
| `OrchestrationRuntime.#recoverAndResumeRun`           | ~70    | **REPLACE** with Temporal replay                      | Workflow replay IS recovery                                                                                                |
| `OrchestrationRuntime.#enqueueEligibleBlockedRepairs` | ~50    | **REPLACE** with signal + workflow check              | Workflow checks BLOCKED repairs after lease release                                                                        |
| `OrchestrationRuntime.#driveRepairCycle`              | ~70    | **REPLACE** with repair activity sequence             | Activities compose existing services                                                                                       |
| `OrchestrationRuntime.#runTask`                       | ~280   | **REPLACE** with task activity sequence               | Activities compose existing services                                                                                       |
| `OrchestrationRuntime.#finalizeRunState`              | ~10    | **KEEP as activity**                                  | Simple state transition, still Forge-owned                                                                                 |
| `Scheduler.reevaluate()` + `persistDispatch()`        | —      | **KEEP as `reevaluateRun` activity**                  | Forge scheduler authority: reevaluation + persist remain Forge-owned, exposed as activity                                  |
| `ForgeBuilderExecutionService.execute()`              | 260    | **KEEP as activity implementation**                   | Activity delegates to this service                                                                                         |
| `RepairExecutionCoordinator.execute()`                | 292    | **KEEP as activity implementation**                   | Activity delegates to this service                                                                                         |
| `TaskRepairCoordinator`                               | 195    | **KEEP**                                              | Repair state machine remains Forge-owned                                                                                   |
| `ForgeAcceptedOutputIntegrationService`               | 73     | **KEEP as activity implementation**                   | Activity delegates to this service                                                                                         |
| `ForgeScenarioAServiceRunner`                         | 147    | **ABSORB** into workflow structure                    | Workflow replaces this runner's sequencing                                                                                 |
| `TaskOutputAdmissionCoordinator`                      | 156    | **KEEP**                                              | Integration admission remains Forge-owned                                                                                  |
| `LocalRuntimeStarter`                                 | 327    | **REPLACE** with Temporal worker bootstrap            | Worker startup replaces runtime wiring                                                                                     |
| `DrizzleSqliteOrchestrationPersistence`               | ~1,600 | **KEEP** (minus `repair_resume_dispatches` candidate) | Forge persistence remains; repair_resume_dispatches is candidate for removal                                               |
| `repair_resume_dispatches` table                      | —      | **CANDIDATE FOR REMOVAL**                             | Temporal workflow state may replace this, conditional on topology design preserving Forge CAS authority and audit evidence |
| `OrchestrationPersistence` interface                  | 279    | **KEEP** (minus repair resume dispatch methods)       | Core persistence contract remains                                                                                          |
| `AgentRunner` interface                               | 32     | **KEEP**                                              | Provider-neutral agent boundary, per ADR-027                                                                               |
| `PiAgentRunner`                                       | 158    | **KEEP**                                              | Production agent implementation, unchanged                                                                                 |
| `WorkspaceManager`                                    | —      | **KEEP**                                              | Git/workspace operations, unchanged                                                                                        |
| `WriteGuard`                                          | —      | **KEEP**                                              | Lease acquisition/release, unchanged                                                                                       |
| `Scheduler`                                           | —      | **KEEP**                                              | Domain state machine, unchanged                                                                                            |

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
  │   ├── client.ts              # Temporal client creation (CLI use only)
  │   ├── worker-factory.ts      # Worker factory with injectable Forge services
  │   ├── config.ts              # Temporal server connection, task queue config
  │   ├── workflows/
  │   │   └── forge-run.ts       # ForgeRunWorkflow definition
  │   ├── activities/
  │   │   ├── reevaluate-run.ts
  │   │   ├── execute-builder.ts
  │   │   ├── evaluate-builder-output.ts
  │   │   ├── admit-repair.ts
  │   │   ├── execute-repair.ts
  │   │   ├── resume-blocked-repair.ts
  │   │   ├── integrate-accepted-output.ts
  │   │   └── finalize-run-state.ts
  │   └── codecs/                # Payload codecs if needed
  └── package.json
```

### CLI Client (composition root 1)

```
forge CLI:
  → Temporal client creation (libs/temporal-runtime/client.ts)
  → start/query/cancel workflows
  → Does NOT wire Forge services or start Worker
```

### Worker Process (composition root 2)

```
forge-worker (separate executable):
  → libs/temporal-runtime/worker-factory.ts
  → Wire Forge services (persistence, workspace, agent, verifier, scheduler)
  → Activity composition (inject Forge services into activities)
  → Start worker (worker.run())
  → Graceful shutdown on SIGTERM/SIGINT
```

The CLI does NOT contain workflow logic or Worker startup. Workflow logic lives in `libs/temporal-runtime/`. The Worker is an independent process.

## Acceptance Criteria

M3.1 is complete when this ADR defines:

1. ✅ Run/workflow topology (Decision 2)
2. ✅ Workflow cannot self-authorize dispatch — two authority paths (Decision 2b)
3. ✅ Workflow ↔ Activity boundaries (Decision 3)
4. ✅ Forge authority boundaries with concrete seams (Decision 1, Decision 4)
5. ✅ Signal/wake semantics (Decision 5)
6. ✅ Payload/history policy (Decision 6)
7. ✅ Retry + UNKNOWN semantics (Decision 7)
8. ✅ Cancellation semantics — two-phase intent → reconcile → final state (Decision 8)
9. ✅ Worker/process lifecycle — two composition roots (Decision 9)
10. ✅ Legacy component keep/replace/delete-candidate map (Decision 10)
11. ✅ Production bootstrap boundary — CLI client vs Worker process (Production Bootstrap Boundary)

## Next Step

M3.2 — Production Temporal Runtime Bootstrap: create `libs/temporal-runtime/` with worker startup, workflow registration, activity composition, and config. No business logic migration yet.
