# Independent review: read-only Forge Run Inspector

## Exact scope

Baseline: `09af2c13a79185671f93936bbdcffd3ef6381195`, branch `m4/postgres-durable-authority`. Review the Run Inspector increment against that exact baseline.

The user requested a local run debugging tool with React Flow as the primary lifecycle visualization. The implementation adds `libs/run-inspection` for explicit configuration, read-only source composition, evidence projection and a versioned presentation DTO; `apps/run-inspector` contains the React/React Flow UI and a narrow GET-only loopback bridge using Node HTTP. Hono and OpenTUI are not added to this tool.

The only existing persistence production change is `PostgresOrchestrationPersistence.connectReadOnly()`: it retains the existing login/schema audit and opens sessions with `default_transaction_read_only=true`, exposing recovery readers and close through a narrowed type. Existing writer connections are unchanged. New transport and real PostgreSQL fixture regressions verify the driver setting and rejected write. Supplemental global queries are SELECT-only in a read-only transaction and avoid recovery APIs that lock authority state.

Workspace linking uses pnpm. Root scripts, project references and lockfile include the new app/library. The new process entry is excluded from in-process V8 coverage in the same manner as existing entry points; six compiled child-process tests cover it. Coverage thresholds are unchanged. Documentation includes the design, usage and synchronized onboarding summaries.

## Constraints to preserve

- No new authority, workflow commands/patches, migration SQL/checksums, provider adapters, setup or credential architecture.
- No retry, recovery, abandon, cancel/settlement, workspace/Git/database mutation controls or writer credentials in the browser.
- React consumes DTO states; it does not calculate authority decisions.
- Missing observations remain UNKNOWN and never become FAILED merely because a worktree, file or lease is absent.
- Later objects do not backfill upstream completion. Source reads are not an atomic authority snapshot.
- Explicit selected authority identity/repository/queue/namespace; no fallback from Neon to local or another authority file/shell configuration.
- Existing ordinary CLI, OpenTUI, comparison wrapper and worker behavior remain intact.

## Verification

Focused tests cover projection, response validation, missing/mismatched configuration, source composition, GET-only API/origin checks, diagnostic filtering, compiled entry startup and environment-file precedence. The real PostgreSQL fixture attempts a write through the read-only session and then recovers a run created through the ordinary writer. The full image-enabled `pnpm check` passed 1250/1250 tests in 118 files with zero skips, including PG18, Docker, Temporal and configured native TUI tests. Coverage: statements 90.82%, branches 85.49%, functions 94.33%, lines 90.75% against unchanged gates. Full build, separate typecheck, type-aware lint, format check and `git diff --check` passed. Six compiled-entry tests also passed after their clean-checkout build hook was added.

Browser checks use the compiled React Flow frontend with a clearly labelled PREPARING regression fixture. The 1440×1000 and 760×960 views have no horizontal overflow. All 35 fixture visual nodes render; the narrower task filter retains 20 nodes for one task and run context. Selecting UNKNOWN setup admission displays its lack of evidence, refresh works and the browser console is clean. A separate GET-only live Neon read of `fe89c1bf-0ec8-4aee-80da-b14d2e0918fa` returned HTTP 200 from the explicitly selected schema. Its core DTO had 33 lifecycle nodes, ACTIVE run metadata, RUNNING/PENDING task states and UNKNOWN admission; React displayed 35 visual nodes after adding task lane headers. PostgreSQL/Git/local sources were observed, Temporal was unavailable and remained UNKNOWN. Private screenshots and browser snapshots remain under ignored `.local` paths.

## Known limitations and evidence boundaries

- Global PostgreSQL only in this slice; no SQLite fallback or deployment/environment discovery.
- Temporal uses explicitly configured ordinary endpoint/namespace settings; no new remote authentication layer or deployment manager.
- Existing phase rows may not retain proof of an earlier arming stage; that node can stay UNKNOWN after handoff.
- Current Git listing observes persisted workspace paths. It does not establish historical absence or discover unpersisted worktrees.
- Scoped local JSON files are observed with identity checks and scalar allowlists; signatures are not verified or exported.
- The live Neon query was read-only. No live mutation, real provider call, production worker restart or new GroundGraph coding E2E occurred. The reported failed run remains failure evidence, not a claimed successful deployment. The Temporal unavailable status does not distinguish a missing workflow from a source connection problem.
- Pixel snapshots are not a test gate. Semantic regressions and real browser interaction support this presentation increment.

## Review questions

1. Do all observations and HTTP routes remain read-only, with no private completion verifiers, signed envelopes, credentials or provider/driver diagnostics entering the browser?
2. Does explicit environment selection reject missing authority fields and confirmed repository/scope/queue mismatches without querying another environment?
3. Does the reported ACTIVE/PREPARING regression preserve UNKNOWN setup/worktree/leases and the separately recorded PENDING task?
4. Is each COMPLETE/FAILED/ACTIVE/PENDING node supported by its own direct evidence, with contradictory/unavailable sources kept visible?
5. Are the existing writer, approval, binding, handoff, workflow, provider and explicit CLI paths unchanged?
6. Are the documented fixture/browser/real PostgreSQL evidence and live-deployment limitations accurately separated?
