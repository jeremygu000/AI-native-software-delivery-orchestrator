# AI Native Software Delivery Orchestrator

A TypeScript-native, repository-aware multi-agent coding orchestrator. The system is designed to
derive safe execution decisions from task dependencies, repository structure, symbol impact,
shared resources, and runtime write ownership instead of relying on model guesses about
parallelism.

## Current milestone

Milestones 1–9 establish the deterministic analysis, dispatch, write-safety, and local recovery core:

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
- Vitest coverage thresholds, type-aware Oxlint, Oxfmt, and GitHub CI quality gates.

Milestone 9 implements local SQLite persistence and Scheduler replay verification. It does not create
workspaces, observe real writes, coordinate processes, or invoke Git. The Scheduler, Guard, and
Persistence components remain library APIs; the CLI still exposes `plan` as a discoverable placeholder
until there is a tested task-spec input path and end-to-end integration.

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
