---
title: OpenCode Engineering Handover
tags:
  - coding-orchestrator
  - handover
  - opencode
  - architecture
status: active
updated: 2026-08-10
---

# OpenCode Engineering Handover

This document is the operational handover for continuing the AI Native Software Delivery
Orchestrator. Read it completely before changing files. It captures the repository's actual state,
accepted architecture, user workflow, unresolved review state, and the required sequence for the
next milestone.

## Immediate instructions

1. Work in `~/Desktop/apra_new/apra-amcos-admin-coding-orchestrator`.
2. Run `git status --short` before doing anything else.
3. Preserve every existing tracked and untracked change. Do not reset, clean, checkout over, stash,
   delete, or rewrite the working tree.
4. Read the changed production files, their tests, `docs/architecture.md`, both relevant ADRs, and
   both Task Impact training guides before starting Milestone 7.
5. Do not commit automatically. The user requires an independent review after every completed
   stage and explicitly authorizes each commit afterward.
6. At the end of every stage, update both progress summaries and prepare a self-contained review
   message. Leave the implementation uncommitted for review.
7. Do not begin a materially broader milestone than the one the user approved.

## Source-of-truth order

When sources disagree, use this order:

```text
current implementation and tests
        |
        v
accepted ADRs and docs/architecture.md
        |
        v
current progress summaries and this handover
        |
        v
older project prompts and conversation history
```

The original project brief requested Nx and npm. Those choices were explicitly superseded. The
project now intentionally uses pnpm without Nx. Do not restore Nx or npm merely because the old
brief mentions them.

## Product goal

Build a TypeScript-native, repository-aware multi-agent coding orchestrator that maximizes useful
parallelism without relying on model guesses for deterministic facts.

The intended long-term flow is:

```text
Specification
      |
      v
Task Planner / Task Contracts
      |
      v
Repository Facts Layer
      |
      v
Predicted Task Impact
      |
      v
Conflict Graph + Functional DAG
      |
      v
Event-driven Scheduler
      |
      v
Isolated Agent Workspaces
      |
      v
Runtime Write Guard / Write Leases
      |
      v
Verification -> Integration -> Persistence / Recovery
```

The core principle is:

> Use deterministic software for repository facts, dependency validation, conflict constraints,
> scheduling, state transitions, leases, Git operations, and verification. Use an LLM only where
> genuine semantic reasoning is required.

## Repository and Git state at handover

Recorded on 2026-08-10:

```text
repository:     ~/Desktop/apra_new/apra-amcos-admin-coding-orchestrator
branch:         codex/remove-nx
HEAD:           7fd4a0f03a98be813f326255b24b9ff7a7c6e011
HEAD subject:   feat: add task impact and conflict analysis
origin:         git@github.com:jeremygu000/AI-native-software-delivery-orchestrator.git
origin/main:    points to the same base commit at handover
working tree:   dirty by design; Milestone 6 follow-up is uncommitted
```

Repository-local commit identity is already configured. Preserve it:

```text
name:  JeremyGu2021
email: isdance2004.yg@gmail.com
```

There are two local SSH identities. The current `origin` configuration has already been used
successfully. Do not rewrite the remote or SSH configuration without first diagnosing a real push
failure.

### Existing working-tree changes

Tracked modifications:

```text
README.md
docs/adr/005-conflict-scoring.md
docs/adr/008-shared-resource-semantics.md
docs/architecture.md
docs/progress-summary.en.md
docs/progress-summary.zh.md
libs/conflict-engine/src/lib/conflict-engine.spec.ts
libs/conflict-engine/src/lib/conflict-engine.ts
libs/domain/src/lib/conflict.ts
libs/task-impact/src/lib/task-impact-analyzer.spec.ts
libs/task-impact/src/lib/task-impact-analyzer.ts
```

Untracked documents:

```text
docs/task-impact-analysis.en.md
docs/task-impact-analysis.zh.md
docs/opencode-handover.md
```

Ordinary `git diff` does not show untracked documents. Read them directly or use
`git diff --no-index /dev/null <file>` when preparing a review package.

### Review status of the dirty tree

The production-code changes implement the final Milestone 6 correctness follow-up:

- preserve project/file/glob/symbol write provenance;
- prevent broad scope from being downgraded to sibling-symbol risk;
- preserve producer-to-consumer direction independently of task-ID sorting;
- keep a zero-score risk result parallel even when the guarded threshold is zero.

These code changes passed independent review with no Critical, High, or Medium findings.

The new bilingual Task Impact training documents also passed an independent review. That review
identified one Medium documentation gap and one Low readability issue. Both were corrected after
the report:

- project/file/symbol ambiguity behavior is now described separately;
- a file path resolved only through the shared-resource registry is documented as a valid zero
  graph-file match without an ambiguity signal;
- canonical task-ID ordering is explained at first use.

The corrections have not yet received the final follow-up confirmation at the time of this
handover. They do not change implementation behavior. Before committing, obtain or perform the
focused documentation verification requested by the user.

## User workflow that must be preserved

### Review and commit protocol

For every stage:

```text
implement
   |
   v
tests + build + documentation + real-repository check when relevant
   |
   v
update progress-summary.en.md and progress-summary.zh.md
   |
   v
prepare a detailed independent-review message
   |
   v
STOP without committing
   |
   v
user obtains review
   |
   v
fix valid findings and repeat validation
   |
   v
commit only after explicit user approval
```

Never make an automatic “cleanup commit.” Do not amend, push, or open a PR unless the user asks.

### Progress and training documentation

- Code, comments, commit messages, ADRs, architecture documentation, and normal repository Markdown
  are English.
- `docs/progress-summary.en.md` and `docs/progress-summary.zh.md` are maintained together.
- Major implemented mechanisms receive standalone English and Chinese training guides for a reader
  without prior experience.
- Existing guides:
  - `docs/repository-graph-analysis.en.md`
  - `docs/repository-graph-analysis.zh.md`
  - `docs/task-impact-analysis.en.md`
  - `docs/task-impact-analysis.zh.md`
- Do not preserve long repetitive review transcripts. Summarize review history as a timeline of
  finding and fix, then focus on the accepted mechanism.

### Obsidian synchronization

The progress summaries and standalone training guides are mirrored under:

```text
~/Documents/obasidian_vault/obsidian_vau;t/Coding Orchestrator
```

Current note names include:

```text
Progress Summary (English).md
项目进展说明（中文）.md
repository-graph-analysis.en.md
repository-graph-analysis.zh.md
task-impact-analysis.en.md
task-impact-analysis.zh.md
```

The installed `obsidian` CLI has repeatedly exited with code 134 because it could not connect to a
running compatible Obsidian instance. The established fallback is an explicit file copy followed by
`cmp -s` for byte-for-byte verification. Do not assume a successful copy without verification.

### Style constraints from the user

- Do not add re-exports unless they are absolutely necessary. Prefer importing from the owning
  module and keep private helpers private.
- Do not create empty libraries in anticipation of future milestones.
- Do not add Nx.
- Do not add a second TypeScript version.
- Do not introduce Rspack for the CLI. esbuild is intentionally sufficient for the current single
  Node entry point.
- Do not let product- or client-specific names enter this repository. The public title is
  `AI Native Software Delivery Orchestrator`.
- Do not add LLM, pnpm, Git, Jira, provider, or persistence concerns to deterministic core domain
  logic.

## Toolchain and workspace

```text
runtime:          Node.js 24+
package manager:  pnpm 11.1.0
language:         TypeScript 7.0.2 native compiler
module format:    strict ESM
tests:            Vitest 4 + V8 coverage
validation:       Zod 4
lint:             type-aware Oxlint
format:           Oxfmt
CLI:              Commander
CLI bundle:       esbuild
persistence deps: Drizzle + SQLite-ready dependencies installed, not implemented
license:          Apache-2.0
```

The workspace is pnpm plus TypeScript project references. There is no task runner or monorepo
orchestrator beyond the package scripts.

Required commands:

```bash
pnpm install
pnpm check
pnpm build
git diff --check
```

`pnpm check` runs formatting, TypeScript declaration checking, type-aware linting, and coverage.
Before a commit, all three commands above must pass.

The current validated baseline is:

```text
test files:  10 passed
tests:       99 passed
statements:  96.67%
branches:    91.26%
functions:   99.51%
lines:       96.60%
build:       passed
diff check:  passed
```

TypeScript 7 native can produce an internal Go panic when its output directory is not writable.
This was observed when a sandbox permitted reading the repository but denied writing declaration
artifacts. It is a misleading permission failure, not automatically a source-code defect. Confirm
directory permissions before diagnosing such a panic as a compiler or project regression.

## Current package boundaries

```text
                         domain
                        /  |   \
                       /   |    \
                    dag    |   repository-analysis
                           |
                      task-impact
                           |
                    conflict-engine

future scheduler should consume domain contracts and DAG functions
without importing CLI, repository providers, Git, persistence, or LLM code
```

Current responsibilities:

| Package               | Responsibility                                                             |
| --------------------- | -------------------------------------------------------------------------- |
| `domain`              | Task, graph, impact/conflict, execution, state, and lease contracts        |
| `dag`                 | Validation, SCC cycle reporting, topology, ready-task calculation          |
| `repository-analysis` | pnpm workspace facts plus TypeScript semantic graph                        |
| `task-impact`         | Selector resolution, impact expansion, shared-resource registry            |
| `conflict-engine`     | Pairwise reasons, structural constraints, deterministic risk scoring       |
| `apps/cli`            | Thin Commander adapter; currently exposes `analyze` and placeholder `plan` |

`domain` owns types and policies that are package-manager-neutral. `repository-analysis` owns pnpm
and TypeScript integration. The native TypeScript API must never escape into domain types.

When adding `libs/scheduler`, create it only together with a real implementation and tests. Its
likely direct dependencies are `domain` and `dag`. It should consume already-produced
`HardTaskConflict[]` and `RiskTaskConflict[]`; it should not need to import the conflict-engine
implementation to recompute them.

## What is complete

### Milestones 1–3: foundation, domain, and DAG

- Strict TypeScript 7 ESM pnpm workspace.
- Task Contract schemas for project, file, glob, symbol, and shared-resource selectors.
- Explicit task-state transition validation.
- Self-contained hierarchical Write Lease contracts with run identity, versioning, heartbeat,
  stale/release states, containment, and idempotent release semantics.
- Stack-safe DAG validation for deep chains.
- Duplicate tasks/dependencies, missing dependencies, self-dependencies, and every SCC cycle are
  reported deterministically.
- Stable priority/ID ordering, topological sort, and ready-task calculation.

### Milestones 4–5: Repository Facts Layer

`forge analyze <repository>` is a real deterministic implementation, not LLM analysis and not a
simple directory listing.

It combines:

```text
pnpm-workspace.yaml + package.json manifests
                       |
                       +--> projects and declared project dependencies

TypeScript 7 Programs + Checkers
                       |
                       +--> files, symbols, imports, references, semantic project edges
```

Important accepted behavior includes solution-style tsconfig references, deterministic compiler
context ownership, real-path/symlink identity, repository-boundary checks, generated markers,
stable symbol IDs, declaration merging, computed names, explicit cleanup, and structured
diagnostics for missing/empty/uncovered TypeScript projects.

The CLI exposes:

```bash
pnpm build
pnpm exec forge analyze .
pnpm exec forge analyze . --full
```

`forge plan` is intentionally a placeholder and exits with “Planning is not available yet.”

### Milestone 6: Task Impact and Conflict Engine

The accepted deterministic flow is:

```text
TaskContract + RepositoryGraph + SharedResourceRegistry
                          |
                          v
               PredictedTaskImpact
                          |
                compare task pairs
                          |
                          v
                    TaskConflict
             /                           \
    HardTaskConflict              RiskTaskConflict
```

Implemented impact behavior:

- project, file, glob, symbol, and shared-resource selector resolution;
- project/file/symbol ancestry;
- explicit ambiguity signals, including the registry-only non-graph file exception;
- shared-resource `read`, `write`, and `coordinate` modes;
- exclusive, ordered, and producer-controlled policies;
- reverse transitive downstream-project expansion;
- exported-symbol, generated-artifact, ambiguity, and high-fan-out signals;
- separate explicit-project, exact-file, glob-file, and symbol-derived-file write provenance;
- stable, locale-independent output ordering;
- fail-fast `UNKNOWN_SHARED_RESOURCE` for explicitly named unknown resources.

Implemented conflict behavior:

- same-symbol structural serialization;
- sibling-symbol soft risk only when both tasks are purely symbol-scoped for the file;
- whole-file treatment whenever broader project/file/glob scope covers the file;
- repository read/write producer-consumer reasons without inventing a DAG edge;
- generated overlap, same-project, upstream/downstream, public API, and high-fan-out reasons;
- exclusive and competing producer-controlled resources serialize;
- ordered resources stagger;
- producer-controlled writer/reader constraints preserve actual direction;
- producer-controlled read/read remains parallel;
- hard conflicts contain a non-empty structural-constraint tuple;
- risk conflicts contain no constraints;
- hard enforcement is independent of numeric score;
- zero risk always recommends plain parallel, even with a zero guarded threshold;
- pair output, reasons, constraints, and resource IDs are deterministic.

For the complete teaching model, read:

- `docs/repository-graph-analysis.en.md`
- `docs/task-impact-analysis.en.md`

## Current real-repository evidence

The project uses two repositories for regression evidence.

### Self-analysis

Latest recorded Milestone 6 sample:

```text
projects:             7
files:                40
symbols:              477
projectDependencies:  13
fileDependencies:     62
symbolReferences:     811
diagnostics:           2 expected root-project diagnostics
```

### Research repository

Path:

```text
~/Desktop/apra_new/apra-amcos-admin-ingestion-and-matching
```

Latest recorded sample:

```text
projects:             3
files:                968
symbols:              7309
projectDependencies:  3
fileDependencies:     3446
symbolReferences:     13192
diagnostics:           1 UNCOVERED_TYPESCRIPT_FILES
```

The remaining diagnostic covers 25 scripts under `workspace/api/src/scripts/**`. This is expected
and documented. The research repository is active, so small count drift is normal. Investigate
semantic changes, new diagnostics, large count changes, or crashes rather than treating every
small numerical difference as a regression.

When a repository-analysis milestone or cross-layer contract changes, rebuild and run both:

```bash
pnpm exec forge analyze .
pnpm exec forge analyze ~/Desktop/apra_new/apra-amcos-admin-ingestion-and-matching
```

Task Impact and Conflict Engine are currently library APIs. `forge analyze` still returns repository
facts only.

## Known limitations and accepted technical debt

These are documented and are not current blockers:

- generated files may create diagnostic noise because visibility is currently preferred over silent
  exclusion;
- Repository Facts analysis has been exercised around one thousand files, not tens of thousands;
- impact selector lookup currently scans in-memory maps rather than a dedicated index;
- project-to-file semantics are consulted in both project impact expansion and conflict overlap;
  review both paths together if either representation changes;
- `coordinate` on a producer-controlled resource is intentionally conservative and has no producer
  direction;
- repository read/write overlap creates a scored producer-consumer reason; only an explicit
  producer-controlled registry policy creates a hard directional constraint;
- `HardTaskConflict.score` remains explanation metadata. Milestone 7 must prove that the Scheduler
  never filters or selectively enforces hard conflicts by score;
- observed impact collection and prediction reconciliation are not implemented;
- incremental repository refresh and impact caching are not implemented;
- recoverable integration blocking is deferred. Before Git integration, design a phase-aware model
  rather than adding a lossy `INTEGRATING -> BLOCKED -> READY` path.

Do not “fix” accepted limitations during Scheduler work unless they directly block the approved
Scheduler scope and the user agrees to expand it.

## Next milestone: Milestone 7 Scheduler

### Objective

Implement deterministic, event-driven dispatch that maximizes useful concurrency while respecting:

- functional task dependencies;
- structural hard constraints;
- scored risk recommendations according to explicit policy;
- task priority and stable task-ID tie-breaking;
- already running tasks;
- maximum concurrency;
- runtime events that change readiness.

An initial `ExecutionPlan.waves` view may be produced for explanation. It must never become a
runtime barrier.

### Existing contracts are intentionally incomplete

`libs/domain/src/lib/execution.ts` currently contains:

```text
ExecutionWave { index, taskIds, reason?: string }
ExecutionPlan { waves }
ScheduleOptions { maxConcurrency }
SchedulerEvent { type, taskId }
SchedulerSnapshot { taskStates, runningTaskIds }
SchedulerDecision { startTaskIds, blockedTaskIds, reasons: string[] }
Scheduler.createInitialPlan(...)
Scheduler.reevaluate(...)
```

Do not implement the Scheduler directly against the thin string fields. The accepted architecture
gate requires Scheduler events and decision reasons to become structured discriminated payloads
first, suitable for audit, persistence, and replay.

### Required implementation sequence

#### 1. Audit and harden the domain contracts

Design and test structured event variants. At minimum, the existing event meanings must remain
representable:

```text
task-completed
task-failed
lease-released
lease-blocked
lease-stale
runtime-conflict-discovered
workspace-integrated
verification-completed
```

Each variant should carry only the evidence required to replay the decision. Do not hide state in
free-form text. If event identity, run identity, sequence, or time is added, keep the deterministic
ordering rule explicit; never call `Date.now()` inside scheduling logic to break ties.

Replace flat `reasons: string[]` with per-task structured reasons. Required reason categories are
likely to include:

```text
dependency incomplete
task state not runnable
hard conflict with an active/selected task
producer must complete first
max concurrency reached
risk policy deferred the task
priority/ID selection explanation
lease or runtime conflict blocked the task
```

The exact names are a design decision. Write compile-time and runtime tests for the chosen
discriminated union. Keep human-readable detail as metadata, not the only machine-readable fact.

Review whether `SchedulerSnapshot` contains enough reconstructable state. Extend it only with
domain facts the scheduler truly needs; do not leak persistence records, Git worktrees, pnpm, or
provider types into it.

#### 2. Decide unresolved Scheduler policies before coding the engine

Document and test these choices explicitly:

1. How `parallel`, `guarded-parallel`, `stagger`, and `serialize` risk recommendations affect
   selection when no hard constraint exists.
2. How an undirected `ordered-resource` pair chooses first task—priority and then stable task ID is
   the expected deterministic basis unless a stronger explicit order exists.
3. How directional `producer-consumer` constraints become runtime readiness without rewriting or
   confusing the original functional DAG.
4. What happens to transitive dependants after a task fails. Do not leave them silently pending
   forever. The policy must fit the existing state machine, where terminal `FAILED` and `CANCELLED`
   states cannot transition again.
5. How tasks blocked during `RUNNING` return through `BLOCKED -> READY` after lease/runtime events.
6. Whether `createInitialPlan` is only explanatory or also a deterministic preview of the same
   selection policy. It must not own runtime progress.

These are architecture decisions, not incidental loop behavior. If the choice materially changes
product semantics, present it to the user before implementation.

#### 3. Implement a meaningful scheduler package

Create `libs/scheduler` only when adding the implementation and tests in the same stage. Use a
simple deterministic greedy algorithm; do not introduce an optimization solver.

Suggested control flow:

```text
validate tasks and options
        |
        v
derive dependency-ready candidates from current task states
        |
        v
apply directional producer readiness
        |
        v
sort by priority, then stable task ID
        |
        v
for each candidate:
  compare with running tasks and already selected starts
  enforce every hard constraint regardless of score
  apply explicit risk policy
  respect remaining concurrency capacity
        |
        v
return structured start/block decisions and reasons
```

Prefer pure functions and immutable inputs. Do not perform execution, acquire leases, mutate Git,
write persistence, or invoke agents inside the Scheduler.

#### 4. Produce an initial wave visualization without a wave barrier

`createInitialPlan` may group a static preview into waves. Runtime `reevaluate` must not wait for an
entire preview wave to finish.

Required counterexample:

```text
initial visualization:
  wave 0 = [A, B]
  wave 1 = [C depends only on A]

runtime:
  A completes while B is still running
  C has no conflict with B

expected:
  C may start immediately
  C must not wait for B merely because B shared wave 0
```

This test is mandatory. A hidden wave barrier violates the accepted architecture.

#### 5. Add adversarial tests, not only happy paths

At minimum cover:

- invalid task graph: duplicate tasks/dependencies, missing dependencies, self-dependency, cycles;
- stable priority and task-ID ordering;
- max concurrency with already-running tasks;
- hard conflict enforced even when its score is zero;
- hard conflicts never filtered by score or risk threshold;
- same-symbol hard serialization;
- sibling-symbol soft-risk policy;
- producer direction when lexical task-ID order is both aligned and reversed;
- producer not ready, then unblocked after producer completion;
- ordered and exclusive resources;
- independent tasks start together;
- a high risk score does not replace a functional dependency;
- task completion makes only its true dependants ready;
- task failure propagation follows the documented policy;
- blocked task returns only through a valid state transition;
- runtime conflict/lease events cause reevaluation;
- the no-wave-barrier scenario above;
- repeat calls with identical inputs return deeply equal, stably ordered decisions;
- empty input and `maxConcurrency` boundary validation.

Use table-driven tests where appropriate. Preserve project-wide coverage thresholds of at least
90% for statements, branches, functions, and lines.

#### 6. Integrate the workspace mechanically

If `libs/scheduler` is added:

- add its package manifest and TypeScript project references;
- add it to the root `build:packages` script;
- add its Vitest project/config consistently with existing libraries;
- add only direct dependencies actually imported;
- keep ESM `.js` suffixes and `import type` for type-only imports;
- do not add Nx metadata or generated project files;
- do not add a public re-export merely for convenience.

Do not wire `forge plan` until the Scheduler API and task-spec input path are genuinely usable and
tested end to end. A truthful placeholder is better than a command that only partially schedules.

#### 7. Validate and document the stage

Run:

```bash
pnpm check
pnpm build
git diff --check
```

Run self-analysis and the research repository if package structure or repository-analysis behavior
changes. Update:

```text
README.md
docs/architecture.md
relevant ADR or a new focused ADR
docs/progress-summary.en.md
docs/progress-summary.zh.md
```

Create bilingual Scheduler training guides after Milestone 7 behavior has passed independent
review, following the RepositoryGraph and Task Impact guide style with ASCII diagrams and worked
examples.

Prepare a review package that includes the milestone base SHA, current Git state, every changed
file, complete diff, key file contents, exact commands/results, edge-case coverage, architecture
dependencies, public interfaces, known limitations, and specific reviewer questions. Stop without
committing.

### Milestone 7 acceptance criteria

Milestone 7 is not complete until all of the following are true:

1. Scheduler inputs and decisions use structured machine-readable event/reason contracts.
2. The task DAG is validated before scheduling.
3. Functional readiness, hard constraints, risk policy, priority, running work, and max concurrency
   are all enforced deterministically.
4. Every hard constraint is applied regardless of numeric score.
5. Producer-consumer direction is preserved independently of task-ID order.
6. Runtime reevaluation is event-driven and contains no execution-wave barrier.
7. Failure and blocking/unblocking behavior is explicit and tested.
8. Repeated equal inputs produce stable equal output.
9. The Scheduler contains no LLM, CLI, pnpm, repository-provider, Git, worktree, persistence, or
   agent-runtime implementation details.
10. Quality gates and coverage pass.
11. Architecture and both progress summaries describe actual behavior without overclaiming runtime
    capabilities.
12. Independent review finds no unresolved Critical, High, or blocking Medium issue.

## Later milestones: do not pull them forward

### Milestone 8: Runtime Guard

Implement live lease acquisition, simultaneous-acquisition safety, heartbeat, evidence-based stale
recovery, idempotent release, and observed scope enforcement. It must use the already accepted
self-contained project/file/symbol/shared-resource hierarchy.

### Milestone 9: Persistence

Persist reconstructable runs, events, transitions, conflicts, decisions, observations, and leases
through Drizzle/SQLite ports. Recovery and replay semantics become mandatory here. Do not persist
raw AST objects.

### Milestone 10: Workspace and Git

Create isolated worktrees, rebase, integrate, and dispose through ports. Before supporting
recoverable integration conflicts, design a phase-aware resume model. Do not use the existing
generic `BLOCKED -> READY` transition to lose whether a task was executing or integrating.

Agent runtime, provider/Jira adapters, planner LLM integration, advanced verification, and brokers
for lockfiles/migrations/generated files remain beyond the deterministic core unless the user
explicitly reprioritizes them.

## Architecture red flags for review

Stop and reconsider if a change does any of the following:

- asks an LLM whether two known repository scopes conflict;
- merges the functional DAG and conflict graph into one ambiguous edge type;
- converts hard constraints into a score threshold;
- filters `HardTaskConflict[]` by score;
- uses initial waves as runtime barriers;
- lets task-ID sorting invent producer direction;
- treats predicted writes as runtime authorization;
- silently expands observed scope;
- hides task failure by leaving dependants pending forever;
- adds arbitrary state transitions to make one test pass;
- puts pnpm, TypeScript native objects, Git, Jira, database rows, or provider SDK types in domain or
  Scheduler logic;
- adds re-export layers solely to shorten imports;
- creates empty future libraries;
- introduces Nx, a second TypeScript compiler, or Rspack without a new demonstrated requirement;
- claims runtime execution, observation, persistence, or recovery before it exists.

## First recommended OpenCode response

Before editing, report back to the user with:

1. the observed branch, HEAD, and dirty working-tree files;
2. confirmation that existing changes will be preserved;
3. confirmation that Milestone 6 code is accepted and only the final documentation follow-up is
   pending;
4. a short Milestone 7 contract-first plan;
5. any semantic decision that genuinely needs user approval before implementation.

Do not begin by cleaning the repository, committing existing work, or generating a Scheduler
library before the contracts and policies above have been reviewed.
