# Architecture

## Purpose

This project is a TypeScript-native coding orchestrator. It turns validated task contracts and
repository facts into deterministic, explainable execution plans. Language models may propose
tasks or implement them later, but they do not decide dependency order, conflicts, leases, state
transitions, or verification outcomes.

The implemented foundation covers repository setup, domain models, the task dependency graph,
pnpm project discovery, and TypeScript file/symbol analysis. Task impact and conflict analysis are
the next boundary.

## Workspace structure

```text
apps/
  cli/                 Thin Commander entry point (`forge`)

libs/
  domain/              Stable types, schemas, ports, and state rules
  dag/                 Functional dependency validation and ordering

  # Added in later milestones when each boundary has real behaviour:
  repository-analysis/ Provider-neutral project discovery plus pnpm workspace analysis
  task-impact/          Contract selector resolution and impact expansion
  conflict-engine/      Explainable deterministic conflict scoring
  scheduler/            Dependency- and conflict-aware wave construction
  runtime-guard/        Hierarchical write leases
  persistence/          Drizzle repositories backed by SQLite
  workspace/            Isolated task workspace lifecycle
  git/                  Native Git command abstraction
  verification/         Structured command verification
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
SQLite, package-manager parsers, TypeScript Compiler API, Commander, and model-provider details
remain at the edges.

## Domain model

### Task contract

`TaskContract` is validated at external boundaries with Zod. Its predicted access surface uses
`expectedReads` and `expectedWrites`; these are estimates, not permissions. Selectors support
projects, files, globs, stable symbols, and named shared resources. Verification is expressed as
explicit commands.

Functional dependencies are task IDs and form a DAG. Duplicate IDs, missing dependencies,
self-dependencies, duplicate dependency entries, and cycles are errors before scheduling begins.
Cycle detection is iterative and reports every strongly connected component, so valid deep plans do
not depend on the JavaScript call-stack limit. All tie-breaking uses locale-independent ID ordering.

Shared resources have two deliberately separate declarations:

- a `shared-resource` selector in `expectedReads` or `expectedWrites` predicts static impact;
- `sharedResources` requests concurrency coordination regardless of predicted file access.

`collectSharedResourceIds` forms the canonical, sorted union used by impact and conflict analysis.
The schema normalizes duplicate coordination declarations rather than requiring planners to emit a
perfectly canonical array.

### Repository graph

The in-memory graph contains maps for projects, files, and symbols plus explicit dependency and
reference edges. Stable symbol IDs will use:

```text
<project-id>:<repository-relative-file>:<symbol-path>
```

Line numbers are metadata only and never identity. The current analyzer records export status;
signature extraction remains a later extension for distinguishing public API changes from
implementation changes. `RepositoryAnalysisRequest.changedFiles` is an extension point for
incremental indexing; the current implementation performs a full scan.

The TypeScript implementation uses the pinned TypeScript 7 native synchronous API only inside
`repository-analysis`. Compiler AST nodes and checker symbols are converted immediately into the
provider-neutral graph and never cross the adapter boundary. Imports resolve through each real
project `tsconfig.json`, including path aliases and shared-source imports. The unstable API path is
an explicit, package-local compatibility boundary recorded in ADR-004; TypeScript 6 is not present.

Configuration discovery begins at each pnpm project's root `tsconfig.json` and recursively follows
project `references`, including solution layouts whose real programs live in `tsconfig.lib.json`,
`tsconfig.app.json`, or `tsconfig.spec.json`. JSONC comments and trailing commas are supported;
malformed configuration and missing/out-of-repository references are structured errors. A compiler
configuration belongs to the most specific pnpm project containing that configuration file. This
allows referenced configurations below a project root, such as `config/tsconfig.build.json`, while
preventing sibling projects from lending one another an arbitrary checker. When production and test
configs both contain a source file, the non-test context wins deterministically. If multiple
non-test contexts overlap, the lexicographically first configuration path wins; this deterministic
tie-break is not a claim that the selected compiler options are semantically preferable.

Projects with no root configuration or no owned source files remain visible and receive explicit
`RepositoryDiagnostic` warnings. A repository scan also reports TypeScript files that belong to a
workspace project but are not covered by any discovered configuration. Nested pnpm workspaces are
separate repository boundaries and are excluded from this comparison. This distinguishes genuinely
empty, non-TypeScript, and partially uncovered packages from malformed configuration, which fails
analysis. Namespace contents are indexed recursively.

Source-file identity uses the filesystem real path. Multiple symlink paths to the same TypeScript
file therefore produce one `FileNode` and one symbol set, and a symlink whose real target is outside
the repository cannot bypass the repository boundary. `FileNode.path` and `FileNode.id` therefore
name the repository-relative real file, not necessarily the symlink spelling that appeared in an
import statement. Consumers resolving user-supplied paths must apply the same real-path
normalization before graph lookup. The uncovered-file scan does not currently suppress intentionally
excluded generated files; this favors complete visibility over quiet output until a concrete
severity or filtering policy is designed. The additional repository-wide glob has been exercised
on repositories of roughly one thousand TypeScript files. Its cost must be measured again before
assuming the same behavior is suitable for repositories with tens of thousands of files.

Declaration merging uses a fixed kind priority and records every participating kind in
`SymbolNode.mergedKinds`, so class/namespace results do not depend on source order. Dynamic computed
accessors and overload-like callable declarations share an expression-based identity; repeated
computed properties use an occurrence count among the same expression, not their absolute sibling
position.

The analyzer assumes input source is type-checkable enough for the TypeScript checker to establish
symbols. It does not turn same-kind duplicate declarations in already-invalid source into a separate
repository diagnostic; compiler/type verification remains responsible for reporting those errors.

Cross-project TypeScript imports are currently promoted into `projectDependencies` together with
manifest dependencies. These edges do not yet carry provenance and do not distinguish production,
test, generated, runtime, or type-only sources. Downstream impact logic must therefore treat them as
structural reachability evidence, not as proof of equal architectural strength. Edge provenance is
an explicit future graph-schema extension rather than an assumption hidden in conflict scoring.
This provenance decision must be revisited before project-dependency edges receive different
conflict weights, before test/generated/type-only edges are filtered, or before another repository
provider supplies dependency evidence with different strength.

### Impact and conflict

`TaskImpact` keeps read/write sets at project, file, symbol, and shared-resource levels. It also
records downstream projects and explainable risk signals.

The functional dependency graph and pairwise conflict graph remain separate. `TaskConflict` has a
0–100 score, individual scored reasons, and one of four recommendations: parallel,
guarded-parallel, stagger, or serialize. Scoring constants will live in conflict-engine
configuration, not domain types or scheduler branches.

### Write leases

`WritableResource` models project, file, symbol, and shared-resource ownership. File and symbol
resources always carry their project ID; symbols also carry their file and ancestor symbol IDs.
This makes a persisted lease self-contained and containment checks deterministic:

- a project lease conflicts with contained files and symbols;
- a file lease conflicts with all symbols in that file;
- a class lease conflicts with its methods;
- sibling methods may receive separate exclusive leases;
- a named shared resource follows its configured concurrency rule.

Every lease is scoped by `runId`, has a monotonic version and expiry, and supports optimistic renew.
Release reports `released` or `not-found`; treating an unknown lease as an idempotent outcome makes
restart recovery safe. The Phase 1 guard grants or blocks exclusive leases. Queuing and
rebase/resume coordination are orchestration concerns layered above the guard.

## Persistence boundary

Drizzle and SQLite are installed in the workspace but persistence is deferred until the core
models, DAG, analyzers, conflict engine, scheduler, and guard are stable. Persistence repositories
will store reconstructable orchestration state, not raw ASTs. PostgreSQL support must be addable by
implementing the same repository ports.

## Workspace tooling decision

The repository uses pnpm workspaces for package linking, TypeScript solution references for build
order, Vitest projects for tests, and esbuild for the CLI. It does not use a repository task
orchestrator at the current scale. This is the reversible decision recorded in ADR-009.

Repository graph contracts remain package-manager-neutral. The implemented provider reads pnpm
workspace configuration and package manifests because pnpm is the current supported input. npm,
Yarn, or tool-specific providers are added only when a concrete product requirement calls for them.

## Milestone plan

1. **Setup:** a single TypeScript 7 toolchain, strict ESM, pnpm, Commander, Vitest, Oxlint, Oxfmt,
   Zod, Drizzle, and SQLite-ready persistence dependencies. A repository analyzer may add a
   package-local compatibility API only if its implementation proves one is required.
2. **Domain:** task contracts, repository graph, impact/conflict, execution, state, and write-lease
   models with boundary schemas and tests.
3. **DAG:** deterministic validation, cycle detection, topological sorting, and ready-task selection.
4. **Project graph:** pnpm workspace discovery, dependency mapping, provider detection, and a working
   `forge analyze` command.
5. **Repository analysis:** TypeScript program, import/export/file/symbol/reference graph, stable IDs.
   **Complete.**
6. **Impact and conflict:** selector resolution, shared-resource registry, explainable scoring.
7. **Scheduler:** dependency-safe waves, conflict thresholds, priorities, and max concurrency.
8. **Runtime guard:** hierarchical lease acquisition, blocking, and release.
9. **Persistence:** recoverable runs, transitions, conflicts, waves, and leases in SQLite/Drizzle.
10. **Workspace and Git:** isolated worktrees, rebase, integration, and disposal behind ports.

Every milestone must pass formatting, TypeScript 7 type checking, type-aware linting,
non-interactive tests, project-wide coverage thresholds, and a forced clean-equivalent build before
the next starts.
