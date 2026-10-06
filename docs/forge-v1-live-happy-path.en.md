# Forge v1: real live happy-path acceptance

## Scope and repository

This acceptance exercises the existing single-owner local product path, not a controlled writer or
fake verifier. The target is the public `unjs/pathe` repository, cloned into the approved temporary
directory. Its clean initial commit was `bc7477a01f0bd60ada017add8142c9f9d69ccdc5`.
The request fixes `normalizeAliases` treating sibling-prefix keys as descendants, and adds three
regression tests. Only `src/utils.ts` and `test/utils.spec.ts` are allowed to change.

The repository's original baseline `test` and `build` scripts passed before planning. Planning,
semantic plan review, coding and independent output review used the actual configured Pi SDK with
DeepSeek Flash and high thinking. Credentials were supplied through the host environment; none are
included here. Private session files and run evidence remain outside tracked project files.

## Completed run

| Fact                      | Observed value                                           |
| ------------------------- | -------------------------------------------------------- |
| Saved plan                | `e2cde948-5b9f-4ef2-aba8-7b87b1dbb2f0`                   |
| Planner attempts          | One; live semantic review accepted                       |
| Approval                  | Explicit `approve --yes` before execution                |
| Run                       | `cdeaacd3-2e6e-42a0-821b-512070442ea3`                   |
| Task                      | `normalize-aliases-sibling-prefix`                       |
| Execution metadata        | `live`, `repository`, `reviewed`, `live-pi`              |
| Actual scope              | Exactly the two planned files; matched                   |
| Real verification         | Original `pathe.test` and `pathe.build` scripts passed   |
| Independent output review | `accept`, empty unresolved findings                      |
| Final task state          | `COMPLETED`                                              |
| Integrated target commit  | `a193406bd5cc48ed195de349de34329a10a2b558`               |
| Final target state        | Clean `main`, one commit ahead of its remote; not pushed |

The model wrote the implementation and all three tests. Forge created the worktree, ran the checks,
reviewed the actual patch and performed the serialized Git integration. The integrated diff is two
files, 25 insertions and one deletion. No person edited or formatted the target implementation/tests.
No test, verification script, dependency requirement or coverage gate was removed or weakened.

## Failed attempts were stopped, not repaired or resumed

These were separate newly planned and explicitly approved runs against the same unchanged target
baseline. Each writer ran once. Failed plans remain consumed and their worktrees/evidence retained.

| Run                                    | Reason integration was refused                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `46860ad8-3a13-493a-bb36-db2d84d300cf` | Repository formatter rejected the model's implementation layout.                                                           |
| `de3371da-de1d-4120-8f44-e322c4dbf37b` | Real checks passed, but live review rejected missing requested regression tests.                                           |
| `5e383655-0c81-48d3-b167-7ef293386083` | Implementation and tests existed, but the unchanged repository formatter rejected the condition layout.                    |
| `d636fd7f-6126-4565-b065-866cb764d94d` | Real checks passed; reviewer returned invalid `accept` with unresolved findings, so schema validation refused integration. |

A read-only formatter stdin diagnostic supplied precise formatting guidance in a new request; it did
not modify a target file. Two concrete Forge defects were corrected: the runtime had sent only the
task goal, omitting the approved description and test constraints; the reviewer prompt had omitted
the existing rule that accepted output must have empty findings. The fixes forward the description
and explain the unchanged review schema. Regression tests cover both. There is no parsing retry,
automatic repair, resumed writer, new task attempt or new recovery/state protocol.

## Validation and limits

Fresh Forge `pnpm check` passes 422 tests in 31 files, including format, TypeScript, lint and unchanged
90% coverage gates: statements 96.16%, branches 90.89%, functions 95.98%, lines 96.16%.
`pnpm build` passes all libraries and the compiled CLI. Focused completion/runtime tests pass 61/61.

This establishes one real live happy path and demonstrates that failed gates prevent integration.
It does not establish a model reliability rate, parallel live delivery, cancellation, retry/resume,
repair, TUI, provider attribution or distributed operation. Those features were not added. The
historical authority branch remains separate and unchanged.
