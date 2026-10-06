# Forge v1 P3: real parallel live delivery

## What was exercised

This acceptance uses the public `unjs/pathe` repository and real configured Pi/DeepSeek sessions for
planning, semantic plan review, coding and independent output review. It is a single-owner local run,
not a distributed-worker or recovery test. No person edited the target source or tests, no failed
task was repaired or resumed, and no repository check was skipped.

The successful plan is `e2fc144b-3a65-48e8-8721-39bc40d65359`; its explicitly approved live run is
`cef92ad5-5b07-4c09-9383-a7631c575647`. The target branch is `forge-parallel-acceptance`, initially at
`c698a6f211cdfed5457efc7ef989400cf77bef2e`. This starting commit includes the legitimately accepted
filename change from an earlier incomplete run; it was not manually reconstructed.

Three tasks formed the request:

- A changes `src/_internal.ts` and `test/index.spec.ts` to uppercase lowercase drive-relative drive
  letters without inserting a slash.
- B changes `src/utils.ts` and `test/utils.spec.ts` to resolve an exact alias by string equality.
- C depends on both A and B and changes only `test/node-glob.spec.ts`. Its real test imports both
  implementations and composes normalization, alias resolution, filename extraction and glob matching.

The real planner and independent semantic reviewer accepted the plan in one attempt. Its schedule
allows two simultaneous writers; A/B have a soft guarded-parallel relationship, while C has explicit
dependencies on both producers. The user approval is the ordinary local `approved` boolean.

## Actual execution evidence

Times below are UTC and come from persisted agent attempts and scheduler events, not inferred from
the requested concurrency setting.

| Task | Writer started          | Writer finished | Integrated event | Integrated commit                          |
| ---- | ----------------------- | --------------- | ---------------- | ------------------------------------------ |
| A    | 2026-10-06 07:46:35.423 | 07:46:54.750    | 07:48:29.080     | `55556e31587880ec6f204026ad78dcfd7f098bde` |
| B    | 2026-10-06 07:46:35.424 | 07:48:29.081    | 07:50:10.720     | `569df62982e5d7810941021119b3584bde8ae824` |
| C    | 2026-10-06 07:50:10.788 | 07:51:55.489    | 07:52:12.350     | `6888775489130c3567090d047e7ef7354a0fccf9` |

A and B overlapped for approximately 19.3 seconds, with distinct real Pi session IDs and separate
`task-1`/`task-2` Git worktrees. Both began at the planned repository commit. Each task independently
passed the repository's existing `test` and `build` scripts and received an `accept` output review.
The existing local lifecycle serialized verification/review/integration; writer execution was parallel.

C started after both integrated events. Its persisted worktree `baseRef` is exactly B's integration
commit, `569df62982e5d7810941021119b3584bde8ae824`, so its writer read the combined A+B implementation.
C also passed real verification and independent review before its own integration. All three task
events are COMPLETED. The inherited run row remains ACTIVE; the read model explicitly reports the
terminal aggregate as `stateSource: task-events`, preserving the recorded row separately.

## Only observed product blockers were fixed

1. File-specific task impacts also list their containing project as derived impact. The local run
   composition incorrectly converted that into a whole-project reservation, serializing disjoint
   files. It now reserves the exact predicted files plus only explicitly requested project writes.
   The underlying same-run guard and scheduler were not redesigned.
2. A dependent worktree previously always used the original plan commit. The local composition now
   resolves the current integration branch when creating a dependency-bearing task, inside the existing
   serialized workspace lifecycle. Independent tasks retain the planned base. No new execution engine,
   approval protocol, takeover or recovery mechanism was introduced.
3. A task without transitions yet appeared NOT_RECORDED even when the initial persisted scheduler
   snapshot contained PENDING. The read model now uses that initial observation as a fallback; later
   transitions/events still take precedence, and genuinely missing snapshots still mean NOT_RECORDED.

Real Git tests hold two controlled writers at a barrier to prove simultaneous start and exact file
reservations, then require a dependent writer to read both integrated changes and the current base.
Read-model tests observe two RUNNING tasks and a PENDING dependency without modifying persistence.
These regression tests are separate from the paid-model acceptance described above.

## UI and final repository checks

The real loopback React Flow page was observed during execution with C PENDING, A completed and B
reviewing, and later with all three tasks COMPLETED. An actual 140×45 pseudo-terminal opened
`forge tui`, selected the recorded run and displayed its run ID, COMPLETED states, passed verification
and accepted reviews; it exited normally. The earlier simultaneous RUNNING/PENDING read-side state
was also checked through the shared controller/read-model regression. No browser mutation was used.

At final target HEAD `6888775489130c3567090d047e7ef7354a0fccf9`, independent `pnpm test` and
`pnpm build` pass. The original suite reports 496 passed, 8 skipped and 8 todo; those existing skips
and todos were preserved. Target coverage is 98.36% statements, 92.10% branches, 100% functions and
98.25% lines. The target Git working tree is clean, with three sequential Forge integration commits.

Forge's own `pnpm check` passes 435/435 tests in 33 files, including formatting, TypeScript and lint.
Coverage is 94.75% statements, 90.07% branches, 94.41% functions and 94.78% lines; all four original
90% gates remain unchanged. `pnpm build` and `git diff --check` pass.

## Failed attempts and limits

Two earlier separately planned and approved runs remain FAILED with their evidence/worktrees intact.
The first exposed the project-reservation widening and a model-produced formatting failure; B's
independently accepted filename change integrated, while A failed and C did not run. The second had
real overlapping writers and passed repository checks, but B's independent review rejected its output;
A integrated and C did not run. Neither consumed plan was retried, repaired or forced through review.
The final run used a fresh approved plan and clean branch, not a recovery of either failed run.

This proves one real three-task parallel delivery, not a reliability or provider benchmark. Live
writer/check commands still execute trusted local repository code. Credentials and private model
session transcripts are not included in this report. Repair, retry/resume, cancellation, attribution,
distributed authority and browser writes remain outside this stage.
