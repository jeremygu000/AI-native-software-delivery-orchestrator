# Observable Forge

Build with `pnpm build`, then run:

```bash
pnpm forge tui --repository /absolute/repository --state-directory /outside/repository/forge-state
pnpm forge view <plan-id> --state-directory /outside/repository/forge-state
pnpm forge inspect --state-directory /outside/repository/forge-state
```

The full-screen Node TUI calls the existing CLI operations. `N` enters a request; Enter inserts a
newline and Ctrl+Enter (or Ctrl+S) submits it. Arrow keys and Enter inspect a saved plan. `A` explicitly
approves, `L` starts live/paid execution, and `C` starts controlled/fake execution. PgUp/PgDn scroll,
Esc returns to plans and Q exits when idle. Active execution cannot be cancelled by this UI.

`Y` or Ctrl+Y copies complete plain-text diagnostics, including errors, check output, review findings,
identifiers, worktree and diff, without viewport truncation. In request entry, ordinary `y` remains
text. Copy is available while working. It uses `pbcopy` on macOS, `clip.exe` on Windows or `wl-copy`
on Linux. If unavailable, the complete text is saved with private permissions under the local state's
`diagnostics` directory and its path is displayed. Mouse selection remains available because no mouse
capture is enabled. Diagnostics may contain your source diff; review them before sharing.

The browser URL printed by `inspect` is loopback-only and GET-only. React Flow shows saved tasks,
dependency/conflict edges and recorded task details. It has no approval/run controls or write routes.
Both interfaces use a thin shared read model over ordinary Plan JSON, read-only SQLite and completion
JSONL. Partial evidence generates a warning; missing facts are not invented. The inherited run row may
remain ACTIVE after task events are terminal: `recordedRunState` exposes that row, while a displayed
terminal aggregate is explicitly labeled `stateSource: task-events`. Neither observation writes state.
Completion entry observations VERIFYING/REVIEWING do not change scheduling or execution semantics.

Verification: `pnpm check` passes 433 tests in 33 files and unchanged 90% coverage gates; build passes
for CLI and browser assets. Tests cover real Git/SQLite read-only observations, explicit TUI operations,
failure/missing evidence, GET-only HTTP and complete diagnostic copy/fallback. A real browser smoke
test opened the earlier completed live pathe run and selected its task to see passed verification,
accepted review and integrated commit. Native terminal automation and a new paid run were not performed.
Repair, retry/resume, cancellation, remote services and browser mutations remain outside this slice.
