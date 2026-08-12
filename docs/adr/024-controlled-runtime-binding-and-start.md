# ADR-024: Controlled Runtime Binding and Start

## Status

Accepted. Stage 20's runtime boundary and sandboxed-verification follow-up passed independent review.

## Context

`PlanExecutionIntent` proves that an immutable artifact, approval, claim, repository snapshot,
Repository Facts, and authority policies agreed at binding time. It is not a repository lock. Calling
the runtime from an old intent without another check would leave a bind-to-run time-of-check/time-of-use
gap. Running directly in the source checkout would also mix user state, task state, and integration
state.

## Decision

Stage 20 introduces a dedicated `run-preparation` application boundary. It performs these operations in
order:

```text
validated PlanExecutionIntent
        -> fresh PlanExecutionBinder revalidation
        -> reject dirty approved snapshots
        -> provision/reuse integration checkout at approved baseCommit
        -> derive deterministic task bindings and worktrees
        -> verify runtime request against the approved decision
        -> persist run authority and start or resume OrchestrationRuntime
```

The integration checkout is owned by the orchestrator and is outside the approved source repository.
Each task worktree starts at the approved base commit and integrates serially into the run-specific
integration branch. The source checkout is never used as an execution workspace.

The durable run record stores artifact, approval, claim, execution, repository snapshot, Repository
Facts, shared-resource policy, and verification-policy fingerprints. An identical retry can return or
resume the same run; a retry with different authority fails closed.

Every local `startRun()` and `startOrResumeRun()` call for the same repository/run identity enters one
process-wide lifecycle queue before it reads recovery evidence or dispatches an agent. This prevents
two concurrent callers in one orchestrator process from resuming the same `PREPARING` attempt and
starting the external agent twice. The queue is deliberately not described as cross-process fencing.

Every task commit contains `Forge-Run-Id` and `Forge-Task-Id` trailers. Reusing an advanced integration
checkout requires every commit after the approved base to carry the requested run trailer. This marks
ordinary accidental or third-party commits as foreign; it is local integrity metadata, not a signature
against an attacker who can forge Git commits.

`forge run` is a thin CLI composition route. `RunPreparation`, `LocalRuntimeBindingPolicy`, and
`LocalRuntimeStarter` own orchestration composition. Pi receives only the controlled Forge tools.
Package-script verification is executed after the agent completes, but only through the exact
fingerprinted Docker verification profile. Direct host execution is forbidden. Each verification container
has a run-scoped name; timeout, cancellation, or output limits trigger Docker daemon-side `kill`, `wait`,
and cleanup before the verifier reports that command settled.

## Boundaries

- Stage 20 supports clean approved Git snapshots. Dirty artifacts are rejected until their exact
  tracked/untracked byte state can be materialized into an isolated checkout.
- The local SQLite and in-memory lease implementation is recoverable on one host. It is not
  distributed fencing. Persisted leases are hydrated on retry so a restarted local guard does not
  silently forget existing exclusions.
- The lifecycle queue prevents duplicate local dispatch only inside one Node.js process. Multiple
  processes or hosts require a future durable execution claim/fencing protocol.
- Successful output remains on the run-specific integration branch and checkout. Publishing it to the
  user's branch, opening a pull request, or pushing a remote branch is a later product workflow.
- The default coding-agent binding does not grant `forge_command`. Final package-script verification is
  independent of agent command access.
- SHA-256 evidence remains an integrity link under the local filesystem threat model, not a signature.
- Package verification maps the approved project through Repository Facts, uses a fixed argument
  vector, and runs in a pinned-digest Node container with no network, read-only root/workspace mounts,
  a non-root user, dropped capabilities, `no-new-privileges`, bounded memory/CPU/PIDs, and disposable
  temporary storage. Parent environment variables are not inherited. Unknown packages, free-form
  commands, policy drift, missing Docker/image state, and sandbox failure all fail closed.
  The verification image must use an immutable sha256 digest.
- Linked worktrees isolate checked-out files, not the source repository's shared `.git` metadata.
  Physical Git-metadata isolation requires a future dedicated orchestrator clone. Branch-only partial
  creation after process interruption also requires an explicit reconciliation path.
- Verification container names are unique run-scoped identifiers but do not currently embed readable task
  provenance. Container-to-task operational lookup is future observability work.

## Consequences

The first end-to-end local Plan-to-Run route now exists without moving scheduler, lease, Git,
verification, persistence, or recovery policy into the CLI or Pi adapter. Additional product adapters
can call the same preparation boundary, while dirty-snapshot materialization, distributed lease
fencing, cancellation, multi-failure aggregation, and publication remain explicit future work.
