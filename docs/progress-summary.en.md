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
- `mode` — currently always `exclusive`;
- `leaseDurationMs` — how long the permission remains valid.

A successful request returns `granted` with a lease ID, version, acquisition time, and expiry time.
A blocked request returns `blocked` plus the IDs of the active leases causing the conflict. This lets
the scheduler explain which owner a task is waiting for instead of reporting an unexplained delay.

`runId` prevents data from an older orchestration run being confused with a new run that happens to
reuse the same task or agent ID. It does not mean two runs may automatically write the same checkout;
the eventual guard must still consider every active lease protecting that workspace.

#### Renewal, versions, and expiry

Long-running work renews its lease before expiry. Renewal includes the lease ID, the version the
agent expects to be current, and a new duration. If the stored version still matches, the guard
increments the version and extends the expiry. If the lease is gone, it returns `not-found`. If a
newer version exists, it returns `version-conflict` with the actual version.

This is optimistic concurrency control. It prevents a stale worker from extending a lease after a
recovery process or replacement worker has already taken responsibility for newer state.

Release returns either `released` or `not-found`. Treating an already-absent lease as a successful
cleanup outcome makes release idempotent: retries and crash recovery can safely issue the same
cleanup operation more than once.

#### How the future runtime guard must acquire leases safely

The complete service will need to:

```text
resolve and validate the requested resource identity
        ↓
ignore or remove expired leases
        ↓
load active leases that could overlap
        ↓
apply areWritableResourcesConflicting()
        ↓
atomically grant a new lease or return blocked
        ↓
renew during long work and release after verification
```

The conflict check and lease creation must be one atomic database operation. If two agents can both
check "no conflict" before either one writes its lease, both could be granted incorrectly. The
future persistence implementation therefore needs a transaction, serialization mechanism, or
equivalent constraint that makes "check and create" indivisible.

#### What is implemented, and what is not

Implemented now:

- writable-resource identities and their complete hierarchy;
- deterministic and symmetric containment-conflict rules;
- request and result contracts for acquire, renew, and release;
- run, agent, task, version, acquisition, and expiry fields;
- tests for the principal conflicting and independent resource combinations.

Not implemented yet:

- a concrete `WriteGuard` service;
- active-lease storage or SQLite/Drizzle persistence;
- atomic acquisition transactions;
- expiry cleanup, heartbeats, or automatic renewal;
- enforcement that intercepts an agent before an actual write;
- blocked-task queues, wake-up, and crash recovery;
- repository-graph resolution and validation of resource identities.

The accurate current status is: **the lease contracts and resource-conflict decision are working;
live lease acquisition, storage, renewal, expiry, release, and enforcement are still future work.**

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

## Stage 4: Simplifying the toolchain — removing Nx

The project originally decided to use a tool called Nx to manage "which package should be built or
tested in what order" across multiple packages. During actual implementation, the team found that
with only 3 packages, the complexity Nx introduced (extra configuration files, extra sync commands,
and occasionally "phantom dependencies" that looked real in the project graph but weren't actually
used in code) outweighed its benefits.

The team therefore decided to **remove Nx from its role as this repository's own build
orchestrator**, replacing it with a simpler combination of tools:

- pnpm (a package manager) handles how the packages reference each other.
- TypeScript's built-in "project references" feature handles which package compiles before which.
- Vitest's built-in multi-project feature handles running all packages' tests in one go.

This decision was written up as a formal architecture decision record (ADR-009), which explicitly
states that **this is not "Nx is bad" — it's "not needed at the current scale"**, and it lists
concrete conditions under which the team should reconsider a similar orchestration tool (for
example, if the number of packages grows past 12, or if running all checks starts taking more than
five minutes).

This cleanup also fixed a real bug along the way: the command-line tool's (`apps/cli`) configuration
previously _declared_ that it depended on the `domain` and `dag` packages, but the actual code never
used them — a leftover configuration mistake. This cleanup removed that phantom dependency as well.

**Outcome of this stage**: the project is still structured as "multiple packages in one repository,"
but no longer relies on an extra orchestration tool. A smaller, easier-to-understand combination of
tools achieves the same result, and the change itself had no negative impact on the workflow or
build output (all checks and builds were re-verified and produced identical results).

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

A small provider-neutral interface separates "ask for a project graph" from "how pnpm stores
workspace metadata." Only the pnpm provider is implemented because it is the only current product
requirement. The previously reserved Nx fixture and Nx-specific verification rule were removed;
another provider will be added only if a real supported-repository requirement appears.

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
~/Desktop/apra_new/apra-amcos-admin-ingestion-and-matching
```

The command completed successfully with the `pnpm-workspace` provider and discovered three projects:

| Project                                   | Repository root | Source root         |
| ----------------------------------------- | --------------- | ------------------- |
| `apra-amcos-admin-ingestion-and-matching` | `.`             | not declared        |
| `api`                                     | `workspace/api` | `workspace/api/src` |
| `ingestion-and-matching-ui`               | `workspace/ui`  | `workspace/ui/src`  |

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
  ~/Desktop/apra_new/apra-amcos-admin-ingestion-and-matching
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

## Stage 7: TypeScript file and symbol analysis

Stage 6 answered "which packages exist?" Stage 7 answers a deeper set of deterministic questions:
"which TypeScript files belong to those packages, which files import which other files, what named
code declarations exist, and which declarations refer to which other declarations?"

This is still **not LLM analysis**. `forge analyze` makes no network request and sends no source code
to a model. It opens each discovered `tsconfig.json` with the pinned TypeScript 7 native API, so it
uses the repository's real compiler options, module-resolution rules, and path aliases. The type
checker resolves imports and references; fixed conversion rules turn those compiler facts into the
provider-neutral `RepositoryGraph`.

The analyzer now performs these steps:

1. Discover the relevant `tsconfig.json` files for pnpm workspace projects.
2. Ask TypeScript 7 for each configured program and keep only TypeScript source files inside the
   repository, excluding dependency files under `node_modules`.
3. Assign each file to the most specific workspace project and create a stable ID from the project
   ID plus repository-relative path. Generated paths are marked explicitly.
4. Resolve import specifiers semantically and create file-dependency edges. This can discover
   relationships expressed through TypeScript aliases or shared source paths even when no
   `package.json` workspace dependency exists.
5. Index top-level classes, functions, interfaces, type aliases, enums, namespaces, and variables,
   plus class/interface constructors, methods, accessors, and properties.
6. Record parent-child symbol structure and public export visibility, while keeping private and
   protected members non-exported.
7. Use the type checker to turn identifier use into deduplicated symbol-reference edges.
8. Infer project dependencies from cross-project file dependencies and merge them with manifest
   dependencies.

Stable identities do not contain line numbers. Moving a declaration up or down in the same file
does not change its graph ID. A typical ID looks like:

```text
api:workspace/api/src/modules/work/router.ts:createWorkRouter
```

The TypeScript 7 programmatic API is currently published under an `unstable` import path. That risk
is deliberately isolated inside `libs/repository-analysis`, the exact compiler version is pinned,
and no native AST or checker object enters the domain model. TypeScript 6 was **not** reintroduced;
the repository still has one TypeScript version. ADR-004 records when this boundary must be
reevaluated.

The CLI is now registered as a workspace executable. After building, the concise form is:

```sh
pnpm exec forge analyze /path/to/repository
```

The default output is a readable summary with counts, projects, and project dependencies. Add
`--full` to emit every file, symbol, file-dependency edge, and symbol-reference edge. Full output can
be very large, so summary mode is the practical default for a large repository.

### Real Stage 7 validation: Ingestion and Matching

The exact command requested for the research repository was run successfully for the initial Stage
7 implementation:

```sh
pnpm exec forge analyze \
  ~/Desktop/apra_new/apra-amcos-admin-ingestion-and-matching
```

It completed in about 14.5 seconds on this machine and produced:

| Graph fact           |  Count |
| -------------------- | -----: |
| Projects             |      3 |
| TypeScript files     |    973 |
| Indexed symbols      |  7,819 |
| Project dependencies |      3 |
| File dependencies    |  3,514 |
| Symbol references    | 13,475 |

The three projects are the repository root, `api`, and `ingestion-and-matching-ui`. Most
importantly, the enriched graph now contains `ingestion-and-matching-ui → api`. Stage 6 reported no
manifest dependency between those workspace packages; Stage 7 found the real code-level relation
through TypeScript resolution. This is exactly why project-manifest discovery and semantic source
analysis are separate layers.

These counts do not mean the tool "understands the business meaning" of all 7,819 symbols. They mean
it has a deterministic structural index: where declarations live and how TypeScript resolves
relationships between them. That is the evidence layer the next impact/conflict engine will query.

### Current limitations of analysis

- It analyzes TypeScript-family files covered by discovered `tsconfig.json` files; it is not a
  universal JavaScript, SQL, CDK, database, or infrastructure semantic analyzer.
- It indexes supported declaration categories, not every possible nested or anonymous AST construct.
- It records export visibility but does not yet extract normalized callable/type signatures.
- Analysis is currently a full scan; `changedFiles` exists in the contract but incremental refresh
  is not implemented.
- A graph edge says "TypeScript resolved this relationship." It does not by itself say a proposed
  task will change that code, how risky two changes are, or whether agents may run concurrently.
- `forge plan` remains unavailable; no agent is dispatched and no source file is modified by
  `forge analyze`.

**Outcome of this stage**: `forge analyze` now builds the project, file, symbol, file-dependency, and
symbol-reference layers of a real TypeScript pnpm repository graph. This completes architecture
milestone 5 and provides the factual input required by task-impact and conflict analysis.

### Independent review and Stage 7 hardening

Before starting the next milestone, an independent Claude review inspected the uncommitted changes,
reran every quality gate, and built separate temporary repositories for language edge cases. The
review found no Critical issue and confirmed the single-TS7 boundary, read-only behavior, stable IDs,
path-escape protection, Nx removal, and semantic alias/re-export resolution. It also found several
correctness gaps that were fixed before handoff:

- Namespace bodies are now indexed recursively, including functions, variables, classes, nested
  namespaces, and dotted namespace declarations.
- Class/namespace declaration merging no longer depends on which declaration appears first. A fixed
  kind priority selects the primary `kind`, while `mergedKinds` records every participating kind.
- Modifier checks now use TypeScript 7's typed `modifierFlags`; the previous reflective, silently
  failing lookup was removed. Private and protected members remain non-exported.
- Dynamic computed properties are labelled explicitly as computed and receive an occurrence suffix;
  string/numeric computed keys are restored to their literal name. Reserved path separators are
  escaped so a property containing `.` cannot pretend to be another hierarchy level.
- A file is now analyzed only by a TypeScript configuration owned by its pnpm project. A project
  with no owning configuration no longer borrows an arbitrary sibling project's checker.
- Cleanup failures can no longer replace the original analysis failure. If analysis succeeded but
  cleanup failed, the cleanup error is still reported as a structured error.
- Shared path helpers were consolidated, full CLI output uses concrete `FileNode`/`SymbolNode`
  types, and the reference batch-size rationale is documented.

Regression tests now cover namespace children, both declaration-merge orders, computed names,
multi-hop re-exports, `export *`, `tsconfig.paths`, bare package specifiers through a workspace
symlink, re-export visibility, and the no-owning-tsconfig rule.

After these fixes, the real repository was analyzed again. The current result is:

| Graph fact           |  Count |
| -------------------- | -----: |
| Projects             |      3 |
| TypeScript files     |    952 |
| Indexed symbols      |  7,188 |
| Project dependencies |      3 |
| File dependencies    |  3,401 |
| Symbol references    | 12,958 |

The lower file/symbol counts are intentional: the original analyzer admitted files through a
compiler context that did not belong to the file's pnpm project. The hardened analyzer excludes
those ambiguous files unless the owning project supplies its own root `tsconfig.json`. The
important `ingestion-and-matching-ui → api` semantic dependency remains present.

One graph limitation is now explicit. Project dependencies inferred from TypeScript imports are
merged with manifest dependencies, but an edge does not yet record whether it came from production,
tests, generated code, a type-only import, or a package manifest. The next impact engine must treat
these edges as reachability evidence, not assume every edge has equal architectural strength. Edge
provenance remains a graph-schema extension to design deliberately. Summary JSON also contains the
absolute repository path; users sharing logs should be aware that it can reveal a local username or
directory layout.

### Second independent review: solution configurations and stable computed symbols

A second Claude review found that the stricter ownership rule had introduced a Critical regression:
solution-style projects could return a successful but empty graph. In this common layout,
`tsconfig.json` contains only `references`, while `tsconfig.lib.json`, `tsconfig.app.json`, or similar
files contain the actual source includes. The native API does not automatically expand those
references when only the solution files are opened. This repository uses exactly that layout and
was independently reproduced as `0 files / 0 symbols`.

The corrected analyzer now:

- parses TypeScript JSONC configuration, including comments and trailing commas;
- follows project references recursively and rejects missing or out-of-repository targets;
- opens every referenced real compilation configuration;
- keeps file ownership tied to a compiler context owned by the same pnpm project;
- deterministically prefers production contexts when production and spec configs contain the same
  file;
- rejects malformed configuration with `INVALID_TYPESCRIPT_CONFIGURATION`;
- emits `MISSING_TYPESCRIPT_CONFIGURATION` or `EMPTY_TYPESCRIPT_PROJECT` warnings for valid projects
  that cannot contribute owned source files;
- includes diagnostics and their count in normal `forge analyze` output.

The review also found that dynamic computed getter/setter pairs were split and that their IDs used
the absolute member position. They now share one expression-based callable symbol. Repeated dynamic
properties are numbered only among occurrences of the same expression, so inserting an unrelated
member does not change the computed property's ID.

Native cleanup outcome logic was extracted into a directly tested internal module. Tests now prove
that both cleanup actions are attempted, the original analysis error wins over cleanup errors, a
cleanup-only failure remains visible, and an impossible missing-result state fails loudly.

This repository itself is now a permanent solution-layout regression test. A real self-analysis
produced:

| Graph fact           | Count |
| -------------------- | ----: |
| Projects             |     5 |
| TypeScript files     |    29 |
| Indexed symbols      |   298 |
| Project dependencies |     5 |
| File dependencies    |    44 |
| Symbol references    |   424 |
| Diagnostics          |     1 |

The one diagnostic is expected: the root package is a solution/coordination package with no owned
TypeScript source. It is now visibly different from a malformed config, which fails analysis.

The latest Ingestion and Matching run remains healthy and reports 952 files, 7,191 symbols, 3,411
file dependencies, 12,983 symbol references, and zero diagnostics. Its UI-to-API dependency remains
present.

### Third independent review: configuration ownership and diagnostic completeness

The third Claude review confirmed that solution-style analysis was repaired, then found a narrower
valid layout that was still excluded: a project-root `tsconfig.json` may reference a real compiler
configuration below the root, for example `config/tsconfig.build.json`. Exact directory equality
rejected that configuration even though it belonged to the same project.

The ownership rule now assigns each discovered configuration to the most specific pnpm project that
contains the configuration file. A referenced configuration may live anywhere below that project
root, but it cannot claim source owned by a nested or sibling workspace project. A dedicated
regression repository proves that `packages/a/config/tsconfig.build.json` can include
`packages/a/src/index.ts` without weakening project isolation.

The review also identified a diagnostic blind spot: a project with one indexed file could silently
omit other TypeScript files. The analyzer now scans the repository and compares project-owned
TypeScript files with the indexed set. Any difference produces `UNCOVERED_TYPESCRIPT_FILES` with
the exact repository-relative paths. Dependency, build, coverage, and nested pnpm-workspace trees
are excluded from this comparison. This warning does not force those files into a potentially wrong
compiler context; it makes the missing coverage visible for a human or later policy layer.

Native cleanup now has an integration test, not only pure lifecycle tests. The test opens a real
TypeScript native snapshot, triggers an invalid compiler-option diagnostic inside the active
session, and verifies that both `snapshot.dispose()` and `api.close()` run before the structured
failure is returned. Structured analysis errors are rethrown directly, preserving their original
stack. Computed property identity also removes redundant outer parentheses, so `[key]` and
`[(key)]` use the same expression identity.

The production/spec context preference is deterministic. If two production configurations cover
the same file, the lexicographically first configuration path currently wins. This is documented as
a reproducibility rule, not as proof that its compiler options are semantically better; a future
overlap diagnostic remains appropriate if real repositories depend on this distinction.

After the third-round fixes, self-analysis reports:

| Graph fact           | Count |
| -------------------- | ----: |
| Projects             |     5 |
| TypeScript files     |    29 |
| Indexed symbols      |   299 |
| Project dependencies |     5 |
| File dependencies    |    44 |
| Symbol references    |   437 |
| Diagnostics          |     2 |

The root solution package still receives `EMPTY_TYPESCRIPT_PROJECT`. It also receives one
`UNCOVERED_TYPESCRIPT_FILES` warning for the root `vitest.config.ts`; fixture workspaces are
correctly treated as nested repository boundaries instead of root-project source.

The requested real-repository run now reports 3 projects, 957 indexed files, 7,218 symbols, 3
project dependencies, 3,422 file dependencies, 13,030 symbol references, and 1 diagnostic. The
diagnostic lists 25 files under `workspace/api/src/scripts/**` that exist on disk but are not covered
by `workspace/api/tsconfig.json`. The analyzer did not guess a compiler context or silently add
them. This is exactly the newly visible distinction: the main repository graph remains usable, and
the omitted script set is explicitly reviewable.

### Fourth independent review: symlink identity hardening

The fourth Claude review found no Critical or High issue and independently confirmed all three
third-round fixes. Its remaining data-correctness finding was that two TypeScript paths pointing to
the same real file through a filesystem symlink became two `FileNode` records and two copies of each
symbol. That would cause a later impact engine to count one code asset twice.

File identity now resolves the filesystem real path before ownership, deduplication, graph-ID, and
repository-boundary decisions. If `src/index-link.ts` points to `src/index.ts`, the graph contains
only `src/index.ts` and one symbol set. If a repository-local symlink points to a TypeScript file
outside the repository, the real target fails the boundary check and is not indexed. Tests cover
both cases. The repeated computed-expression parenthesis logic was also consolidated into one
internal helper; no new public export or re-export was added.

Two limitations are deliberately recorded rather than hidden:

- intentionally excluded generated TypeScript files still appear in
  `UNCOVERED_TYPESCRIPT_FILES`; the warning is factually correct but may be noisy, so future policy
  may separate generated and handwritten files by severity;
- uncovered-file detection performs an additional repository glob. It is acceptable on the current
  957-file research repository, but must be benchmarked again before assuming it scales unchanged
  to repositories with tens of thousands of files.

After this fix, the research repository remains stable at 957 files, 7,218 symbols, 3,422 file
dependencies, 13,030 symbol references, and the same useful 25-file uncovered-script diagnostic.
Self-analysis reports 29 files, 302 symbols, 44 file dependencies, 442 symbol references, and the
same two expected root diagnostics. The increased counts from the previous self-run come from the
new analyzer helper and regression-test source, not duplicate symlink data.

The final independent review reported no Critical, High, or Medium finding. It additionally tested
multiple symlinks to one file, cross-project links, links into `node_modules`, broken links, and
imports through a symlink; file dependencies and symbol references consistently resolved to the
real owning file. Its two Low observations were closed during final cleanup: the analyzer no longer
performs a second redundant `realpath` call for an already-resolved file, and the architecture now
states that `FileNode.path` is the real repository-relative path rather than necessarily the path
spelling used in an import. The dedicated RepositoryGraph factual-layer review is now closed. The
next implementation stage is Task Impact Engine.

## Current overall status (as of this writing)

- Architecture milestones 1–5 of 10 are complete. That is roughly 50% by milestone count, not 50%
  of total engineering effort: later runtime, persistence, Git, and agent-execution milestones are
  larger and riskier than several foundation milestones.
- Formatting, linting, TypeScript 7 checking, and tests run through `pnpm check`. There are 70 tests,
  all passing.
- Coverage is 96.15% statements, 91.24% branches, 100% functions, and 96.07% lines. Every enforced
  threshold is at least 90%.
- `pnpm build` passes. `forge analyze` is real and verified on a 957-file repository; `forge plan`
  remains intentionally unavailable.

## What has NOT been implemented yet

- Resolve a natural-language or structured task's selectors into the projects, files, and symbols
  it may read or write.
- Expand impact to downstream consumers and calculate explainable pairwise conflict scores.
- Group tasks into dependency-safe and conflict-safe execution waves.
- Implement live lease acquire/renew/release storage and runtime write enforcement.
- Persist orchestration runs so they can recover after restart.
- Create isolated Git workspaces, rebase and integrate task changes safely.
- Invoke coding agents, monitor them, and verify their results.

In short: **the orchestrator can now build a deterministic structural map of a real TypeScript pnpm
repository. The next stage must connect task intentions to that map; it still does not plan or run
agents.**
