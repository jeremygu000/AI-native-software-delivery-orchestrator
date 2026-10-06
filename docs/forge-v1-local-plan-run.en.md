# Forge v1 P1.2: approved local plans and controlled runs

## What this batch delivers

The accepted P1.1 baseline is `9120740054084cbdfdc70669055f129ecaf23f18`. P1.2 connects its
previously separate planning and local execution libraries through CLI commands. It uses a
plain local Plan JSON containing id, repository path, base commit, tasks, predicted impacts,
conflicts, schedule, an approval boolean and an optional run ID. There are no approval tokens,
claims, authority evidence, policy fingerprints or new distributed services.

```sh
pnpm build
pnpm forge plan request.md --repository /absolute/repository --semantic-review --save \
  --state-directory /absolute/forge-state
pnpm forge show PLAN_ID --state-directory /absolute/forge-state
pnpm forge approve PLAN_ID --yes --state-directory /absolute/forge-state
pnpm forge run PLAN_ID --controlled --state-directory /absolute/forge-state
```

`plan` without `--save` keeps its existing JSON-output behavior. The default state directory is
`~/.forge`; it must be outside the target repository. Planning with `--save` checks a clean Git
root before planning and that its commit remains unchanged before saving. Running checks a
clean repository and the saved commit again. A changed repository stops with a re-plan message.
Detached HEAD is not supported by this local composition: integration needs the current branch.

`show` displays the saved tasks and execution inputs; `approve --yes` records explicit approval.
`run` refuses unapproved or already-run plans. It assigns one run ID before execution, writes a
small run-to-plan record and uses the existing SQLite runtime for task/workspace/attempt state.
Task worktrees and branches use generated run IDs and numeric task indices, not task labels as
filesystem paths. Existing scheduler conflicts/concurrency and serialized Git integration are
reused without changing their protocols. This assumes one active local orchestrator; no
cross-process claim service or distributed ownership guarantee is introduced.

## Controlled execution is not production coding

`--controlled` is mandatory. The default runner is the existing **no-op FakeAgentRunner**, and
verification is the existing **FakeTaskVerifier**. A COMPLETED task in that mode means the
controlled runtime finished; it does not mean an AI implemented the request or repository checks
passed. The run output and `run.json` explicitly label `execution: controlled` and
`verification: fake`. Do not use this batch as a production code-quality gate.

The application test injects a controlled writer that actually edits a file in a real Git
worktree. Through the same CLI path it verifies planning output is saved, inspection works,
approval is required, runtime integrates the edit into the real repository and persists SQLite
state. The planner is controlled too. This proves product wiring, not paid-model inference.
The default no-op path and a rejected fake verification are also tested: the former changes no
commit, and the latter leaves the task FAILED without integration.

## Validation and boundaries

- `pnpm check`: 402 tests in 30 files pass, including five new product-path tests.
- Coverage: statements 96.44%, branches 91.43%, functions 96.66%, lines 96.41%; thresholds unchanged.
- `pnpm build`: libraries and compiled CLI pass; compiled help lists show/approve/controlled run.
- Error coverage: no approval, omitted explicit CLI confirmations, dirty/changed repository,
  commit changing during planning, malformed/mismatched plan file, invalid task/impact mapping,
  state inside the repository and repeat execution are rejected.

There is no cancellation, resume, repair, output review, actual verifier, diff reconciliation,
TUI or usage attribution in this batch. Interrupted/failed execution consumes the plan; the
record and worktree are preserved, and retry/resume is explicitly unavailable. No automatic
cleanup or silent re-execution is offered. These are later product decisions, not reasons to
import the archived approval/binding/authority architecture.

The next narrow batch can connect real repository verification and output review based on this
now-exercisable product path. Full P1 delivery remains incomplete.
