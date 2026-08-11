# Architecture

## Purpose

This project is a TypeScript-native coding orchestrator. It turns validated task contracts and
repository facts into deterministic, explainable execution plans. Language models may propose
tasks or implement them later, but they do not decide dependency order, conflicts, leases, state
transitions, or verification outcomes.

The implemented foundation covers repository setup, domain models, the task dependency graph, a
first-class Repository Facts Layer, TypeScript file/symbol analysis, predicted task impact, shared
resource policies, deterministic conflict analysis, and event-driven scheduling decisions.

## Workspace structure

```text
apps/
  cli/                 Thin Commander entry point (`forge`)

libs/
  domain/              Stable types, schemas, ports, and state rules
  dag/                 Functional dependency validation and ordering

  repository-analysis/ Repository facts and TypeScript semantic analysis
  task-impact/          Contract selector resolution, impact expansion, resource registry
  conflict-engine/      Hard constraints and explainable deterministic scoring

  # Added in later milestones when each boundary has real behaviour:
  scheduler/            Event-driven dependency- and conflict-aware dispatch
  runtime-guard/        Hierarchical write leases
  persistence/          Drizzle repositories backed by SQLite
   workspace-git/        Cohesive isolated-worktree and Git integration adapter
  verification/         Structured command verification
  agent-runtime/        Provider-neutral coding-agent execution
  provider/             Model-provider ports and adapters
```

Libraries are introduced when they own meaningful behaviour. Domain concepts are grouped rather
than split into one library per type. `workspace-git` owns the single cohesive boundary from isolated
worktree creation through Git integration and disposal; it is not split into speculative `workspace`
and `git` packages.

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

`domain` has no internal workspace dependencies. `dag` and `runtime-guard` depend only on `domain`.
`scheduler` depends only on `domain` and `dag`. Future engines may depend on `domain` and, where
necessary, `dag`; domain code never imports an adapter. Git,
SQLite, package-manager parsers, TypeScript Compiler API, Commander, and model-provider details
remain at the edges.

## Domain model

### Task contract

`TaskContract` is validated at external boundaries with Zod. Its predicted access surface uses
`expectedReads` and `expectedWrites`; these are estimates, not permissions. Selectors support
projects, files, globs, stable symbols, and named shared resources. Verification is expressed as a
generic command with an optional working directory or as a package script selected by package name.

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

### Repository Facts Layer

Repository facts are deterministic evidence gathered from pnpm workspace configuration, package
manifests, TypeScript project references and imports, filesystem identity, Git state, and relevant
configuration. Language models may use these facts to plan work, but they do not invent project
ownership, dependency reachability, symbol identity, or verification results.

`WorkspaceGraphProvider` is the generic discovery port. Its first implementation reads pnpm facts;
the port is not named after a repository task tool. Each project records its package manifest path,
dependency names, versions and kinds, `workspace:` usage, scripts, source roots, and discovered
TypeScript configuration paths. The TypeScript analyzer then enriches that workspace graph into a
Repository Knowledge Graph.

### Repository Knowledge Graph

The in-memory graph contains maps for projects, files, and symbols plus explicit dependency and
reference edges. Stable symbol IDs will use:

```text
<project-id>:<repository-relative-file>:<symbol-path>
```

Line numbers are metadata only and never identity. The current analyzer records export status;
signature extraction remains a later extension for distinguishing public API changes from
implementation changes. The current implementation performs a full scan; no incremental-analysis
request contract is exposed before an implemented consumer defines its semantics.

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

Cross-project TypeScript imports are promoted into `projectDependencies` together with manifest
dependencies. Every project edge carries one or more evidence sources:
`package-dependency`, `workspace-protocol`, `tsconfig-reference`, `typescript-import`,
`generated-artifact`, or `manual`. The current implementation emits manifest, workspace-protocol,
and TypeScript-import provenance. TypeScript-reference provenance is represented by the contract
and will be populated as configuration-reference ownership is promoted into graph edges. Downstream
logic treats provenance as evidence to explain reachability, not as permission to change files.

### Impact and conflict

`PredictedTaskImpact` resolves a task contract into likely read/write sets at project, file, symbol,
and shared-resource levels. It also records downstream projects and explainable risk signals.
`ObservedTaskImpact` records runtime reads, creates, writes, deletes, dependency requests, manifest
changes, and generated-file changes. `TaskImpact` keeps the prediction and optional observation
together without pretending they are the same kind of evidence.

The implemented impact pipeline is deterministic:

```text
TaskContract selectors
        |
        v
project / file / glob / symbol lookup -----> ambiguity signals
        |
        v
file and project ancestry + registry rules
        |
        v
reverse project-dependency traversal
        |
        v
PredictedTaskImpact
```

A symbol selector matches stable ID, declaration path, or simple name. Exact selectors that resolve
to zero or several facts produce an `ambiguous-selector` signal; globs may intentionally match many
files. File and symbol selections automatically include their owning project. Writes expand through
the reverse project-dependency graph to every transitive downstream project. Sets, resource access
modes, and diagnostics use locale-independent stable ordering.

`filesWritten` is the conservative union, not sufficient provenance for deciding sibling-symbol
parallelism. Predicted impact separately retains explicit project selectors, explicit file
selectors, glob-expanded files, and symbol-derived parent files. Two different symbols in one file
receive sibling-symbol treatment only when both file writes came from symbol parents and neither
task has an explicit project, file, or glob scope covering that file. Any broader scope produces a
whole-file conflict reason.

Shared-resource rules are validated configuration owned by `task-impact`, not filename conditionals
inside the scheduler. File rules and path patterns can attach resources even when a non-TypeScript
file such as `package.json` is absent from the semantic file graph. Predicted impact retains
`read`, `write`, and `coordinate` modes. `exclusive` and `ordered` rules constrain all declared
access; `producer-controlled` permits concurrent reads but constrains producer/write access. File
ownership is resolved through the registry for file, glob, and symbol selectors. A whole-project
selector checks the manifest and every known file owned by that project without falsely expanding
the task's explicit file-write set.

Every explicitly named shared resource must exist in the registry before impact analysis begins.
Unknown IDs fail with structured `UNKNOWN_SHARED_RESOURCE` evidence, so a spelling mistake cannot
silently weaken an intended hard policy. Conflict analysis retains a soft unknown-resource fallback
only for defensive handling of manually constructed or older persisted impacts that bypassed the
normal analyzer.

An exported symbol selected for writing produces `public-api-touch`. It does not produce
`public-api-signature-change`: touching an implementation is not evidence that its public signature
changed. That stronger signal is reserved for future before/after observed-diff analysis.

The functional dependency graph and pairwise conflict graph remain separate. `TaskConflict` is a
discriminated union. A `HardTaskConflict` must contain at least one structural scheduling constraint
and may recommend only stagger or serialize. A `RiskTaskConflict` has `none`/`soft` severity, an
empty constraints tuple, and a 0–100 score with explainable reasons. Scheduler methods receive hard
and risk conflicts as separate parameters, so hard constraints cannot silently disappear inside a
single scored list. Scoring constants live in conflict-engine configuration, not domain types or
scheduler branches. `HardTaskConflict.score` remains explainability metadata; a Scheduler
implementation must never filter, ignore, or cap hard conflicts by score. This invariant requires
an explicit implementation-level test when Scheduler development begins.

The implemented conflict engine compares task pairs in canonical task-ID order and emits stable,
deduplicated reasons. Same-symbol writes and configured shared-resource policies create structural
constraints independently of numeric weight; a test proves that a same-symbol conflict stays hard
even when its weight is zero. Same-file sibling-symbol writes, same-project writes,
producer/consumer overlap, generated code, dependency direction, public API touch, and high fan-out
remain explainable scored risks. Scores are capped at 100, and weights and action thresholds are
validated engine configuration rather than domain constants.

A conflict edge is pairwise and symmetric: it says two tasks must not execute concurrently. A
producer-consumer constraint additionally carries `producerTaskId` and `consumerTaskId`, expressing
an ordering edge independent of canonical pair order. One writer plus one reader of a
producer-controlled resource, or a one-way repository file/symbol write-read overlap, produces this
directional constraint. Read/read remains parallel, writer/writer remains a nondirectional hard
serialization conflict, and bidirectional repository reads and writes remain an undirected scored
risk rather than an invented producer order. The implemented Scheduler consumes directional
constraints as separate completion requirements without rewriting the functional DAG.

### Write leases

`WritableResource` models project, file, symbol, and shared-resource ownership. File and symbol
resources always carry their project ID; symbols also carry their file and ancestor symbol IDs.
This makes a persisted lease self-contained and containment checks deterministic:

- a project lease conflicts with contained files and symbols;
- a file lease conflicts with all symbols in that file;
- a class lease conflicts with its methods;
- sibling methods may receive separate exclusive leases;
- a named shared resource follows its configured concurrency rule.

Every lease is scoped by `runId`, has a monotonic version, state, and heartbeat evidence. A lease
does not become available merely because a fixed timer elapsed. The runtime combines heartbeat,
agent liveness, workspace state, a grace policy, and recovery evidence before marking an active
lease `STALE`; only then may recovery reclaim it. Heartbeat, stale marking, and release all require
the current lease version; a stale lifecycle request returns `version-conflict`. An absent or
non-active lease returns `not-found`. The implemented `InMemoryWriteGuard` serializes in-process operations, so
simultaneous conflicting acquires cannot both succeed. The implementation records supplied stale
evidence but does not decide staleness from a timer. Queuing and rebase/resume coordination are
orchestration concerns layered above the guard.

The guard is intentionally process-local and non-persistent. It does not coordinate multiple Node.js
processes, survive process termination, resolve a user-supplied path against the repository graph,
observe a write, or mutate Scheduler state. One guard instance serves one workspace namespace and
must not be shared by unrelated workspaces with colliding resource IDs. Milestone 9 must replace or
wrap this storage behavior with persistent, atomic repositories before cross-process recovery claims
are valid. Before an agent runtime performs a real write, a later milestone must carry the lease
version as a true write fencing token; the current version fences only guard lifecycle operations.

### Planning and runtime feedback

The planner converts intent into task contracts. Task-impact analysis resolves those contracts
against repository facts; it does not decide the task decomposition. The scheduler may create an
initial wave-shaped visualization, but runtime dispatch is event-driven. Task completion, failure,
lease release, conflict changes, verification results, and observed scope expansion trigger a new
decision. A wave is never a barrier that forces unrelated ready work to wait.

Tasks move through `INTEGRATING` after verification and before completion. Each task executes in an
isolated Git worktree. Workspace integration now uses a separate persisted phase lifecycle:
`READY_TO_INTEGRATE`, `INTEGRATION_BLOCKED`, and `INTEGRATED`. An integration block retains structured
Git evidence and never converts completed execution work into ordinary `READY` work. The local Git
adapter rebases the task branch onto the integration ref, then integrates through a fast-forward-only
merge. Dirty integration repositories, rebase conflicts, and fast-forward failures remain explicit
blocks that an outer runtime may resume or abort. Observed writes are still not implemented, so no
current component claims to check them against predicted scope or leases before integration. The
workspace record carries a positive revision. Persistence accepts only a strictly newer revision, or
an exactly matching retry at the same revision; an older workspace record cannot overwrite newer Git
integration evidence. Git processes run asynchronously and use NUL-delimited path output, so a long
rebase does not block the Node.js event loop and unusual filenames remain structured evidence.

`integrationRepositoryPath` is an orchestrator-owned integration checkout, not a user's active checkout. A
future caller must provision an exclusive directory, for example `.forge/integration/<repository-id>`,
because integration deliberately switches it to the requested integration ref. A clean user checkout
is not safe: switching it could move a user's current branch without leaving dirty-work evidence.

### Application orchestration layer

`libs/orchestration-runtime` now owns the first local application workflow and keeps `apps/cli` thin.
It persists Scheduler evidence, creates and persists workspaces, acquires/releases leases, runs a
provider-neutral fake agent, verifies it, integrates Git work, and reconstructs a recovery snapshot.
Its production package depends only on Domain ports; local Scheduler, SQLite, Guard, and Workspace/Git
implementations are injected by integration tests rather than imported as application dependencies.
Its accepted scope is serial `maxConcurrency: 1`; it does not provision dedicated integration checkouts,
run real agents or verification commands, coordinate processes, resume unknown in-flight agents, or
automatically repair Git conflicts. Those workflows remain runtime extensions and must not be placed in
the CLI or hidden inside infrastructure adapters.

Scheduler `RUNNING` means dispatch is authorized, while a separate revisioned `AgentExecutionAttempt`
records external execution preparation, startup, durable session establishment, completion, failure, or
unknown restart outcome. The start decision and `PREPARING` attempt persist atomically. A task binding
uses a canonical multi-resource `TaskLeasePlan`; blocked acquisition rolls back earlier leases rather
than retaining partial ownership. Current execution leases end before verification and Git integration,
which is intentionally not an integration reservation policy. ADR-016 records these durable execution
and lease-plan boundaries. Pi and controlled agent tools remain future adapters, not current runtime
dependencies.

Agent execution hardening remains deliberately backend-neutral. A real agent backend such as Pi must
implement `AgentRunner`, establish a provider-neutral session reference through the attempt lifecycle,
and eventually use orchestrator-controlled tools. It must not create worktrees, bypass lease plans,
mutate persistence directly, decide scheduling, or claim final verification.

`libs/agent-runtime` now provides the first backend implementation. `PiAgentRunner` uses a private Pi
session gateway and exposes only `forge_read`, `forge_list`, `forge_find`, `forge_edit`, and
`forge_write`. Pi sessions start with `noTools: "all"`: there is no built-in Pi `bash`, `edit`, or
`write` capability. Mutation routes through `AgentToolRuntime`, which scopes paths to one workspace,
acquires/persists write leases, and returns observed file evidence. The gateway maps Pi SDK types only
inside `agent-runtime`; domain and orchestration runtime remain provider-neutral.

`forge_command` is an explicit policy-controlled extension, not Pi shell access. The agent selects only
a command ID. `AgentCommandPolicy` fixes each executable, argument vector, timeout, output limit, and
environment; `NodeAgentCommandExecutor` runs it with `shell: false` in the task workspace. The policy
must be present before the session enables the tool. This is not an OS sandbox: it does not isolate
network, secrets, file descriptors, process descendants, or resource limits. ADR-018 records the
boundary.

The feedback loop is:

```text
intent -> plan -> predicted impact -> conflicts -> dispatch
   ^                                            |
   |                                            v
explanation <- persisted events <- observed impact <- isolated execution
```

### Scheduler

`DeterministicScheduler` is a pure decision engine. It validates the task DAG and positive integer
concurrency limit before selecting work. Its serializable snapshot contains every task state and the
exact lease or runtime-conflict blockers for blocked tasks. Its input event and per-task output
reasons are discriminated payloads, so a future persistence layer can replay decisions without
parsing a human string or recovering hidden scheduler state.

The selection sequence is:

```text
functional dependency completion
        +
directional producer completion
        +
priority descending, then locale-independent task ID
        +
hard constraints against running and selected work
        +
risk recommendation policy
        +
remaining maximum concurrency
        |
        v
structured ready / start / block / unblock / cancel / defer decisions
```

All hard constraints apply regardless of `HardTaskConflict.score`. `parallel` and
`guarded-parallel` risk recommendations may overlap; `stagger` and `serialize` defer the later
candidate while its conflict peer remains active. Static capacity, priority, and conflict deferral
do not fabricate a state transition. Only a runtime blocker event can request `RUNNING -> BLOCKED`,
and only release evidence matching the snapshot's recorded blocker can request `BLOCKED -> READY`.

Terminal prerequisite handling is explicit: a failed task cancels every nonterminal transitive
functional dependant and directional producer consumer with `dependency-failed` evidence. A
pre-existing cancelled prerequisite has the same propagation behavior with distinct
`dependency-cancelled` evidence. The scheduler returns those legal transitions; an outer runtime
must apply them. `createInitialPlan` creates an explanatory wave preview with the same policy but
owns no runtime progress. A completion event can therefore start a true dependant while a task from
an earlier preview wave is still running.

The current Scheduler does not start agents, change the input snapshot, acquire or enforce a lease,
collect events, write persistence records, run verification, create worktrees, or invoke Git. Those
remain outer-runtime responsibilities.

Observation events now carry deterministic post-event states and require the Scheduler input snapshot
to already contain that state: completion and workspace integration require `COMPLETED`, failure
requires `FAILED`, and verification completion requires `INTEGRATING`. Runtime blocker evidence
remains the explicit exception: the Scheduler validates and applies its blocker transition. Each
persisted reevaluation stores the Scheduler input snapshot, event, transitions, and decision under
one sequence number, then recovery replays the same call and verifies the saved decision. ADR-013
defines this replay boundary.

## Persistence boundary

`libs/persistence` implements an SQLite/Drizzle adapter using `better-sqlite3`. It persists only
domain-shaped JSON plus relational run, sequence, and current-record keys; compiler AST objects and
SQLite types remain outside the domain. It atomically writes each event reevaluation, validates data
while recovering it, and verifies stored decisions by replaying immutable run inputs through the
Scheduler. PostgreSQL support must remain addable by implementing the same domain port.

## Workspace tooling

The repository uses pnpm workspaces for package linking, TypeScript solution references for build
order, Vitest projects for tests, Oxlint/Oxfmt for quality, and esbuild for the CLI. Repository
tooling remains separate from the product's deterministic facts and orchestration engines.

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
4. **Workspace facts:** pnpm workspace discovery, dependency mapping, provider detection, and a working
   `forge analyze` command.
5. **Repository analysis:** TypeScript program, import/export/file/symbol/reference graph, stable IDs.
   **Complete.**
6. **Impact and conflict:** predicted selector resolution, affected-package expansion,
   shared-resource registry, severity, hard constraints, and explainable scoring. **Complete.**
7. **Scheduler:** event-driven dispatch respecting dependencies, producer direction, hard
   constraints, explicit risk policy, priorities, existing work, and max concurrency; waves remain a
   visualization only. **Complete.**
8. **Runtime guard:** process-local hierarchical lease acquisition, heartbeat, evidence-based stale
   recovery, and idempotent release. **Complete for the in-memory scope.**
9. **Persistence:** finalize scheduler event/snapshot replay semantics, then persist and replay
   recoverable runs, transitions, conflicts, decisions, observations, and leases in SQLite/Drizzle.
   **Complete for the local SQLite scope.**
10. **Workspace and Git:** isolated worktrees, rebase, integration, and disposal behind ports.
    **Complete for the local single-repository Git scope.**
11. **Orchestration runtime:** a local application layer that composes Scheduler, WorkspaceManager,
    WriteGuard, persistence, verification, and a provider-neutral fake agent. The first runtime is
    serial and recovery-only for in-flight work; it does not run a real coding agent. **In progress.**

Every milestone must pass formatting, TypeScript 7 type checking, type-aware linting,
non-interactive tests, project-wide coverage thresholds, and a forced clean-equivalent build before
the next starts.
