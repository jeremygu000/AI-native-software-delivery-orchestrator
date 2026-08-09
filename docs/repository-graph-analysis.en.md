---
title: RepositoryGraph Analysis — Implementation and Working Model
tags:
  - coding-orchestrator
  - repository-graph
  - architecture
status: implemented
---

# RepositoryGraph Analysis — Implementation and Working Model

This document is the standalone technical companion to the project progress summary. It explains
how `forge analyze <repository>` turns a pnpm TypeScript repository into a deterministic
`RepositoryGraph`, where each fact comes from, how identities are stabilized, and what the analyzer
deliberately does not infer.

## The short version

The analyzer combines two evidence sources:

```text
pnpm workspace and package manifests
                  +
TypeScript Programs and Type Checkers
                  |
                  v
          normalized graph facts
```

pnpm supplies package membership and declared workspace dependencies. TypeScript supplies source
files, resolved modules, declarations, exports, and symbol references. Deterministic conversion
rules turn those tool-specific facts into domain-owned nodes and edges.

This is not LLM analysis. It makes no model call, sends no source code over the network, and does
not modify the analyzed repository.

## What the graph represents

```text
RepositoryGraph
├── repositoryPath
├── projects: Map<ProjectId, ProjectNode>
├── files: Map<FileId, FileNode>
├── symbols: Map<SymbolId, SymbolNode>
├── projectDependencies: ProjectId -> ProjectId
├── fileDependencies: FileId -> FileId
├── symbolReferences: SymbolId -> SymbolId
└── diagnostics: RepositoryDiagnostic[]
```

### Nodes

- `ProjectNode` represents a pnpm workspace package and records its stable package ID, package root,
  and optional source root.
- `FileNode` represents one real TypeScript file owned by exactly one project.
- `SymbolNode` represents a supported named declaration inside a file, including its parent symbol,
  kind, merged kinds, and export visibility.

### Edges

- A project edge means a manifest or a resolved cross-project source dependency exists.
- A file edge means TypeScript resolved an import or export from one repository file to another.
- A symbol edge means the TypeScript Checker resolved a use in one indexed symbol to the declaration
  of another indexed symbol.

An edge is structural evidence. It does not yet mean a proposed coding task will modify the target,
that two tasks conflict, or that an agent is authorized to write there.

## End-to-end control flow

```text
forge analyze <repository>
        |
        v
apps/cli/src/app.ts
  resolve the user path
  call analyzeRepository()
        |
        v
project-graph-analysis.ts
  select the first provider whose supports() returns true
        |
        +------------------------------+
        |                              |
        v                              |
PnpmWorkspaceProvider                  |
  read workspace structure             |
  create projects and manifest edges   |
        |                              |
        +--------------+---------------+
                       |
                       v
TypeScriptRepositoryAnalyzer
  discover configs and Programs
  create files, symbols, and semantic edges
  add diagnostics
                       |
                       v
RepositoryGraph returned to the CLI
  summary by default
  complete graph with --full
```

The composition entry point is `libs/repository-analysis/src/lib/project-graph-analysis.ts`.
Package-manager discovery and TypeScript enrichment are intentionally separate so another provider
can be added without changing the domain graph or the TypeScript conversion rules.

## Phase 1: selecting a repository provider

`analyzeProjectGraph()` resolves the requested path to an absolute path and checks the configured
providers in order. The current default list contains `PnpmWorkspaceProvider`.

The pnpm provider supports a repository when its root contains `pnpm-workspace.yaml`. If no provider
supports the path, analysis fails with `UNSUPPORTED_REPOSITORY`; it does not silently guess a
repository layout.

## Phase 2: building the pnpm project graph

`PnpmWorkspaceProvider` performs the following work:

```text
read pnpm-workspace.yaml
        |
        v
expand workspace package patterns
        |
        v
find root and workspace package.json files
        |
        v
parse names and dependency fields
        |
        v
create ProjectNode records
        |
        v
create workspace project edges
```

The provider reads `dependencies`, `devDependencies`, `peerDependencies`, and
`optionalDependencies`. If a dependency name matches another discovered workspace project, it
creates an edge. A missing `workspace:*` target is an error because the manifest explicitly claims
that the target belongs to this workspace.

The provider validates:

- repository and workspace readability;
- workspace YAML and package JSON structure;
- non-empty and unique package names;
- dependency maps and version strings;
- missing workspace targets;
- project self-dependencies;
- manifest paths that resolve outside the repository.

At the end of this phase, `projects` and manifest `projectDependencies` are populated. Files,
symbols, and semantic edges are still empty.

## Phase 3: discovering TypeScript configurations

The TypeScript analyzer begins at each project's root `tsconfig.json`. It parses JSONC directly, so
comments and trailing commas are supported, then recursively follows project references.

```text
project/tsconfig.json
├── tsconfig.app.json
├── tsconfig.spec.json
└── config/tsconfig.build.json
```

This is essential for solution-style repositories: a root config may contain `files: []` and only
coordinate referenced compilation configs. Opening only the root file would otherwise produce a
successful but empty graph.

Reference traversal:

- resolves TypeScript-supported file and directory reference forms;
- deduplicates configs, so reference cycles do not loop forever;
- rejects missing targets;
- resolves symlinks and rejects targets outside the repository;
- reports malformed JSONC and malformed `references` as structured errors.

## Phase 4: opening real TypeScript Programs

All discovered configs are opened through the pinned TypeScript 7 native synchronous API. Each
native Project exposes a Program and Checker configured with the target repository's real:

- compiler options;
- module and module-resolution mode;
- path aliases and base URL;
- package exports and Node ESM rules;
- project references and workspace links.

The analyzer does not reimplement module resolution by scanning import strings. It asks TypeScript
for the relationships TypeScript itself resolved.

The native API is imported only inside `libs/repository-analysis`. Native AST nodes, Projects,
Programs, Checkers, and Symbols are converted immediately and never cross into `libs/domain`.
TypeScript 7 is pinned; TypeScript 6 is not installed.

## Phase 5: choosing the owning compiler context

A physical source file can appear in more than one Program—for example an app config and a test
config may overlap. The analyzer must select one Checker deterministically.

The rules are:

1. Resolve the source file to its real filesystem path.
2. Reject real targets outside the repository or inside `node_modules`.
3. Assign the file to the most specific pnpm project containing that real path.
4. Accept only a compiler config owned by that same project.
5. Prefer a production config over a spec/test config.
6. If equal-priority configs overlap, choose the lexicographically first config path.

The last rule is a deterministic tie-break, not a claim that one set of compiler options is
semantically better.

This prevents a root or sibling project from lending an arbitrary Checker to another project's
source while still allowing a project to store its real compiler config below its root, such as
`config/tsconfig.build.json`.

## Phase 6: stable file identity and symlinks

File identity is based on the real filesystem target:

```text
FileId = ProjectId + ":" + real repository-relative path
```

Example:

```text
api:workspace/api/src/modules/work/router.ts
```

Consequences:

- two symlink paths to the same file produce one `FileNode`;
- their declarations produce one symbol set;
- imports through a symlink still point to the real target node;
- a symlink into `node_modules` or outside the repository cannot bypass the boundary;
- `FileNode.path` may differ from the path spelling written in an import statement;
- callers resolving a user-supplied path must apply the same real-path normalization before lookup.

macOS and Windows keys are case-normalized. Generated paths are marked with `isGenerated`. IDs do
not include line numbers or content hashes.

## Phase 7: building file dependencies

For each selected source file, the analyzer reads TypeScript's resolved module information and maps
resolved repository targets back to `FileNode` IDs.

Supported relationships include:

- normal imports;
- type imports;
- named re-exports;
- `export *` chains;
- path aliases;
- bare workspace package specifiers;
- shared-source imports.

Edges are deduplicated and sorted with a locale-independent comparator. When a file edge crosses
project ownership, it also creates a project edge. Semantic project edges are merged with manifest
edges rather than replacing them.

## Phase 8: indexing symbols

The current declaration index includes:

- classes, interfaces, functions, enums, type aliases, namespaces, and variables;
- constructors, methods, getters/setters, and properties;
- recursive namespace contents and dotted namespace declarations.

Each symbol records its file, stable path, kind, optional parent, export status, and optional merged
kinds. Private and protected members remain non-exported.

A symbol ID extends its file ID:

```text
api:workspace/api/src/modules/work/router.ts:createWorkRouter
api:workspace/api/src/service.ts:UserService.findUser
```

### Declaration merging

TypeScript can merge declarations such as a class and namespace with the same name. The analyzer
uses a fixed kind priority for the primary `kind` and stores all kinds in `mergedKinds`, so source
order does not change the result.

### Computed names

Literal computed names are restored to their literal text. Dynamic names use an escaped expression
identity. Getter/setter pairs share one symbol, redundant parentheses are removed, and repeated
properties are numbered among occurrences of the same normalized expression—not by their absolute
position in the class.

## Phase 9: building symbol references

The analyzer visits identifiers belonging to indexed declarations and asks the Checker for the
resolved native Symbol. Aliases are followed to their target declaration. If the target declaration
belongs to another indexed symbol, the analyzer creates a `SymbolId -> SymbolId` edge.

This supports references across files, path aliases, re-export chains, and projects. It does not
connect identifiers merely because their text is equal. Requests are processed in bounded batches
to cap temporary native handle and memory pressure.

## Phase 10: diagnostics for incomplete input

The analyzer distinguishes invalid input from valid but incomplete input.

Invalid config or repository structure throws a `ProjectGraphError`. Successful graphs may contain
warnings:

| Diagnostic                         | Meaning                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `MISSING_TYPESCRIPT_CONFIGURATION` | The project has no root TypeScript configuration                    |
| `EMPTY_TYPESCRIPT_PROJECT`         | Valid configs produced no owned source files                        |
| `UNCOVERED_TYPESCRIPT_FILES`       | TypeScript files exist on disk but no discovered config covers them |

For uncovered files, the analyzer performs a repository glob and compares project-owned TypeScript
files with indexed files. It excludes dependency directories, build/coverage output, and nested
pnpm workspaces. It reports exact relative paths instead of silently assigning an arbitrary Checker.

Intentionally excluded generated files can still produce noise; severity separation is a future
policy decision.

## Phase 11: native resource cleanup

The native API and snapshot are explicitly closed after success or failure:

```text
attempt snapshot.dispose()
        |
        v
attempt api.close(), even if dispose failed
        |
        v
return the graph or the correct structured error
```

The original analysis error wins over cleanup errors and retains its stack. If analysis succeeded
but cleanup failed, the cleanup failure is still returned as a structured analysis error. Unit and
integration tests cover both the outcome rules and a real failure after a native snapshot opens.

## CLI serialization

```sh
pnpm exec forge analyze /path/to/repository
pnpm exec forge analyze /path/to/repository --full
```

Default output includes:

- provider and repository path;
- counts;
- projects and project dependencies;
- diagnostics.

`--full` additionally includes every file, symbol, file edge, and symbol edge. Full output can be
large and is intended for machines or focused investigation rather than routine terminal reading.

## Core invariants

The implementation is designed around these invariants:

1. Every indexed file belongs to exactly one project.
2. A file is analyzed only by a config owned by that project.
3. One real file has one graph identity, regardless of symlink spelling.
4. No file or config may escape the repository through a symlink.
5. IDs do not depend on absolute machine paths or line numbers.
6. Nodes and edges are deduplicated and deterministically ordered.
7. Invalid input fails visibly; valid incomplete input produces diagnostics.
8. Compiler-native objects never leak into the domain graph.
9. Analysis is read-only.

## What RepositoryGraph does not do

RepositoryGraph answers:

> What projects, files, and symbols exist, and what structural relationships can the repository
> tools prove between them?

It does not answer:

- what a natural-language task intends to change;
- how far a proposed change will propagate;
- whether two tasks conflict;
- which tasks may run concurrently;
- whether an agent currently holds permission to write;
- how changes should be merged in Git.

Those responsibilities belong to Task Impact Engine, Conflict Engine, Scheduler, Runtime Guard,
and Workspace/Git layers respectively.

## Current limitations

- Semantic indexing currently covers TypeScript-family files, not every language or infrastructure
  format.
- Not every anonymous or deeply nested AST construct becomes a symbol.
- Normalized callable and type signatures are not yet extracted.
- Analysis is a full scan; incremental `changedFiles` refresh is not implemented.
- Project edges do not yet preserve provenance such as manifest, production, test, generated,
  runtime, or type-only evidence.
- The uncovered-file scan is validated around one-thousand-file scale, not yet benchmarked for
  repositories with tens of thousands of files.
- Summary output includes an absolute repository path and may reveal local directory information.

## How the next stage consumes it

Task Impact Engine will treat RepositoryGraph as a read-only factual index:

```text
task selectors
      |
      v
resolve project/file/symbol nodes
      |
      v
expand through file dependencies and symbol references
      |
      v
produce an explainable TaskImpact
```

The key architectural boundary is that RepositoryGraph records what exists; Task Impact records
what a particular task may affect.
