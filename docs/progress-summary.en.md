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

The full quality gate now has 219 passing tests. Coverage is 97.36% statements, 92.46% branches,
99.47% functions, and 97.30% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

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

The full quality gate now has 219 passing tests. Coverage is 97.36% statements, 92.46% branches,
99.47% functions, and 97.30% lines. `pnpm check`, `pnpm build`, and `git diff --check` pass.

## Current overall status (as of this writing)

- Architecture milestones 1–10 of 10 are implemented. This does not mean the full product is 100%
  complete: agent execution, real write enforcement, provider integration, and CLI runtime work remain
  substantial product capabilities outside the deterministic milestone plan.
- Formatting, linting, TypeScript 7 checking, and tests run through `pnpm check`. There are 219 tests,
  all passing.
- Coverage is 97.36% statements, 92.46% branches, 99.47% functions, and 97.30% lines. Every enforced
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

## What has NOT been implemented yet

- Invoke coding agents, monitor them, and verify their results.

In short: **the orchestrator can now map a real TypeScript pnpm repository, predict task impact,
compare conflicts, decide what may start after an event, guard exclusive writes inside one process,
recover verified local orchestration evidence from SQLite, and integrate one local task worktree with
Git. It still does not observe real writes, coordinate multiple processes, or run agents.**
