---
title: OpenCode Engineering Handover
tags:
  - coding-orchestrator
  - handover
  - opencode
  - architecture
status: active
updated: 2026-08-13
---

# OpenCode Engineering Handover

## Immediate state

Work in `~/Desktop/apra_new/apra-amcos-admin-coding-orchestrator` on `main`. Stage 20 and its first
follow-up review are committed through `b1f1a4ba6bc01f236c96b3708dc599936042f1c7`. A later
whole-architecture review reopened one P1 verification-executor boundary. The sandboxed-verification
fix is implemented in the working tree and remains intentionally uncommitted pending independent
follow-up review and explicit user approval. Preserve every current change.

Do not commit unless the user explicitly approves it after review. Repository-local commit identity
must remain `JeremyGu2021 <isdance2004.yg@gmail.com>`. The remote is
`git@github.com:jeremygu000/AI-native-software-delivery-orchestrator.git`.

Before editing, read:

- `docs/architecture.md`;
- `docs/adr/022-durable-plan-artifact.md`;
- `docs/adr/023-plan-approval-and-execution-binding.md`;
- `docs/adr/024-controlled-runtime-binding-and-start.md`;
- `docs/plan-artifact.en.md` or `.zh.md`;
- `docs/plan-approval-and-binding.en.md` or `.zh.md`;
- `docs/controlled-runtime-start.en.md` or `.zh.md`;
- the Stage 19 and Stage 20 sections in both progress summaries.

## Source-of-truth order

```text
current implementation and tests
        |
        v
accepted ADRs and docs/architecture.md
        |
        v
current progress summaries and this handover
        |
        v
older prompts and conversation history
```

The project intentionally uses pnpm workspaces, TypeScript 7, project references, Vitest, Oxlint,
Oxfmt, and esbuild for the small Node CLI. It does not use Nx or Rspack. Do not reintroduce them
without a demonstrated requirement.

## Completed architecture

Stages 1–19 are committed and reviewed:

```text
Repository Facts -> Task Impact -> Conflict Engine -> Scheduler
                                             |
                                             v
Write Guard -> Persistence/Replay -> Git Worktrees -> Runtime
                                                    |
                                                    v
Pi Adapter -> Controlled Commands -> Execution Profiles -> Parallel Agents
                                                    |
                                                    v
Autonomous Plan -> Semantic Review -> Durable PlanArtifact -> Approval/Binding
```

Core deterministic packages must remain free of LLM, provider, Jira, pnpm, Git implementation,
filesystem storage, and CLI concerns. Pi stays inside `libs/agent-runtime`. Repository-provider details
stay inside `libs/repository-analysis`. Filesystem and SQLite mechanics stay inside persistence.

## Stage 20 committed baseline and uncommitted security fix

Stage 20 adds:

- `RunPreparation`, which revalidates execution authority immediately before side effects;
- an orchestrator-owned integration checkout at the approved base commit and deterministic task
  worktree bindings derived from it;
- durable `RunAuthorityEvidence` in SQLite and identical-authority `startOrResumeRun()` semantics;
- persisted lease hydration plus correct terminal run-state finalization;
- `LocalRuntimeStarter`, which composes controlled Pi tools, Write Guard, Scheduler, SQLite, Git, and
  post-agent verification outside the CLI;
- a real `forge run` command for clean approved snapshots;
- ADR-024 and bilingual training/progress documentation.

The run flow is:

```text
PlanExecutionIntent -> fresh binder revalidation
          -> clean approved baseCommit checkout
          -> deterministic task/impact/lease/workspace bindings
          -> durable run authority
          -> OrchestrationRuntime.startOrResumeRun()
```

Dirty artifacts are rejected until exact working-tree materialization exists. Successful changes stay
on the run-specific integration branch; Stage 20 does not publish them to the user's branch or remote.

## Current verification baseline

The current uncommitted fix passes:

```text
pnpm check       38 files / 494 passed / 1 opt-in Docker test skipped
coverage         95.43% statements / 90.79% branches / 96.51% functions / 95.38% lines
real Docker      pass when FORGE_DOCKER_TEST=1; malicious script starts, workspace write denied
pnpm build       pass
git diff --check pass
```

Self-analysis: 15 projects, 114 files, 1,635 symbols, 59 project dependencies, 243 file dependencies,
3,031 symbol references, two known root configuration diagnostics.

Research analysis at `~/Desktop/apra_new/apra-amcos-admin-ingestion-and-matching`: 3 projects, 1,010
files, 7,617 symbols, 3 project dependencies, 3,592 file dependencies, 13,893 symbol references, and
the known 25-file API scripts coverage diagnostic.

## Review state

Stage 19 passed independent review and follow-up verification. Stage 20 passed its first follow-up
review and closed its initial C1 and H1-H3 findings. A later whole-architecture review found a new P1:
the post-agent package script was Agent-mutable code executed directly on the host after leases were
released. Fixed arguments and a clean environment did not contain the script's filesystem, secret,
network, or child-process effects.

The uncommitted fix removes direct host script execution. Verification policy v2 fingerprints a
pinned-digest Docker profile; runtime rechecks that exact policy, resolves the package root through the
approved RepositoryGraph, and runs only `npm --prefix <root> run <script>` through
`AgentCommandSandbox`. The container is non-root, no-network, read-only, capability-free,
`no-new-privileges`, resource-bounded, and receives only explicit environment. Failure never falls back
to trusted-local. The existing committed evidence still confirms:

- stale-intent and dirty-snapshot rejection before checkout creation;
- checkout base/ref/path confinement and exact retry;
- exact runtime task/conflict/schedule/impact/lease/workspace comparison;
- durable authority migration, corruption rejection, and changed-authority retry rejection;
- real controlled Pi edit through worktree, lease, verification, commit, integration, and SQLite;
- real same-origin/different-clone rejection and dirty-state-only binding coverage;
- complete project gates and research-repository analysis.
- process-wide serialization of concurrent local start/resume calls, with a two-runtime
  `PREPARING` recovery test proving one dispatch;
- run/task commit trailers and rejection of foreign or unrelated integration history;
- strict package/script identifiers, ACTIVE-only lease hydration, and explicit NULL/malformed
  authority recovery tests;
- real clean-at-bind/dirty-before-start rejection before checkout provision.

The follow-up reviewer must specifically challenge whether any host package-script path remains,
whether the runtime profile is truly bound to approval authority, whether Docker failure is fail
closed, and whether the opt-in real Docker test proves the script starts before its write is denied.
Also challenge recovery semantics, clean-only scope, checkout confinement, runtime request equality,
lease hydration, and whether CLI composition remains thin.

Known limits: the pinned Node image invokes approved scripts with npm and never installs dependencies,
so scripts requiring pnpm or missing dependencies fail closed; Docker/image state must already exist;
strict Git trailer parsing and minimal-environment hardening for trusted Git subprocesses remain later
work. Linked worktrees still mutate source `.git` metadata, and branch-only partial creation needs an
explicit reconciliation path. These Git facts are documented P2 limits, not security-boundary claims.

## Next stage after follow-up review and explicit commit approval

The recommended next stage is **Observed Impact Reconciliation**: inspect the actual Git diff after the
agent settles and before verification/integration, canonicalize changed resources, compare them with
predicted impact and acquired lease authority, and fail/block on unauthorized scope expansion. Run
Operations and Recovery Control (`forge status`, resume/cancel, `UNKNOWN` resolution, integration-block
handling, and multi-failure diagnostics) remains the following planned stage. Neither stage should
publish branches or introduce GitHub/Jira triggers.

Do not let the CLI manually assemble those collaborators. Do not add GitHub/webhook/PR/Jira product
integration yet. Do not broaden sandbox permissions merely to make runtime binding convenient.

## Persistent workflow rules

- Run `pnpm check`, `pnpm build`, and `git diff --check` for every completed stage.
- Run `forge analyze` against this repository and the ingestion-and-matching research repository.
- Update English and Chinese progress summaries plus the Obsidian copies after every stage.
- Major mechanisms receive standalone English and Chinese beginner training documents.
- Generate a self-contained review message and leave changes uncommitted.
- Avoid unnecessary re-exports; export only cross-package contracts and composition APIs.
- Never infer authorization for live model data egress, commits, pushes, or external product writes.
