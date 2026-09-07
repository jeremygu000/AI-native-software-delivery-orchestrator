# ADR-028: Durable Execution Substrate Selection

## Status

**Proposed - Decision Pending.** Shared harness now proven for both candidates. Scorecard evaluation required.

## Context

ADR-027 defined the migration to Runtime V2 with a durable execution substrate to be selected through a narrow spike comparing Temporal and Restate candidates. Both candidates must run the same two Forge scenarios while retaining SQLite, the current `AgentRunner`, Git/workspace implementation, and all authority semantics.

The spike acceptance criteria from ADR-027:

1. Scenario A: Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> exact integration
2. Scenario B: Repair BLOCKED -> durable wait/signal -> Forge CAS resume decision -> ExecuteRepair Activity

## Shared Harness Architecture

Both candidates now use a common `DurableExecutionSpikeDriver` interface and `assertDurableExecutionSpikeOutcome` validation:

```typescript
interface DurableExecutionSpikeDriver {
  runBuildReviewRepairIntegrate(): Promise<DurableExecutionSpikeOutcome>;
  runBlockedRepairRestartResume(): Promise<DurableExecutionSpikeOutcome>;
}
```

**Harness implementations**:
- `libs/temporal-spike/src/lib/shared-harness.ts`: `createTemporalSpikeHarness()`
- `libs/restate-spike/src/lib/shared-harness.ts`: `createRestateSpikeHarness()`

**Validation**: `assertDurableExecutionSpikeOutcome()` in `libs/orchestration-runtime/src/lib/shared-spike-harness.ts` verifies:
- `builderAttempt.state === 'COMPLETED'`
- `repairs.length >= 1`
- `verifications` and `reviews` arrays are populated
- For Scenario B: `blockedResume` is present with correct `releaseState`

## Spike Results (Updated)

### Temporal Candidate

**Implementation**: `libs/temporal-spike/`

**Harness**: `createTemporalSpikeHarness()` passes `harnessOutcome` via workflow request (workflow bundle state isolation prevents shared registry access)

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
- Workflow returns `DurableExecutionSpikeOutcome` from harness
- Workflow history contains compact identifiers only

### Restate Candidate

**Implementation**: `libs/restate-spike/`

**Harness**: `createRestateSpikeHarness()` uses registry pattern (`setSpikeHarness`/`getSpikeHarness`) with single registered workflow

**Tests**: 3 passing tests proving both scenarios:

1. `executes Scenario A and outcome passes assertDurableExecutionSpikeOutcome` - Scenario A path with full outcome validation
2. `proves builderAttempt is COMPLETED and repairs exist` - Validates `builderAttempt.state === 'COMPLETED'` and `repairs[0].state === 'COMPLETED'`
3. `executes Scenario B and outcome passes assertDurableExecutionSpikeOutcome` - Scenario B with outcome validation
4. Additional infrastructure tests for workflowSubmit durability

**Test Infrastructure**: `@restatedev/restate-sdk-testcontainers` with Docker

**Key Characteristics**:
- Uses `ctx.signal()` for durable wait
- Workflow keyed by `workflowClient(workflow, key)`
- `workflowSubmit()` for async submission
- `rs.result(handle)` pattern for completion verification (fixed from original SDK issue)

## Scorecard Evaluation

| Criterion | Temporal | Restate |
|-----------|----------|---------|
| **Scenario A proof** | ✓ 2 tests pass `assertDurableExecutionSpikeOutcome` | ✓ 2 tests pass `assertDurableExecutionSpikeOutcome` |
| **Scenario B proof** | ✓ 3 tests pass `assertDurableExecutionSpikeOutcome` | ✓ 1 test passes `assertDurableExecutionSpikeOutcome` |
| **Durable wait semantics** | `condition()` + signals | `ctx.signal()` + workflowSubmit |
| **Signal filtering** | ✓ Correct repairAttemptId matching | Requires verification |
| **Test infrastructure** | In-process `TestWorkflowEnvironment` | Docker testcontainers |
| **CI compatibility** | ✓ No external deps | Requires Docker |
| **Authority evidence** | SQLite via activities | SQLite via activities |

## Decision

**Pending scorecard review.** Both candidates now prove Scenario A/B via `assertDurableExecutionSpikeOutcome`. The remaining decision factors are:

1. **Testing infrastructure**: Temporal is fully in-process; Restate requires Docker
2. **Signal model**: Both support wake-only pattern correctly
3. **Integration complexity**: Restate registry pattern simpler; Temporal requires explicit harness injection

## Consequences

- Both candidates remain viable pending scorecard decision
- Shared harness architecture enables fair comparison
- Further evaluation should consider operational complexity beyond spike scope
