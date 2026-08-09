# ADR-009: pnpm workspace without Nx orchestration

## Status

Accepted; supersedes ADR-002

## Context

The repository initially contained three packages. pnpm workspaces, TypeScript project references,
Vitest projects, Oxlint, Oxfmt, and esbuild cover its installation, dependency ordering, testing,
quality, and CLI packaging needs. No implemented product requirement currently depends on Nx.

The migration deliberately gives up Nx affected calculation, task-level caching,
`build-deps`/`watch-deps`, target inference, and automatic project-reference synchronization. These
capabilities have low value at the current scale, but their loss is explicit rather than treated as
pure tooling removal.

## Decision

Use pnpm workspaces for package linking, TypeScript solution references and `tsc -b` for build
order, Vitest projects for tests, Oxlint/Oxfmt for quality checks, and the esbuild CLI for the
executable. Nx is not a root dependency and its types or commands may not enter domain or engine
libraries.

Repository analysis begins with the package manager the product actually uses: pnpm. Additional
repository providers are introduced only when a concrete supported-repository requirement exists;
they are not reserved as milestones in advance.

## Reassessment triggers

Reconsider a repository task orchestrator when any of these conditions is met:

- the workspace grows beyond 12 actively built packages;
- clean CI validation exceeds five minutes in the median of ten successful runs;
- three or more CI workflows duplicate custom affected/build-order logic;
- dependent-package watch and incremental rebuild requirements become a recurring developer cost;
- measured task caching would remove at least 30% of clean CI execution time.

A reassessment compares Nx, other task orchestrators, and simpler scripts. Meeting a trigger starts
evaluation; it does not automatically restore Nx.

## Consequences

The core repository has fewer tool-specific configuration layers and keeps its provider boundary
honest. TypeScript references remain manually reviewed and compiler-validated. CI always performs
a forced build because there is no task cache. Supporting another repository format later requires
a new evidence-backed decision and provider-specific tests.
