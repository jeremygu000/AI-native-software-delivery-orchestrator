# Live subscription provider comparison

## Scope and preserved evidence

This is one real run per provider, not a benchmark or a provider ranking. All three started from GroundGraph commit `1e8835d37a0827c111291fa8a6cf4f12cc2caa68` in separate clean checkouts. The shared task was to reject whitespace-only query questions, trim valid questions, preserve the original **pre-trim** 10000-character limit, and retain other request validation. Only `apps/api/src/schemas/query.schema.ts` and its existing unit test were intended changes.

The operator explicitly authorized a new database, `forge_comparison_20261004`, because the old local database had already installed the rejected historical migration-14 checksum. Existing bootstrap installed migrations 1–15 and GLOBAL_READY in the new database. The old database and its evidence were preserved; no ledger was rewritten. All checkouts registered the same repository identity and shared one opaque scope, so runs executed sequentially rather than bypassing repository-wide conflict checks.

Each provider performed genuine planning and semantic review, received a separate immutable approval, and used the existing isolated Pi SDK, host model broker, PostgreSQL permits, unchanged root verification, model review, repair and confined Git integration. No target source was edited by the operator. The original GroundGraph checkout was not changed.

## Results

| Run                   | Approved model / reasoning                | Planning attempts | Repairs | Builder start → integration | PostgreSQL / Temporal | Final commit                               |
| --------------------- | ----------------------------------------- | ----------------: | ------: | --------------------------: | --------------------- | ------------------------------------------ |
| `comparison-deepseek` | `deepseek-flash` / high, thinking enabled |                 1 |       0 |                     161.7 s | COMPLETED / COMPLETED | `f80a22d9273c198213dd6a7d2e4f1c6062c6644c` |
| `comparison-copilot`  | GitHub Copilot `gpt-6.1-sol` / medium     |                 1 |       1 |                     244.7 s | COMPLETED / COMPLETED | `ce35d427f364ddbff53745330a9fd5cdf1204040` |
| `comparison-codex`    | independent Codex `gpt-6.1-sol` / medium  |                 2 |       2 |                     337.8 s | COMPLETED / COMPLETED | `a2f4a4de3c66760b27fa26ef7c41228a473ef491` |

The elapsed column begins at persisted builder start and ends at the persisted integration event. It excludes planning, approval and setup. Temporal's separately observed workflow start-to-close intervals were 85.650 s, 143.064 s and 281.629 s respectively; these are not interchangeable with builder-to-integration latency because persisted launches and workflow histories have different start boundaries.

All final verification records passed, and each final model review accepted. DeepSeek, Copilot and Codex had respectively 3, 4 and 5 released claims, with zero unresolved generic or workspace permits. All observed Temporal activity starts reported attempt 1. This demonstrates normal execution and genuine repair, not refresh failure, worker-loss recovery or response-loss replay under live subscription accounts.

## Completion is not quality equivalence

DeepSeek implemented `z.string().trim().min(1).max(10000)`. It rejects blanks and trims valid input, but accepts an originally overlong question when surrounding whitespace makes the trimmed value short enough. Its generated tests and accepting review missed the explicit pre-trim limit requirement. A read-only check of the integrated schema confirmed this defect; the result was retained unchanged rather than manually repaired or silently counted as fully correct.

Copilot and Codex implemented `z.string().min(1).max(10000).trim().min(1)`, preserving the original limit. Read-only post-integration checks confirmed blank rejection, valid trimming and rejection of `" " + "x".repeat(10000) + " "` for these two results. Both added explicit pre-trim length regressions.

Copilot's first builder returned an empty diff. Baseline verification passed, but model review requested repair for the missing task implementation. One real repair produced the accepted result. Codex likewise needed repair after an empty builder diff; its first repair failed the actual formatting gate, and its second repair passed verification and review. No operator formatting or test skipping occurred.

## Reproduction and limits

The local helpers are `fresh-comparison-authority.mjs`, `comparison-run.mjs` and `experiment-evidence.mjs` under `apps/temporal-worker/local/`. Fresh bootstrap refuses an existing comparison database and saves the previous private environment before switching. The wrapper fixes provider/model/effort and a separate queue per candidate, removes API-key configuration for subscription runs, and strips privileged local credentials from worker/CLI processes. Credentials remain in the explicit private host store, never the checkouts or container.

```bash
node apps/temporal-worker/local/experiment-evidence.mjs \
  comparison-deepseek comparison-copilot comparison-codex
```

Full-run model request counts, token totals, subscription credit consumption and monetary cost were not durably recorded and are **unavailable**. Readiness-call token counts are not substituted for run usage. Providers generated independent plans from the same task, and reasoning settings differ by explicit operator choice; timings are observations, not statistical comparisons. No production provider, authentication, workflow or authority implementation changed in this validation batch.

Formatting, TypeScript and lint passed. Image-enabled coverage used a separate ignored report directory because another Vitest process owned the default directory; all 988 tests in 96 files passed without skips, with statements 90.95%, branches 85.94%, functions 94.91% and lines 90.84%, above unchanged 90/85/90/90 gates. Compiled CLI/worker build acceptance passed. Frozen M3/M4.1/M4.2/M4.3 contracts remain unchanged.
