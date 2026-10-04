# Interactive GroundGraph acceptance and read-model correction

## Scope and review baseline

Review this increment against accepted Forge baseline `0b8308a4103ecf36218ac931b22e0cc22d90ac15` on `m4/postgres-durable-authority`. The user accepted that Interactive Coding CLI commit with no P0/P1 and explicitly authorized updating the existing local authority through the accepted installer, followed by a real GroundGraph run. Online Neon was excluded.

This follow-up has two parts: real deployment/execution evidence, and a narrow correction to the existing read model exposed by that execution. Changed code is limited to `libs/orchestration-runtime/src/lib/forge-read-model.ts` and its spec. The remaining changes are this report and synchronized English/Chinese progress summaries. No workflow command/patch, schema, migration, checksum, provider adapter, approval or authority mutation contract changed. The user requested commit and push of this follow-up; independent acceptance of the read-model correction remains pending.

## Installer and readiness

The operator invoked the existing `migratePostgresAuthoritySchema` on the explicitly checked loopback deployment `127.0.0.1:54329`, database `forge_comparison_20261004`, schema `forge`, using the separate local owner credential. The private operator probe rejects other endpoints/databases. It does not use the configured Neon credentials.

The migration ledger already contained versions 1–15. Its digest, including versions, checksums and applied timestamps, remained `5d117957f1ab95a01a1d5e707c1f3b64ecff3a75df967c67d054c853ecbb2102`. All nine SECURITY DEFINER functions changed from the exact legacy `search_path=pg_catalog` setting to the accepted `pg_catalog, pg_temp` configuration through the installer. No other function setting was found. GLOBAL_READY remained unchanged. Runtime schema and global authority audits then passed. Existing read-only preflight passed repository, authority, Temporal namespace and both pinned execution images.

The current compiled worker ran separately on the fresh task queue `forge-interactive-coding-20261004`, with the actual GroundGraph repository and `deepseek / deepseek-flash / high`. The existing readiness helper confirmed repository match, code-review policy fingerprint `sha256:ed4e01f3fa301437f30611058f67bd004dfc7081d0357f4d49f5dc4d0915f139`, and both workflow/activity pollers. Every recorded activity ran with worker identity `20286@Nicoles-MacBook-Pro.local`, attempt one. That temporary worker was shut down normally after completion and release checks; other workers were left running.

## Real interactive execution

The production compiled `apps/cli/dist/main.js` was launched with **no subcommand** in a real PTY. A private host launch script supplied existing deployment configuration, stripped privileged environment variables and selected the isolated queue. It did not inject application functions, spawn automation commands to orchestrate planning or use the comparison wrapper.

The actual root menu was used to select Start a coding task, enter the repository and multiline task, pick DeepSeek/high, explicitly authorize model planning/review, inspect plan details, and approve the exact artifact/workspace/integration scope. Planning and independent semantic review used real paid inference. The plan contained exactly one task, two expected writes, original root `check` verification, and no hard/risk conflicts.

| Identity                     | Value                                             |
| ---------------------------- | ------------------------------------------------- |
| Repository                   | `/Users/isdance/Desktop/projects/ground-graph-ts` |
| Approved repository baseline | `1e8835d37a0827c111291fa8a6cf4f12cc2caa68`        |
| Artifact / revision          | `84c5914b-7abd-49cf-b9bf-5e2102512c6c` / 1        |
| Approval                     | `a197a02b-c1b2-4f1b-9661-152d3634daf8`            |
| Run                          | `9fff984d-5265-4184-ae2f-445b3af9dd3a`            |
| Task                         | `query-schema-reject-whitespace-trim`             |
| Temporal execution           | `01a10536-f9c8-7086-a90d-f90b340ebb4f`            |
| Integration commit           | `4bac482be43e8e847281e50965d039f23a6c936a`        |

The task rejects empty/whitespace-only questions, trims valid questions and preserves the existing 10000-character maximum on the original string. Only `apps/api/src/schemas/query.schema.ts` and `tests/unit/api/query-schema.test.ts` changed. The operator made no manual target-source edits. Confined Forge integration advanced the target HEAD and the named integration ref to the commit above, and the actual checkout is clean. No target push or PR was performed.

| Durable observation                  | Result                                 |
| ------------------------------------ | -------------------------------------- |
| PostgreSQL run state                 | COMPLETED                              |
| Temporal workflow status             | COMPLETED                              |
| Temporal start / close (UTC)         | 2026-10-04 04:40:51.400 / 04:44:36.290 |
| Temporal elapsed duration            | 224.89 seconds                         |
| Builder                              | COMPLETED                              |
| Approved original verifier           | passed                                 |
| Independent code review              | accept                                 |
| Repair                               | not needed; none recorded              |
| Integration reservation / workspace  | INTEGRATED                             |
| Global claims                        | 3 RELEASED; no active/uncertain claim  |
| Unresolved generic permits           | 0                                      |
| Unresolved workspace permit lineages | 0                                      |
| Active/stale leases                  | 0                                      |

Verification evidence fingerprint is `sha256:96bfb1a3eecc7a36838b2fe17ee60ca30bcd01856fb371b89d2a59bc872a4f10`. The artifact's original root package-script check was used through the accepted verifier. Its durable evidence records passed status and the fingerprint; a GroundGraph test count is not claimed from metadata that does not retain stdout.

Exact authority fingerprints: plan `sha256:30ef765c0b537db82bc670ecc1acd73343083567bb53e511edc971432e9c6ae9`; approval `sha256:5120e8cfd6798d1c461b67a1ac909e45ed2d098c2f1e0a83f5af9c7cbd05e91b`; execution `sha256:52bbfa640fb0beb51f20a414da6e6bdd16be40715665c19cca27b0b2a3d5e5e2`. Existing signed setup, independent generation observation, recovery evidence and handoff were used before Temporal launch.

## Read-model bug found and fixed

The first terminal summary reported `Completed: 0/1` and task READY, despite the persisted run, workspace and integration records being complete. Read-only recovery identified both causes:

1. At initial sequence one, PENDING → READY and READY → RUNNING are two ordered transitions. Sorting only by descending sequence and taking the first retained the earlier READY transition.
2. Later decision input snapshots recorded VERIFYING, INTEGRATING and finally COMPLETED, but scheduling needed no new transitions. The read model read only transitions and ignored those durable snapshots.

The correction selects the newest snapshot containing the task and applies transitions at that sequence or later. Within one sequence it uses the last transition in persisted order. Older transitions cannot override a newer runtime snapshot. Transition-only recovery and the no-evidence PENDING fallback remain intact. Existing blocking-reason projection uses that same corrected state. It does not infer task success from a run-level outcome or a Git event, and it changes no persisted records.

Seven added regressions cover initial ordered transitions, each of the three later runtime states without scheduler transitions, same-sequence transition precedence, unrelated newer snapshots, and fallback behavior. Rebuilding and reading the **same** completed run now gives task COMPLETED and the existing renderer shows `Completed: 1/1`, verification 1/1, review 1/1 and integration one. No additional provider run was made to obtain that result.

## Trace evidence and limits

Tempo visibly contains two real CLI planning `forge.model.request` traces under `forge-local`, both with provider DeepSeek, model deepseek-flash, effort high, attempt one and outcome completed:

| Role                   | Trace ID                           | Span ID            | Duration |
| ---------------------- | ---------------------------------- | ------------------ | -------- |
| planner                | `1a0ae2df46b04ffe4b5db42ff0c65dfa` | `d6300c0ba3dc9d8e` | 11.79 s  |
| semantic plan reviewer | `e37894636e53ac8d88d1500b47ae6542` | `19735262cbd37b13` | 9.81 s   |

Both span detail views were independently inspected in the existing authenticated Grafana session. The process entry is the production main with no subcommand. Planning precedes run identity allocation, so those spans have no run ID; attribution uses the observed process, timestamps and profile rather than inventing a run linkage.

**These are planning traces, not a complete workflow trace tree.** The accepted tracing deployment rule requires fresh authority and queue before enabling Temporal's plugin. This run intentionally updated and reused the authorized existing local authority, so the worker plugin remained disabled. Full forge.run/task/activity/model-operation tracing remains unverified for this real run. No rule was relaxed to manufacture trace evidence, and no Neon schema/ACL/query operation occurred.

## Verification and private evidence

`pnpm build`: PASS. Focused read-model and interactive coordinator tests: **26/26 PASS**. Final full image-enabled `pnpm check`: **1118/1118 PASS in 107 files, no skips**, including existing PG18 authority/Docker/Temporal fixtures. Coverage: statements 90.63%, branches 85.23%, functions 94.30%, lines 90.56%, above unchanged thresholds. `git diff --check`: PASS. The real run occurred on accepted 0b8308a before the read-only projection correction; code changes were verified by reading the same already-completed durable run afterward.

The final full-gate log is `/tmp/forge-interactive-e2e-check.log`. Private mode-600 evidence is under ignored `.local/interactive-e2e-*`: installer before/after ledger/function audit, worker readiness, exact identities, final PostgreSQL/Temporal evidence, original and corrected status, recovered snapshots/transitions, completion rendering and trace IDs. Existing signed setup/recovery files remain in `.local/`. Host launch and probe scripts are local experiment aids, not production infrastructure or a new CLI configuration registry. Provider transcripts, credentials, signing keys and mutation secrets are not included in this report.

## Specific review questions

1. Does the state projection honor newest decision snapshots and ordered transitions without synthesizing authority or modifying workflow history?
2. Are same-sequence transition precedence, newer snapshot precedence and legacy fallback covered adequately?
3. Does re-reading the unchanged completed run substantiate the display correction without claiming another execution?
4. Do the installer digest, exact identities, signed setup/handoff, verification/review, integration and release evidence support real interactive execution acceptance?
5. Are planning-only Tempo evidence and the still-unverified full workflow trace clearly separated?
