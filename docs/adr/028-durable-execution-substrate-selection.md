# ADR-028: Durable Execution Substrate Selection

## Status

**Proposed - Decision Pending.** OutcomeCollector pattern proven for both candidates. Scorecard evaluation complete. Decision required.

## Context

ADR-027 defined the migration to Runtime V2 with a durable execution substrate to be selected through a narrow spike comparing Temporal and Restate candidates. Both candidates must run the same two Forge scenarios while retaining SQLite, the current `AgentRunner`, Git/workspace implementation, and all authority semantics.

The spike acceptance criteria from ADR-027:

1. Scenario A: Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> exact integration
2. Scenario B: Repair BLOCKED -> durable wait/signal -> Forge CAS resume decision -> ExecuteRepair Activity

## OutcomeCollector Architecture (CRITICAL FIX)

**Previous False-Positive Problem**: The original harness pattern pre-constructed the correct outcome and passed it as input to the workflow, then asserted it passed. This is circular validation - it proves nothing about durable execution.

**OutcomeCollector Pattern**: Both candidates now use evidence collected DURING real workflow execution, then OBSERVED from evidence store AFTER completion.

```typescript
interface EvidenceStore {
  write(key: string, evidence: WorkflowEvidence): void;
  read(key: string): WorkflowEvidence | undefined;
}

// Activities write evidence DURING execution
// OutcomeCollector reads AFTER workflow completes
// Result is OBSERVED, not pre-constructed
```

**Implementation**:
- Temporal: `libs/temporal-spike/src/lib/in-memory-evidence-store.ts` + `outcome-collector.ts`
- Restate: `libs/restate-spike/src/lib/restate-spike-workflow.ts` (evidence stored in workflow state)

## Spike Results

### Temporal Candidate

**Implementation**: `libs/temporal-spike/`

**Evidence Pattern**: Activities write to `InMemoryEvidenceStore`, `OutcomeCollector` reads after workflow completes.

**Tests**: 6 passing tests proving both scenarios:

1. `executes Scenario A and outcome passes assertDurableExecutionSpikeOutcome` - Scenario A path with full outcome validation
2. `proves builderAttempt is COMPLETED and repairs exist` - Validates `builderAttempt.state === 'COMPLETED'` and `repairs[0].repairIteration === 1`
3. `waits for repairWake signal and outcome passes assertDurableExecutionSpikeOutcome` - Scenario B with outcome validation
4. `ignores unrelated wake signals and continues waiting` - Signal filtering
5. `STALE leaseState also triggers resume` - Lease state handling
6. `workflow can be created and executed with different parameters` - Infrastructure

**Test Infrastructure**: `TestWorkflowEnvironment` - no external dependencies, runs in CI

**Key Characteristics**:
- Built-in time-skipping test environment
- `condition()` + `setHandler()` for durable wait
- Signal-based wake with `handle.signal()`
- Activities write to `InMemoryEvidenceStore` (simulating SQLite)
- Workflow executes real `proxyActivities`

### Restate Candidate

**Implementation**: `libs/restate-spike/`

**Evidence Pattern**: Workflow stores evidence in workflow state during execution, returned as part of result.

**Tests**: 5 passing tests proving both scenarios:

1. `executes Scenario A and outcome passes assertDurableExecutionSpikeOutcome` - Scenario A path with full outcome validation
2. `proves builderAttempt is COMPLETED and repairs exist` - Validates `builderAttempt.state === 'COMPLETED'` and `repairs[0].state === 'COMPLETED'`
3. `executes Scenario B and outcome passes assertDurableExecutionSpikeOutcome` - Scenario B with outcome validation
4. `Scenario B workflowSubmit returns invocationId (durable wait infrastructure works)` - Infrastructure
5. `workflow client can be created for different workflow keys` - Infrastructure

**Test Infrastructure**: `@restatedev/restate-sdk-testcontainers` with Docker

**Key Characteristics**:
- Uses `ctx.signal()` for durable wait
- Workflow keyed by `workflowClient(workflow, key)`
- `workflowSubmit()` for async submission
- `rs.result(handle)` pattern for completion verification
- Evidence stored in workflow state (not process-local registry)

## Scorecard Evaluation

| Criterion | Temporal | Restate | Notes |
|-----------|----------|---------|-------|
| **Scenario A proof** | ✓ 2 tests | ✓ 2 tests | Both pass `assertDurableExecutionSpikeOutcome` |
| **Scenario B proof** | ✓ 3 tests | ✓ 2 tests | Temporal has more signal filtering tests |
| **Durable wait semantics** | ✓ `condition()` + signals | ✓ `ctx.signal()` | Both correct |
| **Signal filtering** | ✓ Correct | Needs verification | Temporal has explicit tests |
| **Evidence collection** | ✓ InMemoryEvidenceStore | ✓ Workflow state | Both observable |
| **Test infrastructure** | In-process | Docker required | Temporal CI-friendly |
| **No circular validation** | ✓ Real activities | ✓ Real workflow | Both fixed |
| **Authority evidence** | Via activities | Via workflow state | Both write to evidence |

## Decision

**Proposed: Select Temporal** based on:

1. **CI compatibility**: In-process `TestWorkflowEnvironment` vs Docker requirement
2. **Signal filtering tests**: Temporal explicitly tests repairAttemptId matching
3. **Observable evidence**: InMemoryEvidenceStore pattern clearer than workflow state
4. **Time-skipping**: Built-in test capability for temporal logic

**Alternative: Restate** if:
- Operational simplicity with Restate Cloud is prioritized
- Docker availability in CI is acceptable
- Registry pattern is considered simpler than explicit evidence store

## Consequences

- Both candidates prove real durable execution with OutcomeCollector pattern
- Shared harness architecture enables fair comparison
- Temporal wins on CI compatibility and explicit signal filtering
- Decision enables Integration Bootstrap / RuntimeStarter / CLI switch (per ADR-027)
