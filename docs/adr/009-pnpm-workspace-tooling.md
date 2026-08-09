# ADR-009: pnpm workspace tooling

## Status

Accepted

## Context

The repository needs package linking, deterministic build order, tests, quality checks, and CLI
packaging. Its product architecture must not depend on the repository tool used to perform those
development tasks.

## Decision

Use pnpm workspaces for package linking, TypeScript solution references and `tsc -b` for build
order, Vitest projects for tests, Oxlint/Oxfmt for quality checks, and the esbuild CLI for the
executable.

Repository analysis begins with the package manager the product actually supports: pnpm. The
generic `WorkspaceGraphProvider` contract stays independent of package-manager details. Additional
providers are introduced only for a concrete supported-repository requirement.

## Reassessment triggers

Reconsider the build orchestration approach when any of these conditions is met:

- the workspace grows beyond 12 actively built packages;
- clean CI validation exceeds five minutes in the median of ten successful runs;
- three or more CI workflows duplicate custom affected/build-order logic;
- dependent-package watch and incremental rebuild requirements become a recurring developer cost;
- measured task caching would remove at least 30% of clean CI execution time.

Meeting a trigger starts an evidence-based evaluation; it does not prescribe a particular tool.

## Consequences

The core repository has few tooling layers and keeps the product's facts boundary honest.
TypeScript references remain compiler-validated. CI performs a forced build because no task cache
is assumed. Supporting another repository format later requires provider-specific tests and a
concrete product need.
