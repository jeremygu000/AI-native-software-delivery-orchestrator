---
title: Workspace and Git Lifecycle - Training Guide
tags:
  - coding-orchestrator
  - workspace
  - git
  - integration
status: implemented
---

# Workspace and Git Lifecycle - Training Guide

This guide explains Milestone 10: how a completed task receives an isolated local Git worktree,
rebases safely, integrates through a fast-forward-only merge, preserves a recoverable integration
block, and disposes its workspace without silently deleting dirty work.

For scheduling semantics, read [Scheduler Dispatch](./scheduler-dispatch.en.md). For persisted
integration evidence, read [Persistence and Replay](./persistence-replay.en.md).

## The short version

The Workspace/Git layer answers:

> How can one task change a repository in isolation and later join the integration branch without
> silently mixing incomplete work or losing a Git conflict?

```text
base ref
   |
   v
isolated task worktree + task branch
   |
   v
task commits its completed work
   |
   v
rebase onto integration ref
   |
   v
fast-forward-only merge
   |
   +--> INTEGRATED
   |
   +--> INTEGRATION_BLOCKED with Git evidence
```

The implementation is `GitWorkspaceManager` in
`libs/workspace-git/src/lib/git-workspace-manager.ts`.

## Why a worktree exists

Several tasks must not edit one checkout at the same time. A Git worktree gives each task a separate
directory and branch while sharing one underlying Git repository object store.

```text
integration repository
  main
    |
    +-- task worktree A, branch orchestrator/run-1/A
    |
    +-- task worktree B, branch orchestrator/run-1/B
```

Each task can commit independently. Worktree paths are deliberately outside the integration checkout,
so Git does not mistake a sibling worktree directory for an untracked integration-repository file.
Creation requires both a clean target path and a new task branch name. If either already exists, the
manager stops with a stable `GitWorkspaceError`; it never attaches a new workspace to a prior task's
branch.

## Workspace identity

A persisted `TaskWorkspace` records:

```text
workspace ID
run ID
task ID
integration repository path
worktree path
task branch name
base ref
integration ref
positive revision
integration phase
optional integration commit or block evidence
```

The workspace uses a lifecycle separate from `TaskState`:

```text
READY_TO_INTEGRATE
        |
        +-- rebase conflict
        +-- dirty integration repository
        +-- fast-forward failure
        |
        v
INTEGRATION_BLOCKED
        |
        +-- resumeIntegration
        +-- abortIntegration
        |
        v
READY_TO_INTEGRATE or INTEGRATED
```

This is intentional. A task that reached `INTEGRATING` already finished normal execution and
verification. A Git conflict must not erase that fact by using the lossy shortcut:

```text
INTEGRATING -> BLOCKED -> READY
```

`INTEGRATION_BLOCKED` preserves whether the system is repairing Git integration rather than running
the task again.

Every state-changing result increments the revision. SQLite persistence accepts a higher revision or
an exactly identical retry at the same revision; it rejects stale revisions and same-revision records
with different evidence. A delayed `READY_TO_INTEGRATE` record therefore cannot overwrite a persisted
`INTEGRATED` or blocked workspace.

## Create

Workspace creation validates both refs before creating anything:

```text
git rev-parse --verify <base ref>
git rev-parse --verify <integration ref>
git worktree add -b <task branch> <workspace path> <base ref>
```

Git creates the branch and materializes the checkout in this one operation. There is no separate
`--no-checkout` phase that a retry could mistake for a ready workspace after process interruption.

Creation is retry-aware after a process interruption. If the target path is already a valid Git
worktree on the requested branch and its `HEAD` matches that branch in the integration repository,
creation returns the equivalent revision-1 workspace. A path that is not that exact worktree remains a
collision and is rejected.

This reuse path is only for an interruption before the first successful persistence. It cannot recover
a later workspace revision; recovery must load that record from persistence. Retrying `create` against
a later persisted workspace produces revision 1, which persistence rejects through revision CAS rather
than allowing it to overwrite newer integration evidence.

## Integration model

Integration has two deliberate steps:

```text
task branch
   |
   v
git rebase <integration ref>
   |
   v
integration checkout switches to <integration ref>
   |
   v
git merge --ff-only <task branch>
```

The rebase incorporates the latest integration history before merging. `--ff-only` prevents the
manager from inventing an implicit merge commit. If the integration ref cannot advance directly to

Before switching or merging, the integration repository must be clean. A dirty repository returns:

```text
phase: INTEGRATION_BLOCKED
blocker.type: repository-dirty
blocker.conflictPaths: changed paths
```

This protects unrelated manual work in the integration checkout.

The checkout is not a user's working directory. `integrationRepositoryPath` must be an orchestrator-owned
integration checkout, such as `.forge/integration/<repository-id>`, because integration switches it
to the integration ref. The future application layer is responsible for provisioning and exclusively
owning this directory; portable detection of an editor or shell using a checkout is not available.

## Rebase conflict handling

When a task branch and integration ref both modify incompatible lines:

```text
task branch:         value.txt = task value
integration ref:     value.txt = integration value
        |
        v
git rebase conflicts
```

The manager returns:

```text
phase: INTEGRATION_BLOCKED
blocker.type: rebase-conflict
blocker.conflictPaths: ["value.txt"]
```

An outer runtime or human repairs the file in the task worktree and stages it. Then:

```text
resumeIntegration
  -> git -c core.editor=true rebase --continue
  -> fast-forward integration if rebase succeeds
```

If repair is abandoned:

```text
abortIntegration
  -> git rebase --abort
  -> READY_TO_INTEGRATE
```

For a dirty integration repository or a fast-forward failure, there is no active rebase to continue
or abort. `resumeIntegration` simply retries normal integration after the outer cause is fixed.

## Persistence and recovery

`TaskWorkspace` records persist by:

```text
run ID + workspace ID
```

This lets SQLite recovery retain a structured `INTEGRATION_BLOCKED` record after restart:

```text
recovered workspace
  phase: INTEGRATION_BLOCKED
  blocker: rebase-conflict
  paths: ["value.txt"]
```

The future outer runtime can choose `resumeIntegration` or `abortIntegration` without confusing this
phase with normal task dispatch.

## Disposal

Removing a workspace is always explicit.

```text
git status --porcelain=v1
        |
        +-- clean --> git worktree remove + git branch -D
        |
        +-- dirty --> return dirty paths
```

The default is safe:

```text
dispose({ workspace, force: false })
  -> { status: "dirty", paths: [...] }
```

Deleting dirty work requires:

```text
dispose({ workspace, force: true, reason: "..." })
```

The adapter validates that the reason is non-empty before a forced removal. The reason belongs to the
caller's audit layer; the current local Git adapter does not persist an audit event itself.

Disposal is retry-aware. If a previous removal already deleted the worktree directory, the manager
skips the dirty check and worktree removal, then deletes the task branch only if it still exists. This
finishes a partially completed disposal without treating a missing worktree as an error.

All Git commands use asynchronous child-process execution. Dirty and conflict path queries request
NUL-delimited Git output, preserving paths with spaces, quotes, or line breaks.

## What Milestone 10 does not do

It does not:

- execute an agent or task command;
- observe filesystem writes or compare them with predicted impact;
- acquire or release Runtime Guard leases during actual writes;
- automatically repair a conflict;
- coordinate multiple repositories, processes, or hosts;
- support merge commits, squash merges, or cherry-pick integration strategies;
- persist Git command output beyond structured workspace blocker evidence;
- turn a lease lifecycle version into a real write fencing token;
- expose an end-to-end `forge plan` or `forge run` command.

The manager is a local Git lifecycle adapter. A future agent/runtime layer must coordinate it with
Scheduler decisions, Runtime Guard ownership, verification, persistent transitions, and actual write
observation.

## Verification and current limits

The workspace-git package has 26 passing tests with 99.02% statements, 94.44% branches, 100%
functions, and 99% lines. Tests use real temporary Git repositories for the main lifecycle and an
injectable command runner for deterministic command-failure paths. The repository quality gate has
234 passing tests with 97.31% statements, 92.48% branches, 99.04% functions, and 97.29% lines.
`pnpm check`, `pnpm build`, and `git diff --check` pass.

The implementation is proven for local single-repository worktrees. It must be measured and extended
before claiming suitability for many concurrent worktrees, network filesystems, remote repositories,
or multi-process workspace ownership.
