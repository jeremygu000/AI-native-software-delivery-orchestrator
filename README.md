# AI Native Software Delivery Orchestrator

A TypeScript-native, repository-aware multi-agent coding orchestrator. The system is designed to
derive safe execution decisions from task dependencies, repository structure, symbol impact,
shared resources, and runtime write ownership instead of relying on model guesses about
parallelism.

## Current milestone

Milestones 1–6 establish the deterministic analysis core:

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
- Vitest coverage thresholds, type-aware Oxlint, Oxfmt, and GitHub CI quality gates.

Event-driven scheduling is the next milestone. Before it starts, scheduler events and decision
reasons will gain structured payloads for audit and replay. Live write leases, persistence, isolated
workspaces, and agent execution remain later work. The CLI exposes `plan` as a discoverable
placeholder until those engines are integrated.

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
docs/adr     Architecture decisions
```

See [docs/architecture.md](docs/architecture.md) for the target architecture, dependency direction,
models, and milestone plan.

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
