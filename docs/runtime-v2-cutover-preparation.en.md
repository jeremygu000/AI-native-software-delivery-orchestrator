# Runtime V2 Cutover Record

## Status

M3.14 is **PASS / CLOSED / FROZEN** following independent review of `ba640de`. The Runtime V2 migration
is **COMPLETE**, and M3 is **COMPLETE / FROZEN**. The authoritative machine-checkable record is
`runtime-v2-destructive-cutover-manifest.json`; its architecture regression is
`apps/cli/src/runtime-v2-cutover-readiness.spec.ts`. The manifest records that the destructive cutover
was executed and independently reviewed; it does not grant permission for future deletions.

M3.12 remains PASS/CLOSED/FROZEN. Its recorded `deepseek/deepseek-flash` external-effect smoke remains
evidence and was not removed or rerun as part of this destructive cutover.

## Production Route

The only production route is compiled `forge run` -> Temporal -> compiled Temporal worker -> Forge runtime
composition. The configured SQLite database remains the durable authority, and `forge status` and
`forge cancel` use that same authority. The worker receives its review policy and model through explicit
deployment configuration: `FORGE_WORKER_REVIEW_PROVIDER` and `FORGE_WORKER_REVIEW_MODEL`. The CLI canonicalizes and
resolves its required `--review-provider` and `--review-model` before plan, bind, or run authority is
written. The worker independently canonicalizes and resolves its deployment identity before polling
Temporal. A missing, blank, unavailable, or fingerprint-mismatched identity fails closed before useful
work; the composition receives only the resulting provider-neutral policy and application-owned adapter
factories.
The composition also receives application-owned reviewer and coding-runner factories. It neither reads
deployment environment variables nor creates Pi adapters or resolves a model itself; the worker is the
sole production assembly boundary for those provider-specific concerns.

## Removed Assets

Sequence B deleted the in-process `OrchestrationRuntime`, `LocalRuntimeStarter`, their `/legacy` exports and
tests, the legacy-versus-Temporal differential suite, and the frozen `temporal-spike`, `restate-spike`, and
`runtime-v2-spike-harness` workspaces. Package scripts, TypeScript references, Vitest coverage exclusions,
package dependencies, and the pnpm lockfile no longer retain those assets.

Reusable `libs/orchestration-runtime` application services remain on the production route, including
`TaskOutputAdmissionCoordinator`, `RepairExecutionCoordinator`, `ForgeRunProgressionService`, and
`ForgeReadModel`.

## Retained Evidence

Temporal and production-composition tests retain exact, mismatched and repeated blocked-integration wakes.
A real local Temporal server test awaits worker A reaching STOPPED before starting worker B and attributes
the exact-wake resume activity to B; a separate
temporary-SQLite test closes composition A and reopens the same database for composition B, where an invalid
wake does nothing, an exact wake integrates, and a repeated wake does not repeat integration. Repair budget
coverage retains completed repair, review, and verification evidence with no integration claim or
`workspace-integrated` event. The core repair-execution test retains post-start `UNKNOWN` authority; this
cutover does not claim a separate full-workflow repair-UNKNOWN nonterminal test. `STALE` blocker repair resume
is tested through production composition. The cutover regression requires every retired path to be absent.

## Verification

The destructive route was verified with `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the
machine-checkable cutover regression. `pnpm check` is currently blocked only by pre-existing formatting
issues in `pi-agent-runner.spec.ts`, `task-repair-attempt.ts`, and `repair-execution-coordinator.spec.ts`;
none are part of this cutover.
