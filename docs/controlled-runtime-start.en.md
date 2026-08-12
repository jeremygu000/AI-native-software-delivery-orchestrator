# Controlled Runtime Binding and Start

## 1. What Stage 20 adds

Stage 20 turns an approved, freshly revalidated plan into a real local run. It is the first stage where
`forge run` may create worktrees, dispatch coding agents, verify their work, commit it, and integrate it.

The key rule is that approval evidence is checked again immediately before the first execution side
effect:

```text
PlanArtifact
    |
PlanApproval + single-run claim
    |
PlanExecutionIntent
    |
    +-- reload artifact and approval
    +-- recapture Git snapshot before analysis
    +-- rebuild RepositoryGraph
    +-- recapture Git snapshot after analysis
    +-- compare repository, facts, and policy fingerprints
    |
    v
orchestrator-owned integration checkout at approved baseCommit
    |
    +-- task worktree A -- Pi tools -- verify -- commit --+
    +-- task worktree B -- Pi tools -- verify -- commit --+--> serial integration branch
    |
durable SQLite run evidence
```

Parsing a valid intent is not enough. The second binder call closes the time gap between `forge bind`
and `forge run`.

## 2. Where the implementation lives

```text
apps/cli
   -> run-preparation
         -> planning (revalidation evidence)
         -> workspace-git (integration checkout and task worktrees)
         -> orchestration-runtime
                -> scheduler
                -> runtime-guard
                -> persistence
                -> agent-runtime
```

The CLI resolves paths and supplies adapters. It does not schedule tasks or manually manage leases.
`RunPreparation` owns the ordered authority boundary. `LocalRuntimeBindingPolicy` converts the approved
decision into runtime tasks, impacts, canonical lease plans, deterministic agent/workspace identities,
and Git bindings. `LocalRuntimeStarter` composes the existing runtime with SQLite, the scheduler, the
write guard, Git worktrees, controlled Pi tools, and package-script verification.

Only newly required public entry points are re-exported. Infrastructure command and helper types stay
inside their adapter modules.

## 3. Integration checkout and task worktrees

The approved source repository is read-only from the run's point of view. The Git adapter creates:

```text
<run-directory>/
└── <run-id>/
    ├── integration/       branch: forge/integration/<run-id>
    ├── tasks/
    │   ├── <task-hash>/   branch: forge/task/<run-id>/<task-hash>
    │   └── ...
    └── run.sqlite
```

The integration checkout must be outside the source repository. A matching checkout is reusable after
an interrupted caller, but a checkout on another commit or branch is rejected. Run IDs are validated,
real paths are checked, and a symlinked run directory cannot escape the configured checkout root.

Every task starts from the artifact's `baseCommit`, not from mutable source `HEAD`. Completed tasks are
rebased and fast-forwarded into the run-specific integration branch one at a time. Parallel agent work
therefore does not introduce parallel Git integration.

## 4. Runtime bindings are derived, then checked again

For every approved task, the binding policy reconstructs `PredictedTaskImpact` sets from the artifact's
stable arrays and derives the canonical lease plan. File/project/shared-resource write authority comes
from predicted impact, not from an LLM decision at execution time.

Before runtime start, `RunPreparation` independently checks:

- run ID and repository ID;
- the complete durable authority record;
- exact task, hard-conflict, risk-conflict, and schedule collections;
- exactly one binding and one predicted impact per task;
- exact integration path, base commit, and integration ref;
- canonical lease-plan equality;
- complete predicted-impact equality.

This prevents an adapter bug from silently dropping a task, weakening a hard conflict, widening a
lease, changing impact evidence, or pointing a worktree back at the user's checkout.

Tasks with no predicted writes receive an empty lease plan. They can read and run verification, but a
later write still goes through runtime scope expansion and Write Guard acquisition.

## 5. Durable authority and retry behavior

The run row now stores a `RunAuthorityEvidence` record containing:

- artifact ID and revision;
- approval ID;
- plan, approval, claim, and execution fingerprints;
- real repository root and approved base commit;
- working-tree and Repository Facts fingerprints;
- shared-resource and verification-policy fingerprints.

SQLite databases created before Stage 20 gain the new column when opened. An old run without valid
authority evidence is not guessed or silently upgraded; recovery rejects it explicitly.

`startOrResumeRun()` behaves as follows:

```text
no run row -> create and execute
same run + same authority + ACTIVE -> recover and resume safely
same run + same authority + terminal -> return terminal evidence, do not dispatch again
same run + different authority -> reject
```

Persisted leases are loaded into the local Write Guard on retry. This preserves process-local exclusion
semantics across a local restart, while not claiming distributed or cross-host fencing.

All `startRun()` and `startOrResumeRun()` calls with the same repository/run identity are serialized by
a process-wide lifecycle queue. This matters at the `PREPARING` recovery boundary: two concurrent
callers cannot both observe the attempt as resumable and invoke the external agent twice. A regression
test starts two separate runtime objects concurrently and proves that the agent receives one call.
This is intentionally an in-process guarantee; a second Node process or host still requires a future
durable execution claim/fencing protocol.

The runtime also now finalizes the run row: all completed/cancelled tasks produce `COMPLETED`; any task
failure produces `FAILED`; blocked/nonterminal work remains `ACTIVE`.

## 6. Agent and verification behavior

Pi still cannot use built-in shell or mutation tools. It receives only controlled `forge_read`,
`forge_list`, `forge_find`, `forge_edit`, and `forge_write` tools. Stage 20's default binding does not
grant `forge_command`.

After Pi completes, the orchestrator runs every approved package-script rule with an argument-vector
process invocation:

```text
pnpm --filter <approved-package-name> run <approved-script-name>
```

No shell string is evaluated. Package names and script names are restricted to package-manager-safe
identifier characters. The child receives only `CI=1` and a trusted `PATH`, so parent variables such as
`NODE_OPTIONS` do not flow into verification. A free-form `command` verification rule fails closed in
this autonomous runtime. A failed script prevents Git integration.

Each task commit includes exact `Forge-Run-Id` and `Forge-Task-Id` trailers. If an integration checkout
has advanced beyond the approved base, reuse checks every intervening commit for the requested run
trailer. A normal manually inserted commit is therefore rejected rather than mistaken for Forge
progress. This trailer is provenance metadata under the local filesystem threat model, not a signature:
a malicious writer with direct Git access can deliberately forge it.

## 7. CLI usage

```sh
forge run <artifact-id> \
  --approval <approval-id> \
  --run-id <stable-run-id> \
  --repository <repository> \
  [--revision 1] \
  [--shared-resources shared-resources.json] \
  [--plan-directory /external/plan/store] \
  [--run-directory /external/run/store]
```

The default run store is `~/.forge/runs/<repository-id>`. Successful changes are in the returned
run-specific integration checkout; Stage 20 does not update the user's current branch or push a remote.

## 8. Tested failure boundaries

Tests cover a real clean-at-approval/dirty-before-start revalidation before checkout side effects,
concurrent `PREPARING` recovery with exactly one dispatch, stale intent revalidation, dirty artifacts,
foreign and unrelated checkout history, wrong checkout commits, symlink path escape,
wrong durable authority, missing tasks/impacts, conflict and schedule drift, lease and impact drift,
wrong workspace checkout, identical retry, changed-authority retry, real Pi-tool editing, failed and
free-form verification, persisted lease hydration, SQLite migration/corruption, and real Git checkout
reuse. A real two-clone integration test proves that clones sharing the same origin and bytes are still
rejected when the physical approved root differs. Dirty-state-only binding is independently tested.

## 9. Intentional limitations

- Dirty PlanArtifacts cannot execute yet because exact dirty/untracked byte materialization is not
  implemented.
- The lifecycle mutex and lease backend are process-local, not cross-process or distributed fencing.
- An interrupted external agent attempt becomes `UNKNOWN`; autonomous cancellation/resolution remains
  future work.
- Multiple sibling failures are settled but not yet aggregated into one diagnostic.
- The result is not automatically published to a user branch, GitHub branch, issue, or pull request.
- No GitHub/Jira/provider identity is allowed into the deterministic domain contracts.
- The current verifier path list targets the supported macOS/Linux local runtime. Windows path
  separators and Corepack/Volta/custom pnpm locations require a later portability adapter.
- Commit provenance uses exact-line run trailers plus the Git ancestor check. It deliberately fails
  closed if any post-base commit lacks the trailer; strict Git trailer-block parsing can be added if
  the metadata format expands.
- Trusted Git subprocesses still inherit the orchestrator environment. Their threat model differs from
  agent-controlled verification, but minimal-environment consistency remains a security-review item.
