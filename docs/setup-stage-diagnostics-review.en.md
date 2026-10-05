# Independent review: safe setup-stage diagnostics

Baseline: accepted commit `3398bb6ee015542731cc3fdefa4bed45c5f9b77a` on `m4/postgres-durable-authority`. This document is the independent review handoff for the next increment.

## Intended scope

The reported live Neon run `fe89c1bf-0ec8-4aee-80da-b14d2e0918fa` has run metadata and a PREPARING builder attempt, but no run-scoped setup claim. The original operator error was not retained. This increment makes the next fresh interactive run report which existing `prepareApprovedWorkspaces()` operation was active when setup stopped. It does not diagnose or alter the historical run.

`apps/temporal-worker/src/operator-workspaces.ts` adds an optional typed `onStage` callback immediately before existing operator operations. It passes fixed stage IDs only. An observer exception is ignored so presentation cannot change setup authority or control flow. `apps/cli/src/app.ts` passes that callback from the existing interactive setup composition and marks the initial `prepareOnly` metadata step. `apps/cli/src/interactive-coding.ts` displays the latest stage and, on setup failure, a fixed safe diagnostic, run ID and broad deployment label. It does not print the underlying exception. No new table, log service, worker credential, retry path or recovery action is added.

## Architecture boundaries and evidence

The existing order remains approval, binding, `prepareOnly`, operator workspace preparation, final Temporal launch. Operator setup still performs the same PostgreSQL connections, setup admission, generation issuance, Git permit/worktree, workspace persistence, recovery attestation, settlement and handoff. The stage callback is observation only and is not durable evidence. The Run Inspector remains frozen at the accepted baseline. Existing explicit CLI commands and the standalone operator script do not supply the optional callback and retain their previous behavior. There is no new Neon run or live mutation in this increment.

Focused tests verify the exact successful stage sequence and existing setup outcomes; failure attribution at configuration, key loading, admission, recovery evidence, handoff connection and Git permit finalization; no later admission/generation/Git work after a rejected handoff connection; callback failure cannot interrupt setup; interactive setup displays a sanitized stage diagnostic and never launches or retries. Focused tests pass **36/36**. Full build and image-enabled `pnpm check` pass: **1258/1258 tests across 118 files, zero skips** using the project's pinned PostgreSQL 18, Pi, Git and native TUI fixtures. Coverage remains above unchanged gates; exact percentages are in both progress summaries.

## Review questions

1. Is each reported stage emitted before its corresponding existing operation, without reordering durable setup actions?
2. Can a callback failure alter admission, generation, Git, recovery, settlement or handoff behavior?
3. Does the interactive failure surface expose only fixed stage/diagnostic text and safe identities, never a driver error, URL, password, private key or signed evidence?
4. Do setup failures stop before later operations and avoid automatic retry, recovery or UNKNOWN settlement?
5. Do the normal successful path and explicit non-interactive commands preserve their accepted semantics?
6. Is the remaining live Neon E2E work accurately left open rather than claimed from mocked tests?
