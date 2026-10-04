# Independent review request: Forge Interactive Coding CLI

## Locked scope

Review the Interactive Coding CLI increment against accepted baseline:

```text
2a4306ec25e157647186096f9c18146f39acc2dd
branch: m4/postgres-durable-authority
```

The user has requested commit and push on this branch. Review the complete resulting commit, including every new file listed below, against the baseline. Independent acceptance remains pending; committing does not claim review acceptance or real E2E completion.

The purpose is a human frontend over the existing application functions. Bare `forge` in a TTY supports Start a coding task: repository/task input, accepted exact model picker, explicit semantic planning/review consent, plan summary/details/revision, exact approval, binding, accepted setup, Temporal launch, durable progress and completion. Configure model reuses the existing picker. Other menu entries explicitly remain unavailable. Explicit automation commands retain their existing semantics; no-subcommand non-TTY execution refuses input.

## Architecture constraints

- Preserve accepted domain/engine/provider neutrality, immutable artifacts/approval fingerprints, binding and worker exact-target checks.
- No new authority, PostgreSQL migration/table, workflow command/patch, provider transport, daemon, registry, saved profile, inference fallback, publication or PR automation.
- Both file and inline source paths use the extracted common planning core. Honest source metadata can differ; do not demand artificial byte-for-byte artifact equality.
- Provider/model/reasoning values remain in memory and reach plan/bind/run unchanged. Existing DeepSeek and subscription policy representations remain accepted.
- Call application functions directly; do not spawn Forge commands or parse their stdout.
- Privileged operator configuration stays in the operator boundary and is never forwarded to a worker.

## Important execution boundary

The existing global path requires:

```text
approve → bind
→ run.prepareRun (persist initial dispatch)
→ signed setup/admission/permitted Git creation
→ generation observation/recovery evidence/handoff
→ run.startOrResumeRun (Temporal launch)
```

The frontend preserves this existing sequence. An explicit `prepareOnly` request option avoids mutating process environment; the old ambient flag is still used by explicit commands when no request override is supplied. Final interactive launch explicitly requests false.

Before preparation, cancellation does not create workspaces or a Temporal run. Once initial dispatch/setup has begun, durable authority may exist even before Temporal launch. The CLI requests existing cancellation for that exact run, reports unconfirmed cancellation honestly and never settles UNKNOWN automatically. Setup is allowed to finish its accepted authority operation before cancellation is requested; it is not interrupted halfway through admitted Git mutation. Treat this existing ordering as a review constraint, not as permission to invent another authority layer.

Worker readiness checks only the declared configuration, existing preflight and workflow/activity queue pollers. It is not cryptographic proof that each poller has that policy; existing binding/worker validation remains authoritative. There is no worker startup/supervisor feature.

## Changed files (24)

CLI composition and terminal/frontend:

- `apps/cli/src/app.ts`
- `apps/cli/src/model-selection.ts` (optional cancellation-message text; existing default preserved)
- `apps/cli/src/interactive-coding.ts`
- `apps/cli/src/interactive-terminal.ts`
- `apps/cli/src/interactive-render.ts`
- `apps/cli/src/interactive-coding.spec.ts`
- `apps/cli/src/interactive-terminal.spec.ts`
- `apps/cli/src/planning-source.spec.ts`

Operator extraction and read-only deployment readiness:

- `apps/temporal-worker/local/prepare-workspaces.ts` (thin compatibility wrapper)
- `apps/temporal-worker/src/operator-workspaces.ts`
- `apps/temporal-worker/src/operator-workspaces.spec.ts`
- `apps/temporal-worker/src/interactive-deployment.ts`
- `apps/temporal-worker/src/interactive-deployment.spec.ts`

Planning cancellation and deliberate package/build boundaries:

- `libs/agent-runtime/src/lib/pi-planning-agent.ts`
- `libs/agent-runtime/src/lib/pi-planning-agent.spec.ts`
- `apps/cli/package.json`
- `apps/cli/tsconfig.app.json`
- `apps/temporal-worker/package.json`
- `package.json`
- `pnpm-lock.yaml`

Documentation:

- `docs/interactive-coding-cli.en.md`
- `docs/interactive-coding-cli-review.en.md`
- `docs/progress-summary.en.md`
- `docs/progress-summary.zh.md`

The CLI workspace dependency was added with pnpm, and TypeScript references preserve build ordering. Worker exports name two deliberate operator/readiness entry points; importing them does not start a worker. Esbuild produces those runtime entries in addition to the unchanged worker entry bundle. No barrel file is introduced.

## Verification performed

- `pnpm build`: PASS.
- Complete `pnpm check` with the existing pinned Pi/Git/Node Docker fixtures and PostgreSQL 18 authority image: PASS, **1111/1111 tests, 107 files, no skips**. Baseline was 1071 tests; this increment adds 40.
- Unchanged coverage gates pass: statements 90.59%, branches 85.19%, functions 94.20%, lines 90.53%.
- Final diagnostics/documentation synchronization is followed by focused frontend/operator/planning checks, build, formatting/type/lint and `git diff --check`. The complete image-enabled `pnpm check` was repeated successfully before the user-requested commit: 1111 tests in 107 files, no skips.
- Core parity tests use real temporary Git repositories, repository analysis and immutable artifact persistence with mocked model output. They compare prepared decisions, snapshots and policy fingerprints while preserving different source metadata/fingerprints.
- Frontend tests check call order, the default prepare/setup/launch wiring, exact IDs/profile continuity (including Copilot medium despite ambient high), consent, revision immutability, drift, failure and durable cancellation. No second run is silently created.
- Operator composition tests exercise real private files, artifact/approval stores, setup approval signing and evidence publication, with mocked authority/supervisor boundaries. They check independent role configs, blocked admission without Git/generation, authority mismatch before connections, partially initialized client cleanup and saved-evidence preservation. They do not replace the real authority regressions in the full gate.
- Eight compiled PTY cases PASS using the real terminal/root coordinator and injected application operations: happy flow exits 0 with `plan,approve,bind,setup,run`; root/repository/task/profile/semantic-consent Ctrl-C exits 130 with no operations; plan-action/approval-confirmation Ctrl-C exits 130 after only `plan`.
- Production compiled `apps/cli/dist/main.js`: TTY root menu observed, Ctrl-C exit 130; non-TTY bare invocation exits 1 with the terminal requirement.

Local evidence: `/tmp/forge-interactive-coding-commit-check.log` (final full gate), `/tmp/forge-interactive-coding-check.log`, `/tmp/forge-interactive-*.txt`, and `/tmp/forge-interactive-coding-pty.py`. The quota-free smoke entry is generated under ignored `.local/interactive-coding-smoke.ts`, compiled into the ignored CLI dist directory; no production mock mode or auth bypass is added.

## Evidence limits and remaining work

No live OAuth, real provider inference, live Neon query/mutation or new GroundGraph coding E2E occurred. The image-enabled suite uses disposable local authority/runtime fixtures, and the terminal smoke injects application functions. A complete real run cannot be claimed from these tests.

Existing deployment configuration, signing material, approved PostgreSQL authority and a separately running exact-profile worker remain prerequisites. For the existing local wrapper, operator files are rooted in the Forge working directory. Resume/View runs/Check environment menus are not implemented. There is no per-role profile or global persistence. Cancellation after initial dispatch can require existing operator recovery; the CLI cannot safely assume settlement when Temporal has not started or acknowledgement is lost.

After code review passes, run the small GroundGraph task through the bare interactive entry with one provider, and independently inspect exact approval/binding, setup, Temporal start, isolated building, verification/review/repair/integration, released claims, unresolved permits and trace evidence. Do not use the comparison wrapper as substitute evidence for the new frontend.

## Read-only execution readiness follow-up

On 2026-10-04, the continuation request was followed by read-only checks of the existing local deployment. The actual GroundGraph checkout remained clean at `1e8835d37a0827c111291fa8a6cf4f12cc2caa68`. Outside the sandbox, repository, Temporal namespace and both pinned execution images passed preflight; authority failed. The existing schema audit reported incompatible restricted writer functions. A read-only catalog transaction confirmed nine SECURITY DEFINER functions with the legacy `search_path=pg_catalog`, zero with the accepted `pg_catalog, pg_temp` setting and zero other configurations. The accepted installer configuration upgrade is therefore a remaining local deployment prerequisite. No installer, function alteration, new run, model inference or Neon operation was performed. Queue poller availability has not yet been checked. This does not change the code-level verification above or provide real E2E evidence.

## Specific review questions

1. Do file and inline source paths converge before analysis/planning/review/artifact creation, with accepted fingerprint semantics intact?
2. Is the selected exact profile preserved through every application operation, including the explicit prepare-only and final execution calls?
3. Are both semantic-model consent and exact workspace/integration approval explicit and bounded by the artifact?
4. Does operator extraction preserve admission, generation, signing, evidence publication and handoff without forwarding privileged credentials to the worker?
5. Does default setup preserve initial dispatch → trusted setup → Temporal launch, including failure/cancellation handling and explicit false prepare-only override?
6. Are repository drift, missing readiness, uncertain launch and unconfirmed cancellation fail-closed without fallback, retry, orphaned clients or automatic UNKNOWN settlement?
7. Does terminal handling preserve consecutive paste, Escape/Ctrl-C/EOF cleanup and active-run cancellation without changing explicit command behavior?
8. Are summaries limited to existing artifact/read-model evidence, and are the live-evidence limitations disclosed accurately?
