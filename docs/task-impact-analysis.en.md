---
title: Task Impact and Conflict Analysis — Training Guide
tags:
  - coding-orchestrator
  - task-impact
  - conflict-engine
  - architecture
status: implemented
---

# Task Impact and Conflict Analysis — Training Guide

This document explains how a structured task becomes a deterministic prediction of repository
impact, and how two predictions are compared to decide whether parallel execution is safe. It is
written for readers without prior orchestration, compiler, or concurrency experience.

For the factual layer that supplies projects, files, symbols, and dependency edges, first read
[RepositoryGraph Analysis](./repository-graph-analysis.en.md).

## The short version

Task Impact answers:

> If this task follows its declared contract, what might it read, write, or coordinate through?

Conflict Analysis answers:

> Given two predicted impacts, what overlaps exist, which are uncertain risks, and which are
> mandatory scheduling constraints?

```text
TaskContract A -----> PredictedTaskImpact A ---+
                                                 +--> TaskConflict(A, B)
TaskContract B -----> PredictedTaskImpact B ---+
                              ^
                              |
                       RepositoryGraph
                       Resource Registry
```

Both stages are deterministic. They make no LLM call, send no source code over the network, and do
not modify the repository. An LLM may eventually help produce a `TaskContract`, but it is not an
authority inside impact or conflict logic.

## Why this layer exists

A dependency graph alone is not enough for safe concurrency.

```text
Task A: change Service.search
Task B: change Service.validate

Functional DAG: no dependency between A and B
```

The DAG says neither task requires the other task's result. It does not say whether both tasks edit
the same file, the same symbol, a generated artifact, a migration directory, or a shared lockfile.

Task Impact translates task intent into repository-shaped scope. Conflict Analysis compares that
scope. The Scheduler will later combine both independent inputs:

```text
ready according to dependencies
              +
allowed according to hard constraints and risk policy
              |
              v
       runtime dispatch decision
```

This separation prevents a useful heuristic score from weakening a true dependency or mandatory
serialization rule.

## The three evidence layers

The architecture deliberately keeps three kinds of evidence separate.

```text
RepositoryGraph
  "What exists and what depends on what?"
          |
          v
PredictedTaskImpact
  "What does this task contract say may be touched?"
          |
          v
ObservedTaskImpact
  "What did the running task actually touch?"       [contract only; runtime not implemented]
```

### Repository facts

`RepositoryGraph` contains tool-proven projects, files, symbols, imports, references, and project
dependencies. These facts are task-independent and read-only.

### Predicted impact

`PredictedTaskImpact` is produced before execution from a validated `TaskContract`, a
`RepositoryGraph`, and a shared-resource registry. It is a conservative prediction, not proof that
every listed resource will change.

### Observed impact

`ObservedTaskImpact` is reserved for runtime evidence: actual file reads, creations, writes,
deletions, dependency requests, manifest changes, generated outputs, and changed symbols. Its domain
contract exists, but runtime collection is not implemented yet.

Prediction and observation must not overwrite one another. A mismatch is useful evidence:

```text
predicted write: file A
observed write:  file A + file B
                         ^
                         unexpected scope expansion
```

The future Runtime Guard must block or escalate unsafe expansion instead of silently treating the
new scope as pre-authorized.

## Input: the Task Contract

A task contract contains identity, dependency, scope, and verification declarations. The impact
analyzer consumes these fields:

```ts
interface TaskContract {
  id: string;
  expectedReads: ResourceSelector[];
  expectedWrites: ResourceSelector[];
  sharedResources: string[];
  // title, goal, dependencies, verification, priority, ...
}
```

The supported selectors are:

| Selector          | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `project`         | A workspace project by ID, package name, or project root      |
| `file`            | An exact graph file ID or normalized repository-relative path |
| `glob`            | All graph files matching a repository-relative path pattern   |
| `symbol`          | A symbol by stable ID, declaration path, or simple name       |
| `shared-resource` | A named non-code or cross-file coordination resource          |

Example:

```json
{
  "id": "change-search",
  "expectedReads": [
    { "type": "project", "value": "consumer" },
    { "type": "shared-resource", "value": "search-index" }
  ],
  "expectedWrites": [
    { "type": "symbol", "value": "SearchService.query" },
    { "type": "glob", "value": "packages/core/src/generated/**" }
  ],
  "sharedResources": ["release-channel"]
}
```

`shared-resource` selectors retain read/write intent. The separate `sharedResources` array means
“this task must coordinate through this resource” and becomes `coordinate` access. They are not
duplicates.

## End-to-end impact flow

```text
validated TaskContract
        |
        +--> validate every explicitly named shared resource
        |         |
        |         +--> unknown ID: fail with UNKNOWN_SHARED_RESOURCE
        |
        +--> resolve expectedReads selectors
        |
        +--> resolve expectedWrites selectors
        |         |
        |         +--> retain why every written file entered the scope
        |
        +--> attach registry rules found through files and paths
        |
        +--> detect exported symbols and generated files
        |
        +--> walk reverse project dependencies transitively
        |
        +--> sort and normalize every set, access list, and signal
        |
        v
PredictedTaskImpact
```

The implementation is `RepositoryTaskImpactAnalyzer` in
`libs/task-impact/src/lib/task-impact-analyzer.ts`.

## How selectors resolve

### Project selector

A project selector matches project ID, package name, or normalized project root. Reading or writing
the project records project scope.

Because a project selector is exact, matching zero projects or several projects emits an
`ambiguous-selector` risk signal. The signal preserves the partial result for conservative review;
it does not silently choose one project.

A project write does not pretend that every known file was explicitly selected:

```text
expectedWrites: project(core)

projectsWritten         = { core }
explicitProjectsWritten = { core }
filesWritten            = { }       <- intentionally not expanded
```

The analyzer still examines the project's package manifest and known files for matching
shared-resource rules. This allows a whole-project task to discover policies such as “changes under
`migrations/**` must be ordered” without manufacturing exact file predictions.

### File selector

An exact file selector matches a graph file ID or normalized repository-relative path. Its owning
project is automatically included.

```text
write file(core:index)
        |
        +--> filesWritten += core:index
        +--> explicitFilesWritten += core:index
        +--> projectsWritten += core
        +--> registry rules for the file path
```

A file such as `package.json` may be absent from the TypeScript graph. A registry rule can still
recognize its path, so non-TypeScript coordination resources are not lost. An exact file selector
normally emits `ambiguous-selector` when it matches zero or several graph files. The zero-match
signal is intentionally suppressed when the selector path resolves through at least one registry
rule: in that case the selector successfully identified a non-graph coordination resource rather
than an unknown path.

### Glob selector

A glob intentionally matches zero, one, or many graph files. Every match records its owner and its
glob provenance. Multi-match is not considered ambiguous because fan-out is the purpose of a glob.

### Symbol selector

A symbol selector matches stable symbol ID, declaration path, or simple name. Selecting a symbol
also records its parent file and project:

```text
write symbol(core:index:SearchService.query)
        |
        +--> symbolsWritten += SearchService.query
        +--> filesWritten += core:index
        +--> symbolDerivedFilesWritten += core:index
        +--> projectsWritten += core
```

A simple name may match several declarations. A symbol selector that matches zero or several facts
emits an `ambiguous-selector` risk signal instead of silently pretending the match is precise.

### Shared-resource selector

The selector directly records `read` or `write` access. Every named resource is validated against
the registry before any impact calculation begins. A typo fails visibly rather than weakening a
hard scheduling policy.

## Why write provenance is retained

`filesWritten` is a conservative union. By itself it cannot explain the task's authority or
precision.

```text
Task A selects symbol Service.first
Task B selects symbol Service.second
Both symbols live in core:file

filesWritten(A) = { core:file }
filesWritten(B) = { core:file }
```

This may be a sibling-symbol risk rather than a whole-file collision. But consider:

```text
Task A selects both core:file and Service.first
Task B selects Service.second
```

If only the union survived, Task A would look symbol-scoped and could be allowed too much
concurrency. Therefore the prediction retains four distinct origins:

```text
explicitProjectsWritten   project selectors
explicitFilesWritten      exact file selectors
globFilesWritten          files reached by globs
symbolDerivedFilesWritten parent files reached from symbols
```

The sets may overlap intentionally. If any project, file, or glob scope covers a file, the Conflict
Engine treats it as whole-file scope. Sibling-symbol treatment is allowed only when both sides are
purely symbol-derived for that file and they write different symbols.

## Shared Resource Registry

Repository code is not the only source of concurrency risk. Tasks may touch lockfiles, migration
streams, generated output, deployment environments, or external coordination channels.

```json
{
  "resources": [
    {
      "id": "lockfile",
      "files": ["pnpm-lock.yaml"],
      "concurrency": "exclusive"
    },
    {
      "id": "migrations",
      "paths": ["migrations/**"],
      "concurrency": "ordered"
    },
    {
      "id": "generated-code",
      "paths": ["generated/**"],
      "concurrency": "producer-controlled"
    }
  ]
}
```

The registry owns policy; the Scheduler does not contain filename-specific conditions.

| Policy                | Current meaning                                                                      |
| --------------------- | ------------------------------------------------------------------------------------ |
| `exclusive`           | Any overlapping declared access is a hard serialization constraint                   |
| `ordered`             | Access must be staggered in task order                                               |
| `producer-controlled` | Read/read may overlap; write/read has producer direction; competing writes serialize |

`coordinate` is conservative intent. On a producer-controlled resource, coordinate/read cannot
prove a producer direction, so it becomes a nondirectional hard serialization constraint.

## Downstream project expansion

Repository project edges point from a consumer to its dependency:

```text
app ------> feature ------> core
     depends on      depends on
```

If a task writes `core`, impact propagation walks these edges in reverse:

```text
write core
   |
   +--> feature is downstream
              |
              +--> app is downstream
```

The traversal is iterative, transitive, deduplicated, and stably ordered. The written project itself
does not appear in `downstreamProjects`.

This is impact reachability, not permission to write downstream projects. It means downstream code
may need verification or may interact with another task's scope.

## Risk signals produced during impact analysis

| Signal               | Current evidence                                                   |
| -------------------- | ------------------------------------------------------------------ |
| `ambiguous-selector` | Exact selector matched zero or multiple repository facts           |
| `public-api-touch`   | A selected written symbol is exported                              |
| `generated-artifact` | A predicted written file is marked generated                       |
| `high-fan-out`       | The number of downstream projects reaches the configured threshold |

`public-api-touch` does not claim a signature change. The stronger
`public-api-signature-change` signal is reserved for future before/after observed analysis.

A signal belongs to one task. It becomes a pairwise conflict reason only if the other task actually
touches a related area. A high-fan-out task and a completely independent task do not receive a fake
conflict merely because one task is risky in isolation.

## PredictedTaskImpact output

The output groups facts by granularity and evidence source:

```text
PredictedTaskImpact
├── taskId
├── projectsRead / projectsWritten
├── explicitProjectsWritten
├── filesRead / filesWritten
├── explicitFilesWritten
├── globFilesWritten
├── symbolDerivedFilesWritten
├── symbolsRead / symbolsWritten
├── sharedResources
├── sharedResourceAccesses: resource -> read | write | coordinate
├── downstreamProjects
└── riskSignals
```

All returned sets and lists have stable, locale-independent ordering. Determinism matters because
the same repository and task contract must produce the same review evidence, cache key inputs, and
scheduling decisions on different machines.

## From impacts to a conflict

The Conflict Engine compares two predicted impacts in canonical task-ID order: it sorts the pair by
locale-independent string comparison, regardless of which task was passed as the first argument.

```text
Impact A + Impact B + RepositoryGraph + Registry + Config
                         |
                         v
              compare code overlap
              compare shared resources
              compare project relationships
              contextualize risk signals
                         |
                         v
              deduplicate and stable-sort
                         |
               +---------+---------+
               |                   |
       any hard constraint?        no constraint
               |                   |
               v                   v
       HardTaskConflict      RiskTaskConflict
```

The implementation is `DeterministicConflictEngine` in
`libs/conflict-engine/src/lib/conflict-engine.ts`.

## Code-overlap rules

### Same exact symbol

Two predicted writes to the same symbol create a structural `same-symbol-write` constraint.

```text
A writes Service.search
B writes Service.search
            |
            v
hard + serialize
```

This remains hard even if the configured explanatory score for the reason is zero.

### Different symbols in the same file

If both tasks are purely symbol-scoped and select different symbols, the engine reports a scored
`same-file-different-symbol` risk. It does not invent a hard constraint.

```text
A writes Service.first ----+
                            +--> same physical file --> soft risk
B writes Service.second ---+
```

Runtime leases may later allow symbol-level concurrency only while observed writes remain inside
the predicted symbol boundaries.

### Whole-file overlap

If either task has explicit project, file, or glob scope covering the file, the overlap is
`same-file`, not sibling-symbol. This prevents broad authority from masquerading as precise symbol
scope.

### Producer-consumer repository overlap

When one task predicts a write to a file or symbol that the other predicts reading, the engine adds
an explainable scored `producer-consumer` reason. It does not rewrite the functional DAG and does
not by itself invent a hard direction. A directional hard constraint currently comes only from an
explicit producer-controlled resource policy.

### Generated overlap

Overlapping access involving a predicted write to a generated file adds a `generated-code` reason.
Generated output often has wider blast radius or regeneration requirements, so it receives separate
explanation and weight.

## Project and propagation rules

- Two tasks writing the same project receive a `same-project` reason.
- A task touching a downstream project of the other task's write scope receives an
  `upstream-downstream-project` reason.
- `public-api-touch` and `high-fan-out` become pairwise reasons only when that downstream
  relationship actually intersects the other task.

These are scored risks unless accompanied by an independent structural constraint.

## Hard constraints versus scored risk

This is the most important rule in the design.

```text
                    TaskConflict
                         |
          +--------------+--------------+
          |                             |
 HardTaskConflict                RiskTaskConflict
 severity = hard                 severity = none | soft
 constraints = non-empty         constraints = empty
 action = stagger | serialize    action = parallel | guarded |
                                          stagger | serialize
```

A hard conflict is hard because a structural constraint exists—not because its score crossed a
threshold. Its score is explanation metadata only.

Examples of hard constraints:

- same exact symbol write;
- exclusive shared resource;
- ordered shared resource;
- producer-controlled competing writes or coordination;
- directional producer-controlled writer/reader.

Risk scores are calculated by adding deduplicated reason weights and capping the result at 100.
Validated thresholds map a non-hard score to an action. Score zero always means `parallel`, even if
someone configures the guarded-parallel threshold to zero.

The future Scheduler must receive hard conflicts and risk conflicts separately and must never
filter hard constraints by score.

## Conflict edge versus ordering edge

A pairwise conflict edge is symmetric:

```text
A <-------- cannot overlap --------> B
```

A producer-consumer constraint is directional:

```text
producer -------- must finish before --------> consumer
```

The Conflict Engine preserves both meanings. Canonical task-ID sorting stabilizes output but never
decides producer direction. Direction comes from actual `write` versus `read` access modes.

Milestone 6 does not mutate the functional dependency graph. Milestone 7 may derive a scheduling
ordering edge from this constraint while keeping the original task dependency facts distinguishable.

## Worked example

Assume this project graph and registry:

```text
web ------> search-api ------> search-core

search-index: producer-controlled
pnpm-lock.yaml: exclusive
```

Task A:

```text
write symbol search-core:SearchService.query
write shared-resource search-index
```

Task B:

```text
read project web
read shared-resource search-index
```

Impact A includes:

```text
projectsWritten          { search-core }
filesWritten             { file containing SearchService.query }
symbolDerivedFilesWritten{ same file }
symbolsWritten           { SearchService.query }
downstreamProjects       { search-api, web }
search-index access      write
public-api-touch         if the symbol is exported
```

Impact B includes:

```text
projectsRead             { web }
search-index access      read
```

Pairwise comparison produces:

```text
reasons:
  producer-consumer
  upstream-downstream-project
  public-api-touch, if applicable

constraint:
  producerTaskId = A
  consumerTaskId = B

severity: hard
recommendedAction: stagger
```

The numeric score explains additional risk. It does not create or remove the producer ordering.

## Failure behavior

The normal analysis path fails fast only for explicitly named unknown shared resources:

```text
UNKNOWN_SHARED_RESOURCE
resourceIds: sorted unknown IDs
```

Unresolved repository selectors are different: they produce `ambiguous-selector` signals because a
partially stale task contract may still be useful for conservative planning and human review.

The Conflict Engine retains a defensive soft fallback for an unregistered resource only when it is
given a manually constructed or old persisted impact that bypassed the normal analyzer.

## Core invariants

1. Repository facts remain independent from task predictions.
2. Predictions remain separate from future runtime observations.
3. File and symbol selectors include owning ancestry.
4. Whole-file provenance cannot be downgraded to sibling-symbol precision.
5. Explicit shared-resource IDs must resolve before normal impact analysis.
6. Hardness comes from structural constraints, never numeric thresholds.
7. Producer direction comes from write/read semantics, never task-ID order.
8. Read/read on a producer-controlled resource remains parallel.
9. Risk signals become pairwise reasons only when the other task touches related scope.
10. Outputs are deduplicated and deterministically ordered.
11. Impact and conflict analysis are read-only and contain no LLM, Git, pnpm-command, or provider
    logic.

## What this milestone does not do

It does not:

- parse natural-language tasks into contracts;
- prove that predicted writes will occur;
- observe filesystem or process activity;
- grant write permission;
- acquire or enforce Write Leases;
- decide which ready task starts now;
- execute an agent;
- create Git worktrees or merge changes;
- persist or recover an orchestration run;
- run verification commands.

Those responsibilities belong to future planning, Scheduler, Runtime Guard, workspace, persistence,
agent-execution, and verification layers.

## Current limitations

- Selector matching currently scans in-memory graph collections rather than a dedicated lookup
  index; this is acceptable at the validated scale but must be measured for very large graphs.
- Project-to-file relationships are consulted in both impact expansion and conflict overlap logic;
  changes to either representation require a consistency review.
- `coordinate` is intentionally conservative and does not imply producer direction.
- Repository read/write overlap produces a scored producer-consumer reason, while only an explicit
  producer-controlled resource currently creates a hard directional constraint.
- Observed impact collection and predicted-versus-observed reconciliation are not implemented.
- No incremental impact cache is exposed.
- Configuration defines policy locally; a user-facing configuration format and CLI integration are
  future work.

## How Milestone 7 consumes the result

The event-driven Scheduler will combine four inputs without collapsing them:

```text
functional DAG readiness
        +
hard scheduling constraints
        +
scored risk conflicts
        +
runtime concurrency capacity
        |
        v
structured, auditable dispatch decision
```

Before dispatch is implemented, Scheduler events and decision reasons must become structured
discriminated payloads suitable for persistence and replay. The Scheduler must not introduce a
hidden execution-wave barrier, and it must never use a hard conflict's score to decide whether the
constraint applies.
