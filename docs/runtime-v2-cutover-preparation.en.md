# Runtime V2 Cutover Preparation

## Purpose

This is a non-destructive M3.14 preparation record. The authoritative, machine-checkable inventory and
cutover gate are in `runtime-v2-destructive-cutover-manifest.json`, with an architecture regression in
`apps/cli/src/runtime-v2-cutover-readiness.spec.ts`. This record explains those checks; it is not
permission to remove a fallback, declare the Runtime V2 migration complete, or close the M3 programme.

**Current status:** CUTOVER READY / M3.12 REAL SMOKE PASS / AWAITING DESTRUCTIVE-STAGE REVIEW. The
architecture regression verifies that production package roots are isolated from legacy-only entrypoints.
The manifest records the successful authorized `deepseek/deepseek-flash` external-effect smoke, while
keeping `destructiveChangesPermitted` set to `false`: deletion still requires a separately designed and
reviewed destructive stage.

## Current Production Route

The production deployment path is compiled `forge run` -> Temporal -> compiled Temporal worker ->
Forge runtime composition. Its durable authority is the explicitly configured SQLite database.
`forge status` reads a provider-neutral durable read model from that same authority database.

## Legacy Inventory

The manifest classifies every retained path and records its callers and post-smoke deletion eligibility:

- `libs/orchestration-runtime/src/lib/orchestration-runtime.ts` is the legacy in-process runtime used
  by the frozen M3.6-M3.9 differential evidence. It is differential-only and exposed only from
  `@ai-native-software-delivery-orchestrator/orchestration-runtime/legacy`.
- `libs/run-preparation/src/lib/local-runtime-starter.ts` is a differential-only caller of the legacy
  in-process runtime and is exposed only from
  `@ai-native-software-delivery-orchestrator/run-preparation/legacy`.
- `apps/temporal-worker/src/legacy-temporal-differential.spec.ts` executes the legacy runtime and the
  Temporal path side by side to protect authority parity. It is differential-only and is invoked by the
  dedicated legacy test command.
- `libs/temporal-spike/` and `libs/restate-spike/` are frozen-prototype artifacts. They do not start
  the production Forge worker.
- `libs/runtime-v2-spike-harness/` is test-only support for the retained differential and prototype
  evidence.
- `libs/orchestration-runtime/src/lib/` is not a deletion candidate as a whole. Its reusable
  application services, including `TaskOutputAdmissionCoordinator`, `RepairExecutionCoordinator`,
  `ForgeRunProgressionService`, and `ForgeReadModel`, remain on the production route.

The executable architecture regression verifies that the compiled CLI imports neither
`OrchestrationRuntime`, `LocalRuntimeStarter`, nor worker composition; that production package roots do
not re-export legacy-only modules; that stale spike dependencies are absent from the CLI package; that
`forge run` contains the `TemporalRunLauncher` and `startForgeRun` route; and that the independently
deployable worker is the sole production process that composes activities with
`createForgeWorkerComposition` and `createTemporalWorker`.

## Cutover Assertions

Before any destructive M3.14 change, demonstrate all of the following:

- M3.12 has a recorded successful, authorized real external-effect smoke. This is now satisfied by the
  `deepseek/deepseek-flash` run recorded in the manifest.
- The production CLI starts only the compact Temporal workflow and writes launch authority once.
- A separately started worker can complete and recover a durable run from the configured authority
  database.
- `forge status` and `forge cancel` operate on that configured authority database.
- The provider-neutral read model remains sufficient for CLI operators and a future API/UI boundary.
- Frozen legacy-versus-Temporal differential coverage can be retired or replaced without losing its
  authority assertions.

## Deletion Plan

Once those assertions hold, a separately reviewed destructive stage may remove production-dead
legacy scaffolding in this order:

1. Replace frozen differential-only callers with durable contract fixtures where they preserve no
   unique behavior.
2. Remove unreferenced prototype packages and their build/test scripts.
3. Remove the final legacy runtime only after no production or contract test imports it.
4. Update architecture and progress documentation to state the final cutover boundary.

Until then, this inventory, manifest, entrypoint separation, and regression are intentionally
non-destructive. No listed path is deleted in M3.14.
