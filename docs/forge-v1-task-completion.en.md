# Forge v1: one-shot task completion

P1.2's simple saved Plan and explicit approval remain the product model. A task now has an
optional completion gate before the existing serialized Git integration:

```text
writer → actual diff → planned scope → repository checks → output review → integrate
```

Each step runs once. Failed checks, rejected/invalid review, changed output during checks,
out-of-scope changes or an empty writer output stop that task. The worktree, SQLite state and
completion evidence remain available; Forge does not repair, retry, resume or automatically
recover it. The already-started plan remains consumed.

## Commands

```bash
forge plan request.md --repository /absolute/repository --semantic-review --save
forge show <plan-id>
forge approve <plan-id> --yes
forge run <plan-id> --live
```

`--live` uses the existing Pi SDK coding gateway and Forge file tools. Configure the SDK's model
and authentication using its existing configuration before running; this stage does not add a
provider router or import subscription credentials. Repository checks and output review are
mandatory in this mode. The output reviewer uses a separate Pi session with the task, actual
patch and verification result; it cannot use Forge's fact tools to change files.

For wiring tests or demonstrations, the existing explicit controlled mode remains available:

```bash
forge run <plan-id> --controlled
forge run <plan-id> --controlled --repository-checks
```

The first command retains the earlier no-op agent and fake verification. The second uses real
checks and default live output review, but still has a no-op writer unless a test injects one;
an unchanged output is rejected by the completion gate. Exactly one of `--controlled` and
`--live` must be selected. Tests can inject controlled Pi/review gateways without paid inference;
that proves product wiring, not a successful live-model delivery.

## What is checked

- Git changes are inspected relative to the saved plan commit, including untracked text files.
  Writers must leave changes uncommitted. Oversized/non-text new files cannot use this review path.
- Paths must match resolved planned files or an explicitly selected project root. A file selector
  does not silently grant the whole project. No-change output fails before verification/review.
- Only saved verification rules run. Package scripts must exist in the analyzed project; command
  rules are explicitly approved local shell commands. Working directories stay in the worktree.
  Checks have a 120-second timeout and bounded output. A failure stops before output review.
- Review is strict `accept` or `reject`, with findings on actual changed paths. Rejection stops;
  acceptance is followed by another diff inspection so unchecked changes cannot be integrated.
- Integration still uses the existing serialized runtime path. Completion evidence is ordinary
  JSONL in `runs/<run-id>/completion/`; `run.json` labels execution, verification and review modes.

This is trusted-local repository execution, not a sandbox or hostile-writer guarantee. Repository
scripts can run code, and dependencies must already be available to their normal check commands.
There is no cancellation, resume, repair, new-file planning vocabulary, TUI, attribution, PostgreSQL,
Runtime V2 or distributed ownership protocol in this stage.

## Verification evidence

`pnpm check` passes 421 tests in 31 files, including real Git/SQLite integration and actual `npm run
check` execution. Controlled gateways prove one Pi tool writer and one accepted review before
integration; rejected scope/check/review and changed output preserve the repository base and stop
without a second writer invocation. `pnpm build` and compiled CLI help pass. No fresh paid/live
model run was performed, so full live happy-path acceptance remains outstanding.

## Named states and result values

Production state comparisons use domain-specific named values rather than repeated string literals:
task/run/agent attempt states, verification/agent/command results, same-run reservations, Git workspace
phases/results, conflict severity/actions and planning/output review recommendations. Schema-backed
values come from the defining Zod enum; other finite result sets use literal-typed constant objects.
The JSON and SQLite values are unchanged. Tests still assert the serialized strings explicitly,
including a compatibility test across these contracts. This is a naming refactor, not a new lifecycle.
