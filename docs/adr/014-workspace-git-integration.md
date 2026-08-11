# ADR-014: Isolated workspace and Git integration lifecycle

## Status

Accepted

## Decision

Each task receives an isolated Git worktree on its own task branch, created from an explicit base ref.
Before integration, the task branch rebases onto the explicit integration ref. The integration
repository then switches to that ref and accepts the task branch only through `git merge --ff-only`.
The implementation never creates an implicit merge commit. Workspace creation uses one `git worktree
add -b` operation that creates the branch and materializes its checkout together; it does not leave a
separate `--no-checkout` to be reconciled after a process interruption. Creation rejects both an occupied worktree
path and an existing task branch through the stable Git adapter error; a branch collision must not
silently reuse a previous task's branch.

`repositoryPath` is an orchestrator-owned integration checkout, not a user's active working directory.
The caller must provision it separately, for example under `.forge/integration/<repository-id>`, and
must not pass a checkout a user may have open on another branch. The Git adapter switches this checkout
to the requested integration ref before fast-forwarding, so accepting a user-active checkout would
silently move that user's branch even when the directory is clean. Detecting shell or editor use is not
portable; exclusive checkout ownership is therefore a caller responsibility until an application layer
provisions and manages these directories.

Workspace integration uses its own phase-aware lifecycle rather than overloading `TaskState`:

```text
READY_TO_INTEGRATE
        |
        +-- rebase conflict / dirty integration repository / fast-forward failure
        |                         |
        |                         v
        |              INTEGRATION_BLOCKED
        |                         |
        |                         +-- resumeIntegration after external repair
        |                         +-- abortIntegration
        |
        +-- successful fast-forward --> INTEGRATED
```

`INTEGRATION_BLOCKED` retains a structured blocker type, detail, and conflicted paths. It never
pretends that verified work is ordinary execution work again by converting `INTEGRATING` to `READY`.
Only a rebase-conflict block runs `git rebase --continue` or `git rebase --abort`; dirty repository and
fast-forward blocks resume by retrying normal integration after the outer runtime repairs their cause.

Workspace evidence is persisted by run ID and workspace ID. It therefore survives restart and retains
the integration phase needed for later resume or abort. A workspace is disposed only by an explicit
call. Disposal refuses a dirty worktree by default and returns its stable changed paths; any
`force: true` disposal requires a non-empty caller reason before Git removal runs.

Workspace creation can reuse only a matching interrupted revision-1 worktree. The retry path does not
recover a later persisted revision; callers must recover that record through persistence rather than
call `create` again. If they do call `create`, workspace revision compare-and-swap rejects the stale
revision-1 view instead of overwriting later integration evidence.

## Consequences

The implementation is a local Git adapter, not an agent runtime. It does not execute task code,
observe writes, acquire leases, resolve predicted scope, automatically repair conflicts, or integrate
multiple repositories. The outer runtime must coordinate Scheduler task state, Runtime Guard leases,
verification, persisted transitions, and the WorkspaceManager lifecycle. Multi-process ownership
fencing remains a later requirement.
