# Forge v1: revised product baseline and delivery plan

## Decision

Select **`ce358ca25c2b2fed706690b16406af3204f2d435` — semantic plan review**.
The local `product/forge-v1` branch now starts at this commit. This revision supersedes the
rejected `10bd7f9` recommendation: being before Global Authority or Runtime V2 is not enough.
The boundary must precede approval/authority becoming the execution architecture.

The earlier report commit `9f0a645713a1dfc3852f88223ae861ed24326475` is preserved locally and on
`origin/archive/forge-v1-stage24-candidate`. With explicit user authorization, we fetched and
verified that the old remote product branch still pointed to that exact SHA, pushed the archive
and verified its SHA, then replaced `origin/product/forge-v1` with the selected `ce358ca` baseline
using an explicit `--force-with-lease` against the old SHA. This report correction is committed
after that replacement. The historical `m4/postgres-durable-authority` branch remains unchanged
at `4204cfc4f3e01351200dc97929847148c1f143be`. No merge or cherry-pick occurred.

This is a small documentation/branch correction. P1 implementation has not started.

## 1. Four-candidate comparison

| Commit                                         | Product capabilities                                                                                                                                                                               | Approval/authority coupling                                                                                                                                                                                                   | Decision                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **`ce358ca25c2b2fed706690b16406af3204f2d435`** | Repository graph, task contracts/DAG, impact/conflicts, scheduler, concurrent local agents, worktrees, SQLite, controlled Pi execution, verification, autonomous planning and semantic plan review | Local write guard/leases, versions, replay and interrupted-attempt handling already exist, but no PlanArtifact, approval claim, PlanExecutionIntent or run authority evidence. CLI offers analyze/plan; runtime is a library. | **Select:** latest inspected product-rich boundary before the durable approval architecture begins.                   |
| `2356dc062967703c75094a7707dfc0739f9b4bd5`     | Adds persisted planning output                                                                                                                                                                     | Immutable PlanArtifact revisions bind source, Git snapshot, repository facts and policy fingerprints; integrity and repository binding become planning contracts.                                                             | Reject as baseline. Extract simple plan storage only if needed.                                                       |
| `9982ddd749ba5e30ea7d6beb7bbf37c03c1d8476`     | Adds user approval and execution binding                                                                                                                                                           | Fingerprinted approval, atomic single-run approval claim, Git/facts recapture, PlanExecutionIntent and execution fingerprint.                                                                                                 | Reject: user approval has become a protocol rather than a small product decision.                                     |
| `10bd7f9f4f6a2b3a8b3b82d3b885bf0064003afc`     | Adds local CLI run/status/cancel, observed reconciliation and composed review/repair                                                                                                               | Inherits those approval protocols plus runtime revalidation and persisted complete RunAuthorityEvidence.                                                                                                                      | Reject despite more features. The previous report incorrectly treated the Runtime V2 boundary as the relevant cutoff. |

Evidence inspected: each commit's CLI, domain persistence contracts, planning contracts,
SQLite implementation and local runtime. `ce358ca` has 12 libraries and no `run-preparation`,
PostgreSQL, Temporal or Restate package. Its `PersistedRun` contains id, repositoryId, state and
createdAt, without later run authority fields. `OrchestrationRuntime` has a bounded concurrent
promise driver and a process-local lifecycle queue that serializes verification/integration.
Its CLI does not expose approve/bind/run/status/cancel yet.

The selected baseline is not entirely simple: `WriteLease`, heartbeat/version/stale handling,
persisted scheduler decisions and UNKNOWN attempts are present. These are **not approved as
the new product model**. Their necessary behavior is reassessed below; their existence is not
a mandate to extend or preserve their protocol.

## 2. Capability inventory

### KEEP — capabilities already present

- Repository analysis and graph, task contracts, dependency DAG.
- Deterministic impact/conflict algorithms and scheduler readiness/concurrency decisions.
- Concurrent local coding agents and isolated Git task worktrees.
- Serialized integration and verification before integration.
- Provider-neutral agent runner, explicit controlled tools and bounded planning attempts.
- Autonomous planning and semantic **plan** review.
- Simple SQLite run/task/workspace/attempt state: retain useful records, not every schema detail.

### SELECTIVELY PORT / REDESIGN — product behavior, not old contracts

- **Plan persistence and user approval:** start with a Plan containing id, repositoryCommit and
  tasks, a visible user approval, and a Run referring to the plan. A normal pre-run repository
  change check is enough initially. Do not import PlanArtifact fingerprints/revisions,
  ApprovalClaim, PlanExecutionIntent, ExecutionBinding or RunAuthorityEvidence.
- **Local run command/composition:** connect the existing planner and execution libraries through
  that small product model, not `run-preparation`'s authority revalidation chain.
- **Code review and bounded repair:** the baseline has semantic plan review, not the later
  integrated output-review/repair loop. Extract review findings, actual verification diagnostics,
  bounded rework and repeat verification; represent them as task attempts and results.
- **Observed diff reconciliation:** extract Git created/modified/deleted paths and compare to task
  intent before integration, without durable mutation-permit or ownership-transfer concepts.
- **Status, actual cancellation, retry/resume and cleanup:** implement owned-process behavior and
  clear user choices, rather than copying database-only cancel or fleet recovery assumptions.
- **TUI, model/auth adapters and attribution:** extract useful UI, independent provider choices,
  task usage and tracing through local application operations. No authority prerequisites.
- **Real-repository fixes:** selectively adapt tested tool errors, verification environments and
  Git identity handling when required by an observed v1 workflow.

### REASSESS — inherited implementation is not automatically KEEP

- Write leases: preserve **preventing overlapping same-run mutations**, preferably as ordinary
  in-memory task resource reservations owned by the single orchestrator. No cross-run lease service.
- Scheduler replay: preserve **knowing completed/pending work after restart**. Full deterministic
  decision replay must justify itself in P3; snapshots and an ordinary event log may suffice.
- UNKNOWN/stale/CAS handling: express interruption and explicit abandon/retry in normal attempt
  state after the old process has stopped. Do not preserve distributed ownership semantics.

The local execution changes in P1 must explicitly choose the small reservation/state boundaries
they need. This is not the previous strategy of importing the approval architecture and hoping
to simplify it later. Unneeded replay/recovery machinery is not a prerequisite for P1.

### DO NOT PORT

PlanArtifact authority binding, atomic approval claims, PlanExecutionIntent, RunAuthorityEvidence;
PostgreSQL authority bootstrap/migrations/roles; GlobalMutationAuthority and cross-run claims or
permits; stale remote-writer fencing; signed recovery/quiescence; parent/child handoff; orphan permit
settlement; authority generations/supervisors; Temporal/Restate fleets or takeover parity harnesses.
No merge or wholesale architectural milestone cherry-pick from the historical branch is planned.

## 3. Complexity boundary

Supported v1: one active orchestrator owns a run; tasks can code concurrently in isolated
worktrees; the scheduler prevents known conflicts; actual diffs are inspectable; successful
integration requires verification and review; repair is bounded; Git integration is serialized;
local state enables progress, explicit retry and practical stopped-process restart.

Not supported: multi-machine active-active execution, arbitrary takeover, partition guarantees,
hostile writers, global authority or distributed proof protocols. A small local guard against
accidentally opening the same run twice is acceptable only when needed by that user workflow.

Before any abstraction: name the current v1 user problem, the simplest solution, why a simpler
mechanism fails, and the observed failure. Prefer ordinary run/task/worktree state. Capability
extraction must not pull in authority contracts merely to satisfy old imports or tests.

## 4. Product gaps at this earlier baseline

1. CLI analyze/plan exists, but no simple persisted plan approval → local run composition.
2. Output code review and repair must be restored; verification failure currently fails a task
   rather than repairing it. Semantic plan review is not output code review.
3. Observed diff reconciliation must be restored; existing controlled tool observations alone
   are not a complete check of actual Git changes.
4. Practical cancellation, failed-attempt abandonment/retry, worktree cleanup and resume remain
   product work. Existing interrupted attempts and replay are not proof these workflows are finished.
5. Task selectors cover reads/writes of existing graph nodes; explicit creates/deletes, a small
   decision brief and bug reproduction criteria are missing.
6. Provider/model configuration, usage attribution, modern status/TUI and reproducible real-repo
   verification environments need selective restoration.

This is deliberately less feature-complete than `10bd7f9`. The missing product behaviors are
cheaper to restore with simple semantics than to remove authority coupling from every later port,
schema, test and CLI flow.

## 5. Initial milestones — unchanged product priorities

| Milestone                                                  | Small delivery mechanism                                                                                                                                                                                                                                | Acceptance                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 — Clean end-to-end coding workflow**                  | First scope Vitest discovery to actual workspace packages and reproduce checks/build. Add simple Plan approval/Run composition, same-run reservations, parallel worktrees, real verification, output review, bounded repair and serialized integration. | Real three-task request: two independent coding intervals overlap, a dependent task waits, a failed gate is repaired/reviewed, final integrated repository passes its own checks. |
| **P2 — Structured planning / creates / bug workflow**      | Small decision brief; reads/modifies/creates/deletes; useful diagnostics and regression criteria. Adapt useful claw-forge primitives only.                                                                                                              | Create a previously absent source/test file; detect duplicate create paths; fix a reproduced bug with a test.                                                                     |
| **P3 — Execution usability and recovery**                  | Accurate status, cancellation of owned processes, explicit retry/abandon/cleanup, stopped-process resume. Reassess whether full replay is needed.                                                                                                       | No post-cancel silent integration; completed work is not repeated after restart; failed work is preserved or deliberately discarded.                                              |
| **P4 — Provider/task usage attribution**                   | Explicit provider/model, returned input/output tokens, latency, known cost and verification/review/repair outcomes.                                                                                                                                     | Useful per-attempt comparison; unknown usage remains unknown; no credentials/private reasoning persisted and no automatic routing.                                                |
| **P5 — Product polish / TUI / real-repository validation** | Local CLI/TUI input, plan approval, progress, understandable errors and onboarding.                                                                                                                                                                     | A user delivers code without authority-management commands; compact real-repository acceptance proves usability.                                                                  |

P1 is a substantial product batch, not a sequence of reviews for each helper. Needed provider or
usability work can occur in P1. No distributed correctness milestones are introduced.

## 6. Validation strategy

- Real repository, three tasks: two parallel worktrees, one dependency, actual failed check,
  bounded repair, independent output review, one-at-a-time integration and final checks.
- Existing-file modification and explicit new-file creation: meaningful planning diagnostics,
  duplicate-path collision prevention, and actual diff inspection.
- Known overlapping writes serialize; unexpected overlap/merge conflict stops integration and
  preserves work for user-directed repair.
- Cancel owned work: stop dispatch and settle/terminate owned agents as supported; show actual
  outcome without treating a database state update as process termination.
- Stop/restart the single owner: skip integrated tasks and deliberately retry/abandon interrupted
  attempts. No stale remote-worker or takeover matrix.
- Explicit provider comparison: genuine task outcomes/repair counts/latency/returned usage;
  transport fixtures are not paid-model end-to-end evidence.

Use focused algorithms, real Git and local SQLite tests. Do not weaken repository verification.
No baseline test suite or live model run completed in this correction. Historical `ce358ca` records
report 397 tests in 29 files and checks/build passing; these are not fresh validation. The current
pre-commit `pnpm check` passed formatting, typechecking and lint, then stopped at duplicate `.local/`
Vitest project names before tests ran, reproducing the earlier candidate's discovery blocker.
`git diff --check` also passed. P1's first action is a direct workspace-scoped glob fix, not a
registry abstraction. No source or test configuration was changed during the branch correction.

## Product relevance

- User problem: restore practical software delivery without an approval/authority control plane.
- v1 relevance: the explicit single-owner coding workflow requires it.
- Smallest mechanism: move the baseline before durable approval coupling, preserve the rejected
  candidate, and describe selective product restoration; no runtime feature is implemented here.
- Complexity added: documentation and a local branch/archive name; inherited reservations/replay
  are explicitly reassessed, not endorsed as product contracts.
- Defer: web inspector, automatic routing, exotic isolation, distributed recovery and full replay
  unless a current product scenario demonstrates need.
- Hypothetical deployment justification: none.

Review order: **Product relevance → Scope correctness → Simplicity → User workflow impact →
Functional correctness → Failure handling → Tests → deeper edge cases inside the promised model.**
