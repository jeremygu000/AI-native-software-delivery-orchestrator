# Review handoff: responsive TUI layout and FORGE title

## Exact baseline and scope

Baseline: `272a5e08b55a918ca0fc9b519929a52487988594` on `m4/postgres-durable-authority`. The user authorized commit and push. Review the resulting single commit against this exact parent baseline; independent acceptance remains pending.

The requested change is presentation only: make the existing OpenTUI readable in normal and narrow terminals, and add a FORGE title using the block ASCII font shown in the referenced bun-hono-opentui project. It does not add a provider system, terminal framework, persistence, process manager or workflow.

## Changed areas

- `apps/cli/src/tui/app.tsx`: live terminal dimensions, separate fixed-height metadata rows, a remaining-height scrollable body, a bounded menu/editor, short footer and local help view. Long values use native cell-aware truncation. Full metadata is available in help. Text rows do not flex-shrink into each other. A block-font title expands only on the root menu on screens at least 80×36; compact screens retain the FORGE panel title.
- `apps/cli/src/tui/layout.ts` and its spec: small pure allocation/wrapping helpers. Approval questions remain complete. Screens below 40×24 show a resize instruction and suspend hidden controls.
- Existing native/compiled test fixtures: actual rendering at 110×38, 60×30 and 40×24; long queue/provider/model values including wide characters; help closure without approval/cancellation; resize recovery; preservation of multiline text and literal `?`; direct and comparison compiled PTY launches, plus a narrow compiled launch.
- Usage guide and synchronized English/Chinese progress summaries: layout, keys, runtime requirements, verification and limits. The obsolete NODE_OPTIONS example is replaced with the already accepted comparison launch.

The exact ten changed files are:

```text
apps/cli/src/tui/app.tsx
apps/cli/src/tui/layout.ts
apps/cli/src/tui/layout.spec.ts
apps/cli/src/tui/native-render.spec.ts
apps/cli/test-fixtures/opentui-acceptance.mjs
apps/cli/test-fixtures/compiled-tui-acceptance.py
docs/interactive-coding-cli.en.md
docs/progress-summary.en.md
docs/progress-summary.zh.md
docs/tui-layout-review.en.md
```

## Architecture and behavior constraints

React still adapts the existing terminal interface and receives presentation events. It does not create approvals, mutate PostgreSQL, launch workflows, prepare workspaces or connect to providers. Controller and application orchestration are unchanged. Existing semantic consent, immutable approval, binder, setup/handoff, launch, status and durable cancellation paths remain authoritative. No migration, workflow command/patch, provider adapter, task queue selection, telemetry or credential boundary changes.

Help is local presentation state. `?` opens it from menus; `F1` works in editors so a literal question mark remains input. Escape/Enter closes help without acting on the underlying request. Hidden editor components remain mounted to retain typed text. Escape/Ctrl-C outside help retain the existing cancellation behavior. No hidden approval is accepted when the terminal is too small.

The title is confined to the lazy-loaded interactive screen. Explicit commands retain their output and Node runtime boundaries; compiled `forge --help` succeeds on the existing Node 25 runtime without FFI or a banner. Native OpenTUI still requires Node 26.4+ with explicit FFI.

## Verification

Focused frontend/layout/native tests pass 65/65 in six files, with the native Node 26.4.0 path explicitly configured. Full build, TypeScript, type-aware lint and diff check pass. Full image-enabled pnpm check passes 1169/1169 in 113 files, with zero skips and all four native/compiled tests actually executed. Coverage remains above unchanged gates: statements 90.62%, branches 85.12%, functions 94.23%, lines 90.54%. A previous aggregate caught the banner condition missing the choice-request guard (1168 passed, one failed); the final successful run supersedes it. Full build, formatting, TypeScript, type-aware lint and git diff --check pass. Native tests remain optionally gated by `FORGE_TEST_TUI_NODE`; compiled PTY fixtures require POSIX/Python 3 and an already built CLI.

## Evidence limits

This is layout, keyboard and compiled-startup evidence. No live Neon connection, deployment privilege update, production worker restart, provider inference or GroundGraph coding run occurred. The existing interrupted Neon run remains failure evidence; this stage does not claim to settle or retry it. Very small terminals require resizing. Full values and long evidence may require scrolling.

## Review questions

1. Do metadata/body/menu/footer fit independently, with each root choice on its own row at the tested narrow sizes?
2. Are authorization questions complete, long values bounded, and full metadata accessible in help?
3. Does help/tiny-screen handling preserve the pending request and editor contents, avoiding accidental approval/cancellation?
4. Are title/help/layout changes isolated from explicit commands and all existing application/authority/runtime semantics?
5. Do native and compiled tests exercise the actual supported runtime rather than only source/controller mocks?

Do not reopen accepted PostgreSQL, provider, workflow or tracing stages absent a concrete new P0/P1 introduced by this diff. The user authorized publishing this increment for independent review.
