# Runtime V2 Scenario A Seam Map

## Purpose

This map identifies the smallest Forge application boundaries that may become durable-execution steps for the
Runtime V2 Scenario A spike:

```text
Build -> Verify -> Review repair -> Repair -> Verify -> Review accept -> exact integration
```

It is a design artifact, not an implementation. It prevents the migration from either wrapping the legacy
runtime in one opaque side-effect call or splitting every coordinator and persistence call into a separate
durable-execution step.

## Source Map

The existing legacy implementation is concentrated in:

```text
OrchestrationRuntime.#runTask
OrchestrationRuntime.#reviewAndRepair
OrchestrationRuntime.#admitRepairWork
OrchestrationRuntime.#driveRepairCycle
OrchestrationRuntime.#integrateRepairOutput
```

The existing authority primitives remain the source of truth:

```text
TaskOutputAdmissionCoordinator
TaskRepairCoordinator
RepairExecutionCoordinator
WriteGuard
WorkspaceManager
TaskVerifier
TaskImpactReconciler
SQLite evidence stores
```

## Boundary Decision

| Candidate boundary                    | Durable step                   | Forge authority retained                                                                          | Compact continuation reference                                                      | Rationale                                                                                                                                                               |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prepare workspace and execute builder | Yes                            | Lease acquisition, attempt lifecycle, write authority, observed impact                            | builder attempt ID, workspace ID                                                    | Builder mutation is externally side-effecting and establishes the first resumable output boundary.                                                                      |
| Evaluate builder output               | Yes                            | Verification evidence, review evidence, exact repair admission                                    | verification evidence ID, review `(run, task, iteration)` reference, recommendation | The result selects the next legal continuation: integrate or one durable repair admission.                                                                              |
| Execute one repair attempt            | Yes                            | Repair attempt lifecycle, lease authority, reconciliation, verification evidence, review evidence | repair attempt ID, workspace ID                                                     | A repair attempt has an independent CAS lineage and may become `BLOCKED` or `UNKNOWN`.                                                                                  |
| Evaluate repair output                | No separate step in Scenario A | Existing repair Activity already persists verification and review evidence                        | repair attempt ID, review reference, recommendation                                 | Splitting this further adds no independent durable continuation point for the first scenario. It becomes relevant only if retry/idempotency evidence later requires it. |
| Admit another repair                  | No separate step               | `TaskRepairCoordinator.prepare` and durable review admission                                      | next repair attempt ID                                                              | Admission remains part of evaluating a `repair` review; it does not itself execute an external mutation.                                                                |
| Integrate accepted output             | Yes                            | Current-output admission, commit, Git integration                                                 | output attempt ID, review reference, integration status                             | Git integration is externally side-effecting and has its own exact authority condition.                                                                                 |

## Scenario A Flow

```text
Workflow
  -> ExecuteBuilder Activity
       -> Forge builder application service
       -> persisted builder attempt, workspace, impact, lease evidence
       -> { builderAttemptId, workspaceId }

  -> EvaluateBuilderOutput Activity
       -> TaskVerifier + TaskOutputAdmissionCoordinator
       -> persisted verification and review evidence
       -> { verificationEvidenceId, reviewEvidenceRef, recommendation }

  -> if recommendation == repair
       -> ExecuteRepair Activity
            -> TaskRepairCoordinator + RepairExecutionCoordinator
            -> persisted repair, verification, review, lease evidence
            -> { repairAttemptId, reviewEvidenceRef, recommendation }

  -> if final recommendation == accept
       -> IntegrateAcceptedOutput Activity
            -> current-output admission + commit + integration
            -> { integrationStatus }

Host-side harness
  -> reload SQLite authority evidence by run ID
  -> assert DurableExecutionSpikeOutcome
```

The workflow retains only identifiers and recommendation/status discriminators. It must not receive full
attempts, leases, diffs, review objects, verification objects, repository content, prompts, or tool output.

## Explicit Non-Boundaries

The following remain internal Forge authority operations in Scenario A:

```text
Individual SQLite writes
Individual WriteGuard acquire/release calls
Individual Git commands
Review parsing and finding validation
Verification-evidence serialization
Scheduler reevaluation
Runtime conflict replay
```

Scenario A has one task and does not need to reproduce cross-task scheduling or runtime-conflict semantics.
Those remain required in the later full Stage 22/22R differential parity suite.

## Scenario B Extension

Scenario B adds a durable wait around an already persisted repair attempt:

```text
Repair BLOCKED
  -> durable wait/signal
  -> Forge CAS resume decision
  -> ExecuteRepair Activity for the same repair ID
```

`UNKNOWN` remains terminal for automatic continuation. The durable execution substrate may remember that it is
waiting, but it never derives repair state or authorizes resume; Forge evidence and CAS remain authoritative.

## Extraction Gate

Code extraction may begin only after review confirms that this map preserves:

```text
no opaque legacy runtime Activity
no duplicate continuation state machine
no durable-execution type in Forge domain contracts
no full authority payload in execution history
no change to existing Stage 22/22R authority rules
```
