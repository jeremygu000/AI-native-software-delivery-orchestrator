# Independent review: interactive TUI text copying

Baseline: `a0bbd73548533d300fcd298288a070016cfe140c` on `m4/postgres-durable-authority`. This document is the independent review handoff for the next increment.

## Intended scope

Add one copy shortcut to the existing full-screen Forge OpenTUI. `Ctrl+Y` copies the current OpenTUI text selection, or a plain-text rendering of the execution details already shown by the TUI when nothing is selected. The footer and help show the shortcut and the footer reports whether the clipboard operation was available. `Ctrl+C` continues to mean cancellation or exit.

## Architecture and changed areas

- `apps/cli/src/tui/start.tsx` reads OpenTUI's selection and writes through its terminal clipboard protocol, falling back to its host clipboard service. The host service is created only on the first fallback and disposed with the renderer.
- `apps/cli/src/tui/app.tsx` builds copy text only from presentation events and named non-secret deployment fields. The keyboard action does not submit a pending choice or alter the coding coordinator. It keeps the current input mounted and reports clipboard failure without exposing driver diagnostics.
- `apps/cli/test-fixtures/opentui-acceptance.mjs` exercises the real native TUI key path with an injected clipboard result. The English and Chinese progress summaries describe the behavior and its evidence boundary.

No approval, binding, PostgreSQL, Temporal, workspace, provider, worker, migration or non-interactive command behavior was changed. No new clipboard package or background service was added.

## Verification and limits

Focused native/layout/controller tests pass **13/13** under the configured Node 26.4 + FFI runtime. Full image-enabled `pnpm check` passes **1258/1258 tests across 118 files, zero skips**. Build, typecheck, type-aware lint, format and `git diff --check` pass. The native test proves copied selection precedence, copied detail content, exclusion of a private connection string, a visible unavailable message, and continued task editing/help behavior. Clipboard writes are injected in the test, so actual terminal OSC 52 and host clipboard acceptance still depend on the user's terminal and operating system. No live Neon run or provider request was made for this increment.

## Specific review questions

1. Does the copy text stay within data already available to the presentation layer, without exposing private environment or authority details?
2. Does `Ctrl+Y` leave selection, task editing, approval and cancellation semantics intact?
3. Are terminal clipboard failure and host fallback contained so they cannot interrupt the running Forge workflow?
4. Does the native TUI test cover the key interaction without claiming real operating-system clipboard success?
