# Independent review: PREPARING run evidence and Temporal lookup classification

Baseline: accepted Run Inspector commit `1aaf63028c470bde63d3819f70e923a2763c622d` on `m4/postgres-durable-authority`. This document is the independent review handoff for the next increment.

## Intended scope

The reported Neon run `fe89c1bf-0ec8-4aee-80da-b14d2e0918fa` displayed many UNKNOWN setup stages. A read-only comparison of Inspector node evidence against the selected `forge_comparison_20261005` authority shows no matching parent claim, generation, workspace permit lineage or generic permit. No mapped authority row was missed. The durable run and PREPARING builder attempt exist, so the observed boundary is after run metadata and before a run-scoped setup claim was persisted. This does not determine the original operator error.

The same inspection had labelled Temporal as unavailable. A separate read-only SDK lookup classified the actual response as `WorkflowNotFoundError`, which means the selected namespace currently has no known record for the exact workflow ID. The narrow code change catches only that typed result in `readTemporalObservation()`, returns UNKNOWN with `lookupResult=not-found`, and marks Temporal as observed. Connection failures remain unavailable. Confirmed task-queue mismatch still fails closed. The lookup does not prove that a workflow never existed; retention can remove history. The graph now displays a specific known reason for unknown state: `NO EVIDENCE`, `CONFLICTING EVIDENCE`, `NO CURRENT WORKFLOW`, `SOURCE UNAVAILABLE`, or `INSUFFICIENT EVIDENCE`. The underlying state remains `unknown`.

## Architecture and evidence boundaries

Production changes are confined to the read-only Temporal observation in `libs/run-inspection/src/lib/observations.ts`, the unknown-reason projection/DTO in `libs/run-inspection/src/lib/inspection.ts`, the visual status label in `apps/run-inspector/web/app.tsx`, one direct dependency on the Temporal SDK's common error type, and documentation. React Flow remains a presenter of the DTO. No PostgreSQL query, authority check, migration, workflow command, worker composition, Git workspace action, provider path, API mutation surface or retry/cancel/recovery behavior changes. The existing `1aaf630` Run Inspector baseline remains intact outside this observation refinement.

Focused regression injects the SDK's real `WorkflowNotFoundError` through the existing source seam and verifies observed source status, internally UNKNOWN node, `no-current-workflow` presentation reason, safe `not-found` evidence, closed connection and no error-body disclosure. Additional projection tests distinguish empty, conflicting and unavailable evidence. Existing connection-failure and task-queue mismatch regressions remain in the same file. Focused tests pass **38/38**. Full image-enabled `pnpm check` passes **1254/1254 across 118 files, zero skips**, with the project's pinned PostgreSQL 18, Pi, Git and native TUI fixtures; full build and diff check pass. Compiled-browser fixture smoke shows 26 NO EVIDENCE nodes and zero console errors. A bare unpinned `pnpm check` failed an unrelated dedicated-hardening test; that exact test passed 1/1 with pinned PostgreSQL 18. The live read uses the already selected Neon comparison runtime URL with verified TLS and SELECT-only audit queries; it does not mutate Neon or start a new run. No live provider call or GroundGraph coding E2E is claimed.

## Review questions

1. Does the new branch match only the typed Temporal not-found error while connection failures remain unavailable and confirmed queue mismatches remain fatal?
2. Does the node remain UNKNOWN and avoid claiming historical non-occurrence or a failed workflow?
3. Are workflow ID, namespace, a fixed `not-found` value and a fixed explanation the only new browser fields, with no SDK message or failure body?
4. Does the live authority audit genuinely show no run-scoped claim/generation/permit row, rather than evidence missed by the existing projection?
5. Is this change independent of all accepted authority, migration, Temporal workflow and provider semantics?
6. Are the displayed unknown reasons determined by direct evidence/source status, with a valid browser DTO and no promotion to COMPLETE or FAILED?
