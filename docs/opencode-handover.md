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

Work in `~/Desktop/apra_new/apra-amcos-admin-coding-orchestrator` on `main`. Stage 18 is committed at
`65b8204e2eeb5134d311a49a57c4acc04ae9658a`. Stage 19 is complete and independently reviewed in the
working tree. It remains intentionally uncommitted pending explicit user approval. Preserve all
tracked and untracked changes.

Do not commit unless the user explicitly approves it after review. Repository-local commit identity
must remain `JeremyGu2021 <isdance2004.yg@gmail.com>`. The remote is
`git@github.com:jeremygu000/AI-native-software-delivery-orchestrator.git`.

Before editing, read:

- `docs/architecture.md`;
- `docs/adr/022-durable-plan-artifact.md`;
- `docs/adr/023-plan-approval-and-execution-binding.md`;
- `docs/plan-artifact.en.md` or `.zh.md`;
- `docs/plan-approval-and-binding.en.md` or `.zh.md`;
- the Stage 18 and Stage 19 sections in both progress summaries.

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

Stages 1–18 are committed and reviewed:

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
Autonomous Plan -> Semantic Review -> Durable PlanArtifact
```

Core deterministic packages must remain free of LLM, provider, Jira, pnpm, Git implementation,
filesystem storage, and CLI concerns. Pi stays inside `libs/agent-runtime`. Repository-provider details
stay inside `libs/repository-analysis`. Filesystem and SQLite mechanics stay inside persistence.

## Stage 19 working tree

Stage 19 adds:

- provider-neutral, fingerprinted `PlanApproval` and `PlanApprovalClaim` contracts;
- atomic immutable JSON approval storage and single-run claiming;
- `PlanExecutionBinder`, which reloads exact evidence, recaptures Git before and after RepositoryGraph
  rebuilding, rejects repository/facts/policy mismatch, and claims only after validation;
- fingerprinted `PlanExecutionIntent` with nested integrity and cross-record validation;
- `forge approve` and `forge bind` composition commands;
- ADR-023 and bilingual training/progress documentation.

The binding flow is:

```text
PlanArtifact + PlanApproval
          |
          v
snapshot A -> RepositoryGraph rebuild -> snapshot B
          |
          v
repository/facts/policy comparison
          |
          v
atomic approval claim for runId
          |
          v
PlanExecutionIntent
```

The claim is deliberately written last. Same-run retry is idempotent and returns the original claim;
different-run replay is rejected. `PlanExecutionIntent` is not `StartRuntimeRunRequest` and does not
start a process.

## Current verification baseline

Stage 19 currently passes:

```text
pnpm check       34 files / 452 tests
coverage         95.82% statements / 91.02% branches / 96.70% functions / 95.79% lines
planning gate    54 tests / 98.38% / 95.07% / 97.84% / 98.54%
pnpm build       pass
git diff --check pass
```

Self-analysis: 14 projects, 104 files, 1,490 symbols, 49 project dependencies, 205 file dependencies,
2,716 symbol references, two known root configuration diagnostics.

Research analysis at `~/Desktop/apra_new/apra-amcos-admin-ingestion-and-matching`: 3 projects, 1,010
files, 7,617 symbols, 3 project dependencies, 3,592 file dependencies, 13,893 symbol references, and
the known 25-file API scripts coverage diagnostic.

## Accepted review result

Stage 19 passed independent review and follow-up verification. The review confirmed:

- nested fingerprint and cross-record integrity;
- approval-before-artifact and exact artifact binding;
- claim atomicity under simultaneous different-run requests;
- same-run idempotency and cross-run replay rejection;
- claim ordering after all repository and policy checks;
- moving-repository rejection around RepositoryGraph analysis;
- repository ID/root, base commit, working tree, dirty state, Repository Facts, and both policy
  mismatches;
- filesystem confinement and error-class correctness;
- CLI boundary discipline and absence of runtime binding assembly;
- provider-neutral types and unnecessary re-exports;
- tests that exercise failures rather than only happy paths.

Stage 20 should add two non-blocking integration tests: two real clones sharing one origin must reach
the binder and reject the different physical root, and dirty-state-only mismatch must be isolated.

## Next stage after explicit commit approval

Stage 20 is **Controlled Runtime Binding and Start**. It should consume a verified
`PlanExecutionIntent`, apply an explicit deployment policy for the existing runtime's agent,
workspace, lease, command, sandbox, model, and verification collaborators, construct the existing
runtime request, persist the start boundary, and expose a recoverable `forge run` path.

The Stage 20 P1 is execution-time freshness. An intent is evidence from bind time, not a permanent
pass. Run preparation must revalidate the source immediately before side effects, provision an
orchestrator-owned integration checkout at the approved base commit, derive every task worktree from
that checkout, persist an atomic-ish run creation boundary, and only then call
`OrchestrationRuntime.startRun()`. A direct `parsePlanExecutionIntent()` -> `startRun()` path is
forbidden.

Stage 20 integration tests must include two real clones sharing one origin with a different physical
root, a dirty-state-only mismatch, mutation between bind and run preparation, wrong integration
checkout base commit, and task workspace ancestry from the trusted checkout. The run record should
retain execution/plan/approval/claim fingerprints. Current CLI shared-resource input is already
canonicalized by `SharedResourceRegistry`; future adapters must not hash arbitrary reordered arrays
without the same normalization.

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
