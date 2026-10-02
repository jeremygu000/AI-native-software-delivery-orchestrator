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

## Stage 5b: Temporal runtime foundation for durable execution

This stage added the first Temporal-backed runtime slice for durable execution. The aim was not to
wire every production service yet. The goal was to establish the workflow boundary, prove it is
testable with Temporal's own worker/test environment, and keep the workflow deterministic.

The Temporal runtime now has two clear responsibilities:

- the workflow only orchestrates durable steps using compact IDs and enums;
- the activity layer is where Forge services will eventually run, because activities are where side
  effects are allowed.

### What the Temporal slice now does

The Temporal runtime package now contains:

- compact Zod contracts for the workflow input and result;
- compact activity contracts for builder execution, repair admission, output integration, and run
  finalization;
- a Scenario A workflow that reevaluates the run, executes authorized builders, evaluates their
  outputs, separates repair admission from repair execution, and finalizes the run;
- a worker factory that requires explicit Forge activities instead of silently assuming a default;
- workflow tests that verify the no-task, accept, repair, and reevaluation paths.

### What was corrected after the first slice

After the first M3.3 slice, review found three authority issues and they were corrected in the
workflow/contracts layer:

- the workflow now consumes authorized builder starts instead of raw scheduler state;
- repair admission is a separate activity before repair execution;
- the workflow re-evaluates the run during processing and finalizes the run state at the end.

### What is verified now

The following checks already pass:

- `pnpm exec tsc -b libs/temporal-runtime/tsconfig.lib.json apps/temporal-worker/tsconfig.app.json --force`
- `pnpm exec vitest run --config vitest.config.ts libs/temporal-runtime/src/lib/temporal-runtime.spec.ts`

The Temporal tests prove the workflow reaches the correct branches for:

- a run with no authorized work;
- a task that is accepted after evaluation;
- a task that requires repair admission and repair execution;
- a run that discovers additional authorized work after reevaluation.

### What still remains unimplemented

The production worker composition root is still not wired. The current `apps/temporal-worker`
package still needs a real adapter that constructs Forge services and passes them into the Temporal
worker. The worker now shuts down more safely, but it is still only the runtime shell, not the final
production wiring.

### What this stage enables next

This stage makes it possible to build the real production worker composition root without guessing
the contract shape. The next stage can focus on wiring durable runtime dependencies into the activity
layer instead of redesigning the workflow boundary again.

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

## Stage 22: Build Review And Repair Loop

Stage 22 begins with a deliberately narrow review-evidence boundary. After a task workspace has been
verified, an independent reviewer can inspect it through only read, list, and find tools. It returns a
strict JSON review: `accept` with no findings, or `repair` with uniquely identified findings, severity,
affected file IDs, description, and optional requirement reference. The runtime collector parses this
untrusted response and persists it idempotently by run, task, and review iteration.

The reviewer session defines and activates only these three read-only tools rather than defining a broader
tool set and relying on an active-tool filter. A real Pi SDK regression test verifies that no built-in
shell or Forge edit, write, or command tool is active.

Every review is now bound to the builder attempt, workspace identity and revision, workspace-change
fingerprint, observed-impact fingerprint, and verification fingerprint. A changed subject at the same
review iteration fails closed, and findings that cite unknown repository file or symbol IDs are rejected
before persistence. This is evidence binding only: no current integration path uses review acceptance as
authority. The next repair increment must first produce durable workspace-change and verification
fingerprints for the exact output it proposes to review or integrate.

The reviewer cannot write files, run commands, approve integration, or dispatch repair. Repair is not yet
implemented: the existing runtime has one durable builder-attempt lineage per task, while a safe repair
loop requires separately modeled repair attempts, a bounded budget, repeat verification and review,
recovery semantics, and an integration-admission rule. ADR-025 records this boundary so the next Stage 22
increment can add repair without weakening attempt provenance.

The next Stage 22 increment adds the first repair authority records without yet dispatching a repair
agent. A `TaskRepairAttempt` has its own revisioned lineage, parent review iteration and subject, bounded
repair budget, session/failure evidence, and separate SQLite storage. An integration admission policy now
accepts only a durable `accept` review whose builder attempt, workspace revision/change, impact, and
verification subject exactly equals the current output. Repair, re-verification, and re-review dispatch
remain the next composition step.

Repair admission is now exact-once durable evidence. Retrying the same parent review returns the existing
repair attempt rather than allocating another iteration or consuming budget again. SQLite atomically looks
up the parent review subject, checks the task budget, allocates an iteration, and stores the attempt. Later
revisions may add lifecycle evidence but cannot alter repair lineage identity. Actual repair dispatch,
post-repair reconciliation, verification, and re-review remain deliberately unimplemented.

The next prerequisite is also complete: passed verification can be stored independently as exact-idempotent
evidence. Its identity includes run/task/attempt, workspace revision, actual worktree-content fingerprint,
verification-policy fingerprint, verified-at time, and self fingerprint. The factory consumes a real Git
snapshot instead of deriving a placeholder. Repair dispatch is still locked until runtime composition
persists this evidence after each verification and uses its fingerprint in the new review subject.

Verification evidence now verifies its own fingerprint whenever it is written or recovered; a
valid-looking but mismatched digest fails closed. Its factory rejects non-completed attempts and any
attempt/workspace or snapshot/workspace identity mismatch. The repair loop therefore has an exact content
and verification authority prerequisite, not an opaque caller-provided digest.

Repair execution composition is now available as a separate coordinator. It persists repair `STARTING`,
waits for controlled-agent `onStarted` before `RUNNING`, records post-start failures as `UNKNOWN` while
retaining active leases, and otherwise sends the resulting workspace through Stage 21 reconciliation,
sandbox verification, exact verification evidence, a repair-output review subject, and a new read-only
review. It does not automatically integrate task output yet: integration remains gated by an exact accepted
review and is intentionally left to the next composition boundary.

Repair contention is now durable rather than disguised as failure. A dynamic lease block moves the repair
attempt to `BLOCKED` with lease evidence, releases leases currently held by that repair, and sends explicit
feedback for later scheduling integration. Compare-and-swap resume returns the same repair lineage to
`PREPARING`; a stale resume cannot overwrite newer lifecycle evidence. Repair scope expansion is likewise
reported through the same feedback boundary. The main runtime still needs a scheduler-visible repair phase
before `forge run` can automatically consume these feedback events and resume repairs.

Lease release remains deliberately separate between builder and repair paths until final repair-scheduler
composition establishes their shared evidence contract. The final Stage 22 increment must add a parallel,
recoverable repair view that resumes blocked repairs by CAS when their blocker lease is released; it must
not insert repair states into the original builder task-state snapshot.

Code review policy is now a separate approved authority from verification policy. Its semantic fingerprint
binds reviewer implementation, agent backend, provider/model, read-only tool profile, review schema
version, and prompt version, while excluding transient sessions and paths. Artifact creation, execution
binding, durable run authority, and local startup all reject review-policy drift independently of verifier
policy drift. The Pi reviewer resolves the approved provider/model through Pi's model registry and passes
the exact resolved SDK model into its session; it fails closed rather than falling back to default Pi model
selection when the approved model is unavailable.

The final Stage 22 composition is now active in normal `forge run`. After builder verification, the runtime
captures the real Git worktree, persists exact verification evidence, builds a review subject, and collects
the approved read-only Pi review. It accepts integration only after a stored `accept` review exactly matches
the current output subject. A `repair` review must itself be recovered as matching durable evidence before a
repair can be admitted.

Repair admission now atomically stores both the separate repair lineage and an immutable
`TaskRepairWorkItem`. This item records the builder attempt, workspace, lease-plan and impact fingerprints,
parent/next review iterations, and verification/review policy fingerprints needed to recover repair
dispatch. The runtime executes the bounded repair through controlled agent tools, Stage 21 reconciliation,
verification evidence, and re-review; only a fresh exact accepted review can then commit and integrate the
repaired output. Builder task state remains independent from repair state throughout this loop.

Repair scope expansion feeds Stage 21's durable runtime-conflict replay, while a lease block refreshes the
parallel repair view without changing the builder snapshot. Restart recovery returns active repair attempts
as `UNKNOWN` and fails closed. Automatic resumption of recovered `BLOCKED` repairs remains unimplemented
because it must reconstruct all durable controlled-dispatch and lease-acquisition authority before it can
retry safely. Stage 22 was verified with `pnpm check` (565 passed, 1 skipped, 90.07% branch coverage) and
`pnpm build`.

The repair coordinator now independently reads durable review evidence before admission. A caller cannot
create a repair merely by supplying a `repair` value: the persisted task/iteration review must have the same
seven-field subject. Immediately before commit and integration, the runtime captures the workspace again
and rejects changed workspace identity, revision, or worktree fingerprint. This makes post-review output
drift fail closed even if future runtime work adds an asynchronous mutation point. The hardening pass was
verified with `pnpm check` (567 passed, 1 skipped, 90.05% branch coverage) and `pnpm build`.

The review-to-integration drift guard also has a production-style regression test. It uses a real Git task
worktree and controlled Pi builder edit, then has an accepted reviewer mutate that real worktree. The runtime
rejects before integration, and the integration checkout remains unchanged. This closes the remaining Stage
22 test-depth gap identified during independent review. The full suite now verifies `pnpm check` with 568
passed, 1 skipped, and 90.01% branch coverage, plus `pnpm build`.

### Runtime V2 Migration

The verified Stage 22R legacy runtime is archived as `stage22r-legacy-runtime-2486fe0` and
`archive/stage22r-legacy-runtime`. Runtime V2 starts on a separate migration branch. ADR-027 preserves
Forge's deterministic authority while selecting a durable execution substrate through narrow Temporal and
Restate spikes before full migration. PostgreSQL evidence storage remains a scaling candidate, not a Runtime
V2 prerequisite.

The selected durable runtime remembers where execution is, SQLite currently remembers what Forge has
inspect/status/cancel API; early UI work may define information architecture, evidence-drawer contracts,
status vocabulary, and visual language without binding to the legacy runtime.

The Temporal candidate now has an isolated real worker, workflow, and Activity skeleton validated with
Temporal's test environment. Workflow history contains only the run ID and scenario discriminator.

**Current spike state is:**

- M1 spike contract: CLOSED
- M2.1 Temporal skeleton: CLOSED
- M2.2 Activity infrastructure: CLOSED
- M2.3A Authority adapter hardening: REOPENED (see below)
- M2.3B Repair seam authority shape: CLOSED

**Scenario A - control flow shape (CLOSED):**

- `ForgeBuilderExecutionService`: implemented (Seam 1: ExecuteBuilder)
- `ForgeBuilderOutputEvaluationService`: implemented (Seam 2: EvaluateBuilderOutput)
- `ForgeRepairExecutionService`: implemented (Seam 3: ExecuteRepair)
- `ForgeAcceptedOutputIntegrationService`: implemented (Seam 4: IntegrateAcceptedOutput)
- `ForgeScenarioAServiceRunner`: composition layer implemented
- Four narrow Temporal Activities defined and wired into workflow
- Workflow refactored to call four narrow Activities instead of opaque `runBuildReviewRepairIntegrate`
- Legacy `runBuildReviewRepairIntegrate` deprecated but retained for backward compatibility
- Durable continuation now enabled: each activity call creates separate continuation boundary
- `createTemporalSpikeScenarioService` adapter: accepts optional `ForgeScenarioAServices` for real delegation, falls back to stubs when not provided

### M3.3: Temporal runtime Scenario A vertical slice

This stage moved the real Temporal runtime package closer to the production shape of the orchestrator. The focus was not to finish every Forge service integration yet, but to prove that the workflow layer, activity contracts, worker factory, and tests can all speak the same Scenario A language.

What was built:

- `libs/temporal-runtime/src/lib/contracts.ts` now defines compact schemas for the Scenario A flow: scheduler reevaluation, builder execution, builder-output evaluation, repair execution, and accepted-output integration.
- `libs/temporal-runtime/src/lib/activities/forge-activities.ts` now defines the activity surface that the worker process must provide.
- `libs/temporal-runtime/src/lib/workflows/forge-run.ts` now orchestrates the Scenario A path by calling narrow activities in sequence and branching on `accept`, `repair`, and `reject` results.
- `libs/temporal-runtime/src/lib/worker-factory.ts` now requires an explicit Scenario A activity implementation instead of silently falling back to the legacy bootstrap stub.
- `apps/temporal-worker/src/main.ts` now passes a placeholder Scenario A activity map so the new worker shape is explicit.
- `libs/temporal-runtime/src/lib/temporal-runtime.spec.ts` now covers three workflow cases: nothing ready, accept path, and repair path.

What this stage proves:

- The Temporal workflow can move through a real multi-step orchestration without putting business logic in the workflow sandbox.
- The workflow history stays compact: the inputs and outputs are IDs and small enums instead of large domain objects.
- The worker and test environment can register the same activity names that the workflow expects.

Verification already performed:

- `pnpm exec tsc -b libs/temporal-runtime/tsconfig.lib.json apps/temporal-worker/tsconfig.app.json --force`
- `pnpm exec vitest run --config vitest.config.ts libs/temporal-runtime/src/lib/temporal-runtime.spec.ts`

Current limitation:

- The production worker entrypoint still uses placeholder activities that throw, so real Forge service wiring is not finished yet.
- The new workflow shape is validated, but it is not yet executing the actual orchestration services end-to-end in the worker process.

What this enables next:

- The next stage can replace the placeholder worker activities with real adapters that call the Forge services.
- Once that wiring exists, the Temporal runtime can become the real production execution path instead of a validated skeleton.

**M2.3A - Authority adapter hardening (REOPENED):**

- Original commits attempted to remove fake data but some remained
- Spike adapter still passes empty `files`/`symbols` maps for repository (stub, not real)
- `verificationPolicyFingerprint` uses empty string instead of real policy fingerprint
- Workflow removed `repair-${Date.now()}` fallback - Forge must provide real repairAttemptId
- Commit: `531445e` (partial fix), additional work needed

**M2.3B - Repair seam authority shape (CLOSED):**

- Fixed P1-4 crash bug: `ForgeRepairExecutionService` blocked case accessed `result!.verification` when result was undefined
- Created `RepairExecutionOutcome` union type with `completed`, `blocked`, and `unknown` states
- Updated `ForgeRepairExecutionService.execute()` to return `RepairExecutionOutcome`
- Updated `forge-scenario-a-service-runner.ts` to check state before accessing properties
- `UNKNOWN` state now fails closed (throws error) instead of becoming 'repair' recommendation
- Commit: `7812ac5`, `23b819f`

**Scenario B - Durable wait/signal primitive (GROUNDWORK):**

- Renamed signal from `repairAuthorizedSignal` to `repairWakeSignal` - Temporal is wake-only, not authorization
- `repairWakeSignal` carries `leaseState: 'RELEASED' | 'STALE'` for Forge CAS authority inside activity
- Workflow waits for valid signal using `condition()` before calling `executeBlockedRepairResume`
- Unrelated signals are ignored (workflow continues waiting)
- Removed arbitrary 30-day condition timeout
- Forge CAS authority still needs to be implemented inside `executeBlockedRepairResume` activity
- Commit: `temporal-spike-workflow.ts` updated

**Remaining P1 items:**

1. **Forge CAS blocked resume** ✅ IMPLEMENTED: `executeBlockedRepairResume` now loads repair, verifies BLOCKED@N, loads blocker lease, verifies RELEASED/STALE, performs CAS BLOCKED@N → PREPARING@N+1

2. **Restart persistence proven** ✅ GROUNDWORK: Temporal `condition + signal` durable wait proven in test environment. True cross-worker restart requires real Temporal cluster (not test environment).

3. **Shared SQLite authority harness** ⚠️ PARTIAL: `TemporalSpikeDriver` is implemented and wires `DurableExecutionSpikeDriver` interface to persistence. Full end-to-end test requires real Temporal cluster with actual persistence (not test environment). Harness assertion logic is verified via unit tests.

**Architecture decision still pending:**

The correct路线 is:

- Complete Temporal spike proof-of-concept ✅ DONE
- STOP TEMPORAL ✅ DONE
- Evaluate Restate candidate with same harness (IN PROGRESS)
- ADR-028 decision
- Winner only: Integration Bootstrap / RuntimeStarter / CLI cutover

NOT doing Integration Bootstrap until candidate winner is selected.

**Completed:**

- Added `temporal-spike` as workspace dependency to CLI package.json
- Signal renamed: `repairAuthorizedSignal` → `repairWakeSignal` (Temporal is wake-only)
- `executeBlockedRepairResume` now implements real Forge CAS authority seam
- `UNKNOWN` state fails closed (throws error)
- Unrelated signals ignored (workflow continues waiting)
- Removed arbitrary 30-day condition timeout
- Durable wait tests prove `condition + setHandler` works
- STALE leaseState also triggers resume correctly
- `TemporalSpikeDriver` implements `DurableExecutionSpikeDriver` interface
- Created `restate-spike` package with SDK structure
- `RestateSpikeDriver` implements `DurableExecutionSpikeDriver` interface
- Restate Activities and Workflow defined using `@restatedev/restate-sdk`
- Restate test structure complete - tests require Docker/testcontainers (Docker unavailable in CI environment)

**OutcomeCollector Pattern (both candidates):**

- **CRITICAL architectural fix**: Removed harnessOutcome/harnessRegistry from both candidates
- Previous harness pattern was FALSE-POSITIVE - circular validation where harness pre-constructs correct outcome, passes it to workflow as input, then asserts it passes
- Both candidates now execute REAL Forge seams, write evidence DURING execution
- OutcomeCollector reads from evidence store AFTER workflow completes
- Outcome is OBSERVED, not pre-constructed
- Temporal: 6 passing tests with OutcomeCollector + InMemoryEvidenceStore
- Restate: 5 passing tests with workflow state evidence collection

**Restate Spike Status:**

- **Scenario A**: `workflowSubmit + rs.result()` completes successfully (3 tests pass)
- **Scenario B**: `workflowSubmit` works, durable wait pattern implemented
- **Fixed**: Removed harnessRegistry (not durable), uses workflow state for evidence
- **ADR-028**: REOPEN - OutcomeCollector pattern proven for both candidates

**Architecture decision: ADR-028 REOPEN - Decision Pending**

- Both candidates now use OutcomeCollector pattern (real execution, observed outcomes)
- Temporal: 6 passing tests with real workflow execution
- Restate: 5 passing tests with real workflow execution
- Both prove durable execution without pre-constructed outcomes
- Next: Complete fair comparison and decision

### Stage 22R: Repair Continuation Design

Stage 22R now closes blocked-repair continuation. The runtime maintains an idempotent parallel queue of repair
attempt IDs. A fresh repair recommendation persists admission and work-item evidence, then enqueues work rather
than recursing under the builder review call. A durable released or stale blocker selects an exact `BLOCKED`
repair, validates its evidence against current authority, performs compare-and-swap resume, and enqueues only
the winner. `PREPARING` repairs are also queued after restart; `STARTING`/`RUNNING` repairs remain `UNKNOWN`
and never auto-resume.

Each queued repair advances one durable cycle: controlled execution, reconciliation, verification evidence,
fresh review, then either exact integration or admission/enqueue of the next bounded repair attempt. A repeated
`repair` recommendation therefore re-enters the same non-recursive driver without introducing a continuation
phase or repair states into the builder snapshot. Recovery coverage proves released, stale, active, CAS-loser,
`PREPARING`, `UNKNOWN`, repeat-review, and re-blocked outcomes. A live multi-task regression proves an
unrelated release does nothing, while the matching builder lease release causes exactly one resumed repair
dispatch. `pnpm check` passes with 570 tests passed, 1 skipped, and 90.12% branch coverage; `pnpm build` also
passes. Stage 22 is closed.

### Stage 23: Observed Impact Reconciliation

Stage 23 closes the observed impact reconciliation gap. The runtime now tracks which files the agent actually reads during execution and validates those reads against the predicted impact scope.

The `AgentToolRuntime` now tracks file reads in its `observedImpact()`. When the agent calls `read()`, `list()`, or `find()`, the accessed file IDs are recorded in a `#readFileIds` set. This information flows through `PiAgentRunner` to `OrchestrationRuntime`, where `RepositoryImpactReconciler` compares observed reads against predicted reads.

`RepositoryImpactReconciler.reconcile()` now computes `unauthorizedReadIds`: files the agent read that were not in the predicted `filesRead` set. This is surfaced as a new `unauthorized-read` event in the scheduler event log rather than failing the task outright—reads are scope violations but not security boundary violations (unlike unleased writes).

The reconciliation result type `TaskImpactReconciliation` gains an optional `unauthorizedReadIds` field. The `RepairRuntimeFeedback` interface gains an optional `unauthorizedRead()` method for repair-time callbacks.

`pnpm check` passes with 572 tests passed, 1 skipped, and 90.04% branch coverage; `pnpm build` also passes. Stage 23 is closed.

### Stage 24: Run Operations and Recovery Control

Stage 24 adds run operations and recovery control commands to the CLI.

The `forge status` command queries the SQLite run database and returns the current run state including tasks, leases, and scheduler events as JSON. It uses `DrizzleSqliteOrchestrationPersistence.recoverRun()` to reconstruct run state and formats task states from transition history.

The `forge cancel` command cancels an active run by calling `DrizzleSqliteOrchestrationPersistence.updateRunState()` with `CANCELLED` state. It validates that the run exists and is in a cancellable state (ACTIVE), rejecting already-cancelled or completed/failed runs.

Both commands support `--run-directory` to specify custom database locations, defaulting to `~/.forge/runs/<run-id>`.

`pnpm check` passes with 578 tests passed, 1 skipped, and 90.31% branch coverage; `pnpm build` also passes. Stage 24 is closed.

## Stage M3.3: Temporal runtime Scenario A slice

This stage added the first real Temporal workflow slice for the Forge runtime, and then corrected its authority model after review. The goal was to prove that the workflow can carry only compact identifiers while the worker-side activities own the heavier orchestration work.

What was built:

- compact Zod contracts for the workflow input, result, authorized task data, builder execution, evaluation, repair admission, repair execution, integration, and finalization;
- a Scenario A workflow that calls `reevaluateRun`, executes builders, admits repairs separately, integrates only accepted output, and then finalizes the run;
- a Temporal activity surface that matches the workflow boundary;
- workflow tests for empty runs, accepted output, repaired output, second-repair admission, and finalization failure;
- a worker factory that now requires explicit Forge activities instead of silently inventing a default.

Why this mattered:

- The workflow must not decide who is allowed to run; that authority belongs to `reevaluateRun`.
- Repair admission must stay separate from output evaluation, so the workflow can fail closed instead of assuming a repair attempt exists.
- The workflow must return the final run state from `finalizeRunState`, not a hand-written success flag.

What was verified:

- TypeScript build for `libs/temporal-runtime` and `apps/temporal-worker` passed.
- Temporal workflow tests passed, including the repaired authority model and the second-repair regression.

Current limitation:

- none for Scenario A. The stage is closed and frozen for the accepted scope.

What this stage enables next:

- M3.4 can reuse the frozen Scenario A authority seams for durable BLOCKED repair continuation;
- the next work is restart-safe lease hydration, signal/wake handling, exact blocker validation, and CAS resume of the same repair attempt.

## Stage M3.3 closure: durable authority and production wiring

The original M3.3 slice proved the workflow contract, but review found that the worker still behaved like a synthetic harness. The stage was therefore extended until the worker boundary itself became durable and production-shaped.

What was added after the first slice:

- a real `createForgeWorkerComposition()` in `apps/temporal-worker/src/forge-worker-composition.ts` that wires the production services used by the worker;
- a dedicated progression seam in `libs/orchestration-runtime/src/lib/forge-run-progression-service.ts` that owns scheduler reevaluation, dispatch persistence, and finalization;
- exact PREPARING-attempt validation for builder and repair execution, so compact Temporal identifiers are resolved back to durable runtime authority before any service call;
- repair lineage that now persists a fresh review at `parentIteration + 1` instead of reusing the builder review identity;
- workflow-level progression that re-evaluates after integration so a minimal `A -> B` dependency chain can advance;
- a worker-side progression test that proves a fresh run can create a new durable PREPARING attempt, recover it after integration, and finish with a completed run.

Why this mattered:

- the worker now recovers persisted bindings, attempts, reviews, and impacts from SQLite instead of inventing authority;
- reevaluation, repair admission, integration, and finalization all use the same durable authority model;
- Temporal retries can recover the same authorizations without minting new synthetic work.

What was verified:

- `libs/orchestration-runtime` and `apps/temporal-worker` both compile;
- the new orchestration progression specs pass;
- the Temporal runtime workflow spec passes;
- the production worker vertical spec in `apps/temporal-worker/src/forge-worker-composition.spec.ts` passes.

What remained outside this stage was completed in M3.4: lease hydration, blocked-repair continuation, and restart recovery are now separate Scenario B guarantees.

## Stage M3.4: BLOCKED repair restart and durable continuation

This stage completed Scenario B without reopening the frozen M3.3 worker authority model. It adds restart-safe BLOCKED repair continuation to the production worker.

What was built:

- durable repair work-item admission with the builder, workspace, lease-plan, review, impact, and policy lineage required for continuation;
- a repair wake signal scoped to `repairAttemptId`, including repeated BLOCKED -> wake -> resume cycles and early-wake handling;
- revision-bound resume dispatches written atomically with the `BLOCKED` -> `PREPARING` CAS, so lost Temporal responses and CAS losers recover the same authorization rather than minting new work;
- full pre-CAS continuation validation across the repair attempt, work item, binding, completed builder attempt, parent repair review, exact review subject, and policy fingerprints;
- run-scoped write guards hydrated from current SQLite ACTIVE leases, refreshed on each wake and before repair execution so released durable leases cannot remain stale in memory;
- a real SQLite restart vertical test: process A persists a BLOCKED repair, process B reopens the same database, handles an early wake, observes an external durable lease release, resumes the same repair attempt, produces a fresh review, and integrates accepted output.

Why this was separate from M3.3:

- M3.3 closed Scenario A production wiring;
- M3.4 is specifically about restart and durable continuation semantics for BLOCKED repairs.

What was verified:

- TypeScript builds for persistence, orchestration runtime, Temporal runtime, and the Temporal worker;
- 41 SQLite persistence tests, including durable dispatch recovery;
- worker composition tests covering restart, early wake, lease release, exact same-repair resume, lost-response recovery, fresh review, and integration;
- Temporal workflow tests covering Scenario A and Scenario B wake/resume behavior;
- progression, reevaluation, and finalization tests in the orchestration runtime.

Stage outcome:

- M3.4 is closed and frozen for Scenario B. Later work must not change its authority semantics unless it exposes a real contract regression.

What this stage enables next:

- M3.5 can add status, cancellation, and operational control surfaces over the now-frozen Scenario A and Scenario B runtime behavior.

## Historical note: earlier worker composition-root wording

Earlier drafts described the worker composition root as a separate stage. That work is now absorbed into M3.3 and should not be treated as a separate upcoming M3.4 deliverable.

## Stage M3.5: Durable cancellation authority and operator control

M3.5 adds operational control without reopening the frozen M3.3 Scenario A or M3.4 Scenario B authority contracts. Its purpose is to make cancellation durable, observable, and safe around work that can mutate a workspace.

What was built:

- cancellation is a two-phase durable state change: an ACTIVE run first becomes CANCEL_REQUESTED, and becomes CANCELLED only after its already-authorized mutation work has settled;
- builder and repair execution claim ACTIVE-run authority atomically before starting. Once cancellation is requested, no new mutation can acquire that authority;
- an attempt whose external execution cannot be confirmed stopped is recorded as UNKNOWN rather than being treated as cancelled. An operator must explicitly settle that attempt after independently confirming it is no longer running;
- accepted-output integration has its own durable in-flight claim. The worker acquires it while the run is ACTIVE before calling Git-facing integration, and cancellation finalization remains pending until the claim is released. A terminal CANCELLED state therefore cannot race an integration that is still able to mutate a workspace;
- if a worker crashes or loses an integration outcome after acquiring that claim, an operator can use `forge settle-integration-cancellation` with the exact run, task, workspace, and output-attempt tuple. This removes only the matching orphaned claim while the run is CANCEL_REQUESTED, allowing cancellation to finish without making the claim a permanent tombstone;
- Pi agent cancellation now distinguishes a request from confirmation. The runner reports cancelled only after the provider session confirms `abort()` succeeded. Abort failures or ambiguous errors propagate, so the existing builder and repair paths retain their active leases and persist UNKNOWN instead of falsely releasing authority;
- the CLI exposes `forge status`, `forge cancel`, `forge settle-cancellation`, and `forge settle-integration-cancellation` so operators can inspect a run, request cancellation, and explicitly reconcile uncertain builder, repair, or integration work.

Why this matters:

- a cancellation request is not proof that an external process, agent, or Git operation has stopped;
- durable claims make the decision about whether a mutation is allowed atomic with the run state, including the narrow period between an integration read gate and its external Git effects;
- keeping uncertain work UNKNOWN prevents a later execution from assuming the workspace is safe while an earlier process may still mutate it.

What was verified:

- focused worker and SQLite persistence regression suites passed, including a paused accepted-output integration where cancellation remains pending until integration settles;
- focused Pi gateway and Pi runner suites passed, including provider `abort()` failures that propagate instead of becoming false cancellation confirmation, even when prompt completion wins the initial race;
- `pnpm typecheck` passed;
- `pnpm lint` passed;
- `pnpm test` passed with 676 passed and 1 skipped tests;
- `pnpm build` passed, including TypeScript project-reference builds and the CLI bundle.

Current limitations:

- cancellation is not a kill guarantee for arbitrary external tools. Before using `forge settle-cancellation` on an UNKNOWN attempt or `forge settle-integration-cancellation` on an orphaned integration claim, an operator must independently verify that the external process or Git operation has stopped and can no longer mutate the workspace;
- this stage does not introduce a general cross-process fencing protocol, external publication workflow, or remote trigger control plane.

Stage outcome:

- M3.5 is closed and frozen for durable cancellation authority and operator control. M3.3, M3.4, and M3.5 authority semantics must change only when a real contract regression is found.

## Stage M3.6: Legacy and Temporal Runtime V2 differential acceptance

M3.6 proves that the legacy `OrchestrationRuntime` and the production Temporal Runtime V2 workflow reach the same durable Forge authority outcome for the migration scenarios in ADR-027. The acceptance suite runs each runtime against its own SQLite authority database, run ID, workspace identity, and repository target. It compares normalized persisted Forge evidence, never framework-specific event history or workflow implementation details.

The suite uses the real legacy runtime, the real Temporal workflow, the production Temporal worker composition, and Drizzle SQLite persistence. Deterministic test seams replace only external Git, agent, verifier, model, snapshot, and reconciliation effects. Both sides use the production `SnapshotTaskCodeReviewSubjectProvider` and `TaskVerificationEvidenceFactory`, so canonical impact fingerprints and exact review, repair, and integration authority evidence remain under production construction. This keeps the test reproducible while still exercising the runtime authority boundaries, persistence, review lineage, repair admission, integration admission, and recovery behavior that the migration must preserve.

What was built:

- a differential normal-path fixture runs build, verification, review requesting repair, one repair, repair verification, accepted review, and exact accepted-output integration through both runtimes;
- a differential blocked-repair fixture persists a `BLOCKED` repair, releases its exact blocker lease, resumes the same repair ID, increments its durable revision, persists one authorization dispatch, completes the repair, and integrates the accepted output through both runtimes;
- legacy recovery now passes its resume authorization into the existing atomic repair-resume persistence operation. The durable repair-state transition and its one resume-dispatch record are committed together, so recovery retries cannot authorize an additional execution of the same blocked snapshot;
- legacy runtime integration now persists its outcome from the exact admitted review subject after workspace integration. A `WorkspaceManager` remains a Git-only adapter and cannot invent or infer the accepted output attempt;
- the SQLite outcome collector orders verification evidence by durable verification timestamp, then attempt and evidence identity, before selecting final evidence. This avoids incidental database row order even when timestamps tie.

What was verified:

- each runtime independently satisfies `build-review-repair-integrate` and `blocked-repair-restart-resume` from the shared durable-outcome contract;
- normalized legacy and Temporal outcomes are equal. Normalization replaces runtime-generated IDs, derived verification fingerprints, timestamps, and runtime-local absolute revision values. It preserves authority structure, while each runtime independently proves the blocked-to-resumed revision relationship;
- the blocked scenario proves the exact blocker release, same repair attempt ID, blocked-to-resumed relationship, one dispatch, final accepted review, and exact integration output binding for both runtimes;
- the Temporal side uses a real test Temporal server, worker, production workflow, production worker composition, and production builder/evaluation/repair/integration services. Only external adapters are deterministic seams. The legacy side uses the real production `OrchestrationRuntime` topology and coordination services;
- the blocked scenario crosses a real restart boundary for both runtimes. Each phase closes its SQLite connection and reconstructs the runtime-specific worker or runtime against the same authority database before the released blocker resumes the repair. On Temporal, worker A is awaited through `STOPPED` before composition B and worker B are created on the same task queue.

Scope and remaining work:

- this stage deliberately excludes runtime-conflict parity. ADR-027 defers cross-runtime conflict behavior to the later Stage 22/22R suite;
- deterministic seams do not claim to replace real Git, external agent session, or model-provider integration coverage. Those side effects remain covered by their dedicated integration tests;
- M3.6 is closed and frozen for the two ADR-027 migration scenarios. M3.3 through M3.6 authority semantics must change only when a real contract regression is found.

## Stage M3.7: Provider-neutral Forge runtime composition

M3.7 extracts the production Forge activity composition from the Temporal worker application without changing the selected durable runtime or any Forge authority rule. ADR-028 still selects Temporal. The purpose of this stage is to make the SQLite-backed Forge service stack reusable by a future provider adapter, rather than duplicating it inside another worker or treating the older Restate spike as production evidence.

What was built:

- `forge-runtime-contracts` now owns the compact Forge run, activity, repair-wake, and activity-port contracts. These contracts contain only serializable identifiers and results; they do not expose Temporal, Restate, persistence-provider, compiler, or domain implementation objects;
- `forge-runtime-composition` now owns the former production Temporal worker composition: SQLite recovery, write-guard hydration, ACTIVE-only claims, builder/evaluation/repair/integration services, cancellation reconciliation, exact blocked-repair continuation, and run progression/finalization;
- the shared composition has no Temporal SDK import. A provider may optionally supply an activity execution context containing a cancellation signal. Absence of that signal does not create authority or bypass any durable validation;
- the shared composition owns a neutral default authority-store location, `dist/forge-runtime.sqlite`. A provider can still select a different store through the existing persistence override or `FORGE_WORKER_DATABASE_PATH` configuration;
- the Temporal worker is now a small compatibility adapter. It supplies `Context.current().cancellationSignal` when an activity runs under Temporal and safely supplies no signal to direct composition tests;
- existing Temporal contract exports remain available through the Temporal package as a deliberate compatibility boundary, while their implementation is provided by the neutral contracts library;
- `SandboxedPackageScriptVerifier` is exported from the existing `run-preparation` public boundary so the extracted composition does not reach into another package's source tree.

What was verified:

- the extracted composition type-checks together with the contracts library, Temporal runtime, and Temporal worker;
- the existing production composition tests still pass, including durable recovery, cancellation, integration-claim, and blocked-repair authority coverage;
- the real Temporal workflow topology tests still pass, proving the workflow bundle can consume the relocated compact contracts;
- the new composition library has no dependency on `@temporalio/*` or the Temporal runtime package.

Scope and remaining work:

- this is an extraction only. It does not add a Restate production runtime, Restate worker, or Restate parity claim;
- the synthetic `restate-spike` and its authority fixture remain historical candidate evidence, not a production Forge execution path;
- a future provider adapter must reuse the neutral contracts and composition, then independently prove production-stack parity and any required split service/executor restart behavior;
- M3.3 through M3.6 remain frozen. M3.7 preserves their durable authority semantics and changes only code ownership and provider boundaries.

## Stage M3.8: Restate provider coordination adapter

M3.8 adds an isolated Restate runtime adapter that consumes the provider-neutral `ForgeActivities` port from M3.7. It does not change ADR-028: Temporal remains the selected durable-execution substrate. The new adapter proves that a second provider can journal Forge coordination while keeping authority decisions inside the compact activity port and its eventual SQLite-backed composition.

What was built:

- `restate-runtime` owns every Restate SDK import for this adapter and exports `createRestateForgeRunService`;
- its Forge run workflow mirrors the selected provider's compact control flow: scheduler reevaluation, builder execution, output evaluation, repair admission and execution, accepted-output integration, and final run state;
- a blocked repair is correlated by its exact repair attempt ID. A wake first reaches `resumeBlockedRepair`; only a durable `resumed` result can execute that repair again;
- Restate durable promises are one-shot, so the adapter arms a durable wake generation before execution can report `BLOCKED` and arms its successor before each resume authorization. The current repair remains armed throughout resumed execution, so the same repair can durably block, resume, and block again without losing its next matching wake. Wakes remain hints, never authority;
- the new runtime does not import the historical `restate-spike` or its synthetic scenario services.

What was verified:

- a live `RestateTestEnvironment` test runs the new service against a scripted compact activity port;
- a wrong repair ID produces no resume attempt;
- a single matching wake received after Forge reaches `BLOCKED` but before the activity response returns is buffered and reauthorized;
- a single next wake received while Forge is deciding that the preceding resume is `ignored` is buffered for the armed successor generation;
- a single matching wake received while a successfully resumed repair executes again is preserved if that repair returns to `BLOCKED`, then reauthorized against the same repair ID;
- a later matching wake with a `resumed` result executes the same repair ID, integrates its accepted output, reevaluates, and finalizes the run;
- the adapter type-checks, lints, formats, and participates in the workspace build and test configuration.

Scope and remaining work:

- M3.8 proves provider coordination only. It does not add a Restate worker application, wire the real Forge runtime composition to Restate, or claim production SQLite authority parity with Temporal or legacy execution;
- `RestateTestEnvironment` bundles the Restate server and service endpoint. Its successful wait/wake test is not evidence that an independently replaced executor resumes a pending workflow;
- a later production parity stage must use the shared composition, isolated authority stores, normalized durable outcomes, and a split server/service-process restart fixture before making those stronger claims;
- M3.3 through M3.7 remain frozen. M3.8 is additive and changes no established Forge authority semantics.

## Stage M3.9: Full Stage 22/22R authority differential parity

M3.9 completes the production-facing legacy-versus-Temporal V2 authority comparison. The tests run
the real legacy `OrchestrationRuntime` and the real Temporal workflow plus production Forge
composition against isolated SQLite databases, run IDs, workspaces, and repository targets. Git,
agent, review-model, verifier, snapshot, and reconciliation effects are deterministic adapter seams;
they do not replace the production builder, evaluation, repair, integration, progression, or
persistence services.

What was built:

- runtime scope expansion is now a provider-neutral conflict calculation. A builder or repair that
  observes a write outside its predicted lease scope persists a hard conflict in the same durable
  scheduler reevaluation that activates it. The conflict affects replay and all later scheduling;
- a two-task scope scenario proves that a project-level predicted lease conflicts with an observed
  `core:expanded.ts` write. Task B is not authorized until task A is durably completed;
- the suite proves two repair iterations from immutable review recommendations `repair`, `repair`,
  `accept`, including final evidence, accepted review, and integration identity bound to repair two;
- repair-budget exhaustion preserves two completed repairs and the third review/evidence, rejects
  further admission without integration, and is non-retryable in Temporal because it is a durable
  validation decision rather than transient work;
- post-session builder and repair failures persist `UNKNOWN` with session evidence and fail closed.
  Temporal executes those agent activities at most once, retains unresolved authority, and matches
  the legacy run-state boundaries instead of retrying an unsafe, state-invalid activity;
- blocked accepted-output integration is an additive provider-neutral continuation. Its exact
  identity is the run, task, workspace, and accepted output subject. A continuation revalidates
  reviewed workspace content, fences Git work through the existing integration claim, calls only
  `resumeIntegration`, and never reruns builder, repair, verification, review, or commit;
- Temporal has a separate exact integration wake signal. Wakes are hints only: wrong and stale
  targets are ignored, repeated blocks remain waiting, and a fresh worker can resume the existing
  workflow against the same authority database. Legacy performs the equivalent retry only through
  explicit `recoverAndResumeRun` recovery;
- dependency progression is compared through canonical scheduler start authority: task B is
  authorized only after task A has a durable integrated completion in the input snapshot;
- a scheduler authorization snapshot now starts independent builders concurrently in stable order.
  Ordinary same-run lease contention leaves the original builder attempt `PREPARING`, rolls back
  partial leases, persists `lease-blocked`, and does not start an agent. Exact lease release
  reauthorizes the same attempt ID, after which it can complete;
- the compact builder result is a completed-or-blocked union. It prevents a blocked builder from
  entering evaluation, repair, or integration. Scheduler dispatch reuses a matching existing
  `PREPARING` attempt rather than creating a duplicate after unblock;
- one composition now retains one hydrated write guard per run for its whole lifetime. Concurrent
  builder activities share that guard instead of replacing it during refresh, so same-run lease
  acquisition has one effective authority view. Before a durable continuation uses that stable
  identity, current SQLite lease records reconcile into the same serialized guard object. This
  makes later `RELEASED` or `STALE` transitions visible without replacing the guard. Hydration also
  retains released lease history as well as active leases; released leases do not block work, but
  their retained identifiers and versions prevent a rebuilt activity from reusing an older lease ID
  and failing SQLite version checks;
- builder mutation authority now atomically persists the complete acquired lease plan with the
  `PREPARING -> STARTING` ACTIVE-run claim. Workspace creation begins only after that claim wins.
  A cancellation that wins first therefore leaves the attempt PREPARING, creates no workspace, and
  persists no active lease; a failed claim rolls the in-memory acquisition back before it can leave
  durable lease evidence;
- the run-level integration summary now updates its latest status. Per-task authority remains in
  integration claims, workspace records, accepted review subjects, attempts, leases, and scheduler
  history.

What was verified:

- real legacy and Temporal differential scenarios cover normal repair/integration, blocked repair
  restart and exact lease resume, runtime scope expansion, repeated repairs, budget exhaustion,
  builder and repair `UNKNOWN`, blocked integration including wrong wake, repeat block, and worker
  restart, dependency progression, and same-run concurrent competing builders;
- scope conflicts have equal durable task-pair, constraint, resource, severity, effective sequence,
  and replay behavior. The comparison deliberately ignores framework-specific event names;
- concurrent builder waves start all tasks in the durable authorization snapshot before either
  completes. A lease-blocked builder has no STARTING lifecycle claim or agent session, bypasses all
  downstream work, and later runs under its original attempt identity after the exact blocker
  releases;
- adversarial tests force two same-run builders to hydrate concurrently before either acquires a
  lease, proving that one shared guard blocks the second builder. Separate service and SQLite tests
  prove a cancellation-lost start claim creates neither a workspace nor an active lease. A real
  repair continuation test hydrates the stable guard while its blocker is ACTIVE, releases that
  blocker through another SQLite connection, then proves the resumed repair acquires its formerly
  conflicting resource rather than re-blocking on stale guard state;
- blocked integration restart proves worker A reaches `STOPPED` before worker B recreates the
  composition on the same SQLite database and task queue. The matching legacy scenario recreates
  its runtime and persistence before recovery;
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass. The full suite reports 71 test
  files, 703 passing tests, and 1 skipped test. The cancellation workflow test was also rerun in
  isolation after one transient full-suite timeout, then the complete suite passed. Expected Temporal test-server warnings and intentional
  failure-path activity logs do not indicate failed tests.

Scope and remaining work:

- M3.9 closes the requested Stage 22/22R parity for isolated, same-run Forge authority scenarios:
  runtime conflict, multi-task dependency progression, repeated repair and budget, fail-closed
  UNKNOWN, blocked integration recovery, and concurrent competing lease behavior;
- same-run is an intentional boundary. The current SQLite-backed write guard is reconstructed from
  one run's leases and has no repository-wide active-lease recovery query. Therefore this stage does
  not claim cross-run competing-lease or horizontally distributed SQLite-worker parity;
- this stage does not use real Git/model-provider side effects, alter ADR-028's Temporal selection,
  or change frozen M3.3 through M3.8 authority semantics. Cross-run locking or distributed-worker
  support requires a later provider-neutral global lease authority design, not a workflow shortcut;
- M3.9 is closed and frozen for the verified same-run Stage 22/22R boundary. Later work can proceed
  to the selected Temporal production cutover, observability/read models, production end-to-end
  hardening, API/UI, advisory memory, and PostgreSQL only when scaling requires it.

## Stage M3.10: Temporal launch bridge

M3.10 begins the selected Temporal production cutover without moving Forge authority into Temporal.
The CLI now prepares and validates the approved run as before, but it no longer constructs a
`LocalRuntimeStarter` to execute the run in-process. Instead, `TemporalRunLauncher` persists the
run, bindings, conflicts, schedule, and initial `run-started` authority decision in the configured
SQLite store before asking Temporal to start `forgeRunWorkflow` with the compact run ID. Its initial
dispatch uses immutable run-derived evidence, so a retry or concurrent launcher can only persist the
same sequence-one `run-started` decision and PREPARING attempt IDs. Once sequence one is durably
recorded, later launches do not reevaluate Forge scheduling even after that attempt has advanced;
they only ask Temporal to reuse the workflow. The progression service checks sequence one again
from fresh authority, and the dispatch write boundary makes a stale sequence-one write a no-op, so
a launcher holding an empty snapshot cannot create sequence two after another launcher initializes
the run. That no-op is limited to the dedicated initial-dispatch persistence boundary; generic
progression dispatches still persist every returned authorization. Initial history is also rejected
unless every sequence-one `start` decision has durable attempt evidence whose immutable agent,
workspace, lease, command-policy, and trusted-path authority matches its task binding. The initial
dispatch transaction performs the same evidence check before treating an equivalent existing
sequence one as a no-op.

The Temporal client uses the stable workflow identity `forge-run:<runId>` and the Temporal
`USE_EXISTING` conflict policy. Repeating a matching launch reuses the same durable Forge request
and workflow identity. A reused run ID with changed authority, bindings, tasks, conflicts, or
schedule fails closed before Temporal is contacted.

This first deployment boundary intentionally supports one explicitly configured authority scope.
Both `forge run` and the independent worker require nonempty absolute
`FORGE_WORKER_DATABASE_PATH` and `FORGE_WORKER_REPOSITORY_PATH`; the CLI also rejects a repository
path outside the worker scope.
The CLI is a Temporal client only and does not start a worker. The worker remains an independently
operated process which reads the same configured SQLite authority store.

Verification:

- launch tests prove first initialization, crash recovery before initial dispatch, concurrent exact
  retry evidence, authority-neutral relaunch after the initial attempt starts and after a gated
  stale empty-history read, stable workflow identity, and authority mismatch rejection;
- CLI command tests and Temporal client tests pass;
- a launch acceptance test initializes authority through `TemporalRunLauncher`, starts a workflow
  through production `startForgeRun`, and completes it on an independently instantiated worker using
  a separate SQLite connection to the same temporary authority file and production Forge composition;
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass. The full suite reports 72 test
  files, 707 passing tests, and 1 skipped test.

Scope and remaining work:

- M3.10 does not remove the legacy runtime, introduce dynamic per-run worker routing, or claim a
  multi-host worker fleet;
- this boundary does not change frozen M3.3 through M3.9 scheduler, lease, cancellation, review,
  repair, or integration authority semantics;
- this test environment proves the launch/worker authority boundary, not a separately deployed
  worker process, real external provider effects, or operational production readiness.

M3.10 is **PASS / CLOSED / FROZEN** following independent review. Changes to this launch authority
boundary now require a demonstrated contract regression or a new, separately designed stage.

## Stage M3.11: Temporal production deployment and process boundary

M3.11 proves the deployment boundary that M3.10 deliberately left open. A runnable worker bundle is
now produced alongside the CLI bundle, so `node apps/cli/dist/main.js` and
`node apps/temporal-worker/dist/main.js` can run as independent processes. The CLI remains only a
Temporal client: it persists launch authority in the configured SQLite file and starts the workflow;
it does not construct a worker or runtime composition.

Operational commands now use the explicit `FORGE_WORKER_DATABASE_PATH` when it is supplied, rather
than silently opening a per-run database beneath `--run-directory`. The legacy per-run location
remains the fallback only when no deployment authority path is configured. A configured path must be
nonempty and absolute. This lets `forge status`, `forge cancel`, and cancellation settlement read
and mutate the same durable authority observed by an independently deployed worker.

The worker app preserves the real Pi, Git, and Docker composition as its default. It has a narrowly
scoped `FORGE_WORKER_COMPOSITION=acceptance` app-boundary mode for the hermetic process test only;
it supplies deterministic builder, reviewer, and verifier adapters without moving deployment policy
into the provider-neutral composition library. Unknown modes fail closed. The test starts a local
Temporal server with a child-reachable random address, then launches the compiled CLI and worker as
separate Node processes with one absolute SQLite authority path, one repository scope, and one unique
task queue.

Worker restart recovery is exercised after the builder has durably completed and evaluation is
paused. The retry-safe evaluation activity has a five-second heartbeat timeout, and the acceptance
reviewer heartbeats while paused. On worker death, a replacement worker receives the retried activity.
Verification evidence is reused when its immutable builder attempt, workspace snapshot, and policy
identity already match, so a crash after evidence persistence cannot fail the retry by generating new
random evidence. The exact iteration-one review subject and review are also recovered before calling
the reviewer again, so a lost activity response after review persistence does not repeat a
nondeterministic model call or conflict with durable review authority. Builder and repair activities
retain their one-attempt boundary because they may perform non-idempotent external work.

Verification:

- compiled-process acceptance starts a real local Temporal server, compiled CLI subprocess, and
  separately spawned compiled worker subprocess; normal execution reaches durable SQLite
  `COMPLETED` state with one initial authority event and one builder attempt;
- the restart acceptance kills worker A during a heartbeat-protected evaluation, starts worker B with
  the same server, queue, repository, and SQLite file, and proves completion without a second initial
  event, builder attempt, workspace, or reviewer call after a persisted-review lost response;
- cancellation is issued by a new compiled CLI process after the original launch process and worker A
  are gone, survives worker restart, and reaches durable `CANCELLED` state;
- status reads the configured authority SQLite file even when `--run-directory` names a different
  empty location; CLI and compiled-worker tests reject relative authority database paths;
- `pnpm build`, targeted CLI/runtime tests, and the compiled-process acceptance pass;
- `pnpm test` runs non-worker projects first, then runs the legacy differential, composition, and
  compiled-process worker specs in separate serialized Vitest processes. This avoids local Temporal
  resource contention while retaining parallelism elsewhere; the final suite has 73 test files, 713
  passing tests, and 1 skipped test.

Scope and remaining work:

- M3.11 proves a local Temporal server and SQLite-backed single authority scope, not a multi-host
  fleet or PostgreSQL deployment;
- the default executable still uses real provider adapters, but live Pi/Claude/Git/Docker smoke is an
  opt-in external integration concern for M3.12 rather than default test-suite behavior;
- this stage does not redesign frozen scheduling, lease, repair, review, integration, or M3.10 launch
  authority contracts.

M3.11 is **PASS / CLOSED / FROZEN** following independent review. Changes to this process-boundary
deployment contract now require a demonstrated regression or a new, separately designed stage.

## M3.12: External-Effect Smoke Harness

M3.12 begins with a deliberately opt-in runner for a real external-effect smoke. It is not part of
the default test suite and does not call a provider unless an operator explicitly sets all of:

- `FORGE_M312_EXTERNAL_SMOKE=1` to authorize this particular external smoke execution;
- `FORGE_M312_CREDENTIALS_CONFIRMED=1` to attest that provider-owned credentials are configured;
- `FORGE_M312_CODING_AGENT_CONFIRMED=1` to attest that the real coding agent is authorized;
- `DEEPSEEK_API_KEY`, plus `FORGE_M312_REVIEW_PROVIDER=deepseek` and
  `FORGE_M312_REVIEW_MODEL=deepseek-flash`, the explicitly approved identity for the current
  closure run.

The runner fails before creating a Temporal server, worker, Git fixture, Docker container, or model
session when any of those values is absent, blank, differs from the approved identity, or cannot be
resolved by Pi's local model registry. The same resolved Pi model and durable review policy are supplied explicitly to planning, semantic review,
builder coding, repair coding, and task code review; no smoke role may fall back to Pi's implicit
default model. Builder and repair runners share one provider-neutral gateway override, so a
nondeterministic repair recommendation cannot select an implicit model. It always creates a disposable temporary Git
repository rather than targeting this orchestrator repository. When explicitly authorized, it runs
the production path: compiled `forge plan` with semantic review, approval, compiled `forge run`, a
separately spawned compiled worker, real Pi coding and review adapters, a real Docker verifier, Git
integration, and a durable Temporal/SQLite completion check. The harness compares the fixture base
commit with the integrated checkout `HEAD`, requires exactly `src/index.ts` in that range, exact file
contents, and a clean integrated working tree. `pnpm smoke:m3.12` builds the runnable artifacts then
invokes this guarded runner;
`FORGE_M312_KEEP_FIXTURE=1` retains the disposable fixture for operator diagnosis.

Verification so far:

- unit tests prove missing authorization, credential attestation, coding-agent attestation, DeepSeek
  credential, provider, blank model, or any other unapproved model configuration
  fails closed;
- a composition regression forces a `repair` recommendation and proves that the same injected coding
  gateway serves both the builder and repair sessions; Pi gateway tests separately prove the explicit
  resolved model reaches each session factory;
- the compiled runner itself was invoked without authorization and stopped with
  `M3.12 external smoke requires FORGE_M312_EXTERNAL_SMOKE=1`, before any external provider or Docker
  operation;
- an authorized real smoke completed with `deepseek/deepseek-flash`: compiled CLI and independently
  spawned worker completed through local Temporal, configured SQLite authority, real Pi adapters, Docker
  verification, and Git integration; the harness recorded `COMPLETED` with that exact identity.

M3.12 is **PASS / CLOSED / FROZEN** following independent review. The recorded run used the exact,
operator-confirmed `deepseek/deepseek-flash` identity. Its `DEEPSEEK_API_KEY` was injected only into the
smoke subprocess and is not stored in repository evidence. The successful result recorded the exact
provider/model and `COMPLETED` outcome. This does not alter frozen M3.10 or M3.11 runtime contracts.
Changes to this external-effect boundary now require a demonstrated regression or a separately designed
stage.

## M3.13: Observability and Provider-Neutral Read Model

M3.13 adds an operator-facing read boundary without changing scheduling, execution, or provider behavior.
`ForgeReadModel` lives in orchestration runtime and reads only provider-neutral durable authority records:
the persisted run, task transitions, builder attempts, repair attempts, verification evidence, and code
reviews. It produces `ForgeRunReadModel`, task and attempt summaries, current blocking reason,
verification/review references, durable lease summaries, and an ordered durable timeline.

Repair lineage is preserved from durable records rather than inferred from review iteration. A repair
attempt, its verification evidence, and its follow-up review correlate both the original builder
`attemptId` and the repair `repairAttemptId`. Lease resources are structural, discriminated summaries
that preserve symbol ancestry, and runtime blocking reasons retain lease and runtime-conflict references
for an API or UI to render without reconstructing scheduler history.

Every read-model record has a provider-neutral correlation object. It carries durable identifiers where
they exist: `runId`, `taskId`, `attemptId`, `repairAttemptId`, and `workspaceId`. The CLI adds the stable
string workflow correlation `forge-run:<runId>` and operation labels such as `execute-builder`,
`execute-repair`, `evaluate-output`, and `reevaluate-run`. The read model never imports Temporal types,
so the same summaries remain usable by a future API or UI without coupling that boundary to a workflow
SDK.

`forge status` now opens the configured SQLite authority store and delegates projection to
`ForgeReadModel`; it no longer assembles a second, CLI-specific interpretation of durable state. This
keeps `status` aligned with the same explicit authority database that production launch, worker, and
cancel use. A focused regression covers a blocked task with builder and repair lineage, verification,
review, lease, timeline, and all required correlations. The regression includes repair verification
evidence and an iteration-two repair review, preventing repair evidence from being misreported as a
builder-only attempt.

M3.14 preparation is deliberately non-destructive. `docs/runtime-v2-cutover-preparation.en.md` and its
Chinese counterpart inventory the retained legacy differential runtime and frozen prototype packages,
state the current production route, list cutover assertions, and provide a deletion order. They explicitly
prohibit deletion of the final legacy runtime or a Runtime V2 completion claim until M3.12 records a
successful authorized external-effect smoke.

Verification:

- focused read-model and CLI status tests validate the projection and JSON surface;
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass;
- `pnpm test` passes 74 files with 720 passing and 1 skipped tests, including the separately invoked
  Temporal worker phases;
- `pnpm check` still stops at the pre-existing formatting issues outside this stage and is reported
  separately rather than silently modifying inherited files.

M3.13 is **PASS / CLOSED / FROZEN** following independent review. Changes to this durable read-model
contract now require a demonstrated regression or a new, separately designed stage. M3.12 is now
PASS/CLOSED/FROZEN after its independent review; no destructive M3.14 cutover work was performed.

## M3.14: Non-Destructive Cutover Readiness

M3.14 converts the remaining Runtime V2 migration inventory from descriptive documentation into a
machine-checkable cutover gate. `docs/runtime-v2-destructive-cutover-manifest.json` classifies retained
legacy runtime, differential tests, frozen prototype packages, test-only spike support, and reusable
application services. It also records their callers, whether they are deletion candidates after M3.12,
and the final assertions a destructive stage must satisfy. Reusable orchestration services, including
`ForgeRunProgressionService` and `ForgeReadModel`, are explicitly kept rather than being conflated with
the legacy in-process `OrchestrationRuntime`.

`apps/cli/src/runtime-v2-cutover-readiness.spec.ts` makes the intended production boundary executable:
the compiled CLI has no legacy runtime, `LocalRuntimeStarter`, worker-composition, or stale spike
dependency; production package roots isolate reusable services from explicit `/legacy` entrypoints;
`forge run` uses `TemporalRunLauncher` and `startForgeRun`; and the independently deployable worker
alone composes Temporal activities. The same test requires the manifest to stay non-destructive and
retain the full inventory and nine final cutover assertions.

The cutover preparation documents now explain the manifest, direct callers, deletion order, and the
strict gate. M3.14 performs no deletion and introduces no alternate runtime path.

Verification:

- the cutover-readiness architecture regression and CLI command tests pass;
- `pnpm lint`, `pnpm typecheck`, and `pnpm build` pass;
- the non-worker `pnpm test` phase passes 72 files with 692 passing and 1 skipped tests, but the frozen
  M3.9 same-run competing-lease differential times out in the Temporal worker phase and in an isolated
  rerun, so the full suite is not currently green;
- `pnpm check` still stops at pre-existing formatting issues outside this stage and is reported without
  modifying inherited files.

M3.14 is **CUTOVER READY / M3.12 PASS-CLOSED-FROZEN / AWAITING DESTRUCTIVE-STAGE REVIEW**. Production roots
are explicitly isolated from `/legacy` entrypoints. The successful M3.12 smoke satisfies that prerequisite,
but no destructive cutover, legacy deletion, or Runtime V2 completion claim is permitted without a
separately designed and reviewed destructive stage. That stage must also make normal worker review-policy
selection explicit deployment configuration and prove that it matches the CLI durable authority policy;
the current smoke-only DeepSeek override does not satisfy that normal-production assertion.

## M3.14 Sequence B: Destructive Runtime V2 Cutover

Sequence B removes the retired in-process `OrchestrationRuntime`, `LocalRuntimeStarter`, their legacy
entrypoints and tests, the legacy-versus-Temporal differential suite, and all frozen Temporal/Restate
spike packages and harnesses. Package exports, workspace references, build and test scripts, Vitest
coverage exclusions, and the pnpm lockfile no longer retain those assets. Reusable production services
remain in `libs/orchestration-runtime`, and the only production execution route remains the CLI launcher,
Temporal workflow, and independently deployed worker.

The retained production tests protect exact, mismatched, and repeated blocked-integration wakes. A local
Temporal server test waits for worker A to reach STOPPED before starting worker B and attributes the exact
wake's resume activity to B; a separate composition test
closes one connection to a temporary SQLite authority database and reopens it for worker B, proving that a
wrong wake leaves integration blocked and the exact wake integrates once even if repeated. A bounded repair
test retains two completed repairs, three review and verification records, no integration claim, and no
`workspace-integrated` event after the third recommendation exhausts the budget. Core repair-execution
tests retain post-start `UNKNOWN` authority behavior; a full Temporal repair-UNKNOWN nonterminal scenario
is not independently asserted here. The cutover manifest and its regression assert that the retired paths
are absent while preserving the recorded M3.12 external-smoke evidence.

Normal production review authority is now explicit rather than a composition default. CLI `plan`, `bind`,
and `run` canonicalize and resolve their required provider/model before authority persistence. The worker
requires `FORGE_WORKER_REVIEW_PROVIDER` and `FORGE_WORKER_REVIEW_MODEL`, resolves the same canonical policy before it
polls Temporal, and checks durable run policy before mutation entrypoints including blocked-repair resumption
and scheduler reevaluation. A worker with the wrong policy cannot resume a BLOCKED repair or persist its
resume dispatch. The neutral composition
receives explicit paths, policy, and application-owned adapter factories without reading deployment
environment or selecting a provider/model itself.

Before independent review, M3.14 Sequence C was **IMPLEMENTED / M3.12 PASS-CLOSED-FROZEN / AWAITING INDEPENDENT REVIEW**. The worker,
not the neutral composition library, assembles Pi coding/review adapters from the resolved normal deployment
identity. It does not remove M3.12 evidence or alter the production Temporal route.

Independent review of `ba640de` confirmed the final worker-replacement proof and the accuracy of the
manifest's evidence record, with no remaining P0 or P1 findings. M3.14 is now **PASS / CLOSED / FROZEN**;
the Runtime V2 migration is **COMPLETE**, and M3 is **COMPLETE / FROZEN**. The manifest records the
destructive cutover as executed and independently reviewed, while retaining the successful M3.12 real
external-effect smoke. The production route and the surviving application services described above remain
the ongoing architecture; the closure record does not authorize further deletion.

## M4.1A: PostgreSQL Durable Authority Contract Audit

M4 begins on `m4/postgres-durable-authority` from frozen M3 commit `e585640`. This first step does not
replace SQLite or expand run authority. It compares the SQLite reference adapter with the existing
`postgres-persistence` package and records the actual gap in
`docs/m4-postgres-durable-authority-parity.en.md` (with a synchronized Chinese edition).

The PostgreSQL package currently validates configuration and opens a closeable candidate client; it
has no Forge tables, migrations, or `OrchestrationPersistence` implementation. A shared contract in
`libs/persistence/src/lib/durable-authority.contract.test.ts` now exercises the SQLite adapter using
two independent connections to one temporary file. It covers exact run authority and task bindings,
initial dispatch retries, competing builder claims, repair admission/budget and resume-dispatch CAS,
immutable review/verification, workspace/impact recovery, integration cancellation settlement, and
terminalization. The PostgreSQL test imports the **same** suite but is explicitly skipped until a real
PostgreSQL adapter and database fixture exist; no parity is claimed from the skip. M4.1A identifies
additional SQLite contracts to promote later, and defers cross-run write fencing to M4.2 and multi-run
acceptance to M4.3.

M4.1A is **AUDITED / SQLITE CONTRACT EXECUTABLE / POSTGRESQL PARITY BLOCKED**. This is a new M4 stage;
M3 remains COMPLETE / FROZEN. The shared contract passed all 8 SQLite cases; its PostgreSQL
instantiation reports 8 skipped cases and 1 pending fixture check rather than claiming parity.
The complete `pnpm test` run passed (63 non-worker test files, 605 passed, 8 skipped, 1 pending;
plus 3 worker test files with 22 passed). `pnpm lint`, `pnpm typecheck`, `pnpm build`, scoped formatting,
and diff checks passed. `pnpm check` stopped at repository-wide formatting in three unchanged files:
`libs/agent-runtime/src/lib/pi-agent-runner.spec.ts`, `libs/domain/src/lib/task-repair-attempt.ts`,
and `libs/orchestration-runtime/src/lib/repair-execution-coordinator.spec.ts`.

After independent review of `4cef6a4`, the shared suite also requires an atomic repair-start
PREPARING-to-STARTING claim: two SQLite connections observe exactly one revision-CAS winner, without
extra attempt or work-item evidence. A separate contract checks that once cancellation has durable
authority, builder, repair, and integration claims all reject without new mutation evidence. The
parity audit records the missing PostgreSQL transaction/CAS boundary for **all three** claims versus
`requestCancellation()`, and the incomplete `PostgresEvidenceStore` candidate type. Synchronous
SQLite `Promise.all` checks observable outcomes, not overlapping transactions; real PostgreSQL
parity requires controlled overlap and a deterministic loser. SQLite now passes 10 shared cases;
PostgreSQL reports 10 skipped cases and 1 pending fixture check. M4.1A remains pending review of
this remediation; no PostgreSQL implementation or M3 semantic change was introduced.

The next review identified one remaining side-effect gap in the cancellation-first contract. The
builder claim now includes a real proposed lease, and the shared suite checks that cancellation
rejects the claim without persisting that lease or advancing the PREPARING builder; the recovered run
must remain CANCEL_REQUESTED. SQLite passes all 10 shared cases; PostgreSQL still skips all 10 with
one pending fixture. M4.1A remains awaiting independent review of this final contract correction.

Independent review of `348f823` confirmed that the nonempty-lease cancellation-first case closes
the remaining P1, with no P0/P1 findings. **M4.1A Durable Persistence Contract Audit is PASS / CLOSED.**
The SQLite reference passes 10/10 shared contracts; PostgreSQL remains **NOT IMPLEMENTED / NOT
VERIFIED** (10 skipped, 1 pending fixture requirement). The common contract is the acceptance
baseline for M4.1B's real PostgreSQL adapter and database fixture, including controlled overlapping
transactions. M4.1 as a whole and PostgreSQL parity are not closed; frozen M3 behavior is unchanged.

## M4.1B: Real PostgreSQL Durable Authority Adapter

M4.1B adds `PostgresOrchestrationPersistence` in `libs/postgres-persistence` without changing the
frozen SQLite runtime. The adapter checks the selected PostgreSQL role/schema, stores run and keyed
evidence, and locks a run row inside each write transaction. Cancellation, builder/repair revision
claims, integration claims, repair budgets/resumes, and initial dispatch therefore share one
same-run serialization boundary. A consistent read-only snapshot reconstructs the run for the
provider-neutral ForgeReadModel.

The fixture starts an isolated local PostgreSQL server with a fresh schema per test. Two independent
connections now execute the **same 10 shared contracts** as SQLite. Five additional PostgreSQL-only
tests exercise invalid schema/role/corrupted run, missing initial evidence, and replay after reopen; they use
`pg_blocking_pids` to prove actual overlap for competing builder claims and cancellation versus
builder/repair/integration claims. The historical skipped-suite count above records M4.1A's audit
baseline, not the new adapter. CLI and worker still use SQLite; M4.2/M4.3 remain separate.

M4.1B is **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**. Its real PostgreSQL cases pass, but no
PostgreSQL production route is enabled. The bilingual parity audit describes remaining schema,
migration, and broader evidence/recovery review items. M3 remains COMPLETE / FROZEN.

Review remediation extends the single shared suite to **16 contracts per backend**. SQLite and a
real PostgreSQL fixture now reject malformed reevaluations and identity-mismatched evidence, plus
missing or corrupted task bindings and invalid verification fingerprints. Both backends prove exact
UNKNOWN builder/repair cancellation settlement without releasing unrelated leases. A PostgreSQL
reopen test recovers the full provider-neutral Forge read model, including repair lineage, blockers,
and timeline. The focused parity run passes **38 tests** (32 shared and six PostgreSQL-only), and
the full repository test run, lint, typecheck, and build pass. The production CLI/worker remain on
SQLite. Versioned migrations, schema compatibility checks, and a separate least-privileged runtime
role without startup DDL are **required before** a PostgreSQL production route; a single-call
`recoverRun` snapshot does not make all read-model recovery calls atomic. M4.1B remains
**IMPLEMENTED / AWAITING INDEPENDENT REVIEW**, not closed.

Independent review of `a6c1884` found no P0/P1 and confirmed the shared corruption and UNKNOWN
settlement contracts, real overlapping PostgreSQL transaction tests, and fresh-connection
`ForgeReadModel` recovery. **M4.1B is PASS / CLOSED**, alongside the already closed M4.1A audit.
This closes the adapter-and-fixture stage, not M4.1 overall: the PostgreSQL production route is
**NOT READY / NOT ENABLED**, and CLI/worker remain SQLite-backed. Before any production selection,
M4.1C must introduce versioned migrations, a fail-closed schema compatibility gate, separate
migration-owner and least-privileged runtime roles without startup DDL, and real upgrade and
privilege acceptance. The read model's separate recovery calls still do not share an atomic snapshot.

## M4.1C: PostgreSQL Operational Schema and Runtime Roles

The PostgreSQL adapter now opens only a previously installed, compatible authority schema. A
separate migration-owner API installs version 1 (run and evidence tables) and version 2 (lookup
index), records checksums in a migration ledger, and applies upgrades transactionally under a
schema-specific advisory lock. Repeat installation is safe; unsupported versions, tampering,
unmanaged tables, wrong ownership, and downgrade requests fail closed. The migration role grants a
distinct runtime role only schema usage, ledger read access, and necessary data-table permissions.
Normal `PostgresOrchestrationPersistence.connect()` executes no DDL and rejects insufficient or
excessive effective privileges, missing objects, altered column or primary/foreign-key definitions,
an incompatible index definition, or an incompatible migration ledger before
serving authority operations.

The local PostgreSQL acceptance fixture now provisions those two roles and installs a fresh
schema per test. Its independent restricted runtime connections pass the **16 shared SQLite/PG
contracts** plus PostgreSQL-specific overlap, recovery, and schema-lifecycle cases: **29 PostgreSQL
tests passed** in the focused suite. Real-database tests also cover v1-to-v2 upgrade with preserved
data, repeat and downgrade, missing/future/tampered ledger, denied schema/table/temporary DDL and
ledger writes, revoked runtime permission, missing index, changed column nullability, dropped
primary key, and an incorrectly redefined same-named index. This makes schema operation
reviewable without enabling PostgreSQL in the CLI or worker. M4.1C is **IMPLEMENTED / AWAITING
INDEPENDENT REVIEW**; M4.1 remains **OPEN** and production routing is deferred to M4.1D. M3
remains COMPLETE / FROZEN; M4.2/M4.3 cross-run capabilities are not part of this stage.

Independent review identified three additional M4.1C startup and migration controls. The
installer now reconciles exact runtime table privileges (ledger read-only, runs read/insert/update,
records read/insert/update/delete) and the runtime gate rejects excess grants. Schema checks now
also distinguish permanent ordinary tables from unlogged or partitioned relations, reject RLS,
unexpected triggers/rules, and a changed ledger timestamp default. Unsupported migration target
versions fail before schema creation. Real PostgreSQL regression tests cover excess-grant repair,
each structural alteration, and unsupported targets; **39 PostgreSQL-specific tests pass**. This
is a review candidate, not M4.1C closure or PostgreSQL production enablement.

The remaining review finding concerned effective PostgreSQL privileges: a table-level check can
miss column-only writes to the migration ledger and delegated permissions. M4.1C startup now
rejects forbidden column grants, grant options on permitted schema/table/column operations, and
any other role membership that could be activated with `SET ROLE`. Direct extra grants are
removed by migration reruns; role membership requires credential administration. PostgreSQL
server support is explicitly limited to versions 14–16 so the PostgreSQL 17 `MAINTAIN` privilege
cannot bypass an unextended gate. Real PG14 tests demonstrate the column-only ledger write,
fail-closed startup, migration cleanup, other column and grant-option excess, and role-membership
rejection. **50 PostgreSQL-specific cases pass**, including 16 shared SQLite/PG contracts. M4.1C
remains **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**; production CLI/worker routing stays on
SQLite and M4.1D has not begun.

The next independent review found that checking only `current_user` did not prove the PostgreSQL
session was restricted: a privileged session identity could assume the runtime role with
`SET ROLE` and later restore its own privileges. M4.1C startup now requires the session and
effective identities both to equal the configured runtime role. A real PostgreSQL fixture proves
that a privileged LOGIN role assuming runtime is rejected by the startup gate and adapter, while
the corrected PG14 `NOINHERIT` test proves non-inherited membership remains activatable with
`SET ROLE` and is rejected. **51 PostgreSQL tests pass** (16 shared and 35 PG-only); M4.1C still
awaits independent review, and neither the production SQLite route nor the planned M4.1D route
has changed.

Another independent review identified that `session_user` itself can be changed by a superuser
using `SET SESSION AUTHORIZATION`; checking both SQL identities alone did not prove the
authenticated connection was a restricted runtime login. M4.1C now requires an explicit matching
runtime username in the adapter connection URL and rejects all URL query parameters before
connecting. The schema gate also checks the client pool's effective login option, followed by
both SQL identities. Real PostgreSQL 14 tests demonstrate the session-authorization impersonation and
restoration, fail-closed startup, and missing/overridden username rejection. **53 PostgreSQL
cases pass** (16 shared and 37 PG-only). M4.1C remains **IMPLEMENTED / AWAITING INDEPENDENT
REVIEW**; production CLI and worker still use SQLite and M4.1D has not begun.

Independent review of the authenticated-runtime-credential correction found no P0 or P1 issues.
**M4.1C is PASS / CLOSED / FROZEN.** M4.1 overall is still **OPEN**: M4.1D has not begun,
and neither the CLI nor the worker has been routed to PostgreSQL. Both production processes
continue to use SQLite. Future TLS and connection-security options must be modeled as explicit
typed adapter configuration rather than URL query parameters that bypass the login gate.

## M4.1D — production backend selection and independent process routing

M4.1D makes the previously reviewed PostgreSQL durable adapter selectable by the production CLI
and Temporal worker. One persistence factory parses the backend configuration, opens either the
existing SQLite authority or the pre-migrated PostgreSQL adapter, and verifies a credential-free
deployment identity. SQLite remains the default for older deployments and per-run operational
commands. PostgreSQL must be explicitly selected with its runtime connection, schema, role, and
matching `FORGE_AUTHORITY_ID` in both independently started processes. Inconsistent backend or
scope settings fail closed. PostgreSQL startup continues to use the M4.1C schema/role/permission
gate; migration is still performed separately by the schema owner, never by a CLI or worker.

The CLI now uses the same backend for launch, status read model, cancel, and cancellation
settlement; it preflights PostgreSQL before binding or checkout provisioning. The worker injects
the selected store into the reusable composition, which no longer chooses a database from process
environment variables or a default path. The launch remains client-only and Temporal remains the
independent worker boundary. A compiled-process acceptance test completes a run through an
owner-migrated PostgreSQL 14 database, separate CLI and worker, and a local Temporal server. It
checks PostgreSQL status and durable evidence from another connection, then separately cancels
another PostgreSQL run after the launching CLI exits and observes `CANCEL_REQUESTED` and
worker-finalized `CANCELLED`. It rejects wrong backend or schema identities. SQLite
compiled-process completion and factory-level default compatibility
remain covered. See `docs/m4-postgres-durable-authority-parity.en.md` for the exact deployment
variables, identity contract, and migration prerequisites.

M4.1D is **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**, so M4.1 overall is still **OPEN**.
M3 and M4.1A–C remain frozen. Repository fencing, multi-run concurrency, and API/UI work remain
outside this stage; TLS configuration requires a separately typed adapter policy.

Verification: 52 focused factory/CLI/composition tests passed (5 factory, 32 CLI, 15 composition).
The compiled Temporal-worker phase passed 15 composition tests, 5 process-acceptance tests, and 3
smoke-configuration tests. Lint, typecheck, and build passed. The non-worker test phase passed
668 tests, but the full suite could not complete because the unchanged Restate container test
could not find a container runtime. `pnpm check` stops at pre-existing formatting issues in
`libs/agent-runtime/src/lib/pi-agent-runner.spec.ts`,
`libs/domain/src/lib/task-repair-attempt.ts`, and
`libs/orchestration-runtime/src/lib/repair-execution-coordinator.spec.ts`.

Independent review of M4.1D found that the explicit SQLite deployment path could omit
`FORGE_AUTHORITY_ID`, bypassing the identity contract for independently deployed processes. The
factory now requires the expected identity whenever `FORGE_AUTHORITY_BACKEND` is set to `sqlite`
or `postgres`; only backend-unset legacy SQLite may omit it. A supplied identity is never ignored.
Factory tests prove a worker pointed at SQLite B cannot use CLI SQLite A's expected identity, and
the compiled SQLite acceptance proves that worker exits before Temporal polling. M4.1D remains
**IMPLEMENTED / AWAITING INDEPENDENT REVIEW**, and M4.1 remains **OPEN**.

Independent review of the explicit SQLite identity fix found no P0 or P1 issues.
**M4.1D and M4.1 are PASS / CLOSED / FROZEN.** M3 and M4.1A–C remain frozen; M4.2 and M4.3
have not begun. The backend-unset SQLite compatibility behavior remains intact, and both
explicit backend selections now require a matching `FORGE_AUTHORITY_ID`.

## M4.2 design approval and implementation starting point

M4.2 addresses a different problem from M4.1: two runs using the same authority store must not
both gain permission to change conflicting parts of one repository. The reviewed design assigns
each approved repository identity to an explicit, opaque authority scope. A scope-wide durable
claim carries one increasing token across all resources acquired atomically by that claim.
Repository authority conflicts with every mutation resource in its scope, while write permission
is directional: a broad lease can cover a narrower write, but a narrow lease cannot authorize a
broader one. A controlled mutation callback must validate current durable authority and hold an
in-flight permit so release or handoff cannot race through the callback.

The final independent review of remote SHA `84adcedb06b4295a88f562b83b8a52a573cfa271`
found no remaining P0 or P1 design blocker. Its decisive rule is a deployment-wide legacy
cutover: old writer admission closes across every scope before inventory and activation. The
inventory includes historical runs and unresolved owners even when their repository ID is
unregistered or unknown. An owner whose scope cannot be established blocks activation of every
scope until it is classified or independently proven quiescent. A known scope with an unknown
resource is represented as repository-wide uncertain authority. This prevents an empty inventory
for one alias from concealing a writer using another alias.

**M4.2 DESIGN is PASS / APPROVED FOR IMPLEMENTATION.** This is approval of the contract, not
implementation acceptance. Initial provider-neutral types and repository resource semantics have
been drafted; domain typechecking and the focused resource tests pass. M4.2 still requires a
complete provider-neutral contract, SQLite and PostgreSQL implementations, store-wide cutover
evidence, real controlled-write rejection, PostgreSQL controlled-overlap races, and durable-state
verification from a third connection. In particular, test both cutover race orders: an old
admission that wins first must be inventoried; a barrier that wins first must reject a later old
admission. M3 and M4.1 remain PASS / CLOSED / FROZEN; M4.3 has not started. The detailed
implementation contract is `docs/m4-cross-run-fencing-proposal.en.md`.

Independent review of implementation-start SHA `3b095cfb9db0e5933adf860e68e36b808f799cab`
found two P1 contract gaps. The draft had described every transition as repository-scope locked,
which cannot serialize an unresolved writer whose scope is unknown. It also provided an in-flight
callback permit without requiring release or handoff to wait for that permit. The contract now
separates the deployment-wide cutover/admission/classification/readiness gate from repository-scope
claim/permit/handoff serialization, and preserves scope-before-run order for eligibility changes.
Release and uncertain-owner reclamation must reject while an exact permit remains unresolved;
process-loss recovery requires independently verified quiescence evidence and keeps the claim
blocking until settlement. A shared backend-neutral test factory specifies both winner orders for
callback versus handoff, plus uncertain-owner reclamation. These are contract corrections and
future adapter acceptance tests, **not** evidence that either durable adapter already satisfies
them. M4.2 implementation remains open and requires independent review of this correction.

Independent review of `6c002e7b976c885a85797dd5e058132f3c7a6e79` accepted the lock
hierarchy and normal callback handoff semantics but found two remaining P1 acceptance gaps. The
shared factory now defines both serialization orders for legacy admission versus deployment-wide
cutover. Its fixtures must use real old writer-creating entry points and observable gate waits:
an unknown-alias writer admitted first must appear in the whole-store inventory, while a barrier
that wins first must reject later builder, repair, integration, and dynamic lease admission without
changing durable writer evidence. An unclassified historical run under unregistered alias B must
keep scope S, registered under alias A, from activating. The provider-neutral API also now exposes
unresolved durable permits with their exact identity, scope, claim, owner, token, and resource.
The shared factory specifies independent-connection recovery after owner connection loss, refusal
to release or reclaim while the orphan remains, evidence-backed orphan settlement that leaves the
claim HELD_UNCERTAIN, and only then reclamation and a higher-token replacement. These are still
unwired acceptance definitions: SQLite and PostgreSQL have not executed them, and M4.2 remains
OPEN pending independent contract review and both adapter implementations.

Review of `311abdd51a6ae6a817c87845541ef1d1febfe4fc` found three more P1 gaps in the
provider-neutral contract. The live callback permit now carries a single-use completion secret
that recovery never returns; recovered permit evidence cannot serve as ordinary callback
completion authority. The shared suite asks a peer to attempt a forged completion while the
callback is active and requires the old claim to remain blocking. The state transitions are also
separated: ordinary release closes only `ACTIVE` authority; `HELD_UNCERTAIN` can be closed only by
evidence-backed reclaim after all permits end or receive privileged settlement. The orphan
scenario now checks that settlement requires `HELD_UNCERTAIN` first and that ordinary release
cannot bypass reclaim afterward. Finally, the legacy-admission-first cutover scenario now covers
builder, repair, integration, and dynamic leases, checking each exact writer kind in the
whole-store unknown-alias inventory. These are still unexecuted shared adapter contracts; they
do not close M4.2 or demonstrate durable SQLite/PostgreSQL fencing.

Independent review of remote SHA `f179d0f480e768bbe67ad3e2ba1f0e281c8f7a4f` accepted
the provider-neutral M4.2 contract and shared acceptance baseline. The live completion
capability is separate from recoverable permit evidence, uncertain claims cannot use ordinary
release, and both legacy-admission-first and cutover-first scenarios cover builder, repair,
integration, and dynamic leases. This acceptance freezes the contract as an implementation
baseline; it does not close M4.2.

SQLite durable implementation has begun. A new adapter stores scope and alias bindings, the
deployment cutover state, whole-store historical owner inventory, claims, leases, permits, and
audit evidence in the existing SQLite authority database. Its write transitions use immediate
transactions, and legacy writer-creating entry points check the same durable cutover gate.
Four shared controlled-permit scenarios now run against two independent SQLite connections;
a focused SQLite scenario also checks an unregistered historical alias, cutover rejection of a
later integration claim, and repository-wide uncertain import for an unknown resource. Existing
SQLite persistence regressions still pass. The controlled legacy-admission race factory is not
yet wired to SQLite, PostgreSQL has no M4.2 adapter, and the real production mutation boundary
and third-connection PostgreSQL evidence remain outstanding. **M4.2 implementation remains OPEN.**

Independent review of the first SQLite increment at
`0d17eefb1f8a7f92336e0994b3fcf615960a9b40` found two P1 identity gaps. Importing an
unregistered historical repository ID now atomically records its alias-to-scope mapping and
immutable historical run binding with the imported blocking claim, so a later `registerScope`
cannot split the same identity into a second scope. A new global claim now requires a real
persisted builder or repair attempt for a task in the bound run, with matching run, task, agent,
and optional workspace identity. A builder must match its approved task execution binding;
a repair must have a matching admitted work item. Only a `PREPARING` attempt can receive a new claim; the same
SQLite transaction advances it to `STARTING` after conflict checks pass. A blocked claim leaves
the attempt unchanged, while an exact retry requires the original attempt to remain `STARTING`
or `RUNNING`. Focused SQLite tests cover both corrections, including a new run under the formerly
unknown alias and builder and repair admission. These corrections still need independent review;
the controlled cutover race, PostgreSQL adapter, and production mutation boundary remain open.

Independent review of `53855c7e9a1d037ac919607fb116b011190517e9` accepted the alias
classification and attempt-identity fixes, but found that a valid attempt could request a file
outside its approved lease plan or even repository-wide authority. SQLite claim admission now
reads the durable task execution binding's lease plan and requires every requested resource to
fall within an approved resource using directional coverage. Repair admission additionally ties
its admitted work item's lease-plan fingerprint to that binding before using its resource plan.
This prevents a file-approved attempt from claiming another file or a broader repository lease.
Focused builder and repair regressions check both rejections, no claim or lease, no token
allocation, and the unchanged `PREPARING` attempt, followed by an approved-resource grant.
Dynamic expansion outside the approved plan still requires separate durable authorization
evidence and a new claim and token; this increment does not implement that path. The SQLite
resource correction awaits independent review. Controlled SQLite cutover races, the PostgreSQL
M4.2 adapter, and the production controlled-write boundary remain unproven; M4.2 remains OPEN.

Independent review of `a925255e7e32685adb78c2ad0ad2eee944f60b0c` accepted the SQLite
resource-authorization correction. The shared legacy cutover race contract is now connected to
SQLite through independent worker connections. It exercises builder start, repair start,
integration start, and dynamic lease creation in both serialization orders. When old admission acquires
the SQLite write gate first, the worker pauses its real transaction before commit; cutover waits,
then inventories that exact writer under the unregistered historical alias. When cutover wins,
each later writer waits and is rejected without durable attempt, lease, or integration-claim
evidence. In both orders the unresolved historical run prevents deployment readiness and scope
activation. This is controlled SQLite acceptance evidence, subject to independent review; the
PostgreSQL adapter, production controlled-write boundary, and remaining M4.2 work are still open.

Review of `6608fcebf8dd9046f05ac531ebd7a9b018299fd5` found that the builder and repair
race cases had used generic `persistAttempt(STARTING)` and `persistRepairAttempt(STARTING)` rather
than the production `claimBuilderStart` and `claimRepairStart` transactions. The SQLite fixture
now seeds real `PREPARING` attempts, then races those two production admission methods against
cutover. Builder start atomically persists its `STARTING` attempt and an ACTIVE local lease;
the admission-first case requires both owner kinds in the store-wide inventory. When cutover
wins, explicit checks require the builder and repair attempts to remain `PREPARING`, no builder
lease, and no repair start/history record. The generic STARTING persistence entry points remain
guarded by the same durable gate but are not the primary admission cases in this controlled race.
This correction awaits independent review; M4.2 remains OPEN.

Independent review of `5cd194213cfd4a9ae0431410ee7ab11a207cf11a` accepted the SQLite
controlled cutover. PostgreSQL M4.2 groundwork now has an explicit migration-owner version 3
schema. It installs deployment control, scope/alias/run bindings, historical-owner inventory,
claims, leases, permits, and audit tables. Runtime startup checks the migration ledger, exact
table and constraint shape, and per-table privileges; the existing M4.1 adapter can still start
on version 2, while the new global-authority gate requires version 3. A version 3 PostgreSQL
orchestration connection now takes the deployment gate before any bound scope and run row. Its
production builder, repair, and integration starts, ACTIVE lease persistence, and generic
STARTING/RUNNING attempt persistence reject after `LEGACY_ALLOWED` closes in that same transaction.
Connections opened before the version 3 migration do not acquire this new gate; deployment
activation must still prove those older workers have stopped or been replaced.
The PostgreSQL parity suite passes 55 tests on a real isolated server. This increment provides
schema and old-writer admission groundwork, **not** a PostgreSQL `GlobalMutationAuthority`
adapter, controlled PG overlap proof, third-connection verification, or production fenced-write
boundary. M4.2 remains OPEN and this increment awaits independent review.

Independent review of PostgreSQL groundwork SHA `a3d80a05eac936374827a0f8f9a17a6f5f1eee7b`
found a P1 startup-permission gap. PostgreSQL can grant a runtime role permission to change just
one column even when the table-level UPDATE check says no. That could let a worker rewrite a
repository's immutable scope binding or move a run to another scope without the startup gate
noticing. The version 3 gate now checks both table and column capabilities on all nine global
authority tables, rejects any grant option, and rejects unexpected column ACL entries even when
an existing table-level grant would hide a redundant column grant. Real-server regressions cover
alias and run-binding rebinding, additional column grants, and grant options; they also verify
that rerunning the owner migration removes the drift and restores startup. A separate case
verifies that a column grant to every database user is detected and removed as well. The focused
PostgreSQL suite passes all 71 tests; formatting, type checking, and linting pass. The full
`pnpm check` run has 735 passing tests and one skipped test, but it cannot complete successfully
here because the unrelated Restate integration test needs a container runtime that is unavailable
in this environment. This correction addresses the reviewed privilege hole; it still awaits
independent acceptance. The global
PostgreSQL adapter, controlled overlap and third-connection proof, and production fenced-write
boundary remain unimplemented, so M4.2 is OPEN.

Independent review of `f47c24532c372d5d41fa44c7bb5c48c03f7f278c` accepted that privilege
correction: the nine-table PostgreSQL version 3 schema and legacy-writer gate now provide an
approved starting point for the global adapter. This next increment adds
`PostgresGlobalMutationAuthority`, a runtime-only implementation of the shared
`GlobalMutationAuthority` contract on the existing version 3 tables. A scope groups repository
aliases that must share write authority; a run is bound to one such scope. Under one PostgreSQL
transaction the adapter takes the deployment cutover gate, then the scope and run locks. It can
register identities; inventory, classify, and import historical writers during cutover; activate
global claims; check persisted run, task binding, attempt, and resource approval before granting
a claim; and advance a builder or repair attempt to STARTING together with its lease and token.
Conflicting active or uncertain leases block later claims. A permit with a one-time completion
secret protects in-flight controlled writes, while evidence-gated orphan settlement and uncertain
claim reclamation keep a stopped or lost worker from silently handing authority to another run.
PostgreSQL BIGINT tokens are parsed exactly and refused before JavaScript's safe-integer limit.

The real PostgreSQL fixture now runs the four shared permit scenarios and eight controlled
cutover races for builder, repair, integration, and dynamic lease admissions, including both
orders at the deployment gate. Additional cases reject invented or overbroad claims, check
atomic repair history, verify unknown-alias historical imports, reject token exhaustion without
partial state, and demonstrate same-scope cross-run blocking and handover through an independent
third connection. The focused PostgreSQL suite passes all 88 tests. This increment is awaiting
independent review; production CLI/worker mutation entry points are not yet wired through this
adapter or its controlled-write port. The existing version 3 migration and legacy gate are not
changed. The deployment-wide token counter remains a documented implementation-shape question,
and the BIGINT-safe public token contract and diagnostic resource ID ambiguity remain follow-ups.
M4.2 is **OPEN** until the production fenced-write boundary and its acceptance evidence are
implemented and reviewed; multi-run deployment acceptance belongs to M4.3.
Formatting, TypeScript project-reference checking, and linting pass. The full `pnpm check`
run reports 752 passing tests and one skipped test, but exits unsuccessfully because the
unrelated Restate integration suite cannot find a working container runtime in this environment.

Independent review of the committed PostgreSQL adapter `37a730a` found no new P1 issue but did
not accept its M4.2 overlap evidence: its third-connection check was sequential, while the frozen
acceptance requires simultaneous transactions and proof of who blocks whom at PostgreSQL's scope
row. Version 4 is the next, separately checksummed owner-only migration; version 3's migration
and checksum remain intact. It adds a non-null `next_token` counter to each scope, initializes it
from that scope's highest persisted claim token (including released and uncertain claims), and
removes the old deployment-wide counter. An owner rerun preserves the recorded counters. The
runtime adapter now requires version 4. Its deployment and historical cutover transitions still
lock the deployment control row, scope, then run; once the irreversible `GLOBAL_READY` state is
read, ordinary claim, permit, release, and reclamation transactions lock only their scope and,
where needed, their run. This lets independent scopes proceed separately while the shared scope
serializes conflicting writers. Existing M4.1 run lifecycle transitions retain the deployment
gate and then take the bound scope and run locks, so they synchronize with global claims.

The isolated real-PostgreSQL acceptance fixture deliberately stalls the first operation _after_
it has the scope lock. `pg_blocking_pids` proves that another run's conflicting claim, or a
competing cancellation or terminal-state transition, waits on the first connection's scope row
lock. After releasing the stall, an independent third connection reads the durable claim, run,
attempt, and permit evidence: one conflicting claim wins with no losing claim or STARTING residue;
in the opposite lifecycle order, the claim is rejected and no token or attempt is created.
Cancellation is checked through both `CANCEL_REQUESTED` and `CANCELLED`, alongside FAILED and
COMPLETED. Release and uncertain-claim reclamation similarly overlap a stale controlled write:
the write waits behind the scope lock and its callback is never invoked once ownership ends.
A separate controlled case shows another scope can grant a claim while the first scope's claim
still holds its row lock, with independent counters. A migration regression starts on a populated
version 3 schema and verifies that existing claim tokens, per-scope high-water marks, and the
version 3 checksum survive the upgrade and rerun. The focused PostgreSQL suite passes 96 tests.
This increment addresses the review's missing
controlled-overlap evidence and awaits independent review; M4.2 remains **OPEN** until the
production CLI/worker fenced-write boundary is connected and accepted. The public token type's
BIGINT range and diagnostic resource-identifier ambiguity still need separate resolution.
Formatting, TypeScript project-reference checking, and linting pass. The full `pnpm check`
reports 760 passing tests and one skipped test, but exits unsuccessfully because the unrelated
Restate integration suite cannot find a working container runtime in this environment.

Independent review accepted the version 4 PostgreSQL migration, scope-local counters, global
authority adapter, and its 96 real-database controlled-overlap tests at commit `15cde7f`. That
acceptance applies to the durable authority provider, not to production write admission: CLI run
creation does not yet bind a run to a registered global scope, and the worker still uses legacy
builder, repair, integration, and dynamic lease admission. In `GLOBAL_READY`, the legacy writer
gate rejects those admissions. The global claim contract currently authorizes PREPARING builder
and repair attempts; it has no separate admission for integration. Therefore merely supplying an
authority to the worker would not make production mutations safe or functional.

The next incremental seam is in the agent tool runtime. When an exact claim and a
`FencedMutationPort` are supplied, the runtime checks that the claim owner matches the run, task,
attempt, and agent. A file write or edit requests a permit for its resolved file resource; the
permit encloses the edit read, filesystem write, and recorded impact, and is completed only after
the callback settles. A Pi command can change arbitrary workspace files, so it requests
repository-wide authority around command execution. A stale or insufficient token prevents the
callback from starting. The existing local lease path remains the behavior when no global claim
is supplied. Focused tests use a real temporary file to show a stale edit/write cannot alter it,
show that impact persistence still holds the permit, and show that a denied repository permit
prevents the Pi command executor from running.

This is a reusable lower-level boundary, **not** production activation: the production CLI and
worker do not yet supply the global claim/port, builder and repair still acquire legacy leases,
and Git workspace creation, integration, and continuation have not been fenced. Completing M4.2
requires durable run binding, atomic global admission through the worker, permit coverage at all
filesystem/command/Git side-effect entry points, and independent acceptance of those paths.
M4.2 remains **OPEN** and M4.3 multi-run deployment work has not started. The public token's
BIGINT range and diagnostic resource identifier ambiguity remain P2 follow-ups; upgrading a live
version 3 writer to version 4 may also require quiescence or retry on PostgreSQL deadlock `40P01`.
The focused agent tool and Pi runner suites pass all 33 tests. Formatting, TypeScript
project-reference checking, and linting pass. The full `pnpm check` reports 764 passing tests
and one skipped test, but still exits unsuccessfully: the unrelated Restate integration suite
cannot find a working container runtime in this environment.

An independent review accepted the agent tool and Pi controlled-mutation seam at commit
`6536ab8`; it did not accept production M4.2. The next production-composition increment
addresses a dangerous mode-selection mistake while the global worker path is still being built.
The existing production worker creates the older, per-run persistence and coding services.
It cannot safely operate after the deployment has closed old writer admission: simply omitting
the optional global claim from a tool constructor would leave its local write path available.
The production worker now asks its durable SQLite or PostgreSQL store whether legacy worker
composition is still permitted **before** creating coding services. Both stores read the
deployment's persistent cutover state rather than relying on a configuration flag. If cutover
has started, composition fails instead of quietly selecting local authority; PostgreSQL also
checks the current state when an already-connected store is reused. Existing database writer
admission checks continue to protect actual old writer creation if cutover races this startup
check. Test-only injected persistence remains an explicit testing seam, not production mode
selection.

The tool runtime now also accepts the actual workspace ID. If a durable claim identifies a
workspace, its owner must match that ID as well as the run, task, attempt, and agent before
tools are created. The runtime composition passes `workspace.id` from the builder or repair
request; the durable provider still makes the final permit decision for scope, token, owner,
and resource. Tests cover absent, mismatched, and matching workspace identities; a real SQLite
cutover rejects worker creation, and real PostgreSQL tests reject both an already-ready worker
and a store connected before cutover. The focused four suites pass 135 tests.

This is a fail-closed guard for the **legacy** production route, not an activated global route.
No production builder or repair yet obtains a global claim or supplies mandatory mutation
context; CLI run/scope binding, dynamic global expansion, and integration/Git permit boundaries
are still missing. Existing old workers must be independently stopped and verified during
cutover; a startup check does not revoke a process already running. M4.2 remains **OPEN** and
M4.3 has not started. An external file write that succeeds before impact persistence fails must
also keep its higher-level global claim uncertain rather than automatically release it when
the future global orchestration path is connected. The public number-token range and diagnostic
resource IDs remain P2 follow-ups.

Verification for this increment: the four focused suites pass 135 tests, and formatting,
TypeScript project-reference checking, linting, and `git diff --check` pass. The full
`pnpm check` is not green: it reports 768 passing tests and one skipped test, while the unrelated
Restate integration suite cannot start without a container runtime. Its compiled CLI/worker
acceptance suite also hit a 10-second child-process limit in one case (`CLI failed (null)`);
an initial separate run hit that limit in a different case. Both affected cases passed
when isolated, and a further complete rerun of the compiled CLI/worker acceptance suite
passed all five cases. The original `pnpm check` result is still a failure because the
Restate container runtime was unavailable; its first process-boundary run was not green.

Independent review accepted the legacy-worker cutover guard and workspace-owner check at
`ae5cf89`. This next production increment gives a new PostgreSQL version 4 run an immutable
global scope binding **when it is created**, rather than trying to infer its scope when a worker
later starts writing. An authorized operator must first register the repository alias with the
global authority; the CLI does not create aliases or guess whether two repository names identify
the same underlying checkout. For a version 4 launch, the run launcher asks the persistence
provider to create the approved run, task bindings, and global run/scope binding in one database
transaction. That transaction checks that old writer admission is still open, resolves the
registered alias, and locks the deployment gate and scope before inserting the new run. A missing
alias or closed admission leaves no half-created run. Earlier SQLite and PostgreSQL version 2/3 launch paths
retain their existing behavior. The lower-level unbound `createRun` API remains available for
historical fixtures and migrations; the production launcher selects the bound API for version 4.

On retries and recovery, the launcher checks both the approved-plan fingerprint and the
persisted run/repository/scope identity before dispatch or starting a Temporal workflow. A
missing or mismatched binding fails closed; a cutover that has closed legacy admission also stops
the launch. The CLI checks the existing legacy-worker deployment state before provisioning a
checkout, with the transactional launch checks providing the final defense against races.
Real PostgreSQL tests show that an unregistered alias creates no run, a registered alias creates
the run and binding atomically and is visible from a separate connection, a wrong repository is
rejected, and cutover prevents subsequent launch. Launcher tests cover rejection before workflow
start and rejection on recovery. The two focused suites pass 102 tests.

This increment prepares run identity for future global claims; it does **not** enable the
`GLOBAL_READY` worker. Builder and repair still need atomic global admission and mandatory
mutation context, dynamic resource expansion and integration/Git writes still need fenced
permits, and an already-running legacy worker still requires controlled shutdown at cutover.
M4.2 remains **OPEN** and M4.3 has not started. The public number-token/BIGINT range and
diagnostic resource-ID ambiguity remain P2 follow-ups.

Formatting, TypeScript project-reference checking, linting, and the 102 focused launcher and
PostgreSQL tests pass. The full `pnpm check` reports 771 passing tests and one skipped test,
but exits unsuccessfully because the unrelated Restate integration suite cannot find a
working container runtime (its teardown also encounters the missing environment).

Independent review accepted the run-to-scope binding increment at `dae9ffc`. The next
increment prepares builder and repair admission without enabling a global worker. A run
already has an immutable binding between its approved repository identity and an opaque
global scope. Both SQLite and PostgreSQL global authority providers can now retrieve that
binding from their persisted run, alias, and scope records. If any part is missing or
disagrees, they reject the lookup; a worker must never derive scope identity from its
workspace directory. This lookup supplies the input to a new
`GlobalBuilderRepairAdmission` boundary. The boundary accepts the approved task binding
and a PREPARING builder or repair attempt, carries the run, task, attempt, agent, and
workspace IDs into a global claim, and asks the durable provider to check the approved
run and task, resource plan, repair work item, and attempt state in the same transaction
that advances the attempt to STARTING. A competing claim receives blockers without
advancing its attempt. A successful admission returns a mandatory mutation context and
a callback entry that uses `FencedMutationPort` for each covered resource. A stale token
cannot execute a new callback; a project claim does not authorize a repository-wide
callback. Unlike a builder, a repair may have a different agent from the approved task
binding: the provider validates it against the admitted repair work item and persisted
repair attempt instead.

The new boundary is independently exercised with a real SQLite authority and a second
connection: an unbound run and a repair without an admitted work item are rejected, a
builder and an admitted repair become STARTING, a competing builder stays PREPARING,
and a callback is denied after release. The existing SQLite and isolated PostgreSQL
provider suites also verify recovery of the exact durable run scope. The three focused
suites pass 116 tests. This is an admission-and-permit **building block**, not a
production worker switch: the production worker still uses legacy admission and rejects
startup after cutover. It does not yet consume this new boundary or require the returned
mutation context in its builder/repair execution, and Git workspace creation, dynamic
resource expansion, and integration writes are not globally fenced. A controlled
production path must also retain uncertain ownership when an external write succeeds
but its impact evidence fails to persist; automatic release would be unsafe. M4.2
remains **OPEN** and M4.3 has not started. Public number tokens versus PostgreSQL BIGINT
and ambiguous diagnostic resource IDs remain P2 follow-ups.

For this increment, `pnpm check` passed formatting, TypeScript project-reference checks,
linting, and all 773 tests, but the command still exited unsuccessfully: aggregate
coverage was 87.73% of statements, 82.41% of branches, and 87.64% of lines, below
the configured 90% threshold in those three categories. The focused three suites
passed all 116 tests.

Independent review of `6cd682c` identified one blocking crash-recovery gap in this
admission building block. Previously, every builder or repair admission call made a
new random claim ID and accepted only a PREPARING attempt. If the database committed
the claim and STARTING transition but the worker lost the response, a restarted
worker could not recover the token: the STARTING attempt failed the local check,
and a stale PREPARING object created a different claim ID. The initial claim ID is
now a stable SHA-256 identity derived from the operation kind, run ID, and attempt
ID. PREPARING, STARTING, and RUNNING attempts may reach the provider, but the provider
still allows a new claim only for PREPARING; STARTING/RUNNING require an exact,
already-active claim with the same owner and resources. This distinction keeps
recovery from creating new authority. Admission additionally verifies that returned
leases are ACTIVE and contain exactly the requested canonical resources.

A real SQLite test now discards the first admission response, recovers each
persisted STARTING builder and repair from another provider connection, and verifies
the same claim ID, token, and leases. It also checks that a STARTING attempt without
a matching claim is rejected, that no extra ACTIVE claim appears, and that the
next genuinely new claim receives only the next token. The production worker still
rejects GLOBAL_READY and does not consume this building block; global Git,
integration, and dynamic writes remain outside the production boundary. M4.2 stays
OPEN, M4.3 has not started, and the public number-token/BIGINT and diagnostic
resource-ID questions remain P2. This remediation awaits independent review.

For this remediation, `pnpm check` passes formatting, TypeScript project-reference
checks, linting, and all 773 tests. It still exits unsuccessfully on the unchanged
90% aggregate coverage gate: statements 87.96%, branches 82.73%, and lines
87.88%. This gate failure is separate from the admission replay finding.

Independent review accepted `b58b2eb`'s replay-safe admission building block. The
next production-boundary increment introduces `GlobalBuilderRepairExecutionBoundary`
for one already-admitted, workspace-bound builder or repair claim. Think of a global
claim as permission to change a particular repository and a fenced permit as the
short-lived record that a specific write is in progress. The new boundary requires
the exact approved run, task, and workspace identity. Its Git workspace creation
callback, including the subsequent durable workspace record, runs under a
**repository-wide** permit. A project-only claim cannot begin that callback and
therefore cannot create a Git worktree or branch. If Git or its record fails after
the callback starts, the global claim is marked HELD_UNCERTAIN, retaining the
barrier to another owner until the external writer's quiescence is independently
established. A returned workspace whose identity differs from the approved binding
is likewise rejected. The boundary also constructs agent tools with the admitted
mutation context explicitly supplied: actual file writes and impact records use
their file/project permit, repository-wide commands require a repository permit,
and neither path falls back to a process-local lease. If a file changes but its
impact record fails to persist, the claim is also marked uncertain instead of
silently allowing another owner to write.

Real SQLite authority tests with separate connections check denial before Git is
called for a project-only plan, a valid file write and rejection of a stale write,
Git and its record under a live permit for an explicitly approved repository plan,
and uncertain ownership when the durable record fails after Git or a file write.
Agent-tool tests also retain uncertain ownership if an already-started command
fails or the permit cannot be completed; a failed permit request never begins
the command. These checks exercise the callback boundary and workspace identity
but **do not** activate a GLOBAL_READY production worker: the existing worker still rejects that mode, and
its legacy builder/repair services have not been replaced by a lifecycle that
consumes this boundary. Global integration, dynamic resource expansion, external
agent shutdown, and safe global release remain unfinished. Normal project-only
plans cannot create Git workspaces in the proposed global route without a separate
approved repository authority. M4.2 remains OPEN; M4.3 has not started. The
number-token/BIGINT and diagnostic resource-ID issues remain P2.

For this boundary increment, `pnpm check` passed formatting, TypeScript
project-reference validation, linting, and all 778 tests across 72 suites. It
still exits unsuccessfully at the repository's 90% aggregate coverage gate:
statements 87.98%, branches 82.71%, and lines 87.90%. The three directly
relevant agent-tool, Pi-runner, and SQLite boundary suites pass all 40 tests.

An independent review of exact remote SHA `c43b487` found one blocking
handoff race in that workspace boundary. On Git or workspace-record failure,
the first implementation ended the durable permit before marking the claim
HELD_UNCERTAIN. A separate recovery connection could release the still-ACTIVE
claim in that gap, allowing a replacement owner even though the Git result was
unknown. This follow-up moves uncertainty recording _inside_ the repository
permit callback, before that callback settles and its permit can be removed.
The outer failure handler still retains ownership if Git and its record succeed
but completing the permit fails. No previously accepted provider or migration
contracts change.

The SQLite regression now observes the transition through a second connection:
while uncertainty is being recorded, the exact permit still exists and an
independent release is rejected as an in-flight mutation; once the permit has
ended, the claim is already HELD_UNCERTAIN. It checks both a failed durable
workspace record and a Git result with a branch different from the approved
binding; the wrong branch is never saved as a workspace record. This fixes the
continuous handoff barrier identified in review. The production GLOBAL_READY
worker still refuses to start, so production builder/repair consumption,
integration fencing, dynamic resource expansion, and safe release remain to be
built. M4.2 remains OPEN and M4.3 has not started. The number-token/BIGINT and
diagnostic resource-ID questions remain P2, as does avoiding an unnecessary
uncertain hold for a pre-write edit validation failure.

For this targeted remediation, the SQLite admission suite passes all 5 cases,
including both workspace failure-ordering paths. `pnpm check` passes formatting,
TypeScript project references, linting, and all 779 tests across 72 suites; it
still exits unsuccessfully on the pre-existing 90% aggregate coverage gate:
statements 87.97%, branches 82.68%, and lines 87.89%.

An independent review of remote SHA `7731480` found a second failure in this
handoff barrier. If recording HELD_UNCERTAIN failed before it was durable, the
ordinary fenced callback would still remove its permit in `finally`. A separate
connection could then release an ACTIVE claim despite an ambiguous Git result.
There was also a gap when permit completion committed but its response was lost:
the outer error handler would only mark uncertainty after the permit was gone.
This follow-up adds an explicit failure-aware `FencedMutationPort` operation for
external effects. It starts the permit, performs the callback, and records
HELD_UNCERTAIN **before** completing that permit, whether the Git callback
succeeded or failed. If recording uncertainty fails, it deliberately leaves the
exact permit unresolved, so independent recovery must establish quiescence
before settling the orphan. If permit completion succeeds but its response is
lost, the claim was already HELD_UNCERTAIN. The ordinary callback operation and
the accepted SQLite/PostgreSQL providers and database migrations are unchanged.

The Git workspace boundary uses this operation for worktree creation, approved
identity checks, and saving its workspace record. A successful Git creation now
also leaves its claim HELD_UNCERTAIN: this is intentionally fail-closed until an
independent process proves the external writer has stopped and reclaims the
claim. It is **not** a completed production builder lifecycle or a way to
resume the agent automatically. The real SQLite tests use another connection
to attempt release while uncertainty is recorded, simulate failure to record
it, and simulate permit completion that commits before its response disappears.
They verify that either the uncertain claim or an unresolved recoverable permit
always blocks handoff. Domain tests check the callback/permit ordering. The
production GLOBAL_READY worker remains disabled; builder/repair consumption,
integration fencing, dynamic resources, and safe lifecycle continuation remain
unimplemented. M4.2 remains OPEN and M4.3 has not started. The public
number-token/BIGINT, diagnostic resource-ID, and pre-write edit-validation
follow-ups remain P2.

For this second targeted remediation, the domain and real SQLite admission
tests pass all 10 focused cases. `pnpm check` passes formatting, TypeScript
project references, linting, and all 782 tests across 72 suites; the overall
command still fails the existing 90% aggregate coverage gate (statements
87.98%, branches 82.71%, lines 87.90%). No coverage threshold was changed.

Independent review accepted `d4ae9b8`'s continuous permit-to-uncertainty
barrier and froze that workspace mutation boundary. The next question is what
happens **after** Git creates a worktree: even success deliberately leaves the
first global claim HELD_UNCERTAIN, so an agent cannot start writing with it.
The new design draft at `docs/m4-workspace-continuation-design.en.md` explains
this state and proposes a separate, privileged continuation. An independent
recovery actor must prove that the original Git operation and any writer using
its authority cannot start again, resolve any unfinished permit, and verify
the approved Git worktree and durable workspace record. A new provider
operation would then, within **one repository-scope transaction**, close the
old claim and create one new execution-phase claim with a higher token. Closing
the old claim in one transaction and claiming again in another would expose a
handoff gap to a competing run and is expressly forbidden. The builder/repair
attempt remains STARTING; a stable parent-to-child phase record would let a
worker recover the exact new claim after a lost response without recreating
the worktree. Failed proofs, conflicts, cancellation, and crashes retain a
durable blocker rather than granting accidental authority. A marker recorded
before Git starts would prevent ordinary release or reclamation of this
special parent from bypassing the atomic handoff.

This is a **proposal awaiting independent review**, not a new production
capability. It requires a trusted, independently verified quiescence process,
real Git identity checks, a new provider-neutral handoff contract, versioned
PostgreSQL persistence, and shared SQLite/PostgreSQL overlap regressions.
Legacy builder/repair services and their attempt updates are not safe to
reuse after global cutover. The production worker still rejects GLOBAL_READY;
agent continuation, integration Git, dynamic resource expansion, external
writer shutdown, and final release are unimplemented. M4.2 remains OPEN and
M4.3 has not started. The public number-token/BIGINT and diagnostic resource-ID
questions remain P2. This document-only increment has no new runtime tests;
it changes no previously accepted contract, provider, or migration.

Independent review of exact remote SHA `c7585b0` found that this continuation
design is **not yet approved**. Three authority decisions were missing. The
revised proposal now makes the workspace parent a purpose-bound Git setup
claim: a durable phase marker is installed before Git, and the provider must
reject ordinary mutation permits for that parent, even though its repository
lease would otherwise cover file and project writes. Only a dedicated permit
for the exact workspace may start, with at most one permit lineage. Phase
transitions, ordinary release/reclaim rejection, cancellation and evidence-
backed abandonment must serialize on the same scope lock. A marker committed
before Git begins survives a crash; if cancellation wins before the dedicated
permit begins, Git cannot start. Neither state can be escaped through an
ordinary release or a second workspace attempt.

The revised proposal also separates permissions by purpose. The parent needs
an explicitly approved repository lease for worktree/branch setup; the child
gets **only** the separately approved agent-execution resources in the atomic
handoff. Git-only repository authority does not become an agent's general
writing permission. An agent needing repository-wide commands requires a
separate execution approval. The handoff still closes the uncertain parent and
grants the higher-token child in one transaction, so competing runs never see
a released parent without its replacement.

Finally, an independent recovery service or operator, using credentials the
worker does not hold, must persist a signed, identifiable attestation. It must
first revoke the original execution generation so the scheduler and permit
entry cannot restart it, obtain a supervised stop confirmation for the worker
and any child writers, account for all parent permits, and directly inspect
the actual clean worktree and Git repository, commit, branch and integration
identities against approvals pinned before Git began. The attestation binds
the exact scope, parent claim/token, owner, workspace/revision, observed
permits, worker generation, and plan digests; exact retry uses its immutable
ID and digest. A heartbeat timeout or a matching path is not proof. Handoff
and abandonment both require this independent proof and zero unresolved
permits; missing proof leaves the parent blocking. This is still a **document-
only proposal awaiting independent review**, not a working recovery service,
provider state machine or enabled GLOBAL_READY worker. M4.2 stays OPEN and
M4.3 has not started. No runtime code, schema or tests changed in this
revision; the last full check had format/type/lint and 782 tests pass but
`pnpm check` fail the existing 90% aggregate coverage threshold (87.98%
statements, 82.71% branches, 87.90% lines).

Independent review accepted `f48f25c` as the **frozen workspace-continuation
design**, not as a working recovery system. The next small implementation
increment adds durable storage for a workspace-setup parent's phase. SQLite
creates a `forge_global_workspace_phases` table; PostgreSQL installs the same
table in a separate **version 5 migration**, leaving the accepted v1–v4
migration checksums unchanged. Each phase row is tied to exactly one existing
global claim. The least-privileged PostgreSQL runtime can read phase rows but
cannot insert or change them; startup audits both the table shape and grants.
Reapplying the migration keeps existing claim tokens and the per-scope counter.

Both authority providers now read that durable row when a caller tries an
ordinary mutation against the marked parent. In INITIAL_ADMITTED,
WORKSPACE_ARMED or WORKSPACE_UNCERTAIN, they reject ordinary token validation,
permit creation, exact claim replay, ACTIVE release and uncertain reclaim.
This remains true if the parent has a repository-wide lease: that broad Git
permission cannot silently become a file-write permission. Separate SQLite
connections and a real isolated PostgreSQL server verify the rejection and
continued blocking, while existing ordinary claims remain compatible. A
version-4 database is deliberately refused by the updated global adapter;
the migration owner must install version 5 first.

This increment is **only a fail-closed phase-storage and read-gate
foundation**. There is no approved workspace-setup plan or execution
generation persisted yet, no privileged transition that creates a phase row,
and no dedicated one-shot Git permit, recovery attestation, abandonment or
parent-to-child handoff. Tests install phase rows using a migration-owner
connection solely to exercise the provider gate. The production GLOBAL_READY
worker remains disabled; M4.2 is OPEN and M4.3 has not started. Public
number-token/BIGINT and diagnostic resource-ID questions remain P2.

Verification for this increment: the focused real PostgreSQL suite passes all
100 cases, and `pnpm check` passes formatting, TypeScript project references,
linting, and all 784 tests across 72 suites. The overall command still exits
unsuccessfully on the existing 90% aggregate coverage threshold: statements
88.06%, branches 82.74%, and lines 87.97%. No coverage threshold was changed.

An independent review accepted the earlier version-5 phase gate at `6bc3b98`
as a deliberately narrow foundation. The frozen continuation design next
requires a separate approval for Git setup, a durable execution generation,
and an **atomic** setup-parent grant and INITIAL_ADMITTED marker. Investigation
of the real approval chain showed why merely adding a `workspaceSetupApproval`
field to a task binding is insufficient: the approved version-1 plan artifact
does not authorize a separate repository-wide Git setup resource. Copying its
ordinary approval ID into such a field would let an execution binding
self-authorize Git. Similarly, granting the PostgreSQL runtime direct INSERT
on the version-5 phase table would invalidate the accepted SELECT-only
least-privilege boundary. An experimental admission implementation was removed
before delivery; there is no callable setup grant, arm operation, or Git
permit in this increment.

The safe prerequisite delivered here is a separate **PostgreSQL version-6
migration** adding nullable setup-plan digest, execution-plan digest,
execution-generation, and workspace-ID slots to the phase row. The migration
keeps versions 1–5 and their checksums untouched and retains SELECT-only
runtime access; neither runtime workers nor an unverified task binding can
populate these fields. The SQLite provider adds the same inert slots on new
databases and upgrades existing phase tables in place. Nullable slots preserve
older phase rows without inventing an approval or a generation. Runtime shape
checks require version 6 for the global PostgreSQL adapter, and rerunning the
migration preserves existing scope tokens and parent states. Real SQLite and
PostgreSQL upgrade tests inspect legacy rows and demonstrate that marked
parents still reject ordinary mutation permits; PostgreSQL tests also reject
runtime writes to the phase table. The real two-backend focused suites pass
119 tests.

For this increment, `pnpm check` passes formatting, TypeScript references,
linting and all 786 tests across 72 suites; the command still exits at the
unchanged 90% aggregate coverage threshold (statements 88.07%, branches
82.75%, lines 87.97%).

For a future usable setup path, the approved artifact/approval pipeline must
first independently authorize the repository-level Git setup plan and bind
its digest to the approved execution plan and workspace. A trusted generation
issuer and revocation protocol must persist the execution generation. The
provider then needs one atomic claim-plus-marker operation that checks both
approvals; PostgreSQL must achieve this without opening general phase INSERT
to the runtime role. Only after that can arming and the single-lineage
dedicated Git permit be implemented. The production GLOBAL_READY worker stays
disabled; M4.2 remains OPEN and M4.3 has not started. The public number-token
versus BIGINT and diagnostic resource-ID questions remain P2.

An independent review accepted the version-6 metadata reservation at
`b6b454c` as a prerequisite, not as setup admission. The next investigation
found that the existing version-1 plan approval names a reviewer and binds an
execution artifact, but contains no separate decision to authorize Git
worktree creation. Worker execution also has no trusted generation issuer or
durable revocation. Neither an ordinary approval ID nor a random value chosen
by a worker can fill those gaps.

This increment introduces a **separate, immutable Git setup decision record**
in the planning library. Its own ID and content fingerprint differ from the
execution approval. It specifies exactly one approved task, repository ID and
root, pinned base commit, repository-wide resource and the single
`git-worktree-create` operation; it binds the original artifact revision and
fingerprint as well as the execution approval fingerprint. Creating and
validating the record rejects mismatched or missing task/plan/approval identity,
an earlier decision timestamp, content tampering and attempts to add other
operations. A JSON-file store outside the analyzed repository publishes the
decision immutably and rejects a different decision under the same ID, even
when two store instances race. Focused tests cover the decision and its
filesystem persistence. Existing version-1 plan artifacts, approvals, run
bindings, PostgreSQL migrations and provider privileges remain unchanged.

This is a **record format and storage boundary**, not a trusted authorization
service: `approvedBy` is not an authenticated identity, and the runtime never
consumes this record. No provider can use it to grant a setup claim, populate
the reserved v6 fields or start a Git permit. Before enabling that path,
separate authorization credentials/identity and a verifiable approval source
must be integrated, and a trusted supervisor must issue and durably revoke
execution generations. The claim and phase marker must then be created in
one scope transaction without granting PostgreSQL runtime general phase-table
INSERT. The production GLOBAL_READY worker remains disabled; M4.2 stays OPEN
and M4.3 has not started. Public number-token versus BIGINT and diagnostic
resource-ID ambiguity remain P2.

Verification for this record-and-storage increment: focused planning and
filesystem tests pass 22/22; `pnpm check` passes formatting, TypeScript
references, type-aware linting and all 791 tests across 73 suites. The
command still exits at the unchanged 90% aggregate coverage threshold:
statements 88.17%, branches 82.85%, lines 88.08%.

An independent review accepted `0907703` strictly as the data format and
immutable storage prerequisite. A file that loads successfully is not a
trusted approval: its SHA-256 fingerprint can be recomputed by anyone who
can replace the file, and its `approvedBy` field is plain text. The next
increment introduces a separate **verification boundary** in the planning
library. Given the exact approved plan artifact, execution approval, Git
setup decision, an Ed25519 signature, and public keys supplied by an
independently trusted configuration, it verifies the decision against the
artifact and execution approval and checks a domain-separated signature
over the complete setup decision and signing key ID. A missing key, altered
decision with a newly calculated fingerprint, different approval, swapped
key identity, invalid signature or wrong key type fails closed. Tests use
independently generated keys to exercise these cases; signing credentials
are never read from the setup record or the JSON store.

This verifier is a reusable boundary, not a deployed Git approval service.
There is no configured trusted signer, authenticated approval workflow,
signature publication or key rotation/revocation mechanism yet; workers
and providers do not consume the verifier or the unsigned store record.
Before any provider setup claim, a separately authenticated approval source
must issue and retain the signed decision, deployment must supply only its
trusted setup-signing public keys, and the consumer must recheck the exact
run/workspace and approved artifact at admission. Trusted execution
generation issuance and revocation, atomic setup claim plus phase marker,
arming, the dedicated Git permit and parent-to-child handoff are still
unimplemented. The production GLOBAL_READY worker remains disabled;
M4.2 stays OPEN and M4.3 has not started. Public number tokens versus
PostgreSQL BIGINT and diagnostic resource-ID ambiguity remain P2.

Verification for this verifier-only increment: both focused planning suites
pass 7/7 tests; `pnpm check` passes formatting, TypeScript project references,
type-aware linting and all 795 tests across 74 suites. The command still exits
at the existing 90% aggregate coverage threshold: statements 88.20%,
branches 82.89%, lines 88.11%.

Independent review accepted `8931825` strictly as verification of a signed
Git setup decision, not as a deployed signing service or provider capability.
It also pointed out a useful future regression: after forging a record, an
attacker can recalculate both its content fingerprint and the unsigned
authorization envelope fingerprint, but still cannot reuse the original
Ed25519 signature. The existing implementation has that signature barrier;
the stronger test and unified external error reporting are P2 follow-ups;
key lifecycle is a prerequisite for production admission. The actual verifier
increment reached 88.20% statements, 82.89% branches and 88.11% lines, as
recorded above.

This **documentation-only design increment** describes the missing trust
services before the frozen workspace-continuation design can be put into
production. A separate authenticated setup approver authorizes the exact
worktree operation; a signing service cross-checks the approved plan and
publishes an immutable signed decision. Its key does not live in the record
store or a worker. An independently administered key registry never reuses a
key ID; new grants, arming and Git permits require a key that is **currently
ACTIVE**, not merely one that was trusted when the decision was written.
Retirement blocks new effects, revocation keeps existing setup parents
blocking until independently verified recovery, and registry reads must
serialize with changes so a cached old public-key list cannot authorize a
new effect. `approvedBy` remains plain text until the signing service proves
its link to an authenticated approver.

A separate trusted generation issuer must bind one durable execution
generation to the exact scope, run, task, attempt, workspace, setup parent and
supervised worker. Revocation is irreversible and checked by both scheduler
resume and provider permit entry; it does not by itself prove that a spawned
process or Git command has stopped. Only independent supervisor containment
and proof of quiescence may allow orphan settlement or the privileged parent
to child handoff. The new design document gives failure and race outcomes for
publication loss, key rotation/revocation, generation issuance/revocation,
cancellation and an in-flight Git callback. It changes no schema, runtime
contract, provider or worker. The approved continuation design is marked
frozen but still incomplete in code; actual signer, key registry, generation
issuer, atomic setup admission, dedicated Git permit and production worker
remain unimplemented. M4.2 stays OPEN, M4.3 not started. Public number tokens
versus BIGINT and diagnostic resource-ID ambiguity remain P2.

## Coverage that measures executed code

The root test command uses V8 to measure code executed within Vitest. Previously
it counted several entry points at zero coverage even though their behavior is
tested in a different process: the CLI-style Temporal worker startup and the
standalone external smoke script. Temporal executes its workflow bundle in an
isolated runtime, so its extensive workflow integration tests cannot attribute
executed lines back to the original source file in the root V8 report. These
three paths are now excluded only from this coverage denominator; existing
integration tests still run. Two unused legacy adapters (the old Scenario A runner and a trivial
bootstrap activity) are likewise excluded rather than reported as untested
production logic.

Real runtime logic remains measured. New direct tests exercise the approved
package-script verifier's pinned Docker image, argument/environment boundary
and failures; the repository resource resolver's existing identities, nested
project ownership and rejection outside approved roots; and the Temporal
worker factory's activity requirement, configuration and idempotent shutdown.
The coverage gate retains 90% for statements, functions and lines and sets
branches to 85%, matching the present measurable baseline rather than ignoring
SQLite/PostgreSQL provider branches merely to attain 90%. This gives a passing
check today while leaving those provider error paths visible as future test
work. This coverage maintenance does not enable the GLOBAL_READY worker or
complete M4.2: trusted signing and generation, atomic setup admission and the
Git permit/continuation remain outstanding.

Validation now completes with `pnpm check`: formatting, TypeScript project
references, type-aware linting, and all 805 tests in 77 test files pass.
Coverage is 92.06% statements, 85.65% branches, 94.19% functions and 91.98%
lines against the 90/85/90/90 thresholds respectively. The historical
90%-branch goal remains future test work on actual persistence and production
composition error paths, rather than an excuse to exclude them from the report.

## Closing the setup trust design's revocation boundaries

Independent review of the documentation-only setup trust and execution
generation proposal at `f0e0fc0` accepted its principal separation, generation
issuance and revocation rules, and lock direction, but identified two missing
authority decisions. This revision fixes the **design contract**, not the
runtime: the trusted key state, individual setup decision/authorization
revocations, and policy version all belong to one durable registry revision
and read/write serialization domain. Each setup grant, arm, dedicated Git
permit, parent-to-child handoff and first child launch holds the registry read
serialization through its scope/run transaction and validates current trust;
registry changes take the same write serialization. Thus a revocation and a
new authority grant have a real winner order even if different components
operate them. No provider or worker implements that registry yet.

After Git worktree creation, independent quiescence proof alone cannot grant an
execution child if the setup key was retired or revoked, or its exact decision
or authorization was revoked. Handoff must check current trust before issuing
the child token. A committed handoff does not start the agent: the first launch
checks trust again and records a once-only launch identity; a retired/revoked
key before actual start prevents the runner from reaching a mutation sink.
Once the child really started, ordinary key retirement does not undo its
separately approved execution authority, but an emergency key revocation or
individual decision/authorization revocation also fences the descendant:
future resumes and permits stop, its generation is revoked, and outstanding
effects require independent containment and recovery. The frozen continuation
design now states that registry locking precedes its existing scope-then-run
order. Failure cases and required concurrency tests cover these boundaries.
At the time of this design revision, it still awaited independent approval;
the review described below subsequently approved the design, while the
implementation remains incomplete. M4.2 remains OPEN and the GLOBAL_READY
worker remains disabled.

## PostgreSQL trust-registry and execution-generation storage foundation

The independent review of `3da3986` approved the unified trust-registry and
execution-generation **design**, not its implementation. The next increment
reserves durable PostgreSQL storage through an installer-owned, separately
versioned migration 7. Earlier migrations and their checksums stay unchanged.
The new singleton registry starts at revision zero with policy `UNCONFIGURED`;
separate tables reserve immutable key identities and their states, exact
decision/authorization revocations, and execution-generation identities and
states linked to a scope and parent claim. These are storage slots, not a
trusted signer, a functioning issuer, or permission to start Git or an agent.
The runtime PostgreSQL login can only read all four new tables, just as it can
only read the workspace-phase table; it cannot create a key, revoke an
authorization, issue a generation, or modify one. Migration startup verifies
the new table shapes and privileges and rejects an unmigrated version 6.

For steady-state PostgreSQL scope operations, a transaction now takes a
schema-specific shared trust advisory lock **before** the scope and run locks,
reads the registry singleton, and holds that lock through commit. A restricted
administrator will have to take the matching exclusive lock before changing
trust state; an administrator interface and its enforceable permission model
are not yet implemented. Real PostgreSQL tests pause each side in turn and
check `pg_blocking_pids`: an administrator-style update wins before a permit,
or an in-progress permit holds its trust read until commit and the update waits.
Other tests show that the owner migration preserves recorded generation rows,
the runtime cannot edit them or the registry, and an accidental runtime INSERT
grant is detected and repaired. The registry is initially unconfigured; none
of these tests assert that it authenticates an approver or enforces key
revocation on an existing ordinary claim.

SQLite does not have a role-separated, independently protected registry here.
It remains fail-closed for the proposed trusted setup path; no in-database
worker-writable table is presented as a replacement for an external trust root.
Restricted trust administration, one-live-generation issuance and revocation,
separate setup approval, atomic setup-parent admission, dedicated Git permits,
handoff and the production worker remain to be implemented and independently
tested. The GLOBAL_READY production worker remains disabled, M4.2 is OPEN and
M4.3 has not started. Public number tokens versus BIGINT and diagnostic
resource-ID ambiguity remain P2.

Verification: `pnpm check` passes formatting, TypeScript project-reference
checks, type-aware lint and all 808 tests in 77 files. Coverage remains above
the configured gates: 92.04% statements, 85.63% branches, 94.18% functions
and 91.97% lines. The focused real PostgreSQL suite passes 104/104 tests.

## Restricted PostgreSQL trust writers and generation issuer

The independent review of `242e014` accepted the PostgreSQL version 7
storage and trust-lock **foundation**, while confirming that a migration owner
could still edit the registry without honoring the advisory lock. This next
increment adds a separate version 8 migration without modifying earlier
migration checksums. It installs two installer-owned PostgreSQL functions with
restricted entry points. A separately provisioned trust administrator may
register, retire or revoke a key, revoke an exact setup decision or signed
authorization, or change the policy version. Each real change advances the
same durable registry revision under the exclusive trust lock; an exact retry
does not advance it again, and a retired or revoked key cannot become active
again. An independently provisioned generation issuer may record one live
execution generation tied to an active scope, bound active run, active parent
claim and matching workspace-phase evidence, or irreversibly revoke it.
Generation issuance holds the shared trust lock before the scope and run locks.
The PostgreSQL runtime login still has only read access to the trust and
generation tables and cannot execute either administrator function. The two
restricted logins have no direct authority-table write access and can execute
only their respective installer-owned functions. Startup checks the functions'
signature, ownership, execution grants and security settings; the installer
can repair an accidental runtime grant. The migration owner retains its
separate administrative privileges and must remain protected operationally.

Real PostgreSQL tests verify role isolation, immutable key and generation
identity, idempotent registry revisions and revocation, scope-lock contention,
and both winner orders between a restricted registry writer and a live
mutation permit by inspecting `pg_blocking_pids`. Test fixtures seed a marked
setup parent with the migration-owner login because no production operation
can yet create that parent. These restricted write APIs are **not** a signer
identity service or a production generation supervisor: caller authentication,
key/decision verification against the live registry, generation checks in
all permit and scheduler paths, independently protected SQLite trust state,
atomic setup-parent admission, dedicated Git permits, handoff and production
worker execution are still missing. The GLOBAL_READY worker remains disabled,
M4.2 is OPEN, and M4.3 has not started. Public number tokens versus BIGINT and
diagnostic resource-ID ambiguity remain P2.

Verification: `pnpm check` passes formatting, TypeScript project references,
type-aware lint and all 812 tests in 77 files. Coverage is 92.00% statements,
85.68% branches, 94.19% functions and 91.92% lines, above the configured
90/85/90/90 gates. The focused real PostgreSQL suite passes 108/108 tests.

## Closing the restricted-writer privilege audit gaps

An independent review of `0c1a6c6` found two ways an accidentally broadened
database grant could escape the version 8 checks. First, a trust administrator
or generation issuer granted direct write access to `forge_runs`,
`forge_records` or the migration ledger could change authority data without
using its restricted function. The writer connection and runtime startup now
check effective table and column mutation privileges across **every authority
table**, including those three base tables. An installer rerun removes direct
writer grants across the entire table set; it also checks that no writer column
grant survives. Real PostgreSQL tests misgrant each base-table privilege and a
run-state column privilege, then verify rejection and repair.

Second, a third role granted EXECUTE on an installer-owned security-definer
function could invoke it without the designated writer login. The installer
now records the two designated writer-role identities as owner-controlled
function metadata, without changing the already applied migration statements
or their checksums. Runtime startup compares each function's complete EXECUTE
ACL against its recorded role: only the function owner and its one designated
writer are allowed. If the functions have not been configured with writer
roles, only the owner may execute them. A migration rerun preserves this
binding and **fails closed** on an additional third-party grant rather than
silently accepting or reassigning the writer identity. A real PostgreSQL test
grants another login schema access and EXECUTE, verifies both startup and
installer rejection, then confirms startup succeeds after the owner removes
the grant. The migration owner remains a separate trusted administrator.

This repairs the two reviewed privilege-audit gaps; it does not turn the
restricted functions into a signer, trusted generation supervisor or production
setup admission. SQLite still lacks an independently protected trust root,
and the GLOBAL_READY production worker remains disabled. M4.2 stays OPEN and
M4.3 has not started. Number-token/BIGINT and diagnostic resource-ID issues
remain P2. Verification: `pnpm check` passes formatting, TypeScript, type-aware
lint and all 814 tests in 77 files; coverage is 91.98% statements, 85.73%
branches, 94.20% functions and 91.90% lines against the 90/85/90/90 gates.
The focused real PostgreSQL suite passes 110/110 tests.

## Closing inherited authority on restricted PostgreSQL writer roles

Independent review accepted the direct table-write and function-ACL checks in
`eebbeaf`, but found one remaining privilege path: PostgreSQL role membership
can give a third party the ability to execute a security-definer function even
when the function's own grant list names only its designated writer role. For
example, granting the trust-administrator role to another login lets that login
inherit EXECUTE or switch into the administrator role. The same risk applies to
the generation issuer.

Installation and runtime startup now inspect PostgreSQL's role-membership
records for **both** designated writer roles. Either direction of membership
is rejected: another role may not inherit a writer role, and a writer role may
not inherit another role. The writer connections apply the same restriction to
their own login. The installer also requires these restricted writer roles to
be login roles. The response is deliberately fail-closed: the migration does
not silently revoke a role grant that belongs to the deployment's DBA or
identity administrator. After that administrator removes the grant, startup
works again. Previously installed migration statements and the trust and
generation state machines are unchanged.

Real PostgreSQL tests cover both the trust administrator and the generation
issuer. An outside login demonstrably inherits function EXECUTE, can assume
the writer role, and can reach the security-definer entry point before the
drift is removed. For each role, startup and migration rerun reject the
incoming grant; writer connection rejects it too. They also reject the reverse
membership direction, and startup and writer connection recover after both
grants are revoked. This closes the reviewed membership path but does not
create a trusted signer, a supervisor, an atomic setup admission, or a
production-ready global worker. SQLite still has no independent trust root;
M4.2 remains OPEN and M4.3 has not started. Public number-token/BIGINT and
diagnostic resource-ID ambiguity remain P2.

Verification: `pnpm check` passes formatting, TypeScript project references,
type-aware lint and all 816 tests in 77 files. Coverage is 92.00% statements,
85.77% branches, 94.20% functions and 91.92% lines against the 90/85/90/90
gates. The focused real PostgreSQL suite passes all 112 tests.

## Inspecting current Git setup trust inside PostgreSQL authority

Independent review accepted the restricted PostgreSQL writer-role membership
closure in `c9d1af4`. The next prerequisite is to check a separately approved
Git workspace decision against **current** trust, not merely against a signed
document that was valid yesterday. A key may have been retired or revoked, an
individual decision or signature may have been denylisted, or the deployment's
policy may have changed before a worker requests authority. Neither a cached
signature nor a caller-provided repository path may override those changes.

The PostgreSQL global-authority adapter now offers a deliberately read-only
`inspectCurrentWorkspaceSetupTrust` operation. Under one transaction it holds
the trust registry's shared serialization lock, then the repository scope and
run locks until commit. It requires the active `git-workspace-setup-v1` policy,
an ACTIVE registered Ed25519 signing key, no exact decision or authorization
revocation, and a valid signature over a separate Git setup approval. It also
checks that the approved artifact and execution approval identify the same
persisted ACTIVE run, registered repository alias, scope, task and workspace,
including the pinned repository root. The planning package's existing signature
verifier performs the cryptographic and approval checks; the dependency and
TypeScript project reference are explicit workspace links.

The returned revision and digests are **inspection evidence only**: this method
creates no claim, execution generation, workspace phase, Git permit or ability
to perform a write. A future setup grant must repeat the checks in its own
atomic authority transaction; an inspection result cannot be redeemed later.
Real isolated PostgreSQL tests check signature/identity mismatch and durable
absence of setup residue. They pause a reader after it has taken the shared
trust lock and prove that the restricted administrator cannot commit a key,
decision, authorization or policy change first. In the reverse order, the
actual restricted writer acquires exclusive trust serialization before its
change commits: `pg_blocking_pids` shows the new reader waiting on that writer,
and inspection rejects after the change commits. This is transactional groundwork, not production setup
admission: no authenticated signing service or trusted supervisor is wired,
SQLite has no independent trust root, and the GLOBAL_READY worker remains
disabled. M4.2 remains OPEN; M4.3 has not started. Public number-token/BIGINT
and diagnostic resource-ID ambiguity remain P2.

Verification: `pnpm check` passes formatting, TypeScript project references,
type-aware lint and all 825 tests in 77 files. Coverage is 91.99% statements,
85.81% branches, 94.20% functions and 91.92% lines against the 90/85/90/90
gates. The focused real PostgreSQL suite passes 121/121 tests, and `pnpm build`
passes after adding the workspace dependency and TypeScript reference.

## Atomically admitting a PostgreSQL Git workspace setup parent

Independent review accepted the read-only current-trust inspection in
`6515d7c`, with an important condition: its result must never become a reusable
grant. A trust administrator could revoke the decision between inspection and
claim creation. This increment therefore adds a separate restricted PostgreSQL
setup-admission login for an independently authenticated signing service. The
service validates the signed, separately approved repository-only Git setup
decision against the plan and execution approval. The service login is a
privileged credential reserved for that signer, never the runtime worker; the
database does not independently implement Ed25519 verification. Its
security-definer entry point repeats current key, policy, exact-revocation,
persisted run, registered alias, approved task and workspace checks under one
trust-read → scope → run transaction. It does not redeem an earlier inspection
result.

PostgreSQL schema version 9 is appended without changing versions 1–8. The
restricted function either blocks without allocating a token, or atomically
advances a PREPARING builder attempt to STARTING while inserting a repository-
only ACTIVE setup-parent claim, its sole lease and an INITIAL_ADMITTED phase
marker. A matching STARTING retry returns the original token; a different
parent cannot reuse that attempt. Runtime retains read-only access to the
phase table and cannot execute the setup function. The installer pins the
separate setup login to the function, checks direct table writes, membership
and exact EXECUTE grants, and does not give worker credentials the signing
service's capability.

Real isolated PostgreSQL tests cover invalid signature and workspace identity,
blocked admission with no phase or token residue, exact replay and ordinary
permit rejection on the marked parent. Controlled overlap proves both commit
orders with the actual trust administrator revoking a signed decision:
`pg_blocking_pids` identifies the blocked writer or setup admission. A winning
admission commits its claim before revocation; a winning revocation leaves no
claim, phase or new token. This is **only setup-parent admission**. Issuing and
revoking its execution generation, arming workspace creation, the dedicated
single-lineage Git permit, independently proven quiescence, parent-to-child
handoff and production worker integration remain unimplemented. SQLite has no
independent trust root. GLOBAL_READY production workers remain disabled;
M4.2 remains OPEN and M4.3 has not started. The public number-token/BIGINT
boundary and diagnostic resource-ID ambiguity remain P2.

Verification: `pnpm check` passes formatting, TypeScript project references,
type-aware lint and all 828 tests in 77 files. Coverage is 91.90% statements,
85.86% branches, 94.17% functions and 91.82% lines, above the 90/85/90/90
gates. The isolated PostgreSQL suite passes 124/124 tests. No production
worker or Git operation is enabled by these results.

## Closing setup-admission privilege drift

Independent review of `62231ba` found that the new signing-service database
login could still acquire PostgreSQL `TRIGGER` or `REFERENCES` privileges, or
`CREATE` on a schema, without the setup-admission checks noticing. A trigger or
other database object created with such a grant could undermine the restricted
function boundary even though the login cannot directly update authority rows.
This is a privilege-audit correction; the version 9 migration statement, setup
claim state machine, trust lock order and production worker remain unchanged.

The signing-service connection and runtime startup now reject effective table
`TRIGGER`/`REFERENCES` and column `REFERENCES` grants in addition to the other
table and column mutation privileges. They also reject `CREATE` on any
accessible non-system schema. A migration rerun removes accidentally granted
table privileges and `CREATE` on the authority schema. Direct column grants are
checked as well: the installer either removes them through its existing
grant-repair process or refuses to proceed until the owner repairs them. A
`CREATE` grant on some other application schema is not silently revoked by
this migration; its owner must remove it before startup can succeed.

Real PostgreSQL tests grant the signing-service role table `TRIGGER` and
`REFERENCES`, column `REFERENCES`, and schema `CREATE` both on the authority
schema and on another schema. They prove that connection and startup reject
the drift, that migration reruns remove grants they own and fail closed on
unrelated-schema grants, and that startup recovers after repair. The restricted
login remains reserved for an independently authenticated signing service;
SQLite still has no independent trust root. Dedicated Git permits, generation
enforcement, handoff and the GLOBAL_READY production worker remain unfinished;
M4.2 is OPEN and M4.3 has not started. Public number-token/BIGINT and diagnostic
resource-ID ambiguity remain P2.

After closing this privilege gap, the workspace dependencies were refreshed to
their compatible current patch/minor releases: Restate SDK packages, Vitest and
its coverage provider, Oxlint/Oxfmt, Drizzle and its toolkit, and Node type
definitions. Workspace links and the pinned Pi coding-agent integration were
preserved; replacing that deprecated agent requires a separate compatibility
review. The newer lint release also required small, behavior-preserving
function-scoping changes in the Docker command sandbox and immutable plan-store
tests. `pnpm check` now passes formatting, TypeScript project-reference builds,
type-aware lint and all 833 tests across 77 files; statement, branch, function
and line coverage are 91.96%, 85.86%, 94.21% and 91.88%, respectively, above
their 90/85/90/90 thresholds. The isolated PostgreSQL suite passes 129/129,
and `pnpm build` passes after the dependency refresh. These checks do not
change the unfinished M4.2 production boundaries described above.

## Closing system-schema and cross-authority capability gaps

Independent review of the two commits from accepted baseline `6515d7c` through
local `2940d3c` accepted the earlier table and column privilege repairs and
dependency refresh, but found two remaining setup-login privileges that could
escape its connection checks. The `CREATE` check excluded system schemas,
including PostgreSQL's `pg_catalog`, which is in the security-definer function's
search path. Also, the signing-service connection checked its own setup
function but not whether the same login could execute the separate trust or
generation writer functions. A grant made after runtime startup could therefore
cross authority boundaries even if that earlier startup audit had passed.

Both setup-login connection and global runtime startup now reject `CREATE` on
**any** schema, including `pg_catalog`; a migration rerun does not try to
change system or other externally owned schemas. The setup-login connection
also requires exactly its own setup routine to be executable and verifies that
neither `forge_trust_write` nor `forge_generation_write` can be executed with
those credentials. Real PostgreSQL regression tests misgrant `pg_catalog`
`CREATE` and each other function's `EXECUTE`, prove connection and startup
refuse them, then prove the independent administrator can revoke the grants
and restore operation. Migration reruns fail closed for these unauthorized
privileges. No versioned migration statement or setup claim transaction was
changed. `pnpm check` passes formatting, TypeScript, type-aware lint and
836/836 tests in 77 files; coverage is 91.96% statements, 85.88% branches,
94.21% functions and 91.89% lines against 90/85/90/90 thresholds. The
PostgreSQL suite passes 132/132. This code still needs independent review;
M4.2 remains OPEN, the GLOBAL_READY production worker remains disabled, and
dedicated Git permits, generation enforcement, handoff and the SQLite trust
root are not implemented.

## Arming an admitted PostgreSQL Git workspace without starting Git

Independent review accepted `dee1a10` as the narrowly scoped PostgreSQL setup-parent admission and privilege boundary. An admitted parent is still only marked `INITIAL_ADMITTED`: even its repository lease cannot be used through an ordinary mutation permit. Before a supervised worker could create a Git worktree, a separately restricted generation issuer must bind a durable execution generation to that exact scope, parent claim, run, task, attempt, workspace and the approved setup and execution plan digests. The issuer's existing operation records the generation as `ISSUED` and links it to the phase; a later revocation is irreversible. This is an authorization prerequisite, not proof that a process is running or has safely stopped.

PostgreSQL migration version 10 appends a restricted, security-definer arming operation without altering migrations 1–9. The signing-service role, never the worker role, calls it after checking the signed setup decision. In a single transaction the database holds current-trust read serialization before locking the registered scope and bound run. It requires the active policy and signing key, no exact decision or authorization revocation, a GLOBAL_READY active scope, an ACTIVE run and repository-only setup parent, exact approved task and workspace identity, and the matching `ISSUED` generation. Only then does it change `INITIAL_ADMITTED` to `WORKSPACE_ARMED`. An identical retry is harmless; missing or revoked generations, cancelled runs and withdrawn approvals fail closed without changing the phase. Runtime access to the phase and generation tables remains read-only, and the setup role receives only its explicitly audited arming function in addition to its existing admission function.

`WORKSPACE_ARMED` does **not** grant Git permission: the marked parent still rejects every ordinary mutation permit, release and reclaim. The dedicated single-lineage Git permit, supervised callback and uncertainty handling, signed quiescence evidence, parent-to-child handoff, SQLite trust root and production GLOBAL_READY worker remain unimplemented. M4.2 stays OPEN; M4.3 has not started. Public number-token/BIGINT and diagnostic resource-ID ambiguity remain P2. The real isolated PostgreSQL suite passes 136/136 tests, including arming before/after generation issuance, exact retries, generation and trust revocation, run cancellation, rejection of the ordinary Git permit, and rejection when the persisted run's approved base commit is altered. `pnpm check` passes formatting, TypeScript project references, type-aware lint and 840/840 tests in 77 files; statement, branch, function and line coverage are 91.94%, 85.88%, 94.22% and 91.86% against 90/85/90/90 thresholds.

## A dedicated, one-lineage PostgreSQL workspace Git permit

Independent review accepted `d2335c3` as the narrow arming prerequisite: the workspace parent can reach `WORKSPACE_ARMED`, but the ordinary mutation port must still reject it. The next step therefore adds a **separate** PostgreSQL permit for precisely one Git workspace-create callback. Migration version 11 only appends new objects; versions 1–10 are unchanged. A new lineage table records one permit per parent with a unique permit ID, exact owner, token, execution generation and workspace, a hash of a randomly generated completion secret, and completion status. The runtime can only read this table. Only the independently authenticated signing service's restricted login can invoke the two new security-definer operations; the worker cannot invoke them or directly modify the lineage or phase tables.

Before returning the secret, the begin operation holds the current-trust read lock, then locks the registered scope and bound run. It requires the active signing key and policy, unrevoked exact decision and authorization, an ACTIVE run with its unchanged approved artifact, repository and task/workspace identity, the repository-only ACTIVE parent and `WORKSPACE_ARMED` marker, and the exact `ISSUED` generation including supervisor identity. It records the sole lineage before returning a completion capability. A second request, even from another signing-service connection or after the lineage completes, cannot mint a second permit. The signing-service adapter verifies the signed setup decision before calling the database; the database repeats the current trust and persisted authority checks inside the permit transaction. The signing-service credential remains a separate trust boundary and must never be supplied to a worker.

After the callback, presenting that exact secret and nonempty outcome evidence changes the parent to `HELD_UNCERTAIN`, the marker to `WORKSPACE_UNCERTAIN`, and the lineage to completed **in one transaction**. If recording uncertainty fails, the lineage remains pending and the callback cannot be rerun through a new permit. Even a successful callback is uncertain until an independent service proves actual Git state and quiescence. Real isolated PostgreSQL regressions cover generation and phase prerequisites, wrong supervisor/version/secret, duplicate issuance across connections, lack of generic or runtime permit authority, cancellation before Git, and failure to record uncertainty leaving exactly one pending lineage. The callback helper is a restricted-service boundary, not production worker integration. No signed quiescence proof, parent-to-child handoff, SQLite trust root, final safe release, or GLOBAL_READY production worker is implemented; M4.2 remains OPEN and M4.3 has not begun. Public number-token/BIGINT and diagnostic resource-ID ambiguity remain P2.

The two commit orders for permit issuance versus generation revocation were also held at real PostgreSQL locks. `pg_blocking_pids` identifies the waiting transaction: if issuance commits first, it leaves one lineage and the later revocation cannot erase it; if revocation commits first, issuance is denied without a lineage. The isolated PostgreSQL suite passes 141/141. `pnpm check` passes formatting, TypeScript project references, type-aware lint and 845/845 tests in 77 files. Statement, branch, function and line coverage are 91.87%, 85.88%, 94.24% and 91.79%, respectively, above the 90/85/90/90 thresholds. This increment awaits independent review and does not close M4.2.

## Inspecting real Git state before any workspace handoff

Independent review accepted `e7b321d` as the narrow PostgreSQL v11 permit boundary. It can record one Git workspace-creation attempt and keep the repository-wide setup parent uncertain, but it cannot yet prove what Git actually created or that the original worker and every descendant can no longer write. A successful Git callback, a completed permit or a saved workspace path is not that proof. The parent must continue blocking other mutations.

The `workspace-git` library now has a read-only `GitWorkspaceStateInspector`. Given the saved initial workspace record and the repository root and base commit approved before Git creation, it independently reads the actual worktree and integration repository. It resolves their canonical paths and Git common directory, checks that the worktree belongs to that repository rather than another Git repository at the same path, checks its symbolic branch and both HEAD and branch commit against the pinned base commit, and rejects tracked, untracked or ignored changes. It also rejects a workspace record that has moved beyond its initial revision. Tests use real temporary Git repositories and deliberately replace a worktree with a different repository, detach or move HEAD, change the expected branch or base, and introduce files. No new PostgreSQL migration, mutation permission or production worker entry point is involved.

This result is **an observation, not a signed quiescence attestation or an authority capability**. Git could change between separate inspection commands or afterward unless an independently authenticated supervisor has already durably revoked the execution generation, contained every process and descendant, and maintained that fence through the eventual handoff transaction. The inspector neither proves external process termination nor authenticates a recovery principal. Orphan-permit settlement, signed proof and freshness checks, evidence-backed abandonment, atomic parent-to-child handoff, SQLite's independent trust root and production `GLOBAL_READY` worker remain unimplemented. M4.2 stays OPEN; M4.3 has not started. Public number-token/BIGINT and diagnostic resource-ID ambiguity remain P2. All five focused real-Git inspection tests pass. `pnpm check` passes formatting, TypeScript project references, type-aware lint and 850/850 tests in 78 files. Statement, branch, function and line coverage are 91.89%, 85.91%, 94.26% and 91.81%, above the 90/85/90/90 thresholds.

## Rejecting nested Git worktrees during initial-state inspection

Independent review found a gap in the inspector: it rejected identical worktree and integration paths, but a real linked worktree created **inside** the approved integration repository still passed all the Git identity, pinned-base and cleanliness checks. A missing nested path in the earlier test did not exercise this case. The inspector now compares canonical paths by directory components and rejects containment in **either** direction; sibling paths with similar name prefixes remain separate. Real Git tests create linked worktrees inside the integration repository and inside an existing worktree and verify rejection, while the normal sibling worktree still passes. The returned `clean` observation describes only the linked worktree, not the integration repository. All seven focused real-Git tests and `pnpm check` pass: 852/852 tests in 78 files, with 91.89% statement, 85.93% branch, 94.27% function and 91.81% line coverage against 90/85/90/90 thresholds. This fix adds no authority capability or PostgreSQL change: independent quiescence, handoff and the production `GLOBAL_READY` worker remain unimplemented, so M4.2 stays OPEN and M4.3 has not started.

## Reading a consistent workspace-setup recovery snapshot

Independent review accepted `ec392708` as the real-Git initial-state inspector and its nested-worktree correction. Recovery still needs to distinguish the database's durable facts from proof that an external process stopped. The PostgreSQL global authority now offers `recoverWorkspaceSetupEvidence(scopeId, parentClaimId)` as a **read-only snapshot** for an independently authenticated future recovery service. It obtains the same shared trust-registry serialization before locking the scope and bound run, then reads the exact setup parent, repository-only lease, phase, approved run/task/STARTING attempt, execution generation, one Git permit lineage and optional saved initial workspace. It checks that their scope, owner, workspace and approved execution-plan identities agree; mismatches fail closed. Its result contains the permit ID and completion status, **never** the completion secret. A lost callback may therefore be identified without acquiring a new permit or silently clearing the old one.

This snapshot neither authenticates a recovery principal nor attests that a worker, its descendants or Git can no longer write. It does not settle an orphan permit, close an uncertain parent, grant an execution child or use the separately read Git inspection as authority. The independent generation-revocation and supervised non-resumability proof, signed Git attestation with freshness checks, privileged settlement and atomic parent-to-child handoff remain necessary. PostgreSQL migrations, grants, SQLite and production worker startup are unchanged; M4.2 remains OPEN and M4.3 has not started. Real isolated PostgreSQL tests cover INITIAL_ADMITTED, a pending Git permit, revocation, WORKSPACE_UNCERTAIN, an optional saved initial workspace and rejection of mismatched generation or workspace records without clearing the parent or its permit. `pnpm check` passes formatting, TypeScript project references, type-aware lint and 854/854 tests in 78 files; statement, branch, function and line coverage are 91.85%, 86.13%, 94.27% and 91.77%, above the 90/85/90/90 thresholds.

## Supervising a containerized workspace writer before recovery inspection

Independent review accepted `7766fcc` as a consistent **read-only** PostgreSQL recovery snapshot, while emphasizing that database and Git observations do not establish that an old writer and all its descendants can no longer mutate files. The frozen continuation design chooses a generation-exclusive container under an independent supervisor, rather than a heartbeat, single process ID or a worker's self-reported stop. This increment adds `DockerWorkspaceGenerationSupervisor` in `workspace-git` as a separately held Docker-daemon boundary. It launches a writer container from a SHA256-pinned image with no network, privileged mode, host PID namespace, capabilities or Docker socket, a read-only container root and one writable bind mount for the canonical workspace. The supervisor records the exact scope, parent, generation and workspace labels and checks the container ID, mount and containment settings before starting a process. A deterministic generation-specific container name prevents its own API from recreating the same generation while the stopped container remains registered. Only the independent supervisor may have Docker-daemon credentials; a worker with such credentials lies outside this boundary.

After a **separate durable generation revocation**, the supervisor can kill the container, wait for exit and inspect that the same container remains exited and non-restarting. It also pins the worktree directory's device and inode at launch, rejecting a replaced directory at later checks. A second read-only helper checks the same container and directory both before and after the existing real-Git initial-workspace inspection. A real optional Docker test runs an actual child process that repeatedly writes through a linked Git worktree, proves the writes stop after container termination, refuses relaunch with the same generation, checks the initial Git state and rejects a replaced workspace directory; the test is enabled with a locally available digest-pinned `FORGE_TEST_DOCKER_IMAGE`. Environments without Docker still test image, supervisor identity, command and workspace validation before a Docker process can be started. `pnpm check` passes formatting, TypeScript project references, lint and 856 tests across 79 files (one optional Docker integration test skipped), with statement, branch, function and line coverage of 90.95%, 85.12%, 93.53% and 90.85%, above the 90/85/90/90 thresholds. The real Docker test also passed separately against the locally available pinned Node image.

This is still **an observation, not signed quiescence or a handoff capability**: the supervisor is not wired to the PostgreSQL issuer, no authenticated recovery principal binds its container to the durable generation, and the returned Docker/Git observations are not durably signed or checked within an atomic authority transition. A daemon administrator could restart or remove a stopped container, so the independent supervisor must keep the daemon unavailable to workers throughout recovery. Orphan Git-permit settlement, signed freshness-bound attestation, an atomic uncertain setup-parent to execution-child handoff, production `GLOBAL_READY` worker admission and SQLite's protected trust root remain unimplemented. M4.2 stays OPEN; M4.3 has not begun. Public number-token/BIGINT and diagnostic resource-ID ambiguity remain P2.

## Observe a stopped PostgreSQL workspace generation independently

The independently reviewed `62490f4` Docker-supervisor increment established a way to observe a stopped container and inspect a real Git worktree, but it did not connect those observations to the durable execution generation in PostgreSQL. This increment adds a separate recovery-process composition in `apps/temporal-worker/src/postgres-workspace-recovery.ts`. It connects with two different restricted PostgreSQL logins: the ordinary global-authority reader and the generation issuer. The latter is never passed to the production legacy worker. The factory also requires the same database schema for both logins and a separately held Docker-supervisor identity; it does not change the existing worker startup path or permit `GLOBAL_READY` execution.

Given a supervised container identity, the observer first checks that PostgreSQL's read-only setup-parent snapshot binds the same scope, parent, workspace, generation and supervisor. It **durably revokes the generation before asking the Docker supervisor to stop the container**. After stopping, it reads PostgreSQL again and requires a revoked generation, the same completed dedicated Git permit, an uncertain parent in `WORKSPACE_UNCERTAIN`, an active approved run and its initial saved workspace. It checks the saved workspace against the approved run and task binding; the Docker supervisor then checks the container is stopped before and after the existing read-only real-Git inspection. Finally, the observer rereads the approved run and PostgreSQL authority and refuses to return an observation if the generation, permit, workspace, parent token/version, signing metadata or approved Git identity changed. Canonical filesystem paths are compared so a platform path alias cannot make an unchanged workspace appear different. All resulting data are observations, never a reusable grant.

The new worker-side unit tests cover ordering, issuer failure, pending permits, missing durable identity and changes during Git inspection. A separate test boots an isolated real PostgreSQL server, creates a real Git repository and linked worktree, seeds an already-completed setup state through the migration-owner **test fixture only**, and checks that the restricted generation issuer records `REVOKED`, the parent remains `HELD_UNCERTAIN`, and no child claim appears. Its Docker-supervisor surface is mocked; the earlier optional real-Docker test independently verifies actual descendant shutdown and workspace containment. `pnpm check` passes formatting, strict TypeScript project references, lint and 861 tests across 81 files (one optional Docker test skipped). Statement, branch, function and line coverage are 90.90%, 85.29%, 93.56% and 90.80%, above the 90/85/90/90 thresholds. `pnpm build` passes after adding the PostgreSQL workspace dependency and TypeScript project reference.

This recovery observer **does not create signed or independently authenticated quiescence evidence**, settle a lost Git completion secret, release the uncertain setup parent, admit the execution child, or run any builder/repair/integration activity. The generation's durable revocation and the Docker stop are separate operations, and the observations are not held under a single cross-system lock. The actual production `GLOBAL_READY` worker remains disabled; a separate recovery deployment must isolate issuer and Docker credentials from writers. SQLite still lacks the required protected trust root. M4.2 stays OPEN and M4.3 has not started; the public number-token/BIGINT boundary and diagnostic resource-ID ambiguity remain P2.

## Signed recovery, orphan Git permits and atomic PostgreSQL handoff

Independent review accepted `6f807ac` as an observation-only recovery process. An observation cannot authorize a new writer: a lost Git completion response may leave the sole permit pending, and even a completed permit leaves its repository-wide setup parent uncertain. The frozen continuation design requires an independently authenticated recovery principal to revoke the old execution generation, stop its supervised container and descendants, inspect the actual Git worktree, and preserve that non-resumability while handing authority to a different claim. The old parent's repository permission must never be silently reused as the builder's permission.

The separate recovery process now creates a short-lived, domain-separated Ed25519 attestation from its PostgreSQL, stopped-container and real-Git observations. It binds the parent, owner, token, workspace revision, generation and supervisor, exact Git permit lineage, approved setup and execution plans, and canonical Git paths, HEAD, branch and base commits. Its verifier rejects a changed signature, unknown key or expired proof. This signature is evidence from a separately held recovery signing key, **not** a grant by itself. The recovery login and Docker-daemon credentials must be isolated from workers and from the setup signing service; the PostgreSQL functions cannot verify Ed25519 internally and therefore trust only that restricted recovery service to invoke them after independent verification and live reinspection.

PostgreSQL migration version 12 appends the settlement and handoff records and two restricted security-definer functions; migrations 1–11 remain unchanged. The runtime can still only read setup phases and Git permit lineages, while the independent recovery role receives audited execution rights without direct authority-table writes. Both operations serialize current trust before locking the scope and bound run. Settlement checks the exact revoked generation, parent, permit and current approval; it can close the one pending Git lineage after independent recovery or record evidence for an already completed lineage. Neither case issues another permit. Handoff requires the settled uncertain parent, unchanged approved ACTIVE run and STARTING attempt, saved initial workspace, current active trust and no unresolved permit. It checks competing leases under the scope lock. When there is no blocker, one database transaction releases the repository-only parent, increments the scope token, creates an ACTIVE child with **only** its separately approved execution resources and records `HANDOFF_COMMITTED` with the exact attestation identity and digest. A blocked or cancelled handoff leaves no child or token residue. An identical still-current child can be recovered after a lost response, while a different digest is refused.

Real isolated PostgreSQL tests verify execution-only child leases, denied ordinary parent permits, allowed child permits only for approved resources, blockers and cancellation without residue, forged fingerprints and wrong proof digests, exact replay, and an actual `pg_blocking_pids` cancellation/handoff wait. An isolated PostgreSQL plus real linked-Git test exercises both completed and orphaned Git lineages through the signed recovery service and its restricted login, including replay; a pinned-image real Docker run is optional, while separate Docker tests have already verified descendant shutdown. `pnpm check` passes formatting, TypeScript project references, type-aware lint and 866 tests across 82 files (one optional Docker test skipped). Statement, branch, function and line coverage are 90.76%, 85.44%, 93.60% and 90.66%, above the 90/85/90/90 thresholds. `pnpm build` also passes.

This establishes an authority transition and a recovery-service boundary, **not a production execution rollout**. The recovery public key is pinned in the independently configured service rather than registered in PostgreSQL; its role credential and Docker-daemon control are deployment trust boundaries, and a daemon administrator could invalidate the stop observation if those credentials are not isolated throughout the database commit. PostgreSQL rechecks current trust and durable identity inside each transaction but does not itself validate the signature or the external container/Git facts. Agent launch and completion, repair, dynamic resource expansion, Git integration, final safe release and SQLite's independent trust root remain unwired. The legacy production worker still refuses `GLOBAL_READY`; M4.2 remains OPEN and M4.3 has not started. Public number-token/BIGINT and diagnostic resource-ID ambiguity remain P2.

## Recover a committed execution child for fenced agent tools

Independent review accepted the `e0b6341` recovery and atomic handoff, but accepting a handoff does not yet run an agent safely. The setup parent has already surrendered its repository-wide Git authority; the new child owns only the separately approved execution resources. The old production builder still tries to acquire local leases, create a Git worktree again and start a legacy attempt, so it must not be used for this child.

PostgreSQL now exposes a **read-only child attachment** operation. Under the existing current-trust shared lock, scope lock and bound-run lock it checks the released parent, committed handoff and exact active child; the current ACTIVE signing key and nonrevoked setup decision/authorization; the ACTIVE registered run, approved task, STARTING or RUNNING builder attempt, saved initial workspace and revoked setup generation; the completed Git lineage; and child leases matching precisely the approved execution plan. It neither creates another claim nor copies the parent's repository lease. Before issuing each ordinary fenced mutation permit, PostgreSQL now also locks and checks the ACTIVE run and current child trust. A cancelled run, revoked setup trust or uncertain child cannot authorize the next write.

A separate worker-side `PostgresExecutionChildTools` boundary attaches an agent request to that exact persisted child and supplies a mandatory `FencedMutationPort` context to `AgentToolRuntime`; its local write guard refuses fallback leases. A real isolated PostgreSQL and linked-Git test attaches once, writes an approved file, reconnects with an independent authority connection and writes again, then routes a controlled Pi `forge_write` tool callback through the permit. A repository-wide command is denied because this child only has project authority. Revoking the signing key, requesting run cancellation, or marking the child uncertain prevents subsequent writes and reattachment before modifying the target file. `pnpm check` passes formatting, TypeScript project references, type-aware lint and 866 tests across 82 files (one optional Docker test skipped). Statement, branch, function and line coverage are 90.71%, 85.63%, 93.37% and 90.61%, above the 90/85/90/90 gates.

This is a **fenced tool-attachment seam**, not an enabled production builder. The Pi test uses a controlled in-process gateway; it does not prove a real Pi session cannot write directly to its workspace outside the tool broker. The isolated Docker image currently has no network access to a PostgreSQL permit broker. Legacy builder/repair attempt transitions, dynamic resource expansion, Git integration, completion and final safe claim release still lack a complete global path. Consequently the existing production worker continues to reject `GLOBAL_READY`; M4.2 remains OPEN, M4.3 has not started, and SQLite still lacks an independent protected trust root. The public number-token/BIGINT boundary and diagnostic resource-ID ambiguity remain P2.

## Persist the execution child's builder lifecycle without legacy admission

Independent review accepted `084a07a` as the fenced tool-attachment boundary. The next missing piece was recording that an agent had started and deciding what ownership should remain when it returned. Calling the old persistence path would try to admit a legacy writer after cutover, so the new `PostgresExecutionChildRunner` uses child-specific PostgreSQL lifecycle operations instead.

Before calling any external runner, it atomically reserves the launch by changing the approved STARTING attempt to RUNNING with a unique launch-reservation session reference. The real session callback replaces that reservation using an exact revision and prior-session check before tools are dispatched. A duplicate request cannot reuse the old STARTING revision to launch another session. Recovering an already RUNNING attempt does not launch a replacement: it records UNKNOWN and retains the child as HELD_UNCERTAIN until independent recovery determines what happened to the previous session.

Terminal attempt state and claim ownership are written in one existing trust/scope/run transaction. A normal return alone is not evidence that every external writer has stopped. Ordinary release requires independently supplied stop confirmation, a still-current ACTIVE run and child trust, and no unresolved mutation permits. Missing or failed confirmation, uncertain session loss, cancellation, or an in-flight permit keeps ownership HELD_UNCERTAIN. The lifecycle never creates another worktree, obtains local leases or calls the legacy builder admission. Historical migrations and database privileges are unchanged.

Nine real PostgreSQL and linked-Git integration cases cover tool takeover, successful completion, session failure, cancellation, restart, unresolved permits, missing stop confirmation and a duplicate execution request while a launch reservation is present. They verify persisted session revisions, terminal attempt states, ownership and unchanged forbidden files through independent connections. `pnpm check` passes formatting, TypeScript references, type-aware lint and 873 tests in 82 files, with one optional Docker test skipped. Statement, branch, function and line coverage are 90.70%, 85.50%, 93.40% and 90.60%, above the existing 90/85/90/90 gates; the compiled CLI/worker acceptance tests also execute the package and application builds successfully.

This remains an explicit global-only execution seam with controlled test runners. Its stop confirmer is an injected independent-service boundary, not a deployed authenticated supervisor, and a real isolated Pi gateway with a fenced tool broker is still missing. Terminal response-loss retries currently fail closed rather than recovering an already committed terminal outcome. Production startup still rejects GLOBAL_READY: repair, dynamic resource expansion, Git integration and cancellation recovery need their complete global execution paths before cutover. M4.2 remains OPEN and M4.3 has not started; the number-token/BIGINT and diagnostic resource-ID issues remain P2.

## Execute admitted repairs through global ownership

Independent review accepted `ef0d656` and froze the builder lifecycle. The next slice adds `PostgresRepairRunner`, which consumes an already admitted repair claim and its immutable work item rather than calling the legacy repair coordinator. PostgreSQL verifies the repair agent, workspace, parent review lineage, approved execution resources and committed builder workspace handoff before attachment. Tools receive mandatory global permits; repository commands cannot inherit setup-parent authority. Repair writes and release decisions consult current setup trust as well as the ACTIVE run.

The runner persists a unique RUNNING launch reservation before invoking an agent, then replaces it with the real session using revision/session CAS. A recovered RUNNING repair becomes UNKNOWN with HELD_UNCERTAIN ownership rather than launching a replacement. Each session and terminal transition preserves the previous repair revision in history in the same transaction; terminal attempt and claim ownership commit together. Success can release only with independent stop confirmation and no unresolved permits. Cancellation, trust withdrawal, session failure, missing confirmation or an in-flight permit retains ownership. No new worktree, local lease fallback or legacy repair admission is used.

Seven additional real PostgreSQL/linked-Git scenarios cover repair success, cancellation, restart, session failure, an unresolved permit, absent stop confirmation and trust revocation, including duplicate-launch rejection and immutable review/history assertions. Full `pnpm check` passes 880 tests in 82 files with one optional Docker test skipped; format, TypeScript references, lint and coverage gates pass. Coverage is 90.64% statements, 85.39% branches, 93.40% functions and 90.54% lines. Compiled CLI/worker acceptance also runs package/application builds successfully.

This is the controlled repair execution lifecycle, not the complete review/verification product loop or deployed isolated Pi gateway. Verification commands, integration Git operations, dynamic expansion and authenticated stop-supervisor wiring still need global production composition. Production GLOBAL_READY remains disabled; M4.2 is OPEN and M4.3 has not started. Historical migrations and privileges are unchanged, and number-token/BIGINT and diagnostic resource-ID ambiguity remain P2.

## Pin repair review provenance throughout execution

Independent review of `2ee82aa` identified a P1: a repair record could change its parent review subject after admission while its immutable work item stayed unchanged. The global authority now uses one shared provenance check for admission/replay, recovery, session start, terminal outcomes and mutation permits. It compares the work item's impact fingerprint, workspace, builder identity, review iteration and approved lease-plan fingerprint with the repair. After admission it also requires the preserved PREPARING history snapshot and compares the complete parent review subject and immutable repair lineage against every stored history revision. A persisted parent review, when present, must have the same complete subject. Thus output attempt, workspace-change and verification fingerprints cannot silently change within an admitted repair even though the work item does not duplicate them.

Real PostgreSQL tests modify the current repair record through the test migration-owner connection after admission, separately changing impact, output attempt, workspace-change and verification fingerprints. Recovery, start, terminal update, permit acquisition and claim replay all reject; independent reads verify unchanged claims, scope token counter, history and permits, and that no terminal update overwrites the tampered record. Restoring the original record permits the normal lifecycle. Additional pre-admission cases reject a work-item impact mismatch and a persisted review-subject mismatch. The two focused PostgreSQL suites pass 160 tests; full `pnpm check` passes 880 tests in 82 files with one optional Docker test skipped, including formatting, TypeScript, lint and coverage gates. Coverage is 90.67% statements, 85.46% branches, 93.40% functions and 90.57% lines; compiled CLI/worker acceptance also builds the packages and applications successfully.

This pins existing durable evidence rather than establishing that a review or verification result is semantically correct. A missing parent review is not synthesized: before admission, subject fields not represented by the work item can only be checked against an existing review; afterward, the admission history pins them. Full verification/review production closure remains future work. No migration, privilege, resource-subset contract or builder lifecycle changes were made. M4.2 remains OPEN and production GLOBAL_READY remains disabled; this P1 remediation awaits independent review.

## Execute accepted output through global integration ownership

Independent review accepted `da03fd1` and froze repair provenance. The next product slice introduces a separate PostgreSQL integration claim and `PostgresIntegrationRunner`. Integration means committing the reviewed worktree, rebasing it and fast-forwarding the integration repository. These operations affect repository-wide state, so an accepted review alone is insufficient: the existing approved task execution plan must explicitly contain a repository resource. Project/file-only plans fail before token allocation or Git execution. Admission also checks the exact durable accepted review subject, completed output attempt, integrity-checked verification evidence, immutable workspace and current committed setup trust under trust-registry, scope and run locks. This validates persisted approval evidence; it does not run verification commands or establish their semantic correctness.

An ADMITTED record, repository-only claim and lease commit together. A durable RUNNING reservation precedes Git, and another caller cannot launch the same execution again. The runner checks actual canonical linked-worktree topology, common Git directory, symbolic branch and the reviewed working-tree fingerprint before mutation. One exact repository permit spans commit/rebase/merge and independent stop confirmation. The terminal transaction verifies its completion secret and atomically persists the Git workspace/result, removes that exact permit and changes claim ownership. Success releases only with independent stop evidence, current run/trust and no other outstanding permit. Blocked Git, cancellation, revoked trust, unknown outcomes or missing stop confirmation retain HELD_UNCERTAIN. If outcome persistence fails, the transaction rolls back and the permit remains unresolved; there is no ACTIVE-without-permit handoff gap. Recovered RUNNING executions become UNKNOWN without repeating Git. Blocked/unknown integration is not automatically resumed.

Ten real PostgreSQL/linked-Git scenarios cover successful integration, insufficient repository approval, Git failure, cancellation, restart, missing stop confirmation, persistence failure, an extra in-flight permit, trust revocation and a blocked integration repository. They inspect ownership and permits through independent connections and reject duplicate Git launch. The focused PostgreSQL suites pass 170 tests; full `pnpm check` passes 890 tests in 82 files with one optional Docker test skipped. Formatting, TypeScript, lint and coverage gates pass: 90.51% statements, 85.33% branches, 93.48% functions and 90.41% lines. Compiled CLI/worker acceptance also builds the packages and applications successfully.

This runner remains a separately consumable global execution boundary, not an enabled GLOBAL_READY production worker. Independent stop confirmation is an injected supervisor contract; the tests exercise controlled confirmation rather than deploying an authenticated Git-process supervisor. Full verification/review orchestration, dynamic resource expansion, isolated Pi execution and global worker cutover remain unfinished. M4.2 stays OPEN and M4.3 has not started. No migrations, role privileges or frozen builder/repair lifecycle contracts changed; number-token/BIGINT and diagnostic resource-ID ambiguity remain P2.

## Keep integration authority pinned to the approved execution plan

Independent review of `f5e1972` identified a P1 authority-expansion gap: integration checked whether the current task binding contained a repository resource, but did not prove that this mutable record was still the execution plan approved at handoff. Integration approval now compares the complete binding lease-plan digest with the committed workspace phase's `execution_plan_digest` for both builder and repair outputs. A completed builder must additionally retain the exact `taskLeasePlanFingerprint` of that binding; repair output continues to use its existing immutable work-item/history provenance check. These shared checks apply to admission/replay, launch, mutation permits and successful release, so repository permission cannot come from a later widened binding.

Real PostgreSQL/linked-Git regressions first complete the builder and persist accepted review and matching verification evidence, then use the test-only migration owner to add repository authority to a project-only binding or change an already repository-approved plan. The tests also change the mutable completed builder fingerprint to match the forged plan, proving that the committed handoff digest independently rejects it. Separate builder-only fingerprint drift is rejected too. Independent SQL reads confirm no scope token increment, integration claim, lease or integration execution record; restoring the approved records permits the existing success flow. The new regressions fail against the previous implementation and pass after the fix.

This is a narrow provenance remediation, not a new approval protocol or integration recovery feature. Historical migrations, ACLs and frozen builder/repair lifecycle behavior are unchanged. Integration actor naming remains a P2 audit/composition concern without a new actor registry. M4.2 remains OPEN, production GLOBAL_READY remains disabled, and this remediation awaits independent review.

Verification passes full `pnpm check`: formatting, TypeScript project references, lint and 890 tests in 82 files, with one optional Docker test skipped. Coverage is 90.51% statements, 85.34% branches, 93.48% functions and 90.41% lines, meeting all configured gates. Compiled CLI/worker acceptance also successfully builds the packages and applications.

## Prevent automatic Pi resource discovery from bypassing Forge tools

Independent review accepted `c0f7f36` and closed the integration plan-anchoring P1; builder, repair and integration lifecycle boundaries are now frozen. Investigation of the remaining real Pi execution path found a separate concrete gap: disabling built-in tools does not disable the SDK's automatic loading of workspace/user extension modules. Such a module executes JavaScript during discovery, before the controlled Forge tool callback can enforce a mutation permit.

The coding gateway now explicitly supplies the real SDK resource loader with extensions, skills, prompt templates, themes and context-file discovery disabled. In-memory settings prevent workspace/user configuration from adding resource packages, and an explicit orchestrator system prompt prevents discovered prompt files from replacing instructions. In-memory session storage avoids automatic session files in the task workspace. Approved model selection, the Forge tool allowlist, durable session-start ordering and cancellation behavior remain intact; model credentials still use the existing SDK authentication configuration.

A real resource-loader regression creates a workspace extension that writes a marker when imported. Default SDK discovery executes it, proving that the fixture exercises the bypass; the coding gateway does not execute it and does not consume the workspace settings, AGENTS.md or SYSTEM.md. The focused gateway/runner suites pass 28 tests. Full `pnpm check` passes 891 tests in 82 files with one optional Docker test skipped, including formatting, TypeScript, lint, coverage and compiled CLI/worker build acceptance. Coverage is 90.52% statements, 85.34% branches, 93.48% functions and 90.42% lines.

This closes automatic discovery in the existing coding-session entry point, not operating-system isolation of Pi or authenticated external-agent stop confirmation. A real isolated Pi process and fenced broker, dynamic global resource expansion and complete production cutover remain unfinished. No PostgreSQL authority, migrations, privileges or frozen lifecycle contracts changed. Production GLOBAL_READY stays disabled; M4.2 remains OPEN and M4.3 has not started. Public number-token/BIGINT, diagnostic resource-ID ambiguity and integration actor naming remain deferred P2 concerns.

## Connect an isolated session process to the host's fenced tools

Independent review accepted `23f0507` as automatic-resource-discovery hardening. The next increment moves the session protocol across a real process boundary: `DockerPiSessionGateway` launches a digest-pinned, deployment-owned image with no repository mount, no forwarded host credentials, no network, a read-only root filesystem, an unprivileged user and dropped capabilities. Only temporary container storage is writable. The host inspects the configuration before starting the process; the image entrypoint is explicitly configured rather than supplied by the task.

The image adapter `runIsolatedPiSession` can connect an explicitly configured Pi gateway to a bounded JSON-lines broker. The container receives the approved prompt and Forge tool names, never a database credential or a writable checkout. Its session-start message must be durably acknowledged by the host before tools run. Tool requests are parsed against the closed Forge call union, checked against the allowlist, serialized and assigned non-reusable request IDs. The host callback remains responsible for durable authority: a real PostgreSQL/linked-Git takeover test now routes an actual isolated container's `forge_write` through `PiAgentRunner`, recovered execution-child tools and `FencedMutationPort` before the host modifies the approved file.

Cancellation kills the container and its descendants, waits for Docker to confirm exit, and drains any already-started host tool callback before reporting confirmed cancellation. Protocol errors, oversized output, duplicate requests, failed durable session establishment and unconfirmed daemon shutdown fail closed. A container whose stop cannot be confirmed is retained for operator recovery. The real Docker regression verifies that the process cannot write the root filesystem or see a workspace/Docker socket, and that cancelling does not abandon an active host callback. Unit tests cover malformed protocol and daemon-stop failure without requiring Docker.

Full `pnpm check` passes 912 tests in 85 files, with four optional Docker tests skipped; formatting, TypeScript, lint and coverage gates pass at 90.62% statements, 85.44% branches, 93.53% functions and 90.52% lines. Compiled CLI/worker acceptance builds the packages and applications successfully. A separate pinned-image run passes all six selected real Docker and PostgreSQL/Git takeover tests. Those containers run a protocol fixture, not a real model-backed Pi session: an approved Pi image/entrypoint, model connectivity and deployment configuration are still required, and the network-disabled container cannot directly reach an LLM endpoint. The adapter alone does not supply those facilities.

This establishes isolated process-to-fenced-host-tool transport, not production cutover. Durable container recovery mapping, authenticated production stop confirmation, dynamic resource expansion and complete global worker composition remain unfinished. Production GLOBAL_READY stays disabled; M4.2 is OPEN and M4.3 has not started. No PostgreSQL migrations, privileges or frozen lifecycle contracts changed, and no coverage threshold was lowered.

## Supply isolated Pi inference through an approved host model

Independent review accepted and froze `12c3f14` as isolated session-to-host-tool transport. The selected next model boundary keeps that container without network access or provider credentials: the host alone chooses the approved model, endpoint, API key and inference budgets. `ApprovedPiHostModelProxy` parses conversation messages, rejects requests that select provider options, rebuilds only the enabled Forge tool schemas, and invokes the real `pi-ai` SDK with the host's fixed configuration. Responses are normalized to a public proxy identity and omit provider diagnostics and metadata; the container does not receive the actual endpoint or authentication configuration.

The isolated image adapter can now instantiate a real Pi SDK session with in-memory authentication/model configuration and automatic resource discovery disabled. A public non-secret routing marker satisfies SDK model selection, while its session inference function sends model requests through the same serialized broker as tool requests. The host accepts inference only after durable session establishment, applies the existing request-ID/output limits, and aborts active model inference during cancellation or timeout before draining callbacks and confirming container shutdown. Tool effects still execute solely in the host's fenced callback.

Tests exercise the genuine Pi session loop receiving a model tool call, requesting a Forge write and continuing to a final model response. A separate real `pi-ai` HTTP/SSE test verifies that only the host sends the configured credential to a local provider endpoint and that the normalized reply contains neither that credential nor the endpoint. Real Docker tests verify the model channel, absence of credential/endpoint forwarding and cancellation; they still use a protocol fixture image, not a packaged Pi SDK image. No paid remote model was used. The direct `pi-ai` dependency is pinned to the same 0.73.1 version as the existing coding-agent SDK rather than mixing ecosystem versions.

Full `pnpm check` passes 924 tests in 86 files with five optional Docker tests skipped; formatting, TypeScript, lint and coverage pass at 90.55% statements, 85.42% branches, 93.45% functions and 90.45% lines. The separately executed pinned-image Docker suite passes five tests. `pnpm build` and compiled CLI/worker acceptance pass. A deployment-owned Pi image/entrypoint and an end-to-end containerized SDK/model/PG execution composition are still required; the separately tested components do not prove that deployment. Dynamic global resource expansion, durable container recovery mapping and complete worker cutover remain unfinished. Production GLOBAL_READY remains disabled; M4.2 is OPEN, M4.3 has not started, and PostgreSQL migrations, ACLs and frozen lifecycle contracts are unchanged.

## Run the actual Pi SDK inside the isolated image

Independent review accepted and froze `62c055d` as the host-approved model boundary. This increment packages the actual Pi SDK and the existing isolated adapter into a deployment-owned Linux image. The build script bundles only the local adapter code into a temporary Docker context and copies an explicit entrypoint, package manifest and lockfile; it does not copy the repository, host node_modules or credentials. A digest-pinned Node base, exact SDK versions and `npm ci --omit=dev --ignore-scripts` install the Linux runtime independently of the pnpm workspace. This image-only npm lock does not change the project's package manager. The entrypoint starts the genuine SDK session with its existing in-memory configuration and host-proxied inference.

The gateway now accepts either a registry digest or an immutable local Docker image ID, while still rejecting mutable tags. The locally built image was exercised with no network, no workspace mount and no provider/database credentials. A real host HTTP/SSE provider drives the actual containerized SDK through a model tool call, a host Forge callback and a final response; a separate test cancels active inference and verifies host callback drainage and container shutdown. Real PostgreSQL/linked-Git takeover tests also run the SDK image through `PiAgentRunner`, execution-child attachment and `FencedMutationPort` before modifying the approved host file. These are actual SDK-container tests, not the earlier protocol fixture, and use controlled local model responses rather than a paid remote provider.

The four selected actual SDK/container and PostgreSQL/Git tests pass. Full `pnpm check` passes 924 tests in 87 test files with seven optional Docker tests skipped; formatting, TypeScript, lint and coverage pass at 90.55% statements, 85.42% branches, 93.45% functions and 90.45% lines. `pnpm build` and compiled CLI/worker acceptance pass. An existing Temporal five-second timeout occurred on one full run; its isolated retry and the subsequent full check both passed.

This supplies the executable image and end-to-end SDK/model/tool composition, not production GLOBAL_READY activation. Deployment image publication and approved remote-model configuration, durable container/session recovery, authenticated stop confirmation, dynamic global expansion and complete scheduler/worker cutover remain unfinished. Production GLOBAL_READY remains disabled, M4.2 is OPEN and M4.3 has not started. PostgreSQL migrations, ACLs and frozen builder/repair/integration authority are unchanged; public number-token/BIGINT, diagnostic resource-ID and integration actor naming remain deferred P2 concerns.

## Persist the builder container before its external process starts

Independent review accepted `9319528` as the actual isolated SDK image boundary. The next concrete restart gap was that a durable Pi session ID alone did not identify the Docker container left behind by a lost host. The builder now records the immutable container ID, reservation-derived name, pinned image and exact entrypoint/arguments in PostgreSQL before Docker starts the process. The record is tied to the exact execution child, owner, token and durable RUNNING launch reservation under the existing trust→scope→run transaction; retries preserve it and replacement identity is rejected. No migration or privilege expansion is needed because this uses the existing authority record store.

On RUNNING recovery the builder first persists UNKNOWN and HELD_UNCERTAIN, then an independent connection can recover the registered descriptor and the gateway can stop that exact container. An unstarted container is removed to prevent delayed launch; a running container must be killed, waited for and re-inspected as exited. Mismatched identity/configuration or daemon failure rejects recovery without launching a replacement. Stopping a container does not establish that an old host-side tool callback drained, so permits remain unresolved and ownership is never released by this recovery operation.

The explicit `createPostgresDockerChildRunner` composition joins the accepted SDK gateway, host-approved inference, mandatory fenced tools, builder lifecycle and pre-start persistence callback. Its ordinary test runs through real PostgreSQL and a controlled gateway; its optional image test uses the actual containerized SDK and verifies the stored Docker ID. The real restart test proves quarantine precedes the stop callback, and the independent Docker regression proves persistence-response loss leaves a never-started container recoverable by its exact identity. Six real Docker gateway tests and the actual SDK/PG builder case pass. Full `pnpm check` passes 927 tests in 87 files with eight optional Docker tests skipped; formatting, TypeScript, lint and coverage pass at 90.42% statements, 85.39% branches, 93.34% functions and 90.33% lines. Compiled CLI/worker acceptance also builds the packages and applications successfully.

This is builder container/session recovery, not automatic session resumption or proof of external quiescence. The explicit factory supplies no independent stop confirmer, so even a normal completed result retains HELD_UNCERTAIN ownership. Repair-container recovery, authenticated stop confirmation and final settlement, dynamic global expansion and scheduler/worker cutover remain unfinished. Ordinary production GLOBAL_READY startup stays disabled; M4.2 is OPEN and M4.3 has not started. Historical migrations and ACLs are unchanged; number-token/BIGINT, resource-ID ambiguity and integration actor naming remain P2.

## Recover the exact isolated repair container without restarting its writer

Independent review accepted `2492284` and froze the builder container descriptor boundary. Repair now has its own matching composition rather than borrowing a builder identity: the immutable Docker descriptor commits before process start, tied to the exact repair claim, owner, token and `forge-repair-launch-reservation`. PostgreSQL validates the admitted repair work item and immutable review/history provenance under the existing trust→scope→run lock order, and checks current run/trust eligibility before accepting the descriptor. An exact retry preserves the original record; a different container ID or owner/reservation is rejected.

On repair RUNNING recovery, the runner commits UNKNOWN and HELD_UNCERTAIN before reading the descriptor through an independent connection and invoking the stop callback. It never launches a replacement writer. Existing callback permits remain present after container shutdown: stopping the container cannot prove that a tool callback on the old host finished, so neither a lease nor a permit is automatically settled. The new `createPostgresDockerRepairRunner` joins the actual isolated SDK, approved host model proxy, mandatory fenced tools and repair lifecycle with this pre-start registration/recovery path. It supplies no independent stop confirmer, so normal completion also retains uncertain ownership.

Real PostgreSQL/linked-Git tests reject wrong repair identities, accept exact descriptor retries, reject replacement IDs and prove durable quarantine precedes container stopping. They retain an in-flight permit across restart and verify zero replacement launches. The actual SDK image/PG repair case also passes and checks the persisted Docker identity. Full `pnpm check` passes 927 tests in 87 files with eight optional Docker tests skipped; formatting, TypeScript, lint and coverage pass at 90.39% statements, 85.38% branches, 93.27% functions and 90.29% lines. Compiled CLI/worker acceptance builds the packages and applications successfully.

This completes the repair counterpart of durable container recovery, not authenticated external stop confirmation, final uncertain-claim settlement, automatic session resumption or production cutover. Dynamic global expansion and complete scheduler/worker composition remain unfinished. Production GLOBAL_READY stays disabled; M4.2 remains OPEN and M4.3 has not started. Historical migrations, ACLs and frozen builder/integration contracts are unchanged; public number-token/BIGINT, diagnostic resource-ID ambiguity and integration actor naming remain deferred P2 concerns.

## PostgreSQL production execution composition: M4.2 closure candidate

This batch joins the previously separate execution boundaries into the actual Temporal worker factory. Default startup remains legacy and cannot pass the global cutover gate. Explicit global startup requires PostgreSQL, a GLOBAL_READY authority store, pinned Pi and Git images, a deployment-approved model and a host-only model credential; acceptance adapters and injected persistence cannot bypass this production selection. The independently approved setup and recovery services must already have committed the task's workspace handoff. The worker resolves that parent from durable run/attempt identity; it never manufactures setup approval, borrows a recovery credential or recreates the workspace through the legacy builder.

Global activities execute the isolated Pi builder, run the read-only verifier before creating passed evidence, collect an exact-subject model review, prepare and execute an isolated repair when requested, and integrate accepted output through repository-authorized Git permits. Verification and review policy fingerprints must match the approved run. Review inference has no tools and receives the actual tracked diff plus bounded, canonical-path-checked untracked text. Every legacy mutation activity is replaced; blocked repair/integration continuation refuses automatic resume and requires independent recovery. Run completion and cancellation finalization check unresolved global authority inside the same persisted lock order as lifecycle changes, avoiding a check-then-finalize gap.

Normal Pi stop confirmation now comes from the same broker that owned the invocation: it records evidence only after its serialized host tool/model callbacks drain and Docker is confirmed stopped. The receipt is associated with that run/attempt and cannot be borrowed by another invocation. It allows a normally completed builder or repair to release authority when the existing provider gates also pass. Restart stopping never produces this receipt; old host callbacks, daemon failures and ambiguous outcomes continue to retain permits and uncertain claims. Git commands execute in inspected, network-disabled, read-only-root containers with only the approved integration/worktree/common-Git paths writable. Hooks, signing, external configuration and network protocols are disabled; the image's `/git` volume is replaced by a bounded tmpfs. Exact command, entrypoint, resource limits and mounts are checked before start. Git release evidence requires confirmed container exit, and any ambiguity retains ownership.

Dynamic tool requests use durable PostgreSQL authority rather than a local guard. A resource already covered by the base claim uses its existing token. A newly requested disjoint resource must still be covered by the immutable approved execution plan and committed handoff digest; it receives a separate deterministic claim ID and higher scope token, leaving the earlier claim unchanged. Exact retry recovers the same grant. Each expansion permit also validates the original base owner/token/current trust; uncertainty cascades to related claims, and terminal release settles them atomically only if none retains an in-flight permit. A third unapproved file is rejected before token or record allocation. This does not authorize arbitrary scope enlargement or retrospective repository approval.

Real-image acceptance covers the actual outer production factory, local HTTP/SSE model inference, real Pi SDK, real PostgreSQL permits and linked Git repositories. The activity chain verifies builder completion, verification/review, repair, Git integration, cancellation-before-write, RUNNING restart without duplicate launch, and approved dynamic expansion with an in-flight-release barrier. With all three acceptance images configured, `pnpm check` passes all 943 tests in 88 files with no skips; formatting, TypeScript, lint and coverage pass at 90.86% statements, 85.92% branches, 94.27% functions and 90.75% lines. Explicit `pnpm build` also passes. Image-dependent acceptance must be enabled for this closure check; omitting those images skips the production scenarios and does not provide equivalent coverage evidence.

To select this path, keep the existing PostgreSQL/Temporal/repository and approved review-model configuration, set `FORGE_WORKER_AUTHORITY_MODE=global`, `FORGE_PI_IMAGE` and `FORGE_GIT_IMAGE` to immutable image references, and provide `FORGE_MODEL_API_KEY` only to the host. For reproducible validation, set `FORGE_TEST_PI_SDK_IMAGE`, `FORGE_TEST_GIT_IMAGE` and `FORGE_TEST_DOCKER_IMAGE` to the corresponding local/published immutable acceptance images before `pnpm check`. The worker needs controlled Docker-daemon access and approved repository paths; it receives only the runtime PostgreSQL credential, not signer, generation-issuer or recovery-role credentials.

This is a PostgreSQL production closure candidate pending independent review, not an already accepted M4.2 closure or an automatic deployment migration. Unknown writers and interrupted host callbacks still require explicit recovery; blocked Git/repair is not silently retried. SQLite's independently protected trust root and automated recovery scheduling remain deferred. Deployment must provision the approved images/model and complete privileged setup/handoff; the acceptance provider is local rather than a paid production endpoint. Historical migrations and ACLs are unchanged. M4.2 remains OPEN until this batch is independently accepted; M4.3 has not started. Public number-token/BIGINT, diagnostic resource-ID ambiguity and integration actor naming remain P2.
