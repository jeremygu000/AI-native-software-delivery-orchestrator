# ADR-028: Durable Execution Substrate Selection

## Status

**Proposed - Evidence parity INCOMPLETE. Real Authority Parity Closure (M2.11) required before scoring.**

## Context

ADR-027 defined the migration to Runtime V2 with a durable execution substrate to be selected through a narrow spike comparing Temporal and Restate candidates. Both candidates must run the same two Forge scenarios while retaining SQLite, the current `AgentRunner`, Git/workspace implementation, and all authority semantics.

The spike acceptance criteria from ADR-027:

1. Scenario A: Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> exact integration
2. Scenario B: Repair BLOCKED -> durable wait/signal -> Forge CAS resume decision -> ExecuteRepair Activity

## Known Gaps (P1 Findings)

### 1. Neither candidate uses real Forge services + SQLite

**Temporal**: Uses `createMockActivities` + `InMemoryEvidenceStore` (simulating SQLite)
**Restate**: Constructs `DurableExecutionSpikeOutcome` directly inside workflow

Current proof demonstrates:

> "Temporal/Restate durable control flow can drive mock activities that produce mock evidence"

Does NOT yet prove:

> "Temporal/Restate maintains real Forge authority semantics with real SQLite evidence"

**Required**: Both candidates must call real Forge seams and persist evidence to SQLite.

### 2. Scenario B shared assert NOT verified for either candidate

**Temporal**: Test explicitly falls back to manual checks:

> "assertDurableExecutionSpikeOutcome requires specific blockedResume structure... manual checks above suffice."

**Restate**: Same - manual checks only.

ADR-028 scorecard incorrectly claims:

```
Scenario B proof
Temporal: ✓ 3 tests
Restate: ✓ 2 tests
```

**Actual status**:

```
Scenario A shared assertion: NOT VERIFIED (mock evidence)
Scenario B shared assertion: NOT VERIFIED (manual checks only)
```

**Required**: Both Scenario A and B must call `assertDurableExecutionSpikeOutcome`.

### 3. Restate has no actual `ctx.signal()` wait path

ADR claims:

> "Uses ctx.signal() for durable wait"

**Actual**: Current `restate-spike-workflow.ts` has no `ctx.signal()` call. Scenario B workflow directly constructs successful outcome without any durable wait.

### 4. Temporal Scenario A has wrong final output binding (FIXED)

**Previous bug**: Workflow discarded `executeRepair()` result and integrated using pre-repair builder review subject.

**Now fixed**: Workflow correctly uses `repairResult.reviewSubjectRef` for integration.

### 5. dispatchCount derived from completed attempts, not real dispatch events

Current:

```ts
dispatchCount = completed builder + completed repairs
```

Does not prove:

> "Exactly one resumed external dispatch after CAS resume"

**Required**: Derive from persisted dispatch/attempt lifecycle evidence.

## OutcomeCollector Architecture (conceptually correct, implementation incomplete)

The pattern itself is sound:

1. Activities write evidence DURING execution
2. OutcomeCollector reads from evidence store AFTER completion
3. Result is OBSERVED, not pre-constructed

But current implementation uses mock evidence, not real Forge SQLite persistence.

## M2.11: Real Authority Parity Closure

Required before ADR-028 scoring:

1. **Fix Temporal final repair-output binding** - ✅ DONE
2. **Temporal A/B through real Forge seams + SQLite** - PENDING (harness exists, activities still stub)
3. **Restate A/B through real Forge seams + SQLite** - PENDING (workflow self-constructs evidence)
4. **Real durable wait/wake + executor restart** - PENDING
5. **Scenario B must call assertDurableExecutionSpikeOutcome** - PENDING
6. **dispatchCount from persisted dispatch evidence** - PENDING (recoverDispatches reconstructs scheduler-start, not repair-resume)

## Scorecard (PRELIMINARY - DO NOT USE FOR DECISION)

| Criterion                                          | Temporal | Restate | Weight  |
| -------------------------------------------------- | -------- | ------- | ------- |
| **Authority/correctness preservation**             | TBD      | TBD     | **30%** |
| **Legacy durable-runtime code actually removable** | TBD      | TBD     | **20%** |
| **BLOCKED/restart/UNKNOWN semantics**              | TBD      | TBD     | **15%** |
| **Framework intrusion / SDK leakage**              | TBD      | TBD     | **15%** |
| Operational complexity                             | TBD      | TBD     | 10%     |
| Observability/debugging                            | TBD      | TBD     | 5%      |
| CI/developer testing experience                    | TBD      | TBD     | 5%      |

**Note**: CI compatibility (Temporal in-process vs Restate Docker) is at most 5% weight, not a primary differentiator.

## Decision

**Pending M2.11 completion.**

Only after Real Authority Parity Closure:

- Both candidates use real Forge seams
- Both persist to SQLite
- Both Scenario A and B pass `assertDurableExecutionSpikeOutcome`
- dispatchCount from real dispatch evidence

Then scoring with fixed weights above.
