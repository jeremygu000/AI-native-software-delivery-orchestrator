# Architecture

## Purpose

This project is a TypeScript-native coding orchestrator. It turns validated task contracts and
repository facts into deterministic, explainable execution plans. Language models may propose
tasks or implement them later, but they do not decide dependency order, conflicts, leases, state
transitions, or verification outcomes.

The first implementation slice covers repository setup, domain models, and the task dependency
graph. Repository analysis starts only after these foundations and their tests are stable.

## Workspace structure

```text
apps/
  cli/                 Thin Commander entry point (`forge`)

libs/
  domain/              Stable types, schemas, ports, and state rules
  dag/                 Functional dependency validation and ordering

  # Added in later milestones when each boundary has real behaviour:
  repository-analysis/ TypeScript repository analyzer facade
  project-graph/        Nx project graph provider
  task-impact/          Contract selector resolution and impact expansion
  conflict-engine/      Explainable deterministic conflict scoring
  scheduler/            Dependency- and conflict-aware wave construction
  runtime-guard/        Hierarchical write leases
  persistence/          Drizzle repositories backed by SQLite
  workspace/            Isolated task workspace lifecycle
  git/                  Native Git command abstraction
  verification/         Structured command and Nx-target verification
  agent-runtime/        Provider-neutral coding-agent execution
  provider/             Model-provider ports and adapters
```

Libraries are introduced when they own meaningful behaviour. Domain concepts are grouped rather
than split into one library per type.

## Dependency direction

```text
CLI / outer adapters
        |
        v
analysis, impact, conflict, scheduler, guard, persistence
        |                  |
        v                  v
       DAG ------------> Domain
```

`domain` has no internal workspace dependencies. `dag` depends only on `domain`. Future engines
may depend on `domain` and, where necessary, `dag`; domain code never imports an adapter. Git,
SQLite, Nx, TypeScript Compiler API, Commander, and model-provider details remain at the edges.

## Domain model

### Task contract

`TaskContract` is validated at external boundaries with Zod. Its predicted access surface uses
`expectedReads` and `expectedWrites`; these are estimates, not permissions. Selectors support
projects, files, globs, stable symbols, and named shared resources. Verification is structured as
commands or Nx targets.

Functional dependencies are task IDs and form a DAG. Duplicate IDs, missing dependencies,
self-dependencies, and cycles are errors before scheduling begins.

### Repository graph

The in-memory graph contains maps for projects, files, and symbols plus explicit dependency and
reference edges. Stable symbol IDs will use:

```text
<project-id>:<repository-relative-file>:<symbol-path>
```

Line numbers are metadata only and never identity. Export status and signatures distinguish public
API changes from implementation changes. `RepositoryAnalysisRequest.changedFiles` is an extension
point for incremental indexing; the interface does not assume every scan is full.

### Impact and conflict

`TaskImpact` keeps read/write sets at project, file, symbol, and shared-resource levels. It also
records downstream projects and explainable risk signals.

The functional dependency graph and pairwise conflict graph remain separate. `TaskConflict` has a
0–100 score, individual scored reasons, and one of four recommendations: parallel,
guarded-parallel, stagger, or serialize. Scoring constants will live in conflict-engine
configuration, not domain types or scheduler branches.

### Write leases

`WritableResource` models project, file, symbol, and shared-resource ownership. Symbol resources
include their file and ancestor symbol IDs so containment checks are deterministic:

- a project lease conflicts with contained files and symbols;
- a file lease conflicts with all symbols in that file;
- a class lease conflicts with its methods;
- sibling methods may receive separate exclusive leases;
- a named shared resource follows its configured concurrency rule.

The Phase 1 guard grants or blocks exclusive leases. Queuing and rebase/resume coordination are
orchestration concerns layered above the guard.

## Persistence boundary

Drizzle and SQLite are installed in the workspace but persistence is deferred until the core
models, DAG, analyzers, conflict engine, scheduler, and guard are stable. Persistence repositories
will store reconstructable orchestration state, not raw ASTs. PostgreSQL support must be addable by
implementing the same repository ports.

## Package manager decision

The workspace uses Nx with pnpm workspaces. pnpm owns dependency installation and workspace
linking; Nx owns the project graph and task orchestration. Repository analysis will remain package
manager-neutral and eventually recognize npm, pnpm, and Yarn lockfiles.

## Milestone plan

1. **Setup:** TypeScript 7 CLI with the TypeScript 6 compatibility API required by Nx, strict ESM,
   pnpm, Commander, Vitest, Oxlint, Oxfmt, Zod, Drizzle, and SQLite-ready persistence dependencies.
2. **Domain:** task contracts, repository graph, impact/conflict, execution, state, and write-lease
   models with boundary schemas and tests.
3. **DAG:** deterministic validation, cycle detection, topological sorting, and ready-task selection.
4. **Project graph:** Nx provider using fixture workspaces.
5. **Repository analysis:** TypeScript program, import/export/file/symbol/reference graph, stable IDs.
6. **Impact and conflict:** selector resolution, shared-resource registry, explainable scoring.
7. **Scheduler:** dependency-safe waves, conflict thresholds, priorities, and max concurrency.
8. **Runtime guard:** hierarchical lease acquisition, blocking, and release.
9. **Persistence:** recoverable runs, transitions, conflicts, waves, and leases in SQLite/Drizzle.
10. **Workspace and Git:** isolated worktrees, rebase, integration, and disposal behind ports.

Every milestone must pass formatting, type checking, linting, and tests before the next starts.
