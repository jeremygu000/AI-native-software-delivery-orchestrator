# APRA AMCOS Admin Coding Orchestrator

A TypeScript-native, repository-aware multi-agent coding orchestrator. The system is designed to
derive safe execution waves from task dependencies, repository structure, symbol impact, shared
resources, and runtime write ownership instead of relying on model guesses about parallelism.

## Current milestone

Milestones 0–2 establish the deterministic core:

- TypeScript 7 native CLI checks and ESM in a pnpm workspace;
- pnpm workspaces for dependency management;
- a Commander-based `forge` CLI shell;
- validated task contracts and orchestration domain models;
- explicit task lifecycle transition rules;
- stack-safe DAG validation, complete SCC cycle diagnostics, and stable ordering;
- deterministic topological sorting and ready-task calculation;
- self-contained hierarchical write-resource and recoverable lease contracts;
- Vitest coverage thresholds, type-aware Oxlint, Oxfmt, and GitHub CI quality gates.

Repository analysis, conflict scoring, scheduling waves, write leases, and persistence are the next
milestones. The CLI exposes `analyze` and `plan` as discoverable placeholders until those engines
are implemented.

## Requirements

- Node.js 24 or newer
- pnpm 11

TypeScript 7 does not currently ship the stable programmatic API needed by the future repository
analyzer. `tsc` is TypeScript 7.0.2 for project builds and type checks, while the aliased TypeScript
6 package is retained for that future analyzer boundary.

## Getting started

```sh
pnpm install
pnpm check
pnpm build
node apps/cli/dist/main.js --help
```

## Workspace

```text
apps/cli     Thin CLI adapter
libs/domain  Schemas, domain types, ports, and state rules
libs/dag     Functional dependency graph engine
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
