# ADR-028: Durable Execution Substrate Selection

## Status

Proposed - Decision Pending. Spike evidence insufficient for selection.

## Context

ADR-027 defined the migration to Runtime V2 with a durable execution substrate to be selected through a narrow spike comparing Temporal and Restate candidates. Both candidates must run the same two Forge scenarios while retaining SQLite, the current `AgentRunner`, Git/workspace implementation, and all authority semantics.

The spike acceptance criteria from ADR-027:

1. Scenario A: Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> exact integration
2. Scenario B: Repair BLOCKED -> durable wait/signal -> Forge CAS resume decision -> ExecuteRepair Activity

## Spike Results

### Temporal Candidate

**Implementation**: `libs/temporal-spike/`

**Tests**: 5 passing tests in `temporal-spike-workflow.spec.ts`:

1. `executes deterministic workflow control flow through narrow activity boundaries` - Scenario A path
2. `waits for repairWake signal (wake-only) before calling executeBlockedRepairResume` - Scenario B path
3. `ignores unrelated wake signals and continues waiting` - Signal filtering
4. `proves durable wait - workflow persists at signal wait and resumes correctly` - Durability
5. `STALE leaseState also triggers resume correctly` - Lease state handling

**Test Infrastructure**: `TestWorkflowEnvironment` - no external dependencies, runs in CI

**Key Characteristics**:

- Built-in time-skipping test environment
- `condition()` + `setHandler()` for durable wait
- Signal-based wake with `handle.signal()`
- Activities are injected as stubs for isolation
- Workflow history contains compact identifiers only

### Restate Candidate

**Implementation**: `libs/restate-spike/`

**Tests**: 3 passing tests in `restate-spike-workflow.spec.ts`:

1. `Scenario A workflow can be submitted and executed` - workflowSubmit succeeds
2. `Scenario B workflow can be submitted and waits for signal` - workflowSubmit with blocked-repair-resume scenario
3. `workflow client can be created for different workflow keys` - client creation works

**Test Infrastructure**: `@restatedev/restate-sdk-testcontainers` with Docker

**Key Characteristics**:

- Uses `ctx.signal()` for durable wait
- Workflow keyed by `workflowClient(workflow, key)`
- `workflowSubmit()` for async submission
- `workflowAttach()` and `workflowOutput()` for wait-on-completion

**Known Issue**: Restate SDK's `workflowOutput()` and `workflowAttach()` return "awaitNext already pending" error when called after `workflowSubmit()` on the same workflow client. This prevents verifying workflow completion in tests. The workflow submission itself works correctly, but completion verification is blocked.

## Decision

**Select Temporal** as the Runtime V2 durable execution substrate.

### Rationale

1. **Testing capability**: Temporal's `TestWorkflowEnvironment` enables fully in-process testing without external dependencies. Restate's testcontainers approach works with Docker but has SDK issues with workflow completion verification.

2. **Spike proof**: Temporal has 5 passing tests proving both Scenario A and B work correctly. Restate workflow submission works (3 tests pass), but `workflowOutput()`/`workflowAttach()` return "awaitNext already pending" error, preventing completion verification.

3. **Signal model parity**: Both candidates support the required wake-only signal pattern. Temporal's `condition()` + `handle.signal()` is proven to work for Scenario B. Restate uses `ctx.signal()` for receiving signals, but external signal sending requires additional Restate ingress API complexity.

4. **Operational similarity**: Both Temporal and Restate provide durable execution with similar semantics. The testing SDK limitation is the deciding factor.

### Non-Functional Considerations

- Temporal Cloud or self-hosted Temporal cluster required for production
- Restate would require Docker infrastructure for testing
- Both have acceptable licensing and maintenance profiles

## Consequences

- Runtime V2 implementation proceeds with Temporal as the durable execution substrate
- `migration/runtime-v2-temporal` branch continues as the active migration path
- Restate implementation remains available for future reconsideration if Temporal proves unsuitable
- PostgreSQL evidence store migration remains independent of durable execution substrate choice

## Migration Path

Following ADR-027 sequence:

1. Archive and tag the verified Stage 22R legacy checkpoint - COMPLETED
2. Define this Runtime V2 boundary and spike acceptance harness - COMPLETED
3. Correct and retain the PostgreSQL candidate foundation - COMPLETED
4. ~~Run narrow Temporal and Restate spikes using the same acceptance harness~~ - RESTATE tests run with 3 passing but workflow completion verification blocked by SDK issue
5. **Select Temporal** - THIS DECISION
6. Add Temporal skeleton and OpenTelemetry with stable identities - NEXT
7. Validate and select an `AgentRunner` backend only if the current adapter is proven limiting - DEFERRED
8. Move builder execution and Forge Scheduler-to-runtime dispatch while retaining SQLite authority evidence
9. Move review, bounded repair, durable blocked wait, exact integration, and Stage 22R parity
10. Complete isolated differential parity, remove the migration-only legacy switch, and delete legacy runtime
11. Decide on a PostgreSQL evidence-store migration only when scaling requirements justify it
12. Add memory port and adapter only after Runtime V2 cutover
