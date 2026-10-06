# Forge v1 P1.1: executable baseline

## Scope and fresh results

The accepted reset commit is `5e1da658988384675edfbd171b8e6afc3c10b939`, based on
`ce358ca25c2b2fed706690b16406af3204f2d435`. P1.1 restores local checks and inspects existing
execution scenarios; it does not implement the rest of P1.

The only executable change replaces recursive Vitest project discovery with two direct
workspace globs under `apps/*` and `libs/*`. Historical `.local/` worktrees are not discovered
or deleted. Coverage configuration and all four 90% thresholds remain unchanged. No dependency,
runtime, authority or persistence implementation changed.

| Check                      | Fresh result                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| `pnpm check`               | PASS: formatting, TypeScript references, type-aware lint, 397 tests in 29 files |
| Coverage                   | Statements 96.46%, branches 91.33%, functions 96.85%, lines 96.43%              |
| `pnpm build`               | PASS: 12 library projects and compiled Node CLI                                 |
| Focused runtime scenarios  | 6 passed; 36 unrelated tests filtered out                                       |
| Focused planning scenarios | 2 passed; 21 unrelated tests filtered out                                       |
| Compiled CLI `--help`      | Only `analyze` and `plan` commands                                              |

The `required option '--semantic-review' not specified` output in the full suite comes from an
existing rejection test, not a failing check. All 397 tests ran in the complete suite. No paid
model, historical credentials or external authority deployment was used.

## Strongest existing local scenario

`libs/orchestration-runtime/src/lib/orchestration-runtime.spec.ts` contains a real temporary Git
repository scenario combining `GitWorkspaceManager`, actual SQLite persistence, an in-memory
write guard, `PiAgentRunner` and `AgentToolRuntime`. A controlled Pi gateway issues `forge_edit`
against `value.txt`. The integrated repository contains `pi\n`, the task and attempt are
COMPLETED, and SQLite records the observed file write. This scenario was inspected and rerun.

Its gateway is controlled and its verifier is `FakeTaskVerifier`: it does not prove live model
inference or actual repository-check execution. A separate real Git/SQLite edit scenario also
passes, including recovered completed state and released reservations.

Complementary existing scenarios, also rerun, establish:

- Two independent controlled agents both start before either completes, with concurrency two.
  That test uses memory workspaces/persistence, not two real Git worktrees.
- A dependency chain completes in the expected event order.
- Failed controlled verification fails the task without attempting integration.
- A conflicting Pi write is blocked without changing its workspace.
- Controlled planning plus semantic plan review produces scheduler input, and missing
  requirements cause bounded planning revision. Planning and execution are tested separately.

Source and tests show a process-local lifecycle queue serializing verification/integration.
There is no single existing test combining request, plan, real parallel worktrees, real checks,
output review, repair and final integration. The separate tests must not be presented as that
complete workflow.

## Concrete product blockers

| Boundary                             | Current evidence                                                                                          | Smallest later product connection                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Request/plan → approved run          | CLI prints planning output but has no approve/run composition                                             | Simple saved Plan, explicit user approval and Run(planId), with a normal repository-change check           |
| Prepared plan → execution inputs     | `startRun` requires caller-supplied agent IDs, worktree paths, impacts and reservations                   | One local mapping from existing prepared plan to runtime inputs, without later authority binding contracts |
| Verification → output review         | Runtime verifies, then commits/integrates; its constructor has no output reviewer                         | Explicit output review before integration, distinct from semantic plan review                              |
| Failed gate → repair                 | Failed verification marks the task failed and returns                                                     | Bounded repair using actual diagnostics and repeat verification/review                                     |
| Intent → actual changes              | Tools record their writes, but runtime lacks complete Git diff reconciliation                             | Inspect created/modified/deleted paths before integration and compare with intent                          |
| Repository checks → runtime verifier | Strongest Git integration uses a fake verifier; planning separately validates package-script declarations | Connect execution of the requested repository checks to the composed local workflow                        |

These missing connections do not justify restoring approval claims, PostgreSQL, Temporal,
global permits or distributed recovery. Inherited leases/replay are implementation to reassess,
not contracts to extend automatically.

## Stop point

P1.1 stops here. Cancellation, resume, creates/deletes, TUI, provider attribution and new recovery
infrastructure were not implemented. No later code was merged or cherry-picked. The next product
batch can start with the first missing connection: simple approved-plan to local-run composition.
Review order remains Product relevance → Scope correctness → Simplicity → User workflow impact
→ Functional correctness → Failure handling → Tests → supported-model edge cases. This report
does not claim completion of P1.
