# Forge v1 P4: full local TUI happy path

## Entry and product boundary

This acceptance started at the real compiled `forge tui` in a 160-column, 50-row pseudo-terminal.
The operator driver entered a multiline natural-language request, selected concurrency two with P,
submitted it with Ctrl+S, inspected the saved three-task plan, explicitly approved with A, and selected
live execution with L. It did not call planning, approval or execution directly through separate CLI
commands. Planning, semantic review, writing and independent output reviews used real configured
Pi/DeepSeek sessions. Credentials and private model transcripts are not included in this report.

The target was a fresh public `unjs/pathe` clone on branch `forge-full-e2e-fourth`, clean at
`c698a6f211cdfed5457efc7ef989400cf77bef2e`. The successful plan is
`6defa36a-8df2-482d-b43f-f8557eb8c33c`; run is `8134c1b6-5a7b-40ed-9283-b16b1660ced0`.
No person edited target source/tests or substituted model output, checks, reviews or database facts.

## Actual execution

The request assigned A the drive-relative normalization implementation/tests, B exact alias
resolution implementation/tests, and C a test composing both implementations. C depended on A/B.

| Task | Writer started, UTC     | Writer completed | Integrated event | Commit                                     |
| ---- | ----------------------- | ---------------- | ---------------- | ------------------------------------------ |
| A    | 2026-10-06 12:49:54.257 | 12:50:04.972     | 12:50:38.010     | `7c52c2d029053cceb7a72dbcb61489217288d67f` |
| B    | 2026-10-06 12:49:54.263 | 12:50:53.757     | 12:51:29.688     | `aaf246f9dc4d49d0c434f0ce431413304347a5f4` |
| C    | 2026-10-06 12:51:29.754 | 12:51:47.499     | 12:52:34.436     | `4f2b9f7753badb6703337f14548be6eda81bf5a3` |

A/B overlapped for approximately 10.7 seconds, with distinct real Pi sessions and worktrees. C's
persisted base was exactly B's integrated commit, so C read the combined implementations. Every task
passed its actual approved repository `test` and `build` scripts and received an independent accept
review before the existing serialized Git integration.

After all task integrations, Forge reran the deduplicated union of approved verification rules on
the actual integration repository. `run.json` records final checks passed, clean true and HEAD
`4f2b9f7753badb6703337f14548be6eda81bf5a3`. A separate final `pnpm test` and `pnpm build` also passed:
492 tests passed, original 8 skips and 8 todos preserved; coverage 98.35% statements, 92.10% branches,
100% functions and 98.24% lines. Git remained clean.

## Three views of the same result

The original TUI displayed its final result, all task completions and the final check/clean/HEAD
summary, then exited normally with Q. Its recorded exit code zero is presentation evidence, not the
basis for declaring task success. The shared RunView and actual loopback React Flow page independently
showed the same plan/run IDs, three COMPLETED tasks, passed checks, accepted reviews, integration
commits and final repository summary. The browser also observed A completed, B running and C pending,
then C running. It performed no mutations.

As before, the inherited SQLite run row remains ACTIVE. Displayed COMPLETED is explicitly sourced
from terminal task events; the recorded row is retained separately. Final repository results are
separate facts: if final commands fail or generate a dirty working tree, the summary says failed even
if task integrations already completed. No task event is rewritten and no integration is rolled back.

## Changes and preserved failures

Product changes are limited to a TUI concurrency selector, full task descriptions and compact task
summary, final integration-root verification metadata, and displaying that metadata in RunView/TUI/web.
The reviewer prompt now ends with the existing strict JSON contract and required findings field.
Schema validation was not loosened, and invalid model responses are not repaired or extracted.

Three earlier independently planned and approved TUI runs remain FAILED with evidence/worktrees and
any legitimate partial integrations preserved: output review returned non-JSON; the model's test
formatting failed; and output review omitted required findings. None was repaired, resumed or retried
as a consumed plan. The successful run used a fresh clean clone and fresh TUI approval. This is one
successful end-to-end acceptance after three failures, not a reliability benchmark.

Regression tests cover explicit concurrency selection, truthful final metadata, final command failure
and dirty-root detection without falsifying completed task events. Forge check passes 437/437 tests
in 33 files, including format/type/lint and unchanged four 90% coverage gates. Build passes.
Repair, retry/resume, cancellation, recovery, attribution and distributed authority remain outside P4.
