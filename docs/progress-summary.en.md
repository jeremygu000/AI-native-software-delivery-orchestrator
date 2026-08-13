# Project Progress Summary (English Version)

> Audience: readers with no prior hands-on experience on this project who want a quick,
> plain-language overview of "what has actually been built so far."
> This document explains what was done and why, in plain language. It does not cover code-level
> implementation details.

## What problem is this project solving

Imagine many coding tasks (e.g. "add a method to this class," "change the return type of this
interface") that need to be handed off to multiple AI agents to implement at the same time. If two
agents edit the same file at once, or if one task actually depends on another task finishing first,
starting them all in parallel will cause conflicts or broken code.

This project builds an **orchestrator**: before any agent starts writing code, it analyzes the
repository's structure, the dependencies between tasks, and which files/resources each task is
expected to read or write. From that, it works out which tasks can safely run at the same time and
which ones must wait their turn. The goal is for parallelization decisions to be **evidence-based,
explainable, and reproducible** — not "the AI thinks it's probably fine."

The project is still building its deterministic foundation, but it can now analyze a real pnpm and
TypeScript repository down to files and code symbols. It cannot yet calculate task-to-code impact,
schedule agents, or let agents write code.

## Stage 1: Setting up the engineering scaffolding

This stage does not implement any business logic. It just sets up the infrastructure needed for a
team to start working — comparable to running the plumbing and wiring before any interior
decoration. Specifically, this included:

- **Choosing the language and runtime**: TypeScript (a typed superset of JavaScript) running on
  Node.js.
- **Setting up a multi-package repository structure**: the codebase is split into a few independent
  packages instead of one giant pile of files. There are currently three packages:
  - `apps/cli`: the command-line entry point — where a user or another program invokes this tool.
  - `libs/domain`: definitions of the core business concepts (details in Stage 2 below).
  - `libs/dag`: the engine that computes task dependency relationships (details in Stage 3 below).
- **Building a command-line shell**: a minimal command-line program named `forge` was built using a
  library called Commander. It has `analyze` (now implemented in Stages 6–7) and `plan` (still a
  discoverable placeholder until planning is implemented).
- **Setting up automated quality checks**:
  - Automatic code formatting so every team member's code looks consistent (tool: Oxfmt).
  - Automatic detection of obvious bugs and bad patterns in the code (tool: Oxlint).
  - Automated tests that verify the code behaves as expected (tool: Vitest).
  - All of these are combined into a single command, `pnpm check`, which anyone can run before
    submitting code to catch problems early.

**Outcome of this stage**: an empty-but-ready project skeleton that can be checked into version
control and set up by any team member with all automated checks already wired up.

## Stage 2: Defining the core business concepts (the domain model)

This stage starts designing "what information the orchestrator needs to know in order to make a
decision" — but only the _definitions_, not the _computation logic_ yet. Think of it as deciding
the column names of a spreadsheet before writing the formulas that fill it in.

Six groups of core concepts were defined:

1. **Task Contract**: describes what a coding task looks like — its name, its goal, which other
   tasks it depends on, which files it is expected to read/write, and how completion should be
   verified (running tests, or running a specific command). This part also includes **format
   validation**: for example, a task cannot depend on itself, the same dependency cannot be listed
   twice, and no two tasks can share the same ID. These checks catch obviously malformed task
   definitions before a task is ever executed.

2. **Repository Graph**: defines how the three layers — "project," "file," and "symbol" (e.g. a
   specific class or function) — should be represented, along with how their dependency and
   reference relationships are recorded. Stages 6–7 now populate this graph from real repositories.

3. **Impact & Conflict**: defines "which projects/files/symbols a task actually affects," "how
   severe the conflict is between two tasks (expressed as a 0–100 score)," and "what should be done
   about a conflict (fully parallel, guarded parallel, staggered, or serialized)." These are, again,
   only shape definitions — the actual logic for computing a conflict score has not been written.

4. **Execution**: defines what an "execution plan" should look like — a sequence of "waves," where
   all tasks inside one wave can run at the same time. The algorithm for actually building these
   waves has not been written; only the shape of the result is defined here.

5. **Write Lease**: this is the key mechanism for preventing conflicts. Before an agent can modify
   something, it must first "acquire a lease" for that resource; only if the lease is granted can it
   proceed, which prevents another agent from editing the same thing at the same time. This part
   defines the containment hierarchy of leases (e.g. a lease on an entire project implicitly covers
   every file and symbol inside it; a lease on a class implicitly covers all of its methods), and it
   already includes a **fully working resource-conflict function** — given any two writable
   resources, the system can correctly determine whether their leases would conflict, backed by a
   test suite. The service that stores and manages live leases has not been implemented yet.

6. **Task State Machine**: defines the states a task moves through from "pending" to "done"
   (pending → ready → running → blocked/verifying → completed/failed/cancelled), and which
   transitions between states are legal (for example, a task cannot jump directly from "pending" to
   "completed" — it must go through the proper sequence). This part is **fully implemented**, with
   tests covering every possible state-transition combination.

**Outcome of this stage**: the "data structure spec" for all six core concepts is essentially
finalized. Two of them — write-lease conflict detection and task state transition rules — are
already usable, working features. The rest lay the groundwork for later implementation stages.

### Deep dive: what a Write Lease is and how it works

A **Write Lease** is a temporary, exclusive permission to modify a named resource. Before an agent
changes a project, file, code symbol, or shared coordination resource, it must acquire the matching
lease. The system grants the request only when no active lease already owns an overlapping resource.

It is useful to think of a lease as a reservation with an owner and an expiry time. A plain lock is
usually described only as "locked" or "unlocked." A lease additionally records who owns it, which
run and task it belongs to, when it was acquired, when it expires, and which version is current. If
an agent crashes and never releases its lease, the expiry prevents the resource from remaining
blocked forever.

#### Why task dependencies are not enough

The DAG answers whether task ordering permits two tasks to start together. It does not know whether
their code edits overlap. For example, one task might modify the `ProductService` class while another
modifies `ProductService.search`. The tasks may have no declared dependency, but the class contains
the method, so allowing both writes at the same time could lose one agent's work.

The intended separation is:

```text
DAG             Is parallel execution logically allowed by task dependencies?
Conflict Engine Is overlapping code impact predicted before execution?
Write Lease     Is this concrete runtime write currently authorized?
```

Predicted impact can be incomplete. The lease is the runtime safety boundary: an unexpected write
must acquire permission before it is allowed to proceed.

#### Resource hierarchy

Writable repository resources form an explicit containment hierarchy:

```text
Project
└── File
    └── Symbol
        └── Child symbol

Shared resource (a separate named namespace)
```

- A **project lease** covers every file and symbol in that project.
- A **file lease** covers every symbol in that file.
- A **symbol lease** covers that symbol and its descendant symbols.
- A **shared-resource lease** covers a named coordination resource such as a database schema,
  dependency set, generated-code output, or API schema.

File resources carry both `projectId` and `fileId`. Symbol resources carry `projectId`, `fileId`,
`symbolId`, and the complete list of `ancestorSymbolIds`. Keeping the full lineage inside the
resource makes conflict decisions self-contained after persistence; the guard does not need to
reload a repository graph merely to learn that a method belongs to a class.

#### Exact conflict rules implemented today

The deterministic `areWritableResourcesConflicting(a, b)` function applies these rules in order:

1. Shared resources conflict only when both sides are shared resources with the same `resourceId`.
2. Repository resources in different projects do not conflict.
3. Within one project, a project lease conflicts with every file or symbol lease.
4. Resources in different files do not conflict.
5. Within one file, a file lease conflicts with every symbol lease.
6. Two symbol leases conflict when they identify the same symbol or when either symbol is an
   ancestor of the other. Sibling symbols do not conflict.

Examples:

| Lease A                 | Lease B                 | Result   | Reason                        |
| ----------------------- | ----------------------- | -------- | ----------------------------- |
| `project:catalog`       | `catalog/product.ts`    | conflict | the project contains the file |
| `product.ts`            | `ProductService.search` | conflict | the file contains the method  |
| `ProductService`        | `ProductService.search` | conflict | the class contains the method |
| `ProductService.search` | the same method         | conflict | identical symbol              |
| `ProductService.search` | `ProductService.get`    | allowed  | sibling methods               |
| `catalog/product.ts`    | `catalog/price.ts`      | allowed  | different files               |
| `database-schema`       | `database-schema`       | conflict | same shared resource          |
| `database-schema`       | `graphql-schema`        | allowed  | different shared resources    |

The function is symmetric: checking A against B always produces the same answer as checking B
against A.

#### Acquisition and ownership

A lease request identifies:

- `runId` — the orchestration run;
- `agentId` — the agent requesting permission;
- `taskId` — the task being performed;
- `resource` — the exact project, file, symbol, or shared resource;
- `mode` — currently always `exclusive`.

A successful request returns `granted` with a lease ID, version, state, acquisition time, and latest
heartbeat time.
A blocked request returns `blocked` plus the IDs of the active leases causing the conflict. This lets
the scheduler explain which owner a task is waiting for instead of reporting an unexplained delay.

`runId` prevents data from an older orchestration run being confused with a new run that happens to
reuse the same task or agent ID. It does not mean two runs may automatically write the same checkout;
the eventual guard must still consider every active lease protecting that workspace.

#### Heartbeats, versions, and stale recovery

Long-running work heartbeats its lease. A heartbeat includes the lease ID and the version the agent
expects to be current. If the stored version still matches, the guard increments the version and
records new liveness evidence. If the lease is gone, it returns `not-found`. If a newer version
exists, it returns `version-conflict` with the actual version.

This is optimistic concurrency control. A fixed timer alone may not release a lease. The runtime
must combine missed heartbeats, agent liveness, workspace state, a grace policy, and explicit
recovery evidence before marking a lease `STALE` and allowing it to be reclaimed.

Release carries the caller's expected lease version. A matching ACTIVE lease returns `released` with
an incremented version; an old version returns `version-conflict`; an absent or non-active lease
returns `not-found`. Retrying with the version returned after a successful release is therefore an
idempotent cleanup outcome, while a delayed stale release cannot end a lease that has advanced.

#### How the future runtime guard must acquire leases safely

The complete service will need to:

```text
resolve and validate the requested resource identity
        ↓
load ACTIVE leases and evaluate liveness evidence
        ↓
load active leases that could overlap
        ↓
apply areWritableResourcesConflicting()
        ↓
atomically grant a new lease or return blocked
        ↓
heartbeat during long work, mark stale only with evidence, and release after integration
```

The conflict check and lease creation must be one atomic database operation. If two agents can both
check "no conflict" before either one writes its lease, both could be granted incorrectly. The
future persistence implementation therefore needs a transaction, serialization mechanism, or
equivalent constraint that makes "check and create" indivisible.

#### What is implemented, and what is not

Implemented now:

- writable-resource identities and their complete hierarchy;
- deterministic and symmetric containment-conflict rules;
- request and result contracts for acquire, heartbeat, mark-stale, and release;
- run, agent, task, version, state, acquisition, heartbeat, release, and stale-evidence fields;
- tests for the principal conflicting and independent resource combinations.

Not implemented yet:

- a concrete `WriteGuard` service;
- active-lease storage or SQLite/Drizzle persistence;
- atomic acquisition transactions;
- heartbeat processing, liveness evaluation, and stale recovery;
- enforcement that intercepts an agent before an actual write;
- blocked-task queues, wake-up, and crash recovery;
- repository-graph resolution and validation of resource identities.

The accurate current status is: **the lease contracts and resource-conflict decision are working;
live lease acquisition, storage, heartbeat, stale recovery, release, and enforcement are still
future work.**

There is also an important practical limitation. Two sibling methods in the same file may receive
separate symbol leases, but two agents that rewrite the whole file can still produce a Git conflict.
Symbol-level leases are safe only when actual writes are constrained and checked at symbol level.
Otherwise the scheduler must request a more conservative file lease. Future isolated worktrees,
diff-boundary validation, lease escalation, and controlled merging must work alongside leases;
Write Lease is an authorization layer, not a replacement for Git integration.

## Stage 3: The task dependency graph engine (DAG)

This was the first core feature completed end-to-end and remains the ordering foundation used by
later engines.

### What a DAG is, and what problem it solves

DAG stands for **Directed Acyclic Graph**. Breaking down the three words:

- **Graph**: a bunch of "nodes" (points) connected by "edges" (lines).
- **Directed**: the edges have a direction — they are not bidirectional. For example, "task B
  depends on task A" is drawn as an arrow pointing from A to B; it cannot be read the other way
  around as "A depends on B."
- **Acyclic**: following the arrows, you can never walk back to where you started. In other words,
  a chain like "A → B → C → A" that loops back on itself is not allowed.

Everyday examples include cooking steps that must happen in order ("chop the vegetables" before
"stir-fry them") and university course prerequisites ("Linear Algebra" before "Machine Learning").
The dependency arrows shown in a project-management Gantt chart can also be modeled as a DAG.

### What a Gantt chart is

A **Gantt chart** is a timeline view used to plan and track a project. Task names are listed in rows
on the left, while time runs horizontally from left to right. Each task is drawn as a horizontal bar:
the bar's starting position shows when the task starts, its ending position shows when it should
finish, and its length represents the expected duration.

A typical Gantt chart can show:

- **tasks** — the pieces of work listed as rows;
- **start and finish dates** — where each task bar begins and ends on the timeline;
- **duration** — how long the bar is;
- **dependencies** — arrows such as "testing cannot start until implementation finishes";
- **parallel work** — bars that overlap in time;
- **milestones** — important zero-duration checkpoints, often drawn as diamonds;
- **progress** — how much of a task bar has been completed;
- **the critical path** — the chain of dependent tasks that determines the earliest possible project
  completion date. Delaying a critical-path task delays the whole project unless time is recovered
  elsewhere.

For example, a simple software plan might show "design" on days 1–2, "API implementation" and "UI
implementation" running in parallel on days 3–5, and "integration testing" beginning only after
both implementations finish. The chart makes the calendar plan easy for a person to see at a glance.

A Gantt chart and a DAG are related but not interchangeable. A DAG records the logical rule "A must
happen before B" without needing dates or duration estimates. A Gantt chart places tasks on a
calendar and adds duration, deadlines, progress, and sometimes resource assignments. A scheduler can
use a valid DAG plus time estimates to construct a Gantt chart, but the DAG itself does not know how
many hours or days a task will take.

This project currently implements only the **DAG dependency engine**. It does not generate a Gantt
chart, estimate task duration, assign calendar dates, calculate a time-based critical path, or track
percentage completion. A Gantt-style view could be added later as a visualization of an execution
plan, but it would not become the source of truth for dependencies.

**The core problem a DAG solves**: given a pile of "this must be done before that can start" rules,
how do you guarantee those rules are not self-contradictory, and how do you compute an order in
which everything can actually be executed. This breaks down into three sub-problems, which map
directly onto the three functions this module actually implements:

- **Are these dependency relationships even valid?** — Validate whether a batch of tasks'
  dependencies are legal: are there duplicate task IDs, does any task depend on a task that doesn't
  exist, does any task depend on itself, and is there a circular chain (e.g. "A depends on B, and B
  depends on A")? Under a circular dependency, no task can ever truly go "first," because every task
  in the cycle is waiting on another task that is ultimately waiting on it — there is no valid order
  at all. If there is a problem, the system produces a clear, structured error report instead of the
  program hanging or silently computing the wrong result.
- **If they are valid, in what order should they run?** — Assuming there are no cycles and no
  missing dependencies, compute a sensible "do this first, then that" order. When multiple tasks
  become eligible to start at the same time, use each task's configured priority to decide which one
  goes first, and guarantee that **the same input always produces the same output order** (this
  ordering stability was specifically verified with tests).
- **Right now, at this moment, which tasks can start immediately?** — Given a list of
  already-completed tasks and a list of currently-unavailable tasks, work out which of the remaining
  tasks have all of their prerequisites satisfied and are ready to start immediately. This is the
  direct basis for deciding "can these run in parallel" — if two tasks both appear on the "ready to
  start now" list at the same time, it means there is no dependency relationship between them, and
  in principle they can run at the same time.

This module was specifically stress-tested: even when given tens of thousands of tasks chained in a
single, very deep dependency line (A depends on B, B depends on C, and so on for tens of thousands
of levels), it still computes the correct result quickly, without crashing or failing due to the
sheer number of tasks.

### What layer of the problem DAG solves in this project

Deciding "which coding tasks can safely run in parallel" requires weighing many factors —
dependency relationships, code conflicts, shared-resource contention, write leases, and so on.
**The DAG engine is only responsible for the "dependency relationship" dimension.** It answers the
most basic question: "Ignoring code conflicts and resource contention entirely, and looking purely
at the ordering rules the tasks declare, is there any logical problem with their execution order,
and which tasks can start right now?"

The Conflict Engine planned for later (deciding whether two tasks would edit the same piece of
code) and the Scheduler (combining "which tasks are ready" with "conflict risk" to actually decide
which tasks get placed into the same parallel batch) both build on top of the "valid order" that the
DAG engine produces, adding further judgment dimensions on top of it. The DAG is the foundation, not
the whole answer — it guarantees the _order_ has no logical errors; it does not guarantee that two
tasks with no ordering dependency between them won't step on each other's code when edited at the
same time (that is what Write Lease and the Conflict Engine are meant to solve, and neither is
implemented yet).

**Outcome of this stage**: a ready-to-use "task ordering calculator." Given a batch of tasks and
their dependencies, it tells you whether the batch is valid, and if so, in what order and at what
pace the tasks should run.

## Stage 4: Simplifying workspace tooling

The project established a small, explicit workspace toolchain appropriate for its current size:

- pnpm (a package manager) handles how the packages reference each other.
- TypeScript's built-in "project references" feature handles which package compiles before which.
- Vitest's built-in multi-project feature handles running all packages' tests in one go.

This decision is recorded in ADR-009, together with measurable conditions for reassessing build
orchestration: package count, CI duration, duplicated affected-build logic, watch-mode cost, and
measurable caching opportunity.

This cleanup also fixed a real bug along the way: the command-line tool's (`apps/cli`) configuration
previously _declared_ that it depended on the `domain` and `dag` packages, but the actual code never
used them — a leftover configuration mistake. This cleanup removed that phantom dependency as well.

**Outcome of this stage**: the project is structured as multiple packages in one repository, using
an explicit toolchain whose responsibilities are easy to inspect and whose build output was fully
re-verified.

## Stage 5: Simplifying the toolchain — unifying the TypeScript version

TypeScript recently released a "native" version (generation 7), whose compiler core was rewritten in
a different programming language for much better speed. Because it is new, some older tools have
not caught up yet and only support certain low-level APIs that were provided by the previous
generation (generation 6). To hedge against needing those older APIs later, the project originally
installed both generation 6 and generation 7 of TypeScript at the same time.

It later became clear that generation 6 had zero actual usage in the codebase — it was purely a
"just-in-case" reservation — and keeping two versions installed side by side added maintenance
overhead and made it easy to lose track of "which version is actually checking this code." The team
removed generation 6, and the project now uses a single TypeScript toolchain (generation 7).

The architecture decision record was also updated to state that if a future feature (such as "read
source files and understand code structure" for repository analysis) genuinely needs an API that
only the older generation provides, that compatibility dependency should be added specifically for
that feature at that time — not pre-installed now and left unused.

**Outcome of this stage**: the project now has a single compiler toolchain, removing an ongoing
burden of maintaining, explaining, and worrying about version consistency between two compilers.

## Stage 6: Reading a real pnpm workspace

Until this stage, the repository graph was only a definition of what repository information should
look like. Tests could manually create project nodes and dependency lines, but the program could not
open a real repository and discover those facts itself. This stage built the first working bridge
between files on disk and that repository graph.

The supported input is a **pnpm workspace**. A pnpm workspace is a repository containing multiple
Node.js packages, with a `pnpm-workspace.yaml` file that says where those packages live. Each package
has a `package.json` file containing its name and dependencies. The new analyzer now performs the
following steps:

1. It confirms that the requested directory is a pnpm workspace.
2. It reads the package-location patterns from `pnpm-workspace.yaml`, including exclusion patterns.
3. It discovers the root package and every matching workspace package.
4. It reads each package name and its normal, development, optional, and peer dependencies.
5. It converts dependencies between local workspace packages into project-graph edges. Dependencies
   on third-party packages are deliberately ignored because they are not editable projects in the
   repository.
6. It emits the result in a stable order, so analyzing unchanged input repeatedly produces identical
   JSON output.

For example, if an application declares that it depends on a local `domain` package, the output
contains an edge from the application to `domain`. The direction means "the first project needs the
second project," not the order in which folders happen to appear on disk.

The implementation also protects the analysis boundary. It reports structured errors for malformed
YAML or JSON, packages without usable names, duplicate package names, self-dependencies, explicit
`workspace:` dependencies whose target does not exist, unreadable repository paths, and workspace
entries that escape the repository directory. This prevents bad repository metadata from silently
producing a misleading graph.

A small provider-neutral interface separates "ask for workspace facts" from "how pnpm stores
workspace metadata." Only the pnpm provider is implemented because it is the only current product
requirement. Another provider will be added only if a real supported-repository requirement appears.

The `forge analyze` command is now a real command rather than a placeholder. Running:

```sh
forge analyze /path/to/a/pnpm-workspace
```

prints the selected provider, canonical repository path, discovered projects, their roots and source
roots, and local project dependencies as JSON. The implementation is tested both against a dedicated
fixture and against the command-line integration. It was also run against this repository itself,
where it correctly found five workspace projects and four dependency edges.

### Real-repository validation: Ingestion and Matching

The analyzer was also run against the existing local repository:

```text
~/Desktop/research-repositories/ingestion-and-matching
```

The command completed successfully with the `pnpm-workspace` provider and discovered three projects:

| Project                     | Repository root | Source root         |
| --------------------------- | --------------- | ------------------- |
| `ingestion-and-matching`    | `.`             | not declared        |
| `api`                       | `workspace/api` | `workspace/api/src` |
| `ingestion-and-matching-ui` | `workspace/ui`  | `workspace/ui/src`  |

It reported zero local package-dependency edges. This result must be interpreted narrowly: neither
workspace package declares the other as a local dependency under the dependency fields currently
read from `package.json`. It does **not** prove that the API and UI have no code-level relationship.
Connections expressed through TypeScript path aliases, shared source imports, generated types, tRPC
contracts, or ordinary imports are outside this stage's analysis and will only become visible after
file and symbol analysis is implemented.

At the end of Stage 6, the CLI package had not yet registered its `forge` executable, so the
verified invocation at that historical point was:

```sh
node apps/cli/dist/main.js analyze \
  ~/Desktop/research-repositories/ingestion-and-matching
```

Stage 7 registers the executable and uses `pnpm exec forge`; see the next section. Therefore, the
precise capability at the end of Stage 6 was: **given a readable pnpm workspace,
the built CLI can discover workspace packages and dependency relationships explicitly represented
by their package manifests. It cannot yet infer code-level coupling that is absent from those
manifests.**

### What "analyze" means at this stage

The word "analyze" can easily suggest that an AI model is reading and interpreting the code. That
is **not** what happens here. The command makes no network request, sends no repository content to an
LLM, and makes no probabilistic judgment. It is an ordinary deterministic program: it reads known
configuration fields and transforms them according to fixed rules. The same valid input therefore
produces the same graph regardless of who runs it or whether any AI service is available.

It is also more specific than a simple recursive file listing. The command does not currently print
every directory and file. It reads only the workspace definition, package manifests, and whether a
package has a `src` directory. From those facts it builds a **semantic project-level map**: package
identity, package location, source-root location, and local package dependency relationships.

Stage 7, documented below, now inspects TypeScript files, imports, exports, declarations, and symbol
references with deterministic TypeScript parsing and type-checking APIs. LLMs may later help turn
natural-language goals into structured task contracts or implement tasks, but project discovery,
dependency facts, conflict rules, write authorization, and verification results must not depend on
an LLM guessing correctly.

Stage 6 intentionally stopped at the **project level**. The following stage removes that limitation.

**Outcome of this stage**: the orchestrator can now open a real pnpm monorepo and build the first
layer of its repository map. This is the first completed path from user input through the CLI to a
real analysis result.

## Stage 7: RepositoryGraph — TypeScript file and symbol analysis

Stage 6 discovered which pnpm packages exist. Stage 7 turns that package list into a deterministic
map of the repository: which TypeScript files belong to each project, what declarations those files
contain, and how projects, files, and symbols depend on or refer to one another.

This is **not LLM analysis**. `forge analyze` makes no network request, sends no source code to a
model, and does not modify the analyzed repository. It combines pnpm manifests with the pinned
TypeScript 7 native API and converts compiler facts into a provider-neutral `RepositoryGraph`.

For a code-level walkthrough, see [RepositoryGraph Analysis — Implementation and Working
Model](./repository-graph-analysis.en.md).

### What RepositoryGraph contains

```text
RepositoryGraph
├── projects: ProjectNode[]
├── files: FileNode[]
├── symbols: SymbolNode[]
├── projectDependencies: Project -> Project
├── fileDependencies: File -> File
├── symbolReferences: Symbol -> Symbol
└── diagnostics: analysis warnings
```

- A `ProjectNode` represents a pnpm workspace package.
- A `FileNode` represents one real TypeScript file owned by a project.
- A `SymbolNode` represents a named declaration such as a class, function, interface, method, or
  property.
- An edge records a relationship TypeScript or a package manifest actually resolved. It is factual
  evidence, not yet a prediction that a coding task will change that node.

### How `forge analyze` works

```text
forge analyze <repository>
        |
        v
resolve repository path and select a provider
        |
        v
PnpmWorkspaceGraphProvider
  ├── read pnpm-workspace.yaml
  ├── find package.json manifests
  ├── create ProjectNode records
  └── create manifest project-dependency edges
        |
        v
TypeScriptRepositoryAnalyzer
  ├── discover root tsconfig.json files
  ├── recursively follow project references
  ├── open real TypeScript Programs and Checkers
  ├── assign and deduplicate source files
  ├── build file dependency edges
  ├── index declarations as SymbolNode records
  ├── build symbol reference edges
  ├── infer cross-project dependencies
  └── report missing, empty, or uncovered input
        |
        v
serialize a concise summary, or the complete graph with --full
```

#### 1. Project discovery from pnpm

`PnpmWorkspaceGraphProvider` reads `pnpm-workspace.yaml`, expands its package patterns, and parses the
root and workspace `package.json` files. Package names become stable project IDs. Repository-relative
package and source roots become project metadata.

Dependencies declared between workspace packages produce the first project edges. The provider
rejects malformed manifests, duplicate package names, self-dependencies, missing `workspace:*`
targets, unreadable repositories, and workspace paths that resolve outside the repository.

The provider boundary is replaceable: the domain graph does not depend on pnpm types. pnpm is the
implemented input provider, not the universal source of truth for every future repository format.

#### 2. TypeScript configuration discovery

For every project, the analyzer starts at its root `tsconfig.json`. It parses TypeScript JSONC,
including comments and trailing commas, and recursively follows `references` to real compilation
configs such as:

```text
tsconfig.json
├── tsconfig.app.json
├── tsconfig.spec.json
└── config/tsconfig.build.json
```

Missing, malformed, cyclic, unreadable, or out-of-repository references are handled deterministically;
invalid input becomes a structured error rather than a successful empty graph. This supports both
ordinary configs and solution-style repositories whose root config contains only references.

The discovered configs are opened with the pinned TypeScript 7 native API. The resulting Programs
and Checkers obey the target repository's real compiler options, module resolution, path aliases,
package exports, and workspace links. The unstable native API path is isolated inside
`libs/repository-analysis`; native AST and Checker objects never enter the domain model, and
TypeScript 6 is not installed.

#### 3. File ownership, identity, and safety

Each source file is assigned to the most specific pnpm project containing its real filesystem path.
The compiler configuration must belong to that same project, so a root or sibling project cannot
lend an arbitrary Checker to another project's source.

Filesystem symlinks are resolved before ownership, boundary checks, graph identity, and
deduplication. Multiple symlink spellings of one file therefore produce one `FileNode` and one
symbol set. A symlink into `node_modules` or outside the repository is excluded. Because identity is
based on the real file, `FileNode.path` may differ from the symlink spelling written in an import.

A file ID combines the owning project ID with its real repository-relative path:

```text
api:workspace/api/src/modules/work/router.ts
```

Generated paths are marked. IDs do not contain line numbers, so moving a declaration within a file
does not by itself change identity.

When production and spec/test configs both include one file, the production context wins. If two
production configs overlap, the lexicographically first config path is the documented deterministic
tie-break; it is not a claim that those compiler options are semantically better.

#### 4. File dependency edges

File relationships come from TypeScript's resolved module information, not from text matching.
Normal imports, exports, `export *`, re-export chains, path aliases, bare workspace packages, and
shared-source imports can therefore resolve to the real target `FileNode`.

Cross-project file edges are promoted into project-dependency edges and merged with the manifest
edges found earlier. This lets the graph expose a real source dependency even when a workspace
manifest did not declare it explicitly.

#### 5. Symbol indexing and stable identity

The analyzer indexes top-level classes, functions, interfaces, type aliases, enums, namespaces, and
variables, plus constructors, methods, accessors, and properties. Namespace bodies are recursive.
Parent-child structure, public export visibility, and private/protected visibility are retained.

Class/namespace declaration merging uses a fixed kind priority and records all participating kinds
in `mergedKinds`, so results do not depend on declaration order. Dynamic computed properties use an
escaped expression-based identity. Getter/setter pairs share one callable symbol, redundant outer
parentheses are normalized, and repeated properties are numbered only among occurrences of the
same expression.

A symbol ID extends the file ID with a stable declaration path:

```text
api:workspace/api/src/modules/work/router.ts:createWorkRouter
```

#### 6. Symbol reference edges

The TypeScript Checker resolves identifier uses to their actual declarations. The analyzer converts
those resolved relationships into deduplicated `Symbol -> Symbol` edges, including references that
cross files, aliases, re-exports, or workspace projects. Requests are processed in bounded batches
to cap temporary native handle and memory pressure.

#### 7. Diagnostics and cleanup

Successful analysis can still contain warnings:

- `MISSING_TYPESCRIPT_CONFIGURATION`: a project has no root TypeScript configuration;
- `EMPTY_TYPESCRIPT_PROJECT`: valid configuration produced no owned source files;
- `UNCOVERED_TYPESCRIPT_FILES`: TypeScript files exist on disk but are not covered by a discovered
  configuration. The diagnostic lists their repository-relative paths rather than silently choosing
  an incorrect Checker.

The uncovered-file comparison excludes dependencies, build/coverage output, and nested pnpm
workspaces. Intentionally excluded generated files can still add diagnostic noise; a future policy
may separate generated and handwritten files by severity.

Native resources are always cleaned up. Both snapshot disposal and API close are attempted. The
original structured analysis error takes priority over cleanup failures and retains its original
stack; a cleanup-only failure is still reported.

### CLI usage and real-repository result

After building:

```sh
pnpm exec forge analyze /path/to/repository
pnpm exec forge analyze /path/to/repository --full
```

Summary mode returns counts, projects, project dependencies, and diagnostics. `--full` additionally
returns every file, symbol, file edge, and symbol edge, which can be very large.

The analyzer has repeatedly been run against:

```text
~/Desktop/research-repositories/ingestion-and-matching
```

The latest independent-review sample reported:

| Graph fact           |  Count |
| -------------------- | -----: |
| Projects             |      3 |
| TypeScript files     |    959 |
| Indexed symbols      |  7,224 |
| Project dependencies |      3 |
| File dependencies    |  3,424 |
| Symbol references    | 13,037 |
| Diagnostics          |      1 |

The repository is active, so small count changes between runs are expected. The stable result is
more important: the graph consistently finds `ingestion-and-matching-ui -> api`, and the one warning
lists API scripts that exist on disk but are outside `workspace/api/tsconfig.json` coverage.

These numbers do not mean the tool understands the business meaning of 7,224 symbols. They mean it
has a deterministic structural index of where declarations live and how TypeScript resolves their
relationships. That is the factual input for Task Impact Engine.

### Hardening timeline

Several independent reviews used temporary adversarial workspaces, self-analysis, and the real
research repository. The history is kept briefly because the final behavior matters more than the
review-by-review narrative:

| Sequence                    | Problem found                                                                                                                              | Resulting fix                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Initial hardening           | Nested namespaces, declaration merging, modifiers, computed names, and project ownership had edge cases                                    | Added recursive indexing, deterministic merged kinds, typed modifier checks, stable computed IDs, and strict owning-project contexts |
| Solution-layout review      | A references-only root config could return `0 files / 0 symbols`                                                                           | Added JSONC parsing and recursive project-reference discovery; malformed references now fail visibly                                 |
| Ownership/diagnostic review | Configs below the project root were rejected, partially uncovered files were silent, and native failure cleanup lacked an integration test | Assigned configs to their most specific project, added `UNCOVERED_TYPESCRIPT_FILES`, and tested real snapshot/API cleanup            |
| Symlink review              | One real file reachable by several symlink paths became duplicate files and symbols                                                        | Real-path identity now drives ownership, deduplication, edges, IDs, and repository-boundary checks                                   |
| Final review                | One redundant `realpath` call and unclear public path semantics remained                                                                   | Removed the repeated filesystem call and documented that FileNode identity uses the real path                                        |

The final review found no Critical, High, or Medium issue and approved closing the dedicated
RepositoryGraph factual-layer review.

### Current limitations

- Only TypeScript-family files covered by discovered configs receive semantic indexing; this is not
  a universal JavaScript, SQL, database, CDK, or infrastructure analyzer.
- Supported named declaration categories are indexed, not every anonymous or nested AST construct.
- Export visibility is present, but normalized callable/type signatures are not yet extracted.
- Analysis is a full scan; no incremental refresh contract is exposed yet.
- Project dependency edges now record broad evidence sources from manifests, `workspace:` protocol,
  TypeScript project references, and TypeScript imports. They do not yet subdivide imports into
  production/test/generated/runtime/type-only categories.
- The extra uncovered-file glob is proven at roughly one-thousand-file scale, not yet benchmarked
  for repositories with tens of thousands of files.
- Summary JSON contains an absolute repository path, which may reveal a local username when logs
  are shared.
- `forge plan` remains unavailable. `forge analyze` neither dispatches agents nor modifies source.

**Outcome of this stage**: `forge analyze` now builds a tested project, file, symbol, dependency,
reference, and diagnostic map for real pnpm TypeScript repositories. Architecture milestone 5 and
the dedicated RepositoryGraph factual-layer review are complete. The next stage is Task Impact
Engine: resolving task selectors into this graph and expanding their explainable impact.

### Architecture-alignment checkpoint before Task Impact

Before implementing Task Impact, the contracts were reviewed against the intended product boundary
and corrected where an implementation-shaped assumption had leaked into the model:

- `WorkspaceGraphProvider` now means “supply generic workspace facts.” The pnpm implementation
  returns a `WorkspaceGraph`; the TypeScript analyzer separately enriches it into `RepositoryGraph`.
- Every project now retains `packageJsonPath`, dependency names/versions/kinds, `workspace:` usage,
  scripts, source roots, and every owned discovered `tsconfig` path.
- Project dependency edges carry provenance. Manifest, workspace-protocol, TypeScript-reference,
  and TypeScript-import evidence are already emitted and merged deterministically.
- Verification accepts either a generic command with optional `cwd` or a package script selected by
  package name.
- Task impact is split into `PredictedTaskImpact` and `ObservedTaskImpact`; the planner remains a
  separate future component.
- Conflicts distinguish hard structural constraints from scored risk. Scheduler methods receive
  those collections separately rather than accepting one mixed scored list.
- Scheduler contracts are event-driven. An initial wave plan is visualization only, not a runtime
  barrier.
- Task state now includes `INTEGRATING` between verification and completion.
- Write leases use `ACTIVE`/`RELEASED`/`STALE`, versioned heartbeats, and evidence-based stale
  recovery rather than automatic fixed-duration expiry.

This checkpoint changed contracts and factual output; it did not implement Task Impact, Conflict
Engine, Scheduler, or the live Write Guard. The research repository was analyzed again after the
change: 3 projects, 963 files, 7,263 symbols, 3 project dependencies, 3,440 file dependencies,
13,121 symbol references, and the same single 25-file `UNCOVERED_TYPESCRIPT_FILES` warning for API
scripts. Project edges now explain that their current evidence is `typescript-import`.

#### Independent-review corrections

The independent contract review found no Critical issue and confirmed the two-stage facts pipeline,
provenance direction/merging, predicted/observed boundary, event-driven shape, and non-TTL lease
semantics. Its High and cleanup findings were resolved before Task Impact work:

- `TaskConflict` became a discriminated union. `HardTaskConflict` requires a non-empty constraint
  tuple and allows only stagger/serialize; `RiskTaskConflict` cannot contain constraints. Scheduler
  methods take hard and risk collections as separate required parameters.
- The duplicate optional `sourceRoot` was removed; `sourceRoots` is now the only representation.
- `RepositoryGraph extends WorkspaceGraph`, so their shared factual fields cannot drift.
- The unused `RepositoryAnalyzer` and duplicate `RepositoryAnalysisRequest` were removed rather
  than preserving an unimplemented incremental-analysis abstraction.
- The single-value `ExecutionPlan.kind` placeholder was removed, and `lease-stale` was added as an
  explicit scheduler event.
- Exact-symbol lease identity now has a dedicated test in addition to hierarchy tests.

The review also noted that integration conflicts may eventually need recoverable blocking. The
current state machine deliberately remains terminal from `INTEGRATING` because a single `BLOCKED`
state cannot remember whether it should resume execution or integration. A phase-aware resume model
must be designed before the worktree-integration milestone; adding a lossy transition now would hide
that requirement rather than solve it.

The follow-up independent review closed H1, M1–M3, and L1–L3 with no Critical, High, or Medium
finding. It approved ending contract calibration and starting Task Impact Engine. One non-blocking
Low note remains: `HardTaskConflict.score` still exists for explanation, so the future Scheduler
implementation must be tested to ensure it never filters or selectively enforces hard conflicts by
score. That is an implementation-review gate for the Scheduler milestone, not a Task Impact
blocker. The reviewer's latest active-repository sample was 963 files, 7,265 symbols, 3,440 file
dependencies, and 13,123 symbol references; the two-symbol drift from the previous run is normal
activity in the research repository.

### Formal architecture gate before Milestone 6

The first formal architecture/code gate passed with no Blocker. It confirmed the domain direction,
Task Contract, DAG, Repository Facts Layer, symbol graph, conflict variants, lease hierarchy, and
scheduler boundary. Two forward-looking High items were accepted as milestone constraints rather
than defects in milestones 1–5:

- predicted analysis must distinguish touching an exported symbol from proving that its API
  signature changed;
- before Scheduler implementation, scheduler events and decision reasons need structured payloads
  suitable for audit, persistence, and replay.

The review also retained the phase-aware integration-blocking design for the worktree milestone and
required shared-resource concurrency semantics to remain centralized in a registry. No
RepositoryGraph or DAG rework was requested.

### Milestone 6: Task Impact, Shared Resource Registry, and Conflict Engine

Milestone 6 is now implemented as two libraries with one-way dependencies:

```text
domain
  ^
task-impact
  ^
conflict-engine
```

`RepositoryTaskImpactAnalyzer` resolves `project`, `file`, `glob`, `symbol`, and `shared-resource`
selectors against a read-only `RepositoryGraph`. File and symbol selections add their owning
projects. Written projects are traversed in the reverse dependency direction to collect every
transitive downstream consumer. Exact selectors with zero or multiple matches produce stable,
explainable ambiguity signals, while globs may intentionally match many files.

The configurable `SharedResourceRegistry` validates unique definitions and supports `exclusive`,
`ordered`, and `producer-controlled` policies. It attaches rules from exact files and path patterns,
including non-TypeScript files such as package manifests that do not appear in the semantic file
graph. Predicted impact retains normalized `read`, `write`, and `coordinate` modes instead of
collapsing all shared-resource use into one boolean.

Risk reporting now says `public-api-touch` when a task may write an exported symbol. It deliberately
does not claim `public-api-signature-change`; that stronger signal requires a future observed
before/after signature comparison. Generated writes, high downstream fan-out, and ambiguous
selectors are also reported explicitly.

`DeterministicConflictEngine` compares a canonical task pair and emits stable reasons, a bounded
score, and a recommended action. Same-symbol writes and registered resource policies create hard
structural constraints independently of score. Same-file sibling-symbol writes, same-project
writes, producer/consumer scope overlap, generated code, upstream/downstream project relationships,
public API touch, and high fan-out remain scored risks. Explicit unknown shared-resource IDs fail
impact analysis instead of silently weakening an intended hard policy. The Conflict Engine keeps a
soft fallback only for manually constructed or old persisted impacts that bypass normal validation.

The test suite now directly proves that:

- a same-symbol write stays hard even when its configured score is zero;
- sibling symbols in one file are a soft risk, not automatically a hard conflict;
- exclusive, ordered, and producer-controlled resources preserve different semantics;
- producer-controlled read/read access may remain parallel;
- producer-controlled write/read access preserves producer-to-consumer direction regardless of task
  ID ordering, while write/write remains nondirectional serialization;
- sibling-symbol treatment requires symbol-derived file writes on both sides and is disabled by
  explicit project, file, or glob coverage;
- zero score always recommends parallel even when `guardedParallel` is configured as zero;
- registry-resolved `package.json` scope is not mislabeled as an unresolved TypeScript file;
- independent projects produce a zero-score parallel recommendation.

The full quality gate passes with 99 tests. Coverage is 96.67% statements, 91.26% branches, 99.51%
functions, and 96.60% lines. `pnpm build` also passes. Self-analysis now reports 7 projects, 40
TypeScript files, 477 symbols, 13 project dependencies, 62 file dependencies, 811 symbol references,
and 2 expected root-project diagnostics.

The active research repository was analyzed again after the milestone: 3 projects, 968 files,
7,309 symbols, 3 project dependencies, 3,446 file dependencies, 13,192 symbol references, and the
same one `UNCOVERED_TYPESCRIPT_FILES` diagnostic covering 25 API scripts. This run is a regression
check for the Repository Facts Layer. `forge analyze` still returns repository facts only; Task
Impact and Conflict Engine are currently library APIs and have not yet been wired into a new CLI
command.

#### Milestone 6 independent-review hardening

The independent review found no Critical issue and one High shared-resource discovery gap. A symbol
selector added its owning file and project to impact but did not apply registry path rules to that
file. A symbol-scoped migration task could therefore miss an `ordered` resource that a file-scoped
task found correctly. File recording now owns registry lookup, so file, glob, and symbol selectors
share one path. An integration regression test analyzes a symbol task and a different-file task in
one ordered stream and requires an `ordered-resource` hard constraint.

The related Medium project-selector gap was also closed. Whole-project scope now checks the project
manifest and all known owned files for resource rules while leaving `filesWritten` empty; project
scope is not misrepresented as an explicit write to every file. For the second Medium design
question, the project chose fail-fast validation: explicit unknown resource IDs produce a sorted
`TaskImpactAnalysisError` with code `UNKNOWN_SHARED_RESOURCE`.

The Low deterministic-order observation was closed by adding reason/constraint detail as the final
tie-break. The default `guardedParallel = 1` threshold remains intentional: any detected nonzero
risk receives at least guarding, while validated deployment configuration can raise the threshold.

The follow-up reviewer independently reran coverage, TypeScript builds, Oxlint, and whitespace
validation, then hand-traced the symbol/file ordered-resource scenario and the project/unknown-ID
paths. The reported 93 tests and coverage numbers matched exactly. It found no new issue and
formally accepted Milestone 6, closing H1, M1, M2, and L1 and accepting L2 as documented.

One non-blocking maintenance note is carried forward: project-level resource discovery currently
iterates owned files separately from `recordFile`. If per-file behavior grows beyond registry lookup,
extract a shared side-effect-free resource-discovery helper so project-level discovery cannot drift.
No code change was made after acceptance solely for this cosmetic seam.

#### Second correctness review: provenance, direction, and zero-score action

A later ChatGPT review found three additional Milestone 6 correctness gaps. First, the conservative
`filesWritten` union did not retain why a file was present. A task declaring both whole-file and
symbol scope could be mistaken for safe sibling-symbol editing. Predicted impact now separately
stores explicit project writes, explicit file writes, glob-expanded writes, and symbol-derived
parent files. Sibling-symbol handling is allowed only when both sides are symbol-derived and no
broader scope covers that file.

Second, producer-controlled resources previously created only a symmetric non-concurrency
constraint. One writer plus one reader now creates a machine-readable `producer-consumer`
constraint containing the actual producer and consumer task IDs, independent of canonical pair
ordering. Read/read remains parallel; writer/writer remains hard serialization without inventing a
direction. The conflict edge remains symmetric, while this constraint supplies a separate ordering
edge for the future Scheduler.

Third, custom `guardedParallel: 0` could make a zero-score, `none`-severity conflict recommend
guarded parallelism. Action calculation now returns `parallel` for score zero before consulting any
threshold. Six regression cases cover whole-file provenance, project/glob coverage, producer IDs on
both sides of canonical ordering, and zero-score behavior. Hard constraints remain independent of
weights. This follow-up was intentionally limited to Milestone 6; no Scheduler work was included.

The final independent review reran all 99 tests with coverage, TypeScript build, Oxlint, and
whitespace validation, and manually derived the critical provenance, reversed task-ID ordering, and
zero-threshold paths rather than relying only on assertions. It found no Critical, High, or Medium
issue and approved closing Milestone 6. Two Low observations remain recorded for future review:

- project-to-file overlap is evaluated both when task impact expands project selectors and when the
  Conflict Engine compares explicit project scope with a written file. The current semantics agree;
  if either representation changes, their consistency must be reviewed together;
- `coordinate` on a producer-controlled resource is intentionally conservative. Because it is
  coordination intent rather than a directional write, coordinate/read produces a nondirectional
  hard serialization constraint rather than inventing a producer-consumer edge.

Neither observation changes the accepted behavior or blocks Milestone 7.

#### Standalone Task Impact training guide

Milestone 6 now has a standalone bilingual training companion:
[Task Impact and Conflict Analysis](./task-impact-analysis.en.md) and its
[Chinese edition](./task-impact-analysis.zh.md). It is written for a reader without prior
orchestration experience and uses ASCII flows and worked examples to explain the evidence layers,
selector resolution, write provenance, shared-resource policies, downstream propagation, hard
constraints versus scored risk, conflict edges versus ordering edges, current limitations, and the
handoff into Milestone 7. The guide describes the accepted implementation rather than introducing
new behavior.

The independent documentation review found no Critical or High issue and confirmed that both
editions have equivalent structure, examples, and conclusions. It identified one Medium teaching
gap: ambiguity behavior was described only in the symbol section, and the exact-file exception for
paths resolved solely through the shared-resource registry was implicit. Both editions now state
that project, file, and symbol selectors report zero/multiple exact matches, while a zero graph-file
match is not ambiguous when a registry path rule successfully resolves that non-graph resource.
The first use of canonical task ordering also now explains that locale-independent task-ID sorting
is independent of argument order. No implementation behavior changed.

#### OpenCode continuation handover

A detailed operational handover now exists at [OpenCode Engineering Handover](./opencode-handover.md).
It records the exact Git and review state, protected uncommitted files, superseded Nx/npm choices,
toolchain and package boundaries, accepted Milestones 1–6 behavior, real-repository baselines,
known limitations, the user's review/commit/Obsidian workflow, and a contract-first Milestone 7
implementation sequence with adversarial tests and acceptance criteria. It distinguishes mandatory
architecture invariants from Scheduler policies that still require an explicit design decision, so
a continuation agent does not accidentally turn a suggestion into product behavior.

## Stage 7: Event-driven Scheduler

The Scheduler is now a working library that decides which tasks may start after each runtime event.
It does not run an AI agent or change files. Its purpose is narrower and deterministic: combine task
dependencies, conflict facts, current task states, and the available concurrency limit into an
explainable next-step decision.

Before this stage, the Scheduler contract only contained event names and free-form reason strings.
That was too weak for audit, persistence, or replay. The contract now uses structured event variants,
runtime blocker records, task-state snapshots, and per-task decision reasons. For example, a lease
release includes its exact lease ID, and a blocked task records which lease or runtime conflict it is
waiting for. A release can therefore wake only the matching task instead of accidentally unblocking
all work.

The implementation follows a fixed greedy policy:

```text
completed functional dependencies
        +
completed directional producers
        +
priority, then stable task ID
        +
hard constraints and risk policy
        +
remaining concurrency
        |
        v
ready / start / block / unblock / cancel / defer decisions
```

Hard constraints are never filtered by their explanatory score. `parallel` and
`guarded-parallel` risks may run together because no Runtime Guard exists yet; the latter retains
machine-readable audit evidence. `stagger` and `serialize` defer the later candidate. Directional
producer/consumer constraints keep their actual writer-to-reader direction even when task IDs sort
in the opposite direction.

Terminal prerequisites no longer leave dependent work silently pending. A failure produces
`dependency-failed` cancellation decisions for every nonterminal transitive functional dependant and
every dependent created by a directional producer constraint. A pre-existing cancellation propagates
with distinct `dependency-cancelled` evidence instead of pretending it was a failure. Runtime
blocking is also explicit: only a running task can become blocked, and only a matching lease or
runtime-conflict release can return it to ready.

An initial wave plan is available as an explanation view, but it is not a runtime barrier. The tests
prove that if A and B appear in preview wave 0, C depends only on A, and A completes while B still
runs, C can start immediately when capacity and conflicts permit it.

This stage added `libs/scheduler`, which depends only on `domain` and `dag`. It contains no LLM,
pnpm, repository-provider, Git, workspace, persistence, or agent-runtime behavior. The Scheduler is
not connected to `forge plan` yet because no tested task-spec input path or execution runtime exists.

For a code-level teaching model, see [Scheduler Dispatch](./scheduler-dispatch.en.md) and its
[Chinese edition](./scheduler-dispatch.zh.md). The guides explain the boundary between Task Impact,
Conflict Engine, Scheduler, and future Runtime Guard; structured snapshots and events; selection and
risk policy; producer direction; terminal propagation; exact runtime blocker release; the no-wave-
barrier rule; and the deliberately unimplemented runtime boundaries.

The adversarial suite covers invalid graphs and options, stable priority ordering, running capacity,
zero-score hard constraints, same-symbol serialization, ordered and exclusive resources,
sibling-symbol guarded risk, producer direction in both lexical orders, completion readiness, failure
propagation, exact runtime blocker release, determinism, and the no-wave-barrier counterexample.

The completed quality gate has 125 passing tests. Coverage is 96.95% statements, 91.92% branches,
99.60% functions, and 96.88% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

Self-analysis after adding the Scheduler found 8 projects, 44 TypeScript files, 518 symbols, 16
project dependencies, 66 file dependencies, 956 symbol references, and the same 2 expected root
diagnostics. The active research repository still produced its single known 25-file uncovered-script
diagnostic; its current 3 projects, 1,010 files, 7,617 symbols, 3 project dependencies, 3,592 file
dependencies, and 13,893 symbol references are normal active-repository drift rather than a
Repository Facts Layer regression.

## Stage 8: Runtime Guard

The project now includes an in-memory Runtime Guard: a live component that grants or blocks exclusive
write leases inside one Node.js process. This is the first layer that can make a concrete runtime
decision about write ownership rather than only predict risk before work begins.

The guard uses the existing project/file/symbol/shared-resource hierarchy. A broad project lease
blocks files and symbols inside that project; a file lease blocks its symbols; a parent symbol blocks
its descendants; sibling symbols may remain independent; and equal named shared resources conflict.
The guard serializes every operation, so simultaneous conflicting requests cannot both see an empty
state and receive permission.

An agent retry for the exact same run, agent, task, and resource returns its existing active lease.
This makes retry safe without allowing a different agent to share the lease. Other owners receive a
stable list of active conflicting lease IDs.

Leases begin `ACTIVE` at version 1. A heartbeat must provide the expected version; on success it
increments the version and records fresh liveness time. A stale transition also requires the current
version and non-empty evidence supplied by an outer runtime, such as confirmed agent loss and an
unchanged workspace. The guard deliberately has no fixed timeout and never decides staleness merely
because time elapsed. A `STALE` lease no longer blocks a replacement. Releasing an active lease
returns `released`; retrying release returns `not-found`, making cleanup idempotent.

This implementation is deliberately in-memory and process-local. It does not persist leases, survive
a process restart, coordinate multiple Node.js processes, resolve user paths against the repository
graph, observe filesystem writes, or automatically notify the Scheduler. These boundaries remain
necessary for the persistence and runtime-integration work that follows.

One Scheduler contract refinement is recorded for later rather than changed during this Runtime Guard
stage. `task-failed` verifies that its supplied snapshot already shows `FAILED`; runtime blocker
events apply their own blocking transition. Other observation events currently only request a new
evaluation. Before event persistence and replay are implemented, the project must either verify the
matching post-event state for every observation event or split state-observation events from
runtime-evidence events in the domain contract. This is an explicit **Milestone 9 entry gate**, not
an optional cleanup note: persistence must not store the current implicit convention as a permanent
replay API.

The Runtime Guard package depends only on `domain`, keeps its clock and lease-ID factory injectable
for deterministic tests, and contains no database, Git, pnpm, CLI, provider, or agent logic. Its
adversarial tests cover hierarchy overlap, independent resources, retry idempotency, concurrent
acquisition, version conflicts, stale evidence, stale replacement, release idempotency, malformed
requests, and duplicate generated IDs.

For a code-level teaching model, see [Runtime Guard and Write Leases](./runtime-guard.en.md) and its
[Chinese edition](./runtime-guard.zh.md). The guides explain resource containment, exact retry
identity, in-process operation serialization, versioned heartbeats, evidence-based stale recovery,
idempotent release, Scheduler event integration, and the intentionally absent persistence and
filesystem-enforcement behavior.

The full quality gate now has 154 passing tests. Coverage is 97.07% statements, 92.04% branches,
99.64% functions, and 97.00% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

Independent review found no Critical, High, or Medium issue. Two Low findings were corrected before
handoff: symbol lease idempotency now treats ancestor collections as order-independent, and an
unreachable resource-comparison fallback was removed. Follow-up tests also cover broader-resource
retries, concurrent heartbeat/release serialization, and invalid non-finite versions. The guard's
package suite now has 23 passing tests with 100% statements, functions, and lines, plus 96.15%
branches.

## Stage 9: Persistence and Replay

This stage makes orchestration evidence survive a process restart. The new `libs/persistence` library
uses SQLite through Drizzle and `better-sqlite3`, while keeping every SQLite, Drizzle, and native
driver type inside that adapter. Domain contracts stay provider-neutral, so another database can later
implement the same port.

Before a table was created, the Scheduler replay contract was made explicit. Observation events now
carry their required post-event task state: completion and workspace integration require `COMPLETED`,
failure requires `FAILED`, and verification completion requires `INTEGRATING`. The Scheduler rejects
an observation if the supplied input snapshot does not already match that state. Runtime blocker
events remain different: they are evidence that the Scheduler itself applies to its input snapshot.

Each persisted reevaluation is one SQLite transaction:

```text
event + input snapshot + requested task transitions + decision
        |
        v
one positive run-local sequence number
        |
        v
commit all records or roll back all records
```

Runs retain task contracts, hard and risk conflicts, and scheduling options. Current task impacts,
conflicts, and leases are upserted by stable run-local keys. Events, transitions, and decisions are
append-only evidence. Structured JSON preserves domain `Set` collections and lease dates. Recovery
validates stored JSON rather than trusting arbitrary database text, then replays each event through
the Scheduler with its saved input snapshot. A replayed decision must exactly match the persisted
decision or recovery reports an integrity failure.

Follow-up persistence hardening verifies that saved transitions exactly match every non-deferred
state-transition decision before write and again during replay. Same-sequence retries are idempotent
only when all evidence matches; different evidence is rejected. Impact/conflict/lease relational keys
must match their payload identities, and lease snapshots cannot regress to an older version or
overwrite equal-version evidence with different content.

The SQLite adapter is deliberately local. It does not provide multi-process write fencing, an agent
runtime, filesystem observation, Git worktrees, migrations for deployed databases, automatic task
execution, or a CLI command. Before an actual agent write is enforced, a later runtime must also use
an ownership-generation fencing token rather than the ordinary heartbeat lifecycle version.

For a code-level teaching model, see [Persistence and Replay](./persistence-replay.en.md) and its
[Chinese edition](./persistence-replay.zh.md). The guides explain event meanings, input snapshots,
atomic reevaluation evidence, SQLite recovery, domain schema validation, decision replay, and the
deliberately unimplemented cross-process and agent-runtime boundaries.

The persistence tests cover complete recovery, SQLite file reopen, Set/date round-trip, event-
transition-decision atomicity, transaction rollback, append-only sequencing, decision replay mismatch,
current-record upserts, and corrupted stored-state rejection.

The full quality gate now has 281 passing tests. Coverage is 96.68% statements, 91.63% branches,
98.61% functions, and 96.64% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Stage 12: Pi Agent Adapter

The orchestrator now has its first real coding-agent backend seam. `libs/agent-runtime` implements
`PiAgentRunner` using `@mariozechner/pi-coding-agent` through a private gateway. Pi remains behind the
provider-neutral `AgentRunner` port: its session objects, messages, tool definitions, and provider
details do not enter domain contracts or the orchestration runtime.

When the Pi gateway creates a session, it calls `onStarted` with a provider-neutral session reference.
Only then does the durable attempt become `RUNNING`. The adapter passes the task goal as Pi's prompt
but does not allow Pi to choose scheduling, leases, workspaces, persistence, verification, Git
integration, or recovery policy.

Pi starts with `noTools: "builtin"`. The only available tools are `forge_read`, `forge_list`,
`forge_find`, `forge_edit`, and `forge_write`. The mutation tools go through `AgentToolRuntime`, which
keeps paths inside the task workspace, resolves files to resources, acquires and persists write leases,
and records observed file writes. A conflicting tool write leaves the file unchanged and returns a
runtime blocker rather than allowing an unsafe retry. There is no unrestricted shell, built-in Pi
edit/write tool, or agent-controlled Git lifecycle.

The Pi tests use a deterministic session gateway rather than a paid model. The vertical scenario
combines a mock Pi tool request, real SQLite persistence, InMemoryWriteGuard, GitWorkspaceManager,
verifier, and fast-forward integration. It proves the complete controlled write path from Pi intent to
integrated repository change and durable evidence.

For a code-level teaching model, see [Pi Agent Adapter](./pi-agent-adapter.en.md) and its
[Chinese edition](./pi-agent-adapter.zh.md).

This stage does not provide an authenticated production model setup, a command sandbox, timeout or
cancellation policy, network/environment/secrets policy, automatic external-blocker retry, observed
scope replanning, or concurrent execution. Those are later runtime hardening stages.

The Pi SDK is configured with `noTools: "builtin"`; this disables built-ins while retaining the
orchestrator's custom `forge_*` tools. Production Pi model calls are not started in CI. An injected
session factory verifies the SDK tool configuration, while deterministic tests execute each custom tool definition and cover its
controlled call and error-result mapping. The runner rejects an out-of-order pre-establishment tool
call before it can acquire a lease or modify a workspace. The real solution-style repository-analysis
regression test now has a scoped 30-second timeout because full-workspace TypeScript analysis can
legitimately exceed Vitest's default five-second limit under load.

Follow-up safety hardening makes a post-establishment Pi gateway or tool failure rethrow to the runtime,
which records `UNKNOWN` and retains ACTIVE leases rather than treating a possibly live Pi session as a
safe failure. Tool writes reuse an already-covering task lease, immediately persist cumulative observed
impact, and reject symlink paths whose real target escapes the task workspace.
`PiAgentRunner.bindRuntimeAuthority` supplies the runtime's initial impact and leases after every tool
factory creates its `AgentToolRuntime`, preventing an individual factory from accidentally omitting
the authority needed to reuse a broader task lease.
The realpath check is best effort and does not eliminate a concurrent filesystem TOCTOU replacement;
descriptor-relative sandboxed I/O remains future hardening.

The full quality gate now has 281 passing tests. Coverage is 96.68% statements, 91.63% branches,
98.61% functions, and 96.64% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Stage 13: Controlled Agent Commands

The orchestrator can now let a Pi agent request one explicitly approved validation command without
giving it arbitrary shell access. `forge_command` accepts only a command ID. The runtime binding supplies
an `AgentCommandPolicy` that fixes the executable, argument vector, timeout, output limit, and complete
environment for each ID. The agent cannot choose a shell command, extra arguments, a different working
directory, or environment variables.

The concrete local executor runs the fixed command inside the task workspace with `shell: false`. It
captures bounded standard output and error, returns nonzero exits as tool errors, sends `SIGTERM` then
bounded-grace `SIGKILL` on timeout or cancellation, and reports a sanitized startup failure. No command policy means Pi does not
receive the `forge_command` tool at all; Pi built-in `bash` remains disabled.

Command authority is part of durable execution identity: a canonical command-policy fingerprint and
trusted path are stored with every attempt, and PREPARING recovery rejects changed authority or legacy
attempts without identity. The executor receives a constructor-injected trusted path rather than ambient
host `PATH`. Command definitions currently declare only `validation`; this is a policy assertion rather
than proof of no side effects. Workspace-writing commands need a future sandbox, matching leases, and
diff-based observed-impact reconciliation.

This is a policy boundary, not an operating-system sandbox. It does not isolate network access, secrets,
filesystem permissions, process descendants, CPU, or memory. These controls need a later sandbox adapter
and must be designed before arbitrary commands or concurrent production agents are enabled.

For a code-level teaching model, see [Controlled Agent Commands](./controlled-agent-commands.en.md) and
its [Chinese edition](./controlled-agent-commands.zh.md).

The full quality gate now has 320 passing tests. Coverage is 96.72% statements, 91.74% branches,
98.69% functions, and 96.68% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Stage 14: Sandboxed Validation Commands

Validation commands now run through a provider-neutral `AgentCommandSandbox` port and explicit execution
profiles. The default developer profile is `trusted-local`: fixed policy commands run in the task worktree
with developer host permissions and do not require Docker. The optional hardened `docker-read-only` profile
uses Docker Engine or Docker Desktop for network denial, a read-only workspace mount, read-only container
root, and tmpfs `/tmp` on macOS, Linux, and Windows. The macOS `sandbox-exec` adapter remains a native
developer-only option. Unsupported selected hardened profiles or missing adapters fail closed; the runtime
never falls back to an unrestricted subprocess.

Only `validation` commands use these profiles. `trusted-local` is a developer trust model, not sandbox
enforcement; `docker-read-only` restricts workspace and network effects. Neither permits workspace-writing
commands. Process descendants, resource limits, image pinning, Docker daemon policy, full readable-host
isolation for native execution, live Pi cancellation wiring, writable effects under leases, and diff-based
observed impact reconciliation remain future sandbox-runtime work.

For a code-level teaching model, see [Sandboxed Agent Commands](./sandboxed-agent-commands.en.md) and its
[Chinese edition](./sandboxed-agent-commands.zh.md).

The full quality gate now has 337 passing tests. Coverage is 96.68% statements, 91.59% branches,
98.59% functions, and 96.67% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Stage 15: Parallel Agent Execution

The runtime now starts independent task agents concurrently up to the scheduler's configured
`maxConcurrency`. Each agent still has its own worktree, durable attempt, and lease plan. A conflict at
lease acquisition blocks the task before its agent starts; after the conflicting lease releases, existing
Scheduler unblock/retry evidence allows the task to run later.

Concurrency is deliberately limited to external agent execution. The runtime serializes workspace and lease
preparation, durable attempt transitions, Scheduler events, verification, commits, and Git integration.
This keeps the shared integration reference safe and maintains deterministic persistence/replay evidence
while letting real agent work overlap. `forge_edit` now acquires write authority before reading the file,
closing its former read-modify-write race before parallel execution is enabled.

Parallel execution uses fail-stop structured concurrency. A fatal task error stops dispatching new pending
tasks, but `startRun()` waits for all already-started task pipelines to settle before returning the first
fatal error. This prevents detached agent work from continuing after the caller receives a run failure.
Later sibling failures are currently settled but not aggregated into the returned diagnostic.

Cross-process coordination, integration reservation, agent cancellation, unknown-attempt resume, and
writable-command side-effect reconciliation remain future work.

The full quality gate now has 343 passing tests. Coverage is 96.62% statements, 91.39% branches,
98.62% functions, and 96.61% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Stage 10: Workspace and Git Lifecycle

The deterministic core can now give each task an isolated local Git worktree and safely integrate its
completed branch into one local integration reference. This stage does not run an agent. It provides
the workspace and Git lifecycle that a future outer runtime can use after task execution and
verification are available.

Creating a workspace takes a task branch from an explicit base ref and places it outside the
integration repository directory. The task can commit independently without placing untracked
worktree directories inside the integration checkout. Integration is intentionally conservative:

```text
task branch
   |
   v
rebase onto integration ref
   |
   v
fast-forward-only merge into integration ref
```

No implicit merge commit is created. Before merging, the integration repository must be clean and
must successfully switch to the requested integration ref. A rebase conflict, dirty integration
repository, or failed fast-forward creates a phase-aware `INTEGRATION_BLOCKED` workspace record with
structured reason and conflict paths.

Workspace integration state is deliberately separate from ordinary task execution state:

```text
READY_TO_INTEGRATE
        |
        +--> INTEGRATION_BLOCKED
        |       |
        |       +--> resumeIntegration after external repair
        |       +--> abortIntegration
        |
        +--> INTEGRATED
```

This avoids the lossy historical shortcut `INTEGRATING -> BLOCKED -> READY`. A task that finished
execution and verification remains integration work even if Git needs manual repair. Rebase blocks
use `rebase --continue` or `rebase --abort`; dirty-repository and fast-forward blocks retry normal
integration after their external cause is fixed.

Workspace records are persisted by run ID and workspace ID, including blocked phase evidence. An
explicit disposal call removes the worktree and task branch. Disposal protects uncommitted workspace
changes by default: it returns stable dirty paths instead of deleting them. Discarding dirty work
requires `force: true` and an explicit caller reason.

Workspace records also carry a positive revision. Persistence accepts a newer revision or an identical
same-revision retry, rejecting stale or conflicting evidence. Create and disposal recover the smallest
interrupted lifecycle cases: a matching existing worktree is reusable, and a removed worktree with a
remaining branch can finish disposal. Git commands are asynchronous, while NUL-delimited Git path
output preserves unusual filenames.

The Git adapter is tested with real temporary Git repositories for create, rebase, fast-forward
integration, conflict block/abort/resolve/resume, dirty repository blocking, dirty disposal, and
cleanup. A narrow injectable Git command runner covers deterministic process-failure diagnostics
without embedding Git process types in domain contracts.

For a code-level teaching model, see [Workspace and Git Lifecycle](./workspace-git.en.md) and its
[Chinese edition](./workspace-git.zh.md). The guides explain isolated worktrees, phase-aware Git
integration blocking, rebase/resume/abort, fast-forward-only integration, persisted workspace
evidence, and dirty-disposal protection.

This stage still does not execute agents, observe actual filesystem writes, compare observed changes
with predicted scope, acquire leases during writes, coordinate multiple repositories/processes, or
automatically repair conflicts. Those require a future agent/runtime layer and ownership-generation
write fencing.

The full quality gate now has 281 passing tests. Coverage is 96.68% statements, 91.63% branches,
98.61% functions, and 96.64% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Stage 11: Orchestration Runtime

The deterministic libraries now have one local application layer that can demonstrate their combined
lifecycle. `OrchestrationRuntime` remains separate from the CLI. It receives domain ports for the
Scheduler, persistence, WorkspaceManager, WriteGuard, AgentRunner, and TaskVerifier, so none of those
components needs to import or trigger another infrastructure adapter.

The first runtime intentionally accepts `maxConcurrency: 1`. This makes a Scheduler `RUNNING` state
match one actual serial fake-agent execution rather than treating a queued task as already running. A
run begins with a persisted `run-started` event. For each Scheduler start decision, the runtime creates
and persists a workspace, acquires and persists a lease, invokes the provider-neutral fake agent,
persists the agent outcome, releases and persists the lease, verifies, then integrates Git. Every Scheduler event persists the
input snapshot, event, decision, and non-deferred transitions before the runtime updates its current
snapshot.

Task observations preserve the existing replay rule: agent completion first records `VERIFYING`,
verification completion first records `INTEGRATING`, and successful integration first records
`COMPLETED`. Agent or verification failure records `FAILED`, allowing the Scheduler to cancel dependent
tasks. If lease release then fails, the runtime persists `lease-release-failed`, marks the run `FAILED`,
and stops before verification or integration. Lease contention records a runtime blocker but has no
automatic retry in this first serial scope. Integration blocks persist the newer workspace
revision and leave the task in `INTEGRATING` for a later recovery policy; this first runtime does not
auto-repair or resume Git conflicts.

The stage was hardened before admitting a real coding-agent backend. Scheduler `RUNNING` is now only
dispatch authorization; an atomically persisted revisioned `AgentExecutionAttempt` records whether
external execution is `PREPARING`, `STARTING`, `RUNNING`, terminal, or `UNKNOWN`. A restart turns
unresolved starts/runs into `UNKNOWN` rather than assuming an agent exists. Task bindings now contain a
canonical multi-resource `TaskLeasePlan`. The runtime acquires resources in deterministic order and
releases earlier leases in reverse order if a later acquire blocks, leaving no partial ownership. The
predicted-impact conversion conservatively promotes symbol writes to file leases until full symbol
ancestor evidence is available.

Further dispatch hardening makes `PREPARING` attempts resume safe workspace and lease preparation after
recovery. Project-wide predicted writes now dominate child file and symbol leases rather than being
incorrectly narrowed. A runner exception before `onStarted` records a definite attempt/task failure;
after `onStarted` it records an `UNKNOWN` outcome and retains ACTIVE leases because the external actor
may still mutate the workspace. Both stop verification and integration and mark the run failed.
`PREPARING` recovery validates the persisted agent/workspace/lease-plan identity before resuming.
Attempt schemas now enforce state-specific timestamps and failure evidence.

A vertical test now combines real SQLite persistence, InMemoryWriteGuard, GitWorkspaceManager, a
temporary integration repository, and a deterministic writing agent. It proves a committed worktree
edit fast-forwards into the integration branch, durable attempt/workspace/lease evidence recovers, and
Scheduler replay remains deterministic.

Recovery rebuilds the latest snapshot from persisted event and decision evidence, including lease
blocker projection, and returns current workspace and lease records. It deliberately does not restart
an unknown in-flight agent or reclaim a lease: safe recovery of those actions needs durable agent
identity and ownership-generation write fencing beyond this stage.

For a code-level teaching model, see [Orchestration Runtime](./orchestration-runtime.en.md) and its
[Chinese edition](./orchestration-runtime.zh.md). Tests cover the success path through a dependency
chain, agent failure, verification failure, same-run and external-run lease blocking, lease-release failure evidence, pre-start and post-start runner throws, completed-without-onStarted protocol failure, durable attempt recovery/resume with identity validation, multi-resource rollback, real Git vertical integration, blocked Git
integration, eventless recovery, current evidence recovery, invalid bindings, and real SQLite replay.

The full quality gate now has 281 passing tests. Coverage is 96.68% statements, 91.63% branches,
98.61% functions, and 96.64% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Current overall status (as of this writing)

- Architecture milestones 1–12 of 12 are implemented. This does not mean the full product is 100%
  complete: authenticated model setup, command sandboxing, observed-scope enforcement, concurrent
  dispatch, provider routing, and CLI runtime commands remain substantial capabilities outside the
  current milestone plan.
- Formatting, linting, TypeScript 7 checking, and tests run through `pnpm check`. There are 281 tests,
  all passing.
- Coverage is 96.68% statements, 91.63% branches, 98.61% functions, and 96.64% lines. Every enforced
  threshold is at least 90%.
- `pnpm build` passes. `forge analyze` is real and verified on a 968-file repository; `forge plan`
  remains intentionally unavailable.
- Milestone 6's second correctness hardening and Milestone 7's implementation both passed independent
  review and follow-up review with no Critical, High, or Medium issue. The Scheduler's documented
  review findings were fixed and independently re-verified before this commit.
- Milestone 8 Runtime Guard implementation is complete for the accepted process-local in-memory scope
  and has passed independent review.
- Milestone 9 Persistence implementation is complete for the accepted local SQLite scope and has
  passed independent review.
- Milestone 10 Workspace/Git implementation is complete for the accepted local single-repository scope
  and has passed independent review. The review also reproduced Date-aware lease idempotency and
  verified clean-target task-branch collision handling.
- Milestone 11 Orchestration Runtime is complete for the accepted local serial fake-agent scope and
  awaits independent review before it can be committed.
- Milestone 12 Pi Agent Adapter is complete and closed after independent review. The follow-up hardening
  preserves post-start `UNKNOWN` ownership, reuses broader task leases, rejects static symlink escapes,
  immediately persists observed impact, and prevents tool factories from omitting runtime authority.
  Before concurrent dispatch, `forge_edit` must acquire authority before reading; recovery must also
  reconcile the non-atomic filesystem-write and SQLite-evidence window from workspace or Git changes.
- Milestone 13 Controlled Agent Commands is complete and closed after independent review. It admits only
  fixed-policy command IDs with runtime schema enforcement, executor-owned `PATH`, bounded output, and
  direct-child `SIGTERM` to `SIGKILL` escalation. Durable command-policy identity prevents changed
  authority during PREPARING recovery. It remains policy control rather than a process-tree or operating-
  system sandbox.
- Milestone 14 Sandboxed Validation Commands is complete and closed after independent review. `trusted-local`
  is the default developer mode with fixed command policy and host permissions; `docker-read-only` is an
  optional hardened mode with Docker read-only workspace and network denial on macOS, Linux, and Windows;
  the macOS native adapter is developer-only. Writable commands, process-tree controls, resource limits,
  and observed-impact reconciliation remain later sandbox work.

## What has NOT been implemented yet

- Invoke an authenticated production Pi model or run verification commands.
- Execute arbitrary commands in a sandboxed policy boundary.
- Dispatch more than one agent concurrently, recover unknown in-flight agents, or coordinate processes.

In short: **the orchestrator can now map a real TypeScript pnpm repository, predict task impact,
compare conflicts, decide what may start after an event, guard exclusive writes inside one process,
recover verified local orchestration evidence from SQLite, integrate one local task worktree with Git,
and route mock Pi tool intent through controlled leases and workspace writes. It still does not run an
authenticated production coding agent, observe complete real-write scope, or coordinate multiple
processes.**

## Stage 16: Autonomous Plan Phase

The project can now turn a user request or Markdown specification into a deterministically validated,
repository-aware execution proposal. This closes the gap between “understand this repository” and
“here are the tasks that may safely enter orchestration.”

The new `libs/planning` package is an application layer, not a model or domain package. It defines a
provider-neutral `PlannerAgent` port and treats every proposal as untrusted `unknown` input. A proposal
must pass this complete pipeline:

```text
user request / Markdown specification
                 |
                 v
        PlannerAgent proposal
        (untrusted JSON value)
                 |
                 v
        Task Contract validation
                 |
                 v
          functional DAG check
                 |
                 v
 repository-backed verification check
                 |
                 v
 selector resolution + predicted impact
                 |
                 v
       hard/risk conflict analysis
                 |
                 v
       Scheduler plan validation
                 |
                 v
      prepared orchestration plan
```

Malformed JSON, invalid Task Contracts, missing dependencies, dependency cycles, unresolved exact
selectors, unknown shared resources, nonexistent package scripts, and unschedulable constraint
combinations are rejected before dispatch. These failures become structured diagnostics. The planner
may receive those diagnostics and revise its proposal, but the loop is bounded by a positive
`maxAttempts`. Exhaustion fails closed with `AutonomousPlanningError`. Provider or authentication
failure propagates immediately because it is not a task-plan mistake that a revision can repair.

Pi is the first Planner adapter, but Pi concerns remain inside `libs/agent-runtime`. An isolated
resource loader disables project context files, extensions, skills, prompt templates, and themes;
the planning session also starts with every built-in tool disabled. It receives only three Repository
Facts tools:

- `forge_projects` lists exact project/package facts;
- `forge_files` filters and pages file identities;
- `forge_symbols` searches and pages symbol identities.

These tools query the already-built in-memory `RepositoryGraph`. They do not read arbitrary live
filesystem paths, execute commands, or mutate a workspace. Stable pagination prevents a large symbol
graph from being copied into one prompt. Pi session/message/tool types never enter domain or planning
contracts.

`forge plan <specification.md>` is now a real command. It reads Markdown, analyzes the selected
repository, uses the configured Pi model, runs the bounded validation/revision loop, and emits JSON-safe
Task Contracts, predicted impacts, structurally separate hard and risk conflicts, schedule options,
and an explanatory execution-wave preview. Both `--max-attempts` and `--max-concurrency` require
positive integers.

This stage deliberately stops before execution. The prepared plan still needs run identity, agent and
worktree binding, canonical lease plans, command policy, persistence, and a user-visible approval/run
workflow before it can be passed to `OrchestrationRuntime.startRun()`. `forge plan` therefore does not
create worktrees, acquire leases, dispatch coding agents, run verification, commit code, or integrate
Git. Planning waves remain explanations, not runtime barriers.

The CLI accepts an optional JSON shared-resource policy through `--shared-resources`. If omitted, it
deliberately uses an empty registry and explains the missing-policy cause when a plan names an unknown
resource. Command verification remains available to non-autonomous Task Contract callers, but
autonomous planning rejects it until a future rule can select a validated command-policy ID instead
of executable text. Explicit model
routing/failover, plan persistence, human approval, automated reviewer revision, and runtime
`run/status/resume/cancel` commands are also deferred.

The first independent Stage 16 review found three blocking integration defects. First, Pi SDK 0.73.1
interprets `noTools: "all"` as an empty allowlist that also filters custom tools, so both the earlier
coding adapter and the new planning adapter could expose no tools in a real session. Both now use
`noTools: "builtin"`, and a non-mocked SDK integration test proves that all controlled coding and
planning tools enter the session while built-in `bash` remains absent. Both adapters also pass their
controlled names through Pi's explicit `tools` allowlist, excluding unrelated extension/custom tool
definitions from the registry. Second, the CLI test resolver
now includes the planning package's transitive DAG source dependency, restoring clean-checkout test
behavior without prebuilt package output. Third, planning catches only `SchedulerInputError` as a
correctable proposal rejection; unexpected scheduler defects propagate immediately.

The same hardening added a static planning resource loader that never performs Pi's project/global
resource discovery, server-side pagination caps for project/file/symbol tools, the shared-resource
policy option above, and a type-level warning that `PreparedOrchestrationPlan` is still unbound and not
runnable. A known selector limitation remains: globs only resolve existing facts, so a glob describing
files that will be created later is rejected until an explicit planned-creation selector is designed.

The independent repair review approved Stage 16 for closure. Its two non-blocking test suggestions
were also added before handoff: CLI tests now lock in direct propagation of missing-file, malformed-JSON,
and schema-validation policy errors, while fact-tool tests cover zero, negative, fractional, non-finite,
non-numeric, and over-maximum pagination limits. These tests add regression protection without changing
the reviewed production behavior.

A final Plan-to-Run closure review identified two verification-authority gaps and one provider
lifecycle gap. Autonomous planning now requires at least one repository-backed package-script rule on
every task and rejects every free-form command verification, including tasks that also contain a valid
package script. This policy lives in `libs/planning`, not the general Task Contract, so manual or future
non-autonomous workflows retain their existing domain representation. The Pi planning adapter also
disposes each one-response session in a `finally` block after success, provider failure, or malformed
response handling. The Planner prompt states the same restrictions, but deterministic validation is
the authority.

The detailed beginner-oriented explanation is in
[Autonomous Planning](./autonomous-planning.en.md). ADR-020 records the trust boundary, revision rules,
and the separation between a prepared plan and runtime authority.

The final local quality gate has 380 passing tests. Coverage is 96.48% statements, 91.67% branches,
97.20% functions, and 96.46% lines. The planning package's standalone gate reaches 100% in every
category; agent-runtime's standalone branch coverage is 90.79%.
`pnpm check`, `pnpm build`, and `git diff --check` pass.

Repository Facts regression checks also pass. Self-analysis now reports 14 projects, 89 files, 1,252
symbols, 46 project dependencies, 158 file dependencies, 2,266 symbol references, and two known root
configuration diagnostics. The active ingestion-and-matching research repository reports three
projects, 1,010 files, 7,617 symbols, three project dependencies, 3,592 file dependencies, 13,893
symbol references, and the same known `UNCOVERED_TYPESCRIPT_FILES` warning for 25 API script files.

A live Pi-backed `forge plan` smoke test against that research repository was not run. It would send
repository-derived project/file/symbol facts to the currently configured external model destination,
and this session did not have explicit authorization for that data egress. Deterministic fake-planner,
Pi gateway/tool, isolated resource-loader, CLI composition, and rejection-path tests are complete; an
authorized live-model smoke remains a review/deployment check rather than an unstated success claim.

## Stage 17: Semantic Plan Review

Stage 17 separates “this task plan is structurally valid” from “this task plan appears to cover the
user's request.” Deterministic repository and scheduling logic cannot prove natural-language
completeness, so the project now defines a provider-neutral `SemanticPlanReviewer` as a second,
untrusted semantic role.

The Reviewer receives the original source, a deterministically valid Task Specification, and the
already-built RepositoryGraph. Its response remains `unknown` until `semanticPlanReviewSchema`
accepts a structured requirement map. Each requirement is `covered`, `missing`, or `ambiguous`.
Covered items must cite at least one known task. `accept` is legal only when every item is covered;
`revise` must identify at least one gap. Duplicate requirements, unknown task IDs, contradictory
recommendations, malformed JSON, and non-object values fail closed.

Missing and ambiguous items become stable `SEMANTIC_REQUIREMENT_GAP` diagnostics for the next Planner
attempt. They share the existing positive `maxAttempts` budget, so semantic revision cannot loop
forever. Reviewer formatting or provider failures do not become Planner revision requests because a
Planner cannot repair that infrastructure path. After an accept recommendation, the complete Task
Contract, DAG, verification, impact, conflict, and Scheduler pipeline runs again from a schema-cloned
specification before returning a `PreparedOrchestrationPlan`.

`PiSemanticPlanReviewer` is implemented inside `libs/agent-runtime`, using a separate one-response Pi
session and the same isolated resource boundary as planning. The fact surface now includes a fourth
read-only tool, `forge_relationships`, for bounded project-dependency, file-dependency, and
symbol-reference queries. It supports incoming/outgoing/either filtering and a server-enforced
500-edge page maximum. Neither Planner nor Reviewer receives live filesystem mutation or command
capability. Session cleanup now also preserves the primary provider failure if disposal fails at the
same time.

The CLI requires `--semantic-review`. This is an explicit consent gate for the additional model call
to receive the specification and read-only repository facts. Without it, Commander rejects the
command before the planning composition root runs. The accepted semantic recommendation is serialized
with the plan as advisory evidence; it is not human approval and cannot start a run.

ADR-021 records this trust boundary. Standalone beginner-oriented guides are available in
[English](./semantic-plan-review.en.md) and [Chinese](./semantic-plan-review.zh.md). Human approval,
plan/repository fingerprints, durable planning evidence, runtime binding, and `forge run` remain the
next Plan-to-Run stage.

The Stage 17 local gate passes with 29 test files and 397 tests. Coverage is 96.46% statements,
91.33% branches, 96.85% functions, and 96.43% lines. `pnpm check`, `pnpm build`, and
`git diff --check` pass. Self-analysis reports 14 projects, 93 files, 1,285 symbols, 46 project
dependencies, 171 file dependencies, 2,331 symbol references, and the same two known root
configuration diagnostics. The ingestion-and-matching research repository remains stable at three
projects, 1,010 files, 7,617 symbols, three project dependencies, 3,592 file dependencies, 13,893
symbol references, and one known 25-file `UNCOVERED_TYPESCRIPT_FILES` diagnostic. No live Planner or
Reviewer model call was made; the automated adapter tests use controlled gateways, and the CLI now
requires explicit review consent for real data egress.

## Stage 18: Durable Plan Artifact and Repository Snapshot Identity

Stage 18 closes the first Plan-to-Run authority gap: a valid in-memory plan now becomes a durable,
immutable decision artifact tied to the exact repository evidence used during planning. It does not
yet approve or execute that artifact.

`PlanArtifact` is schema-versioned and JSON-safe. It records artifact ID/revision/time, the complete
planning source, source fingerprint, repository identity and real root, Git base commit, working-tree
fingerprint and dirty state, canonical Repository Facts fingerprint, shared-resource and verification
policy fingerprints, Task Specification, predicted impacts, hard/risk conflicts, schedule, execution
preview, semantic-review evidence, and one fingerprint over the full payload. Predicted Set values are
serialized as stable unique arrays.

The schema validates relationships as well as field shapes. Every task must have exactly one impact
and exactly one execution-wave occurrence. Wave indices are contiguous, respect declared dependency
order, and cannot exceed `maxConcurrency`. Conflict endpoints must be distinct known tasks, and an
unordered pair cannot be duplicated within or across hard/risk collections. Semantic-review task
citations must exist in the Task Specification. Hard and risk collections cannot be interchanged.
Array-shaped shared-resource accesses, access modes, and risk signals are normalized and schema-
checked for unique canonical order. Tampering with source or decision content without changing the
fingerprint fails closed.

`GitRepositorySnapshotProvider` binds more than `HEAD`: it hashes every tracked and untracked
non-ignored entry with length-framed path, filesystem mode, kind, and bytes. Symlinks hash their link
text instead of following a target. Origin URL supplies cross-clone repository identity; a real local
root is the fallback. Without an origin, clones at different real paths intentionally receive
different IDs. Ignored build/cache state is intentionally outside Git source identity. Git submodules
and paths that collide after Unicode NFD normalization plus lowercase conversion fail closed rather
than claiming an incomplete or non-portable identity. This is not full Unicode case folding.

The real CLI captures one snapshot before RepositoryGraph analysis and another after it. Any change
to repository ID/root, base commit, working-tree fingerprint, or dirty state raises
`RepositorySnapshotChangedError`; no mixed-state artifact is published. `repositoryBindingMismatches`
supplies the future approval/runtime binder with explicit repository-ID, commit, working-tree, and
facts mismatches. It is implemented and tested but deliberately has no production caller in Stage 18.
Stage 19's `PlanExecutionBinder` must reject any `repositoryId`, `baseCommit`,
`workingTreeFingerprint`, or `factsFingerprint` mismatch before creating a runtime request.

`JsonFilePlanArtifactStore` implements the planning store port in the infrastructure persistence
package. It writes a unique temporary file and atomically hard-links it to
`<artifact-id>.r<revision>.json`. Concurrent identical saves are idempotent; different content cannot
replace the same revision. Corrupt content, filename/payload disagreement, path traversal IDs, invalid
revisions, and fingerprint mismatch fail closed. `forge plan` now stores artifacts in
`~/.forge/plans/<repository-id>` by default; `--plan-directory` selects another location outside the
analyzed repository. In-repository and symlink-aliased in-repository destinations fail closed because
artifact persistence must not invalidate the snapshot it just recorded. Save checks the resolved
destination before directory creation, after creation, and immediately before the temporary-file
write, covering replacement of a previously missing ancestor by an in-repository symlink before
publication. Cleanup failure cannot mask an already selected publication or immutability error, while
a cleanup-only failure remains visible. Planning still
does not create a runtime run, worktree, lease, agent dispatch, verification execution, or Git
integration.

The first independent Stage 18 review found one Critical storage-boundary race, three High hardening
gaps, and three Medium consistency/documentation gaps. The storage path is now re-resolved during
save; portable path collisions fail closed; cleanup preserves the primary error; array-shaped impact
evidence is normalized; and artifact validation now rejects self-conflicts, duplicate conflict pairs,
dependency-invalid waves, and waves wider than the schedule limit. The review also confirmed that
runtime repository comparison is a Stage 19 binding responsibility and that local-root fallback is
path-specific. New adversarial tests lock these guarantees. No runtime execution capability was added.

The follow-up review independently reproduced the race test, complete project gate, planning-only
coverage, scheduler readiness behavior, and runtime dispatch behavior, then approved Stage 18 for
closure. Its remaining non-blocking suggestions were completed before close: storage now performs a
third confinement check immediately before writing, dedicated tests cover non-colliding portable paths
and cleanup-only failure propagation, Unicode wording now matches the actual NFD-plus-lowercase
algorithm, and ADR-022 names `PlanExecutionBinder` plus all four mandatory binding fields.

A final whole-architecture gate reviewed commit `2356dc062967703c75094a7707dfc0739f9b4bd5` and rated
Stage 18 **PASS / CLOSED**. It confirmed that durable identity, dirty/untracked source binding,
Repository Facts binding, mixed-state rejection, canonical cross-record validation, immutable
publication, repository-external storage, and the future rebinding contract all hold together as one
Plan/Execute authority boundary. No new Stage 18 P1 was found.

Two non-blocking deployment limitations remain explicit. First, repository identity hashes the origin
URL as written, so equivalent SSH and HTTPS remote spellings receive different fail-closed IDs; remote
canonicalization belongs to future distributed-worker/product integration. Second, repeated real-path
checks mitigate ordinary symlink races but pathname APIs cannot provide atomic directory-descriptor
confinement against a hostile concurrent local process. That stronger security boundary is outside the
current single-user local threat model.

ADR-022 records the boundary. Standalone beginner-oriented guides are available in
[English](./plan-artifact.en.md) and [Chinese](./plan-artifact.zh.md). The architecture guide also now
correctly distinguishes controlled `forge_write`/`forge_edit` capture from the still-missing complete
observed-impact reconciliation and dynamic conflict recomputation.

The Stage 18 local gate passes with 32 test files and 427 tests. Coverage is 96.28% statements, 91.32%
branches, 97.16% functions, and 96.24% lines. The planning-only gate passes 41 tests at 99.06%
statements, 95.70% branches, 98.68% functions, and 99.01% lines. `pnpm check`, `pnpm build`, and
`git diff --check` pass. Self-analysis reports 14 projects, 99 files, 1,388 symbols, 49 project dependencies, 188 file
dependencies, 2,510 symbol references, and the same two known root
configuration diagnostics. The ingestion-and-matching research repository remains stable at three
projects, 1,010 files, 7,617 symbols, three project dependencies, 3,592 file dependencies, 13,893
symbol references, and the known 25-file `UNCOVERED_TYPESCRIPT_FILES` diagnostic. No live Pi plan was
run because Stage 18 changes deterministic artifact authority and local persistence, not model
behavior.

Stage 19 is **Approval + Execution Binding**. `PlanApproval` remains a separate provider-neutral fact
recording the exact artifact ID, revision, `planFingerprint`, approving actor, and approval time; it is
not an `approved: true` flag embedded in the immutable PlanArtifact. `PlanExecutionBinder` must load and
verify that exact artifact, validate the exact approval, recapture repository snapshot and Repository
Facts, reject every repository binding mismatch, revalidate current shared-resource and
verification authority fingerprints, and only then produce one canonical runtime request. The CLI may
compose I/O and adapters but must not manually assemble agent, workspace, lease, command-policy,
sandbox, model, or runtime bindings.

## Stage 19: Plan Approval and Execution Binding

Stage 19 is complete and independently reviewed. It closes the deterministic approval
half of the Plan-to-Run boundary without pretending that an approved plan is already a runnable
deployment request.

`PlanApproval` is a separate schema-versioned, fingerprinted record. It binds a provider-neutral actor
and approval time to the exact artifact ID, revision, and `planFingerprint`. Artifact content remains
immutable. Approval before artifact creation, content tampering, malformed identity, or any artifact
ID/revision/fingerprint mismatch fails closed. The actor string is intentionally not a GitHub, Jira,
SSO, or Pi type; authentication and signature policy remain adapter/deployment concerns.

`PlanApprovalClaim` adds one atomic single-run consumption boundary. `JsonFilePlanApprovalStore`
publishes approvals and claims through the same temporary-file plus hard-link strategy used by durable
artifacts. Identical approval writes are idempotent. A same-run claim retry returns the original claim
and timestamp, while a different run is rejected. A dedicated simultaneous two-run test proves that
exactly one atomic publication wins. Corrupt JSON, nested fingerprint damage, filename/payload
disagreement, path traversal, and repository-internal storage fail closed with approval-specific
errors.

`PlanExecutionBinder` now provides the mandatory Stage 18 repository comparison call site. It loads
and validates the exact artifact and approval, captures Git evidence, rebuilds Repository Facts,
captures Git evidence again, rejects a moving repository, compares repository ID, base commit,
working-tree fingerprint, and facts fingerprint, and revalidates current shared-resource and
verification-policy fingerprints. Only after every check passes does it atomically claim the approval
and return a fingerprinted `PlanExecutionIntent`. A failed repository or policy check leaves the
approval unclaimed. The intent parser validates the fingerprints of its nested artifact, approval,
and claim as well as cross-record identity and the outer execution fingerprint.

The CLI adds `forge approve` and `forge bind`. `BINDING_REJECTED` reports deterministic mismatch IDs.
The CLI remains a composition and JSON-I/O boundary; it does not construct agent, workspace, Write
Guard, command, sandbox, model, verification, or Git-integration bindings. `PlanExecutionIntent` is
therefore authority evidence, not `StartRuntimeRunRequest`, and `forge run` remains deferred until a
controlled runtime binding policy exists.

ADR-023 records this boundary. Standalone beginner-oriented guides are available in
[English](./plan-approval-and-binding.en.md) and
[Chinese](./plan-approval-and-binding.zh.md).

The Stage 19 local gate passes with 34 test files and 452 tests. Coverage is 95.82% statements, 91.02%
branches, 96.70% functions, and 95.79% lines. The planning-only gate passes 54 tests at 98.38%
statements, 95.07% branches, 97.84% functions, and 98.54% lines. `pnpm check`, `pnpm build`, and
`git diff --check` pass. Self-analysis reports 14 projects, 104 files, 1,490 symbols, 49 project
dependencies, 205 file dependencies, 2,716 symbol references, and the same two known root
configuration diagnostics. The ingestion-and-matching research repository remains stable at three
projects, 1,010 files, 7,617 symbols, three project dependencies, 3,592 file dependencies, 13,893
symbol references, and the known 25-file `UNCOVERED_TYPESCRIPT_FILES` diagnostic. No live Pi call was
needed because approval and binding are deterministic authority operations.

Stage 20 should implement **Controlled Runtime Binding and Start**: consume a verified execution
intent, apply an explicit deployment policy for the existing runtime's agent/workspace/lease/command/
sandbox/model/verification collaborators, persist the start boundary, and expose the first recoverable
`forge run` workflow. It must preserve the current rule that the CLI cannot become a hidden
orchestrator.

### Stage 19 independent-review hardening

The first independent review found one High correctness gap: execution binding compared stable
repository identity, commit, content, and facts but did not compare the physical repository root. Two
clones of the same remote could therefore bind the same artifact when their bytes matched, even though
Stage 20 would create real workspaces from a different location. `repositoryBindingMismatches` now
also requires the exact real `repositoryRoot`. It additionally compares the recorded dirty state so
every snapshot authority field has an explicit binding check. A dedicated binder test reproduces the
same-origin/same-content/different-root case and proves rejection occurs before approval claim.

The review's Medium observations were also closed. Documentation now states precisely that SHA-256
fingerprints are not signatures: a direct JSON-store writer can recompute them, so the local threat
model depends on filesystem access control and binder cross-checks. Unused Stage 19 barrel exports
were removed; internal schemas, mismatch types, integrity errors, and provider ports remain private
until a real cross-package consumer exists. Approval and claim stores now have dedicated symlink
TOCTOU regression cases, and a separately self-consistent approval test locks the pure
`artifact-revision` mismatch branch.

The follow-up review independently reproduced the 452-test gate and planning-only coverage, verified
the real-path origin of `repositoryRoot`, the exact pre-claim rejection path, export usability after
declaration emit, both dynamic approval/claim TOCTOU injections, and the revision-only mismatch. It
found no remaining correctness or architecture issue and approved Stage 19 as **PASS / CLOSED**.

Two non-blocking test-organization improvements are registered for Stage 20 integration coverage:
one end-to-end test should create two real clones with the same origin and prove the binder rejects the
second clone, and one isolated test should change only dirty state. Existing tests already prove the
two underlying halves and the production comparisons are present, so these do not reopen Stage 19.

A final whole-architecture review of commit `9982ddd749ba5e30ea7d6beb7bbf37c03c1d8476` again rated
Stage 19 **PASS / CLOSED** and identified the Stage 20 P1 more precisely. A `PlanExecutionIntent`
proves that repository, facts, and policies matched at bind time; it is not a repository lock and may
be consumed seconds or hours later. Stage 20 must therefore revalidate authority immediately before
side effects, provision an orchestrator-owned integration checkout whose base commit matches the
approved artifact, derive task worktrees from that checkout, persist the run-creation boundary, and
only then call the existing runtime. It must not merely parse the intent and call `startRun()`.

The review also raised representation-sensitive shared-resource policy fingerprints as a possible P2.
The current CLI path is already semantically canonical: `SharedResourceRegistry` normalizes and sorts
file/path patterns and sorts definitions by ID before both planning and binding call `registry.list()`.
Therefore JSON input reordering does not reject the production CLI path. The generic binder still
accepts an `unknown` policy value and hashes its array representation, so any future non-registry
adapter must canonicalize through the same domain registry or a dedicated authority fingerprint
function. This is a future-adapter contract concern, not a Stage 19 defect. Durable intent storage is
also unnecessary now: same-run rebinding reloads and revalidates durable artifact/approval/claim
evidence and regenerates the same execution fingerprint. The future run record should persist the
execution, plan, approval, and claim fingerprints for traceability.

## Stage 20: Controlled Runtime Binding and Start

Stage 20 is complete and independently reviewed. It provides the first real,
recoverable `forge run` path while keeping orchestration out of Commander and out of the Pi adapter.

`RunPreparation` revalidates the claimed execution through `PlanExecutionBinder` immediately before
any execution side effect. A valid old intent is rejected if current Git source, physical repository
root, Repository Facts, shared-resource policy, or verification policy no longer matches. Clean-only
execution is explicit: a dirty PlanArtifact fails before checkout creation because Stage 20 cannot yet
materialize the exact approved dirty/untracked byte set in an isolated worktree.

`GitIntegrationCheckoutProvisioner` creates a run-specific `forge/integration/<run-id>` checkout at
the approved base commit outside the source repository. Exact retries reuse it; wrong commit/branch,
invalid run identity, source-internal checkout roots, and symlink escape fail closed. Every task
worktree derives from that checkout and approved commit. The source checkout is never the agent or
integration workspace.

`LocalRuntimeBindingPolicy` reconstructs predicted impacts, derives canonical lease plans, and creates
deterministic agent/workspace identities. Before dispatch, `RunPreparation` independently compares
the durable authority record, tasks, hard/risk conflicts, schedule, impacts, lease plans, and Git
workspace bindings against the approved intent. Empty write sets now produce valid empty lease plans;
unexpected writes still require runtime acquisition.

`RunAuthorityEvidence` is persisted in SQLite with artifact/revision/approval identity and the plan,
approval, claim, execution, working-tree, Repository Facts, shared-resource, and verification-policy
fingerprints. Existing databases receive the new column; legacy rows without valid authority fail
recovery explicitly. `startOrResumeRun()` returns an identical terminal run without dispatching again,
resumes matching ACTIVE evidence, and rejects a same-ID request with changed authority. Persisted
leases hydrate the restarted local guard. The runtime now also finalizes durable run state to
`COMPLETED` or `FAILED` instead of leaving completed task snapshots under an `ACTIVE` run row.

`LocalRuntimeStarter` composes the existing Scheduler, SQLite adapter, Write Guard, Git workspace
manager, controlled Pi agent, and post-agent package-script verifier. The default agent binding does
not grant `forge_command`; verification remains orchestrator-owned. The later whole-architecture
review identified that the original verifier still executed the package script directly on the host;
the security hardening subsection below supersedes that executor. Successful output remains in the
run integration checkout and is not pushed or merged into the user's branch.

The two Stage 19 test-organization follow-ups are closed: one real integration test creates two clones
with the same origin and bytes and proves the second physical root is rejected before claim; another
changes only dirty state. A real local runtime test performs a controlled Pi edit through task
worktree creation, lease enforcement, verification, commit, serial integration, SQLite recovery, and
identical retry.

ADR-024 records the boundary. Beginner-oriented mechanism guides are available in
[English](./controlled-runtime-start.en.md) and [Chinese](./controlled-runtime-start.zh.md).

The Stage 20 follow-up gate passes with 38 test files and 491 tests. Coverage is 95.44% statements,
90.90% branches, 96.51% functions, and 95.39% lines; the new `run-preparation` package independently reaches
100% statements, 98.33% branches, 100% functions, and 100% lines. `pnpm check`, `pnpm build`, CLI help,
and `git diff --check` pass. Self-analysis now reports 15 projects, 114 files, 1,620 symbols, 59 project
dependencies, 241 file dependencies, 3,007 symbol references, and the same two known configuration
diagnostics. The ingestion-and-matching research repository reports three projects, 1,010 files, 7,617
symbols, three project dependencies, 3,592 file dependencies, 13,893 symbol references, and the known
25-file `UNCOVERED_TYPESCRIPT_FILES` diagnostic.

No live external Pi model call was made against the research repository. The end-to-end runtime test
uses a controlled Pi gateway and real filesystem/Git/SQLite/pnpm operations. A live `forge run` would
perform model-backed code changes and therefore requires an intentionally prepared and approved
artifact rather than using the research repository as an uncontrolled mutation target.

Known deferred work remains distributed/cross-process lease fencing, dirty-snapshot materialization,
agent cancellation and `UNKNOWN` resolution, multi-failure aggregation, publication/PR integration,
and GitHub/Jira/provider triggers. These limits do not weaken the local clean-snapshot authority chain;
they define the next productization stages.

### Stage 20 independent-review hardening

The first independent review reproduced the original 484-test evidence and found one Critical local
recovery race. Two concurrent callers could both observe one durable `PREPARING` attempt and invoke the
external agent before SQLite's later optimistic checks detected contention. Every `startRun()` and
`startOrResumeRun()` entry now uses a process-wide queue keyed by repository and run identity. A
regression test concurrently starts two separate runtime instances against the same recovered attempt
and proves exactly one agent dispatch. This closes duplicate dispatch inside one process without
misrepresenting it as cross-process fencing.

Integration recovery now distinguishes ordinary foreign commits from Forge progress. Runtime-created
task commits contain exact `Forge-Run-Id` and `Forge-Task-Id` trailers, and checkout reuse verifies every
commit after the approved base. Legitimate integrated history remains reusable; a clean manual commit
and completely unrelated history both fail closed. The trailer is provenance metadata, not a signature
against a direct Git writer who deliberately forges it.

Verification no longer inherits the parent process environment. It receives only `CI=1` and a trusted
`PATH`, and package/script identifiers have explicit character allowlists. A real child-process test
sets an invalid parent `NODE_OPTIONS` and proves the approved pnpm script still succeeds without
inheriting it. Lease hydration now explicitly selects only ACTIVE leases. SQLite recovery adds direct
NULL and malformed-JSON authority tests.

Finally, a real Git integration test binds while clean, changes the repository to dirty, then calls
`RunPreparation`; the fresh `PlanExecutionBinder` rejects before checkout provision. Unused new barrel
exports were removed. These fixes close C1 and H1-H3 from the initial review and cover M1-M5 without
expanding Stage 20 scope.

### Stage 20 follow-up review: PASS / CLOSED

The follow-up reviewer independently reproduced the 491-test gate and exact coverage numbers. Three
adversarial experiments then used real SQLite persistence: two runtime instances concurrently resumed
the same `PREPARING` attempt and produced exactly one agent call; a changed-authority request waited
behind an in-flight run and was still rejected; and a failed queued operation did not poison or
deadlock the next request. This confirms that the module-level queue is shared across runtime
instances, releases correctly after rejection, and does not bypass authority checks.

A mutation test temporarily restored parent-environment inheritance. The new `NODE_OPTIONS` regression
test failed immediately and passed again after restoring the whitelist, proving that it detects the
intended security regression. The real Git clean-at-bind/dirty-before-start test, ACTIVE-only lease
hydration, NULL/malformed SQLite authority tests, identifier allowlists, unrelated-history rejection,
and public-export cleanup were also verified directly. Stage 20 is therefore **PASS / CLOSED**, and
Stage 21 may begin.

Four non-blocking follow-ups were registered at that review point: use strict
Git trailer parsing if the provenance format grows; retain the fail-closed rule that every post-base
commit must carry the run trailer; make verification executable-path construction portable to Windows
and configurable for Corepack/Volta/custom pnpm installations; and decide in a later security review
whether trusted Git subprocesses should also receive a minimal environment. None is an observed Stage
20 authorization or duplicate-dispatch bypass.

### Stage 20 whole-architecture review: sandboxed verification fix pending follow-up

A later whole-project review found one P1 architecture violation that the earlier Stage 20 review did
not expose. The orchestrator released execution leases and then ran an Agent-mutable `package.json`
script directly on the developer host. Fixed arguments and a minimal environment prevented shell and
environment injection, but they did not contain the script itself: it could still write outside the
task workspace, read host secrets, use the network, or start child processes outside Write Guard.

The working-tree fix removes direct host package-script execution. Verification policy v2 contains an
exact pinned-digest Docker profile and its full profile is part of the approved policy fingerprint.
`LocalRuntimeStarter` recomputes that fingerprint before persistence or dispatch, resolves the package
only through the approved RepositoryGraph, and delegates this fixed command to `AgentCommandSandbox`:

```text
approved package-script rule
        -> approved RepositoryGraph project root
        -> fingerprinted Docker profile
        -> npm --prefix <project-root> run <script>
        -> read-only workspace, no network, disposable /tmp
```

The container runs non-root with all Linux capabilities dropped, `no-new-privileges`, read-only root
and workspace mounts, memory/CPU/PID limits, and explicit environment variables only. Docker/image
absence, an unknown package, free-form command verification, policy drift, sandbox startup failure, or
nonzero script exit all fail closed. There is no trusted-local fallback. The official pinned Node image
uses its bundled npm only to invoke an already approved script; it never installs dependencies. Scripts
that require pnpm or missing dependencies currently fail closed until a dedicated verifier image exists.

The Docker adapter now resolves the host Docker CLI to an absolute path before replacing its
environment. This was found by the real adversarial test: a bare `docker` executable plus an empty PATH
could not start the sandbox. The host Docker client now receives only the minimum HOME it requires,
while the container continues to receive the explicitly approved environment.

Each verification container has a unique run-scoped name. Timeout, cancellation, and output-limit paths
ask the Docker daemon to `kill` and `wait` for that named container, then remove it before the verifier
reports the command settled. The Docker CLI process exiting is not treated as proof that the container has
stopped. Verification image policy rejects mutable tags and requires an immutable sha256 digest.

Tests prove exact sandbox delegation, runtime policy mismatch rejection, unknown-package and free-form
rule rejection, Docker hardening flags, and fail-closed sandbox errors. The final default gate has 38 test
files with 494 passed and one opt-in Docker test skipped (495 total); coverage is 95.40% statements,
90.76% branches, 96.32% functions, and 95.36% lines. When explicitly enabled, the real Docker test
starts a malicious package script, observes its marker, and proves its attempted workspace write is
denied. `pnpm check`, `pnpm build`, and `git diff --check` pass. Self-analysis reports 15 projects, 114
files, 1,635 symbols, 59 project dependencies, 243 file dependencies, 3,031 symbol references, and the
same two known root diagnostics. The research repository remains stable at 3 projects, 1,010 files,
7,617 symbols, 3 project dependencies, 3,592 file dependencies, 13,893 symbol references, and its known
25-file diagnostic. Documentation sync and independent follow-up review are complete.

The same review clarified two Git boundaries. Linked worktrees protect the user's checked-out files,
but their branches and registrations still mutate the source repository's shared `.git` metadata; true
metadata isolation needs a dedicated orchestrator clone. Also, interruption after branch creation but
before worktree materialization can leave a branch-only partial state requiring explicit reconciliation.
These are documented P2 limitations, not claims that linked worktrees provide a full security boundary.

Stage 20 is **PASS / CLOSED** after independent follow-up review. The recommended next product stage is
**Observed Impact Reconciliation**: compare actual Git changes with predicted impact and lease authority
before allowing verification/integration. Run Operations and Recovery Control remains planned after that
authority gap.

## Stage 21: Observed Impact Reconciliation

Stage 21 closes the first observed-effect authority gap. After an agent finishes but before verification,
the local runtime asks Git for the task worktree's real changed paths, including untracked files. It maps
each path through the approved RepositoryGraph rather than accepting a model-provided identifier. The
result is durable observed evidence for created, modified, and deleted files.

The reconciliation compares each actual written file with the approved predicted write scope and the
ACTIVE write leases held for that execution. A change with no matching active lease fails the task before
verification or integration. A leased file outside the approved predicted impact is retained explicitly
as `runtime-scope-expanded` evidence. It is not silently treated as plan-approved.

Leases remain ACTIVE through reconciliation. They are then released before verification because the
approved verifier runs in a separate read-only Docker container and cannot perform repository writes;
this is the boundary between controlled agent mutation and verification. An unleased observed change has
already failed the task and run before that release occurs, so no later task dispatch is allowed to treat
the released resource as safe work in the failed run.

When expansion overlaps another task's predicted write scope, the runtime persists a hard
`runtime-scope-expansion` conflict. That conflict is included in the next scheduler reevaluation, so a
task that remains in verification or integration still prevents a newly eligible conflicting task from
starting. The scheduler retains its established ordering for concurrently selected tasks while extending
conflict protection through these in-flight lifecycle states.

On an ACTIVE run restart, persisted runtime conflicts are reloaded and trigger a durable
`runtime-reconciliation-recovered` reevaluation before dispatch resumes. Runtime conflict collections are
therefore deliberately mutable runtime state, separate from the approved immutable plan conflicts.

The implementation keeps Git parsing in `workspace-git`, graph/path ownership in `run-preparation`, and
the provider-neutral reconciliation contract in `domain`. It does not infer symbols, dependencies,
manifests, generated output, or dynamic conflicts beyond actual file scope. Cross-process write fencing,
dirty snapshot materialization, cancellation/UNKNOWN reconciliation, and operator workflow remain later
stages.

One non-blocking correctness limitation remains at the verification boundary. Releasing a task's execution
leases before its read-only verifier starts is safe against verifier mutation, but it does not preserve a
read snapshot against another legitimate task write that acquires a new lease after the release. A later
stage should evaluate verification-read reservations or a repository snapshot so verification can be tied
to an immutable post-agent state. This is not an authorization bypass: the later write still requires its
own lease and the verifier cannot write.

Focused verification passes: TypeScript project-reference build, Oxlint, scheduler and runtime tests, the
real local worktree/SQLite runtime test, and new reconciliation tests covering actual-diff precedence,
leased scope expansion, and unleased-change rejection.

### Stage 21 closure: sequenced runtime knowledge

Runtime scope conflicts are now committed as mutations in the same durable scheduler sequence that first
uses them. Replay applies each mutation only from its `effectiveFromSequence`, so it reproduces historical
decisions without incorrectly leaking a later conflict into earlier scheduling. Expansion matching now
compares actual `WritableResource` values against other tasks' canonical lease plans, preserving project,
file, and symbol hierarchy instead of relying on a file-ID-only comparison.

The durable retry boundary also includes runtime conflict mutations. A retry for an already committed
scheduler sequence succeeds only when its event, snapshot, transitions, decision, and same-sequence
runtime conflicts are exact evidence matches; a changed mutation set fails closed. This preserves the
run's uncertain-commit idempotency rule while leaving later observations for an already serialized task
pair as diagnostic follow-up rather than rewriting its initial conflict evidence.
