# ADR-028: Durable Execution Substrate Selection

## Status

**Decision Made: Temporal**

## Context

ADR-027 defined the migration to Runtime V2 with a durable execution substrate to be selected through a narrow spike comparing Temporal and Restate candidates. Both candidates must run the same two Forge scenarios while retaining SQLite, the current `AgentRunner`, Git/workspace implementation, and all authority semantics.

The spike acceptance criteria from ADR-027:

1. Scenario A: Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> exact integration
2. Scenario B: Repair BLOCKED -> durable wait/signal -> Forge CAS resume decision -> ExecuteRepair Activity

## Known Gaps

| Gap | Status |
| --- | --- |
| Mock evidence instead of real Forge + SQLite | **Resolved** — Both candidates now call real `ForgeScenarioService` backed by `SqlitePersistence` |
| Scenario B shared assert not verified | **Resolved** — Both candidates call `assertDurableExecutionSpikeOutcome` for both scenarios |
| Restate had no durable wait path | **Resolved** — Restate now uses `ctx.promise()` + `sendWake` handler |
| Temporal wrong final output binding | **Resolved** — Uses `repairResult.reviewSubjectRef` |
| dispatchCount from derived data | **Resolved** — Derived from real `recoverRepairResumeDispatches` persisted evidence |
| Restate executor restart evidence | **Waived** — see below |

### Waiver: Restate executor-restart direct proof

The Restate executor-restart test (P1-B) was **not directly reproduced** in the repository. `RestateTestEnvironment` bundles server and service — they cannot be independently stopped/restarted to prove executor replacement. This evidence gap is accepted for candidate selection rather than closed as proven. It lowers Restate's BLOCKED/restart/UNKNOWN and CI scores and does not affect Forge authority parity demonstrated by Scenario A/B happy-path and wrong-wake regression tests.

## M2.11: Real Authority Parity Closure — COMPLETE (with documented waiver)

1. **Fix Temporal final repair-output binding** — ✅ DONE (`03b3cb7`)
2. **Temporal A/B through real Forge seams + SQLite** — ✅ DONE (`03b3cb7`)
3. **Restate A/B through real Forge seams + SQLite** — ✅ DONE (`11d0ac3`)
4. **Real durable wait/wake + wake isolation** — ✅ DONE (`e0bfab9`)
   - Per-repair durable wake key prevents cross-repair poisoning
   - Wrong-wake regression test verifies isolation
5. **Scenario B must call assertDurableExecutionSpikeOutcome** — ✅ DONE
6. **dispatchCount from persisted dispatch evidence** — ✅ DONE
7. **Worker/executor restart resilience** — ✅ Temporal: direct test (`03b3cb7`); ⚠️ Restate: **waived** (testcontainers limitation, see waiver above)

## Scorecard

| Criterion                                          | Temporal | Restate | Weight  |
| -------------------------------------------------- | -------- | ------- | ------- |
| **Authority/correctness preservation**             | 9        | 8.5     | **30%** |
| **Legacy durable-runtime code actually removable** | 8        | 8.5     | **20%** |
| **BLOCKED/restart/UNKNOWN semantics**              | 9        | 8.5     | **15%** |
| **Framework intrusion / SDK leakage**              | 8        | 7.5     | **15%** |
| Operational complexity                             | 8        | 7       | 10%     |
| Observability/debugging                            | 8        | 7       | 5%      |
| CI/developer testing experience                    | 9        | 6       | 5%      |
| **Weighted Total**                                 | **8.50** | **8.00** |         |

### Scoring Rationale

**Authority/correctness preservation (30%)** — Both candidates run identical `DurableExecutionScenarioService` implementations, call the same `assertDurableExecutionSpikeOutcome`, and produce the same `DurableExecutionSpikeOutcome` from SQLite. The authority boundary is identical: framework-specific workflow/activity code, with all authority evidence in SQLite via the shared service. Temporal scores marginally higher because it has a direct worker restart test; Restate's durability is proven by happy-path + wrong-wake regression (direct restart deferred due to testcontainers bundling server+service).

**Legacy durable-runtime code actually removable (20%)** — Approximately 4,500-5,000 lines of manual blocking/wake/repair-resume machinery exist in production: `#enqueueEligibleBlockedRepairs`, `#driveRepairCycle`, `#recoverAndResumeRun`, the `repair_resume_dispatches` persistence table, and the `RepairExecutionCoordinator` state machine. Both frameworks replace these with native primitives, though `repair_resume_dispatches` may need to be retained or adapted depending on how the production Temporal topology preserves Forge CAS authority and audit evidence. Restate's virtual object model maps marginally better to per-repair isolation, giving it a slight edge.

**BLOCKED/restart/UNKNOWN semantics (15%)** — Both handle all three states correctly. Temporal's signal+condition with exact `repairAttemptId` match is explicit and proven by worker restart test. Restate's per-repair promise key (`repairWake:${id}`) is equally precise, proven by wrong-wake regression.

**Framework intrusion / SDK leakage (15%)** — Temporal requires 4 workflow-scope imports (`proxyActivities`, `setHandler`, `defineSignal`, `condition`). Restate requires 5+ imports including two distinct context types (`WorkflowContext`, `WorkflowSharedContext`). Both keep SDK types out of the activity interfaces. Temporal has a slightly cleaner boundary.

**Operational complexity (10%)** — Temporal requires a server but `TestWorkflowEnvironment` provides in-process testing with zero Docker dependency. Restate requires Docker via testcontainers; `RestateTestEnvironment` bundles server+service preventing independent restart, and uses a 120s startup timeout increasing CI cost and variability.

**Observability/debugging (5%)** — Temporal provides a mature UI, workflow event history with signal delivery visibility, and battle-tested debugging tools. Restate has admin UI and journal-based debugging but a less mature ecosystem.

**CI/developer testing experience (5%)** — Temporal tests complete in 10-15s with time-skipping, no Docker. Restate tests require Docker, 30-60s timeouts, and a 120s startup timeout. The Docker dependency introduces CI fragility and increased variability.

### Decision Rationale

**Temporal wins 8.50 vs 8.00.** The decisive advantages:

1. **CI/testing (5% weight, 3-point gap)**: No Docker dependency, time-skipping tests, in-process worker — significant developer experience and CI reliability win
2. **Operational maturity**: Temporal has a far larger ecosystem, battle-tested at scale, extensive documentation
3. **Framework intrusion**: Slightly cleaner SDK boundary with fewer imports

Restate's only advantage is legacy removable surface (8.5 vs 8), where its virtual object model maps marginally better to per-repair isolation — but this is outweighed by Temporal's testing and operational advantages.

## Decision

**Select Temporal as the durable execution substrate for Runtime V2.**

### What This Means

1. **M2.11 Real Authority Parity Closure is complete** (with one documented Restate evidence waiver). Both candidates demonstrated real Forge scenarios, real SQLite persistence, shared authority assertions, durable wait/wake, and per-repair wake isolation. Temporal also demonstrated worker restart resilience directly; Restate's restart capability was waived due to testcontainers limitations.

2. **Temporal is the substrate.** All subsequent Runtime V2 work will use `@temporalio/workflow`, `@temporalio/worker`, and `@temporalio/client` as the durable execution layer.

3. **Production migration path.** The ~4,500-5,000 lines of manual blocking/wake/repair-resume machinery in `orchestration-runtime` are candidates for replacement by Temporal workflows and activities. Key candidates:
   - `#enqueueEligibleBlockedRepairs` → Temporal signal + `condition()`
   - `#driveRepairCycle` → Workflow activity calls
   - `#recoverAndResumeRun` → Temporal workflow replay
   - `repair_resume_dispatches` persistence table → a candidate for removal or reduction during production topology design, provided the final Temporal design preserves Forge CAS authority, exact dispatch identity, crash semantics, and required audit evidence without treating Temporal history as Forge authority
   - `RepairExecutionCoordinator` state machine → Activity retry/timeout policies

4. **Next steps.** Design the production Temporal workflow topology (workflow-per-run vs workflow-per-repair, activity boundaries, signal channels) and implement the first production workflow.
