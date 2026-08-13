# AI Native Software Delivery Orchestrator

A TypeScript-native, repository-aware multi-agent coding orchestrator. The system is designed to
derive safe execution decisions from task dependencies, repository structure, symbol impact,
shared resources, and runtime write ownership instead of relying on model guesses about
parallelism.

## Current milestone

Milestones 1–21 establish the deterministic analysis, planning, approval, dispatch, write-safety, recovery,
and local Git workspace core:

- TypeScript 7 native CLI checks and ESM in a pnpm workspace;
- pnpm workspaces for dependency management;
- a Commander-based `forge` CLI shell;
- validated task contracts and orchestration domain models;
- explicit task lifecycle transition rules;
- stack-safe DAG validation, complete SCC cycle diagnostics, and stable ordering;
- deterministic topological sorting and ready-task calculation;
- self-contained hierarchical write-resource and recoverable lease contracts;
- pnpm workspace discovery and deterministic local package dependency mapping;
- TypeScript 7-native analysis of files, imports, exports, declarations, and symbol references;
- recursive solution-style project-reference discovery and explicit empty/missing-project diagnostics;
- a working `forge analyze` command with summary and `--full` repository-graph output;
- deterministic task-selector resolution with project, file, glob, symbol, and shared-resource scope;
- transitive downstream-project expansion and explicit `public-api-touch` risk reporting;
- a configurable shared-resource registry with exclusive, ordered, and producer-controlled policies;
- structurally separate hard conflicts and scored risks with explainable reasons and actions;
- structured scheduler events, runtime blockers, snapshots, decisions, and reason evidence;
- deterministic event-driven dispatch respecting dependencies, producer direction, hard constraints,
  risk policy, priority, existing work, and maximum concurrency;
- explanatory execution waves that never become a runtime barrier;
- an in-memory, concurrency-safe exclusive Write Guard with versioned heartbeat, evidence-based stale
  recovery, and idempotent release;
- SQLite/Drizzle persistence for reconstructable runs, events, decisions, transitions, impacts,
  conflicts, and leases, including verified Scheduler decision replay;
- isolated Git worktrees with phase-aware integration blocking, rebase, fast-forward-only integration,
  explicit resume/abort, and dirty-workspace disposal protection;
- an application orchestration runtime that coordinates Scheduler, workspaces, leases,
  persistence, verification, and provider-neutral fake agents, with durable agent attempts and
  deterministic multi-resource lease plans; independent agent calls may overlap while lifecycle and
  Git integration operations remain serialized;
- a Pi-backed `AgentRunner` with controlled filesystem tools, policy-controlled fixed commands, and
  optional hardened validation sandbox profiles; Pi built-in mutation and shell tools are disabled;
- an autonomous Plan phase that turns a user request or Markdown specification into validated Task
  Contracts, resolves them against Repository Facts, analyzes impact and conflicts, and produces a
  Scheduler preview through a bounded deterministic revision loop;
- a working `forge plan <specification.md>` command whose Pi planner can inspect only paginated,
  read-only Repository Facts tools and cannot mutate the repository or execute commands; every
  autonomous task must reference a discovered package script for verification, while free-form
  command verification fails closed;
- a separate semantic Plan Reviewer that maps source requirements to proposed task IDs, requests
  bounded Planner revision for missing or ambiguous coverage, and is followed by full deterministic
  revalidation; its recommendation is evidence, never execution approval;
- immutable, JSON-safe PlanArtifact revisions bound to the planning source, Git commit and working-tree
  bytes, Repository Facts, shared-resource policy, verification policy, and complete planning decision;
  `forge plan` stores them atomically under `~/.forge/plans/<repository-id>` by default;
- immutable provider-neutral approvals tied to an exact artifact revision and fingerprint, atomic
  single-run approval claims, and execution binding that recaptures Git and Repository Facts and
  revalidates shared-resource and verification policy before producing a `PlanExecutionIntent`;
- a recoverable `forge run` path that revalidates authority immediately before execution, creates an
  orchestrator-owned integration checkout at the approved commit, derives isolated task worktrees,
  persists complete run authority, dispatches controlled Pi agents, verifies package scripts only in
  a pinned no-network/read-only Docker profile, and serially integrates successful work;
- Git-diff observed-impact reconciliation before verification: unleased actual changes fail closed,
  leased scope expansion produces sequenced durable runtime conflicts, and replay applies that changing
  conflict knowledge at the historical scheduler sequence;
- Vitest coverage thresholds, type-aware Oxlint, Oxfmt, and GitHub CI quality gates.

Milestones 12–21 add a Pi coding adapter, policy-controlled `forge_command`, execution profiles,
concurrent local agent execution, and an autonomous Pi-backed planning and review path. Planning and execution
remain separate: `forge plan`, `forge approve`, and `forge bind` do not create worktrees, acquire leases,
dispatch coding agents, run verification, or integrate Git work. `forge run` is the explicit side-effect
boundary and currently accepts only clean approved snapshots. Cross-process coordination, explicit
model routing/failover, dirty-snapshot materialization, publication, and automatic conflict repair remain deferred.

Pi remains a coding-agent engine behind the runtime: it cannot own scheduling, leases, workspaces,
persistence, Git integration, final verification, or recovery. `forge_command` selects only a policy
approved command ID; unrestricted shell access remains disabled until a future OS sandbox boundary exists.

## Requirements

- Node.js 24 or newer
- pnpm 11

TypeScript 7.0.2 is the single compiler used for project builds and type checks.

## Getting started

```sh
pnpm install
pnpm check
pnpm build
node apps/cli/dist/main.js --help
pnpm exec forge analyze .
pnpm exec forge analyze . --full
pnpm exec forge plan request.md --repository . --max-concurrency 2 --semantic-review
pnpm exec forge approve <artifact-id> --approved-by reviewer@example.com --repository .
pnpm exec forge bind <artifact-id> --approval <approval-id> --run-id <run-id> --repository .
pnpm exec forge run <artifact-id> --approval <approval-id> --run-id <run-id> --repository .
```

## Workspace

```text
apps/cli     Thin CLI adapter
libs/domain  Schemas, domain types, ports, and state rules
libs/dag     Functional dependency graph engine
libs/repository-analysis  pnpm project discovery plus TypeScript semantic analysis
libs/task-impact  Task selector resolution, impact expansion, shared-resource registry
libs/conflict-engine  Hard constraints and explainable conflict scoring
libs/scheduler  Event-driven deterministic dispatch decisions
libs/runtime-guard  In-process exclusive lease acquisition and lifecycle
libs/persistence  SQLite/Drizzle run evidence, recovery, and replay verification
libs/workspace-git  Local isolated Git worktree and integration lifecycle
libs/orchestration-runtime  Concurrent-agent application layer with serialized lifecycle choreography
libs/agent-runtime  Pi adapter, controlled tools, and execution profile adapters
libs/planning  Autonomous proposal validation, revision, analysis, and schedule preparation
libs/run-preparation  Fresh authority validation, runtime binding policy, and local runtime composition
docs/adr     Architecture decisions
```

See [docs/architecture.md](docs/architecture.md) for the target architecture, dependency direction,
models, and milestone plan.

Standalone training guides:

- [RepositoryGraph Analysis](docs/repository-graph-analysis.en.md) / [中文](docs/repository-graph-analysis.zh.md)
- [Task Impact and Conflict Analysis](docs/task-impact-analysis.en.md) / [中文](docs/task-impact-analysis.zh.md)
- [Scheduler Dispatch](docs/scheduler-dispatch.en.md) / [中文](docs/scheduler-dispatch.zh.md)
- [Runtime Guard and Write Leases](docs/runtime-guard.en.md) / [中文](docs/runtime-guard.zh.md)
- [Persistence and Replay](docs/persistence-replay.en.md) / [中文](docs/persistence-replay.zh.md)
- [Workspace and Git Lifecycle](docs/workspace-git.en.md) / [中文](docs/workspace-git.zh.md)
- [Orchestration Runtime](docs/orchestration-runtime.en.md) / [中文](docs/orchestration-runtime.zh.md)
- [Controlled Agent Commands](docs/controlled-agent-commands.en.md) / [中文](docs/controlled-agent-commands.zh.md)
- [Sandboxed Agent Commands](docs/sandboxed-agent-commands.en.md) / [中文](docs/sandboxed-agent-commands.zh.md)
- [Autonomous Planning](docs/autonomous-planning.en.md)
- [Semantic Plan Review](docs/semantic-plan-review.en.md) / [中文](docs/semantic-plan-review.zh.md)
- [Durable Plan Artifact](docs/plan-artifact.en.md) / [中文](docs/plan-artifact.zh.md)
- [Plan Approval and Execution Binding](docs/plan-approval-and-binding.en.md) / [中文](docs/plan-approval-and-binding.zh.md)
- [Controlled Runtime Binding and Start](docs/controlled-runtime-start.en.md) / [中文](docs/controlled-runtime-start.zh.md)

Continuation agents must read the [OpenCode engineering handover](docs/opencode-handover.md) before
changing the current uncommitted milestone state.

## Commands

| Command              | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `pnpm build`         | Build libraries and bundle the CLI       |
| `pnpm typecheck`     | Type-check all TypeScript references     |
| `pnpm lint`          | Run type-aware Oxlint                    |
| `pnpm test`          | Run all Vitest projects                  |
| `pnpm test:coverage` | Enforce project-wide coverage thresholds |
| `pnpm format`        | Format source and documentation          |
| `pnpm format:check`  | Verify formatting without writing        |
| `pnpm check`         | Run formatting, types, lint, and tests   |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, quality gates, commit
conventions, and pull-request checklist.

## License

Licensed under the [Apache License 2.0](LICENSE).
