# Forge v1: product baseline and initial delivery plan

## Decision and scope

Forge v1 is a repository-aware software delivery tool. Its supported owner is one active
orchestrator per run; that orchestrator may run independent coding tasks concurrently in isolated
Git worktrees. Verification and review precede serialized integration. Local state supports
observation, deliberate retry, and practical restart after the previous process has stopped.

This is a direction reset, not another authority milestone. This document records history inspection
and the branch decision only. No product implementation, merge, or cherry-pick accompanies it.

Recommended and selected baseline:

**`10bd7f9f4f6a2b3a8b3b82d3b885bf0064003afc` — `feat(cli): add forge cancel command`.**

`product/forge-v1` starts at that exact commit. The historical
`m4/postgres-durable-authority` branch remains at
`4204cfc4f3e01351200dc97929847148c1f143be`; it is reference material, not a merge source.

## 1. Baseline analysis

The selection used ancestry, source, package boundaries, runtime composition, tests, and progress
records. Commit timestamps alone are misleading: some early runtime changes were committed later
than the stage they describe. The actual parent chain is the important evidence.

| Candidate                                                                           | Useful capabilities                                                                                                                          | Why selected or rejected                                                                                                                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `26cd7e2c1842bf208548213bac78c6a5b84a77da` — observed runtime impact                | Repository analysis, contracts, DAG, impact/conflicts, scheduler, concurrent agents, Git worktrees, SQLite, autonomous planning and approval | Too early: lacks the subsequently composed code-review and repair loop.                                                                                   |
| `2486fe07732781f95c9955bf6627033b33707983` — Stage 22R; existing archive branch tip | Adds exact output review, bounded repair, re-verification/re-review, and queued blocked-repair continuation to the local runtime             | Strong fallback, but misses later observed-read reporting and useful CLI status/cancel additions.                                                         |
| **`10bd7f9f4f6a2b3a8b3b82d3b885bf0064003afc`** — selected                           | Retains Stage 21–23 and the small Stage 24 status/cancel increment, using the same local runtime                                             | Newest inspected boundary before Runtime V2 starts; those last additions are product operations, not distributed infrastructure.                          |
| `4f7a218b94287488762b79f4deb10faba2ed5426` — direct successor                       | Begins PostgreSQL evidence storage and the Runtime V2 migration ADR                                                                          | Does not yet contain Global Authority, but introduces a new substrate without adding a necessary v1 workflow over the selected baseline.                  |
| `e58564010593d65d58f749c4dd74125368f31092` — Runtime V2 cutover closure             | Later production CLI/worker wiring, restart/cancellation, durable read model                                                                 | Already includes Temporal/Restate evaluation and durable multi-process coordination; too much to remove for a single-owner product.                       |
| `4204cfc4f3e01351200dc97929847148c1f143be` — historical head                        | Subscription models, TUI, inspector, tracing and real-repository fixes                                                                       | These useful product features sit on top of the later authority architecture. Starting here would make disentangling that architecture the project again. |

The selected commit contains 13 libraries: `domain`, `dag`, `repository-analysis`, `task-impact`,
`conflict-engine`, `scheduler`, `runtime-guard`, `persistence`, `workspace-git`,
`orchestration-runtime`, `planning`, `run-preparation`, and `agent-runtime`. It has a CLI and local
SQLite execution. It has no PostgreSQL, Temporal, Restate, global mutation authority, or separate
worker application.

Concrete source evidence:

- `apps/cli/src/app.ts` exposes `analyze`, `plan`, `approve`, `bind`, `run`, `status`, and `cancel`.
- `libs/run-preparation/src/lib/local-runtime-starter.ts` directly composes the local scheduler,
  SQLite store, controlled Pi runner, Git manager, verifier, reviewer, and repair coordinator.
- `libs/orchestration-runtime/src/lib/orchestration-runtime.ts` drains concurrent task/repair
  promises up to `maxConcurrency`, while a process-local lifecycle queue serializes Git integration.
- Stage 21 reconciles actual Git changed paths; Stage 23 additionally reports observed reads.
- Runtime tests cover concurrent independent agents, conflicting tasks, dependency chains, real
  Git integration, stopped-run recovery, and repair/re-review/integration. These are existing test
  definitions, not a newly executed paid-model acceptance run.

Historical records at this commit report `pnpm check`: 578 passed, one skipped, 90.31% branch
coverage, and `pnpm build` passing. **Those historical numbers have not been reproduced during this
reset.** Invoking the documentation formatter caused pnpm to restore the selected baseline's pinned
dependencies without changing its manifests or lockfile. Generated build outputs still belong to a
later checkout; P1 must perform a baseline-specific build/check before treating them as evidence.

## 2. Capability inventory

KEEP means retain a useful baseline capability, not freeze every existing implementation.

### KEEP

| Capability                                     | Baseline location and v1 purpose                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Repository graph and factual analysis          | `repository-analysis` and `domain`: projects, files, symbols and dependencies for grounded planning.             |
| Task contracts and dependency DAG              | `domain` and `dag`: explicit work and deterministic ordering.                                                    |
| Predicted impact and conflict detection        | `task-impact` and `conflict-engine`: explain why tasks can run together or must wait.                            |
| Deterministic scheduler                        | `scheduler`: concurrency limits, dependency readiness and known conflict prevention.                             |
| Parallel task driver                           | `orchestration-runtime`: concurrent coding under one orchestrator.                                               |
| Worktree isolation and local integration       | `workspace-git`: separate task branches/worktrees and one serialized integration path.                           |
| Controlled agent abstraction                   | `agent-runtime`: provider-neutral runner and explicit file/command tools.                                        |
| Autonomous planning and semantic plan review   | `planning` plus Pi adapters: propose tasks, validate them against repository facts and expose diagnostics.       |
| Plan artifacts and explicit approval           | `planning`, `run-preparation`, CLI: preserve the user's agreed work and repository identity.                     |
| Verification, output review and bounded repair | Local runtime, review collector and repair coordinator: test output and rework rejected code before integration. |
| Observed diff reconciliation                   | Git changes mapped to repository resources: compare actual changes to intended work.                             |
| Local SQLite state and basic CLI status        | Persist run/task/worktree/attempt evidence and inspect progress.                                                 |

### SELECTIVELY PORT

| Later capability                                     | Smallest useful extraction; excluded dependency baggage                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenTUI usability                                    | Existing semantic input, plan display, status, cancellation and terminal cleanup; bind to local product operations, not global setup/operator protocols.                   |
| Model and subscription adapters                      | Independent Copilot/Codex authentication and direct API/local execution as user options; no authority-based execution profile or mandatory cross-system approval protocol. |
| Real-world tool fixes                                | Missing read paths, recoverable pre-write edit mismatch, DeepSeek tool-turn reasoning continuity; preserve precise errors and avoid importing mutation permits.            |
| Failed-verification repair and idempotent evaluation | Carry real failed gate diagnostics into a bounded local repair; repeated observation must not consume another repair or duplicate integration.                             |
| Verification environment preparation                 | Reproducible dependency environments and useful stdout/stderr for real package checks; do not transplant operator roles or authority bootstrap.                            |
| Cancellation, restart and task projections           | Stop dispatch, settle owned processes, report actual outcome, resume/retry selected tasks after shutdown; no arbitrary worker takeover.                                    |
| Usage and tracing                                    | Task/provider/model/latency/tokens/cost/outcomes where returned by the provider; unavailable credit or cost remains unknown.                                               |
| Real-repository regression lessons                   | Tests for discovered product bugs, adapted to the local owner model; do not copy fleet fixtures as v1 requirements.                                                        |
| Inspector concepts                                   | Optional local progress/diff visibility only if the CLI/TUI cannot explain the run; defer the separate web application initially.                                          |

### DO NOT PORT

- PostgreSQL Global Authority, store-wide cutover and privileged authority bootstrap.
- Cross-run durable mutation claims/permits, global fencing tokens and ownership transfer.
- Signed recovery/quiescence proofs, authority generations and parent/child handoffs.
- Orphan authority-permit settlement and independent authority supervisors.
- Temporal/Restate worker fleets, multi-process parity harnesses and takeover protocols.
- Authority registry/key administration, restricted database writer roles and migration chains.
- Fleet/crash matrices justified by active-active orchestration or stale remote writers.
- Automatic quality-based provider routing, anonymous telemetry defaults, and a new web/server stack.

## 3. Complexity inventory and simplification boundary

The baseline is smaller, not complexity-free. It still has local `WriteLease` records, resource
coverage checks, revisions, review fingerprints, blocked-repair CAS, and `UNKNOWN` attempts. Some
test names also refer to an external run's lease. **None of that extends the v1 promise to
cross-process ownership or hostile writers.**

Keep local scheduling reservations only where they prevent a demonstrated same-run collision. A
version check can remain a normal local state-consistency check. An interrupted attempt can become
an ordinary interrupted/failed task with preserved output for an explicit retry. Do not grow these
into takeover, stale-writer, signed recovery, or `HELD_UNCERTAIN` protocols.

Prefer one orchestration loop, one local state store, a bounded task executor, and a serialized Git
integration queue. A small local process/file ownership guard may prevent accidentally starting two
orchestrators for the same run; no network lease service is needed. Refactor inherited complexity
when P1/P3 changes the relevant product behavior, not through a speculative rewrite of every module.

Later branch code is mined by capability. No merge or wholesale milestone cherry-pick is planned.
When a later feature imports authority contracts, reimplement its small product boundary against
local task/run/worktree state instead of importing those contracts.

## 4. Product gaps in the selected baseline

1. **Verification failure repair:** the builder path currently marks a failed verification as FAILED
   immediately. Review-triggered repair exists, but test/format failure must enter a bounded repair
   path with the actual failed diagnostics before the complete desired workflow is demonstrated.
2. **Practical cancellation:** `forge cancel` currently changes a SQLite run row to CANCELLED. That
   alone does not stop running agents, drain their callbacks, or prevent further integration. Fix the
   owned-process lifecycle; do not equate this command's presence with cancellation being finished.
3. **Resume and abandoned attempts:** PREPARING recovery exists, while interrupted STARTING/RUNNING
   becomes UNKNOWN and retains local reservations. v1 needs a clear stopped-process check,
   preserve/abandon/retry choices, and cleanup, rather than adopting that historical distributed path.
4. **Explicit new-file and deletion intent:** contracts have `expectedReads` and `expectedWrites`;
   file/glob selectors primarily resolve existing graph nodes. Add normal `creates`/`deletes` intent
   with repository-relative paths, not invented existing-file IDs or repository-wide authority.
5. **Requirements and planning diagnostics:** no dedicated decision brief or bug-spec workflow exists.
   Introduce only the structured facts that improve decomposition and user decisions.
6. **Model usability and attribution:** later provider/auth fixes, subscriptions, task usage, latency
   and cost reporting are absent. Bring back small independent adapters and observable records.
7. **User-facing execution:** no full-screen TUI, useful cancel/resume controls, or modern completion
   summary. Status is basic JSON. These should follow the functioning local workflow.
8. **Real-repository readiness:** dependency provisioning, immutable per-task verification snapshots,
   Git identity, changed integration bases, conflicts and verification after serialized merges need
   practical acceptance. The baseline's controlled Pi/verification seams are not live-model proof.

## 5. Initial product milestones

| Milestone                                                  | Delivery batch                                                                                                                                                                                                                                      | Completion evidence                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 — Clean end-to-end coding workflow**                  | Reproduce baseline checks; compose one local owner with parallel independent tasks, isolated worktrees, actual verification, review, bounded repair for verification failures, serialized integration and final result. Fix observed blockers only. | A real repository request completes the whole workflow, with overlapping independent agent intervals and an actual repaired failing gate. No PostgreSQL/Temporal/authority service is required. |
| **P2 — Structured planning / creates / bug workflow**      | Small decision brief, reads/modifies/creates/deletes, useful invalid-selector diagnostics and bug reproduction criteria; adapt useful claw-forge primitives, not its architecture.                                                                  | An approved plan creates a previously absent source/test file, prevents two tasks creating the same path concurrently, and fixes a reproducible bug with a regression test.                     |
| **P3 — Execution usability and recovery**                  | Accurate status, cancellation of owned work, explicit retry/abandon, stopped-process resume and failed-worktree cleanup.                                                                                                                            | Cancellation stops further writes/integration; restart does not redo completed tasks; selected failed work can be retried without deleting accepted results.                                    |
| **P4 — Provider/task usage attribution**                   | Task/provider/model/input-output tokens/latency/cost-if-known, verification/review outcomes and repair counts; independent auth adapters as needed.                                                                                                 | A run summary traces each attempt to its provider and outcomes, reports unknown values honestly, and exposes no credentials or private reasoning. No automatic routing is introduced.           |
| **P5 — Product polish / TUI / real-repository validation** | Extract the useful TUI over the local application flow, understandable errors, onboarding and a compact real-repository suite.                                                                                                                      | A user can enter a request, inspect/approve its plan, observe progress, cancel/resume where supported, and understand the integrated result without authority-management commands.              |

These are a small number of delivery milestones, not a requirement to stop for review after each
helper or file. P1 is the first substantial implementation batch. Usability or provider configuration
needed for P1 may be delivered there rather than postponed merely to satisfy milestone labels.

## 6. Validation strategy

- **Primary real scenario:** three tasks in a clean repository: two disjoint tasks actually execute
  concurrently; a dependent task waits; one task's first output fails a real check, is repaired and
  independently reviewed; integrations run one at a time; the final repository passes its own checks.
- **Planning scenario:** introduce a new source file and test through explicit create intent; reject a
  missing existing-file selector with an understandable diagnostic and detect duplicate create paths.
- **Conflict scenario:** tasks modifying the same known file do not run together; unexpected actual
  overlap or a merge conflict stops integration and preserves worktrees for user-directed repair.
- **Cancellation scenario:** cancel while owned coding work runs; stop new dispatch, await/terminate
  owned processes as supported, preserve evidence and ensure no later task is silently integrated.
- **Resume scenario:** stop the single orchestrator, confirm it is no longer active, restart from local
  state, skip completed/integrated work and explicitly retry or abandon interrupted attempts.
- **Provider scenario:** run an equivalent task with explicitly selected providers; compare genuine
  outcomes, repair counts, latency and returned usage. Fixture transport success is not paid-provider
  entitlement or proof of a completed coding workflow.

Use focused algorithm/component tests and real Git/local SQLite integration tests to diagnose
failures. Run `pnpm check` and `pnpm build` against this branch's dependencies. Keep paid-model
acceptance separate and record the baseline, task, model, outcome and evidence. Do not weaken a
repository's verification gate to obtain a completion badge. Do not introduce fleet, partition,
takeover, hostile-writer or global quiescence tests into the v1 acceptance contract.

## Product relevance

- **User-visible problem:** restore a practical request-to-integrated-code tool instead of requiring
  users to operate a distributed authority control plane.
- **Part of Forge v1:** yes; repository understanding, concurrent local coding, verification, review,
  repair, integration and progress are its explicit workflow.
- **Smallest mechanism:** select the already-composed local baseline and selectively restore product
  features. No new runtime abstraction or persistence protocol is implemented in this reset.
- **Added complexity:** this report and a new branch; inherited local runtime complexity is listed
  for proportionate simplification when real product work touches it.
- **Deferrable work:** web inspector, automatic provider routing, exotic isolation and automated
  recovery services. Basic CLI delivery comes first.
- **Hypothetical deployment justification:** none; multi-machine takeover, network partitions,
  hostile writers and distributed ownership transfer are explicitly out of scope.

Every subsequent review must use this order: **Product relevance → Scope correctness → Simplicity →
User workflow impact → Functional correctness → Failure handling → Tests → deeper architectural
edge cases only within the promised execution model.** For each new abstraction, identify the current
v1 workflow requiring it, the simplest solution, why simpler alternatives fail, and the observed
problem. If normal task/run/worktree state suffices, use it.

## Reset verification and next action

History inspection confirmed the selected parent boundary, local CLI/runtime wiring, concurrent
task driver, serialized integration, review/repair composition and the absence of later runtime
packages. Branch creation was verified at the selected SHA while the historical branch stayed at
its original head. Existing local historical credentials/evidence are excluded through untracked
Git-local exclude rules; they were neither read, deleted nor copied into product documentation.

Before the documentation commit, `pnpm check` was attempted: formatting, TypeScript and lint passed,
but Vitest stopped before executing tests because its baseline-wide project glob also discovered
preserved GroundGraph worktrees under `.local/`, producing duplicate project names. No source or
test configuration was changed to hide this result, and no live coding experiment was run. P1 must
scope test discovery to the actual workspace packages, reproduce build/check, and deliver the real
local end-to-end batch, guided by product failures rather than speculative distributed edge cases.
