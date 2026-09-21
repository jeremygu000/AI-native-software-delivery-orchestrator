# Runtime V2 Cutover Preparation

## Purpose

This is a non-destructive M3.14 preparation record. It inventories legacy migration evidence and
defines the assertions required before deletion. It is not permission to remove a fallback, declare
the Runtime V2 migration complete, or close the M3 programme.

## Current Production Route

The production deployment path is compiled `forge run` -> Temporal -> compiled Temporal worker ->
Forge runtime composition. Its durable authority is the explicitly configured SQLite database.
`forge status` reads a provider-neutral durable read model from that same authority database.

## Legacy Inventory

The following paths remain deliberately retained as migration evidence, not as production routing:

- `libs/orchestration-runtime/src/lib/orchestration-runtime.ts` is the legacy in-process runtime used
  by the frozen M3.6-M3.9 differential evidence.
- `apps/temporal-worker/src/legacy-temporal-differential.spec.ts` executes the legacy runtime and the
  Temporal path side by side to protect authority parity.
- `libs/temporal-spike/` and `libs/restate-spike/` are frozen decision/prototype artifacts. They do
  not start the production Forge worker.

The compiled CLI must not instantiate the legacy runtime or Forge worker composition. The compiled
worker is the only production process that composes activities.

## Cutover Assertions

Before any destructive M3.14 change, demonstrate all of the following:

- M3.12 has a recorded successful, authorized real external-effect smoke.
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

Until then, this inventory is intentionally documentation-only.
