# Deployment-bound interactive repository input — review handoff

## Exact scope

Baseline: `be61c69f8402c292992f3f516ea055b8a51dd4fe` on `m4/postgres-durable-authority`. The user authorized commit and push of this increment; independent acceptance remains pending.

The comparison wrapper already declares its worker repository through `FORGE_WORKER_REPOSITORY_PATH`. Asking the user to enter that same path again adds friction and can select the wrong checkout. The interactive coding coordinator now takes that configured path as its repository input and skips the Repository prompt. Generic interactive usage without the variable retains the existing prompt.

Both inputs still enter the existing path resolution and repository validator. That validator canonicalizes the Git root, analyzes the repository and compares snapshots before and after analysis. The validated canonical path is published through the existing repository presentation event and carried to the unchanged planning/execution flow. No extra confirmation or stored repository selection is introduced.

An empty, whitespace-only, unresolved shell-variable or failed configured path stops the flow with an error identifying the path and configuration variable. There is no fallback prompt or planning/run. Validation diagnostics are not exposed. Cancellation remains cancellation.

## Changed areas and constraints

- `apps/cli/src/interactive-coding.ts`: repository input source and configured-path failure wording only; this is the only production code change.
- `apps/cli/src/interactive-coding.spec.ts`: eight application-seam cases covering configured-path validation/presentation/continuation, ordinary manual input and invalid configuration with no fallback or application side effects.
- `apps/cli/src/tui/native-render.spec.ts` and `apps/cli/test-fixtures/compiled-tui-acceptance.py`: strengthen the existing comparison-wrapper compiled acceptance path to select Start a coding task and reach task input after real repository validation.
- `docs/interactive-coding-cli.en.md`, `docs/progress-summary.en.md`, `docs/progress-summary.zh.md` and this `docs/deployment-repository-input-review.en.md`: explain configured and manual repository input, evidence and remaining deployment work. Eight files change in total: one production file, three test/fixture files and four documentation files.

The comparison wrapper, default repository validator, worker repository binding, model selection, approval, planning, workspace setup, PostgreSQL/Temporal, task queue, telemetry and explicit commands are unchanged. No configuration registry, persistence, provider fallback or infrastructure is added.

## Verification

Focused tests pass **48/48 in three files**: interactive coding **27**, native/compiled TUI **4**, comparison wrapper **17**. The native runtime is explicitly Node **26.4.0** with FFI enabled. The real comparison wrapper launches the production compiled CLI in a disposable PTY fixture, resolves its repository symlink to a canonical Git checkout, performs actual repository analysis/stability validation and reaches task input without a Repository prompt. It then cancels with exit 130, before model planning. Direct and narrow compiled-root acceptance also pass.

`pnpm build:cli`, full `pnpm build`, TypeScript and type-aware lint pass. Full image-enabled `pnpm check` passes **1177/1177 tests in 113 files, zero skips**, including PostgreSQL 18, Docker and Temporal fixtures. The aggregate check includes formatting, TypeScript and type-aware lint. Final `pnpm format:check` and `git diff --check` pass. Coverage exceeds unchanged gates: statements **90.62%**, branches **85.12%**, functions **94.28%** and lines **90.54%**.

## Evidence limits

Application tests inject planning/execution functions; their completion is not a real coding run. The wrapper acceptance uses a disposable Git repository and fixture comparison environment, not operator credentials. No provider inference, live Neon operation, worker restart, database mutation or new production run occurred. Live Neon acceptance remains open; the earlier failed run is retained as failure evidence.

## Review questions

1. Does a present deployment repository always avoid the prompt while still using the existing canonicalization, analysis and stable-snapshot validator?
2. Is the canonical validated path presented and used downstream, rather than the raw environment value?
3. Do invalid configured paths stop without prompting for another checkout or reaching planning/run?
4. Does normal interactive usage retain its manual prompt, and do explicit commands remain untouched?
5. Does the compiled acceptance exercise the actual comparison wrapper and default application validator, with its evidence limited to pre-planning interaction?
