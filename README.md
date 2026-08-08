# APRA AMCOS Admin Coding Orchestrator

A TypeScript-native, repository-aware multi-agent coding orchestrator. The system is designed to
derive safe execution waves from task dependencies, repository structure, symbol impact, shared
resources, and runtime write ownership instead of relying on model guesses about parallelism.

## Current milestone

Milestones 0–2 establish the deterministic core:

- TypeScript 7 native CLI checks and ESM in an Nx monorepo;
- pnpm workspaces for dependency management;
- a Commander-based `forge` CLI shell;
- validated task contracts and orchestration domain models;
- explicit task lifecycle transition rules;
- DAG validation, missing-dependency and cycle detection;
- deterministic topological sorting and ready-task calculation;
- Vitest, type-aware Oxlint, and Oxfmt quality gates.

Repository analysis, conflict scoring, scheduling waves, write leases, and persistence are the next
milestones. The CLI exposes `analyze` and `plan` as discoverable placeholders until those engines
are implemented.

## Requirements

- Node.js 24 or newer
- pnpm 11

Nx and Vite still require the TypeScript programmatic API, which TypeScript 7 does not currently
ship. Following Nx's supported setup, `tsc` is TypeScript 7.0.2 for project builds and type checks,
while the aliased TypeScript 6 package supplies the internal API used by Nx tooling.

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

| Command              | Purpose                                   |
| -------------------- | ----------------------------------------- |
| `pnpm build`         | Build all applicable Nx projects          |
| `pnpm typecheck`     | Type-check all Nx projects                |
| `pnpm lint`          | Run type-aware Oxlint                     |
| `pnpm test`          | Run Vitest through Nx                     |
| `pnpm format`        | Format source and documentation           |
| `pnpm format:check`  | Verify formatting without writing         |
| `pnpm check`         | Run formatting, types, lint, and tests    |
| `pnpm exec nx graph` | Inspect workspace project dependencies    |
| `pnpm exec nx sync`  | Synchronize TypeScript project references |
