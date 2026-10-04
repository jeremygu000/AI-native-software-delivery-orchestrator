# Real GroundGraph workflow trace acceptance

## Scope and review request

Review this documentation-only increment against accepted baseline `de715459f168adf15c960dea41b1dd918604c0a9` on `m4/postgres-durable-authority`. Independent review accepted the Interactive Coding CLI and its real execution/read-model correction; that product stage is closed. The user then requested continuing the separate full workflow tracing acceptance work.

This stage runs existing production code with its accepted telemetry configuration. It introduces no production code, dependency, workflow patch, authority contract, migration SQL/checksum, provider adapter or configuration registry. Changed tracked areas are this evidence report, the tracing guide, the prior execution report's acceptance status, and synchronized progress summaries. Local experiment configuration and evidence remain ignored and private. The user requested commit and push of this evidence increment; independent acceptance remains pending.

## Fresh deployment boundary

The existing local PostgreSQL deployment at `127.0.0.1:54329`, database `forge_comparison_20261004`, received a new schema `forge_comparison_20261004_full_trace`. A local-only endpoint guard rejects other endpoints/databases, and a catalog check rejects an existing target schema before installation. The accepted installer created the new authority through its existing local `create-or-upgrade` mode, installed versions 1–15, and configured the six existing separate roles. Existing cutover, repository scope activation and setup trust registration then produced GLOBAL_READY. This is local deployment evidence, not validation of Neon's separate shared-schema preparation procedure.

The old `forge` schema was retained. Its ledger digest, including checksum and applied timestamp, remained `5d117957f1ab95a01a1d5e707c1f3b64ecff3a75df967c67d054c853ecbb2102`. No database-wide privilege change, role definition change or Neon operation was performed.

The production worker consumed only the new queue `forge-full-trace-20261004` with `FORGE_OTEL_INSTRUMENTATION=1`, existing OTLP configuration and `deepseek / deepseek-flash / high`. The authority fingerprint was `sha256:d8b2ffe085384ee27d41261773e9293c37ee49427199f54dd9eadef6d641fe35`. Existing read-only preflight passed repository, authority, Temporal and both pinned images. The interactive readiness check found both queue pollers before approval. Recorded activities all ran at attempt one under worker identity `99194@MacBookPro`.

A private experiment directory supplied an isolated `.env.local` to the existing operator setup function, without changing the repository's original `.env.local`. Separate local setup/issuer/recovery passwords and existing signing files remained within that operator boundary. The child CLI/worker environment stripped `LOCAL_*`, privileged role URLs and database-owner settings. The launcher called the actual compiled production entry points; it did not inject application functions or parse automation-command stdout. The worker was stopped normally after completion, with telemetry shutdown and exit zero. The new schema is retained as evidence; other workers were not stopped.

## Actual interactive execution and durable result

The compiled `apps/cli/dist/main.js` opened with no subcommand in a real PTY. The actual menus collected the repository, multiline task and DeepSeek/high profile, obtained explicit semantic planning/review consent, displayed the accepted plan and details, and approved exact workspace/integration scope. Real paid model requests were made for planning, builder work and independent reviews.

The task adds four regression cases to `tests/unit/api/query-schema.test.ts`: tab/newline-only rejection, trimming surrounding tabs/newlines, acceptance at the raw 10000-character limit, and rejection above that raw limit even if trimming would shorten the string. The plan used exactly one task and the original root package `check` verifier. Production schema behavior, manifests and verification gates were unchanged.

| Identity            | Value                                             |
| ------------------- | ------------------------------------------------- |
| Repository          | `/Users/isdance/Desktop/projects/ground-graph-ts` |
| Baseline            | `4bac482be43e8e847281e50965d039f23a6c936a`        |
| Artifact / revision | `8872a0f2-9ecb-4bda-b25e-af3115c30f1e` / 1        |
| Approval            | `ea8c0adf-0516-4532-ade8-f08906c45ea8`            |
| Run                 | `8c7449d0-54fd-436a-b924-b97003c303b1`            |
| Task                | `add-query-schema-trim-boundary-tests`            |
| Temporal execution  | `01a10639-6fa4-7b5d-a821-0021380b6f90`            |
| Integration commit  | `77b28c7c3691d0db70340881850b812f4ef7de13`        |

PostgreSQL and Temporal both report COMPLETED. The workflow started at `2026-10-04T09:23:09.860Z` and closed at `2026-10-04T09:24:15.356Z`: **65.496 seconds**. Builder completed, verification passed, independent code review accepted, and integration completed. All three claims are RELEASED, both unresolved permit counts are zero, and the terminal's durable completion summary reports 1/1 complete and zero active/stale leases. Repair was not needed. GroundGraph is clean at the integration commit, with exactly one file changed and 47 lines added. No manual target-source edit, push or PR was performed.

Verification fingerprint: `sha256:b2c277bb56a6fc724d57cc08c280a3e1fbee282233df25f446e133b8dc77723e`. Plan fingerprint: `sha256:edbcb0f65d20ee537d219c18eb38e087539a1adde0f8494b382aa318db1a5d2b`. Approval fingerprint: `sha256:d92d68f47350fa89f79dc467fab88406e66b4c319e4c5cb93d0e44db12987264`. Execution fingerprint: `sha256:dc27b8c9ad3518b27548593ea21e7d60b7347427cb0f162caa71fe568d7d72be`.

## Tempo evidence

In the existing authenticated Grafana session, this query returned the real workflow trace:

```text
{ resource.service.name = "forge-local" && span.run_id = "8c7449d0-54fd-436a-b924-b97003c303b1" }
```

Trace ID: **`4f59f4801eb67abc02d9709461687301`**. Tempo shows one service and **26 spans**. The trace was opened in Explore and downloaded through its Export as JSON menu. Its observed structure is:

```text
RunWorkflow:forgeRunWorkflow
└── forge.run
    ├── reevaluate activity
    ├── forge.task
    │   ├── executeBuilder activity
    │   │   └── forge.model.request × 5 (builder)
    │   ├── reevaluate activity
    │   ├── evaluateBuilderOutput activity
    │   │   ├── forge.verification
    │   │   └── forge.review
    │   │       └── forge.model.request (reviewer)
    │   └── integrateAcceptedOutput activity
    │       └── forge.integration
    ├── reevaluate activity
    └── finalizeRunState activity
```

Each activity includes Temporal StartActivity/RunActivity spans. These 15 Temporal spans plus 11 Forge spans account for all 26 exported spans. Planning precedes run allocation and remains separate; no planning-to-workflow parentage is claimed.

| Span                            | Count | Duration / outcome                                  |
| ------------------------------- | ----- | --------------------------------------------------- |
| `forge.run`                     | 1     | 65.476 s / completed                                |
| `forge.task`                    | 1     | 65.256 s / integrated                               |
| `forge.model.request`, builder  | 5     | 1.012, 6.538, 8.199, 1.217, 4.516 s / completed     |
| `forge.verification`            | 1     | 28.010 s / passed                                   |
| `forge.review`                  | 1     | 10.684 s / completed; durable recommendation accept |
| `forge.model.request`, reviewer | 1     | 10.663 s / completed                                |
| `forge.integration`             | 1     | 3.159 s / integrated                                |

An independent local audit of the exported JSON verified:

- Every span uses this one trace ID; `forge.task` directly names `forge.run` as its parent.
- Every model/verification/review/integration span has that same task as an ancestor through the activity context. Reviewer model request directly names `forge.review` as its parent.
- Every operation carries the exact durable run/task IDs, and every model request carries DeepSeek/flash/high with the correct builder/reviewer role.
- Every operation ends no later than the task span. Task outcome is integrated; run outcome is completed.
- All 26 spans use only the eight allowed attribute names, with no events, links or nonempty status message. Resource attributes contain only `service.name`.

Run span ID is `b840f6b3d06df04e`; task span ID is `5b1cfd07cca79870`; integration span ID is `448c9b3829291680`. The retained pretty-printed export SHA256 is `eef70bee54b3c2a221cf36c11f081e1f455edaedea942c5bdb80d3ddf6c2084e`.

## Verification, limitations and remaining work

This is real provider/Temporal/PostgreSQL/Grafana execution evidence on accepted code. There are no production/test changes. The baseline build remains prior accepted evidence; no build configuration changed. Before the user-requested commit, full image-enabled `pnpm check` was rerun successfully: **1118/1118 tests in 107 files, no skips**, including the existing PG18/Docker/Temporal fixtures. Coverage: statements 90.63%, branches 85.23%, functions 94.30%, lines 90.56%, above unchanged thresholds. The gate log is `/tmp/forge-full-trace-commit-check.log`. Current deployment preflight and exported-trace assertions passed. `pnpm format:check` and `git diff --check`: PASS.

Private mode-600 evidence is retained in ignored `.local/full-trace-authority.json`, `full-trace-preflight.json`, `full-trace-durable-evidence.json`, `full-trace-status.json`, `full-trace-tempo.json`, `full-trace-analysis.json` and `full-trace-worker.log`. Private launch/probe scripts and the isolated operator environment are experiment aids, not a new production registry. Credentials, signing keys, model transcripts, source/diff bodies and mutation secrets are not included in this report.

The successful real path validates six of the seven Forge span types. `forge.repair` was not exercised because verification/review succeeded; neither deferred integration nor cancellation/error was induced. Their accepted regression coverage remains separate from this live evidence. There is no claim of all seven types observed live, provider comparison, live Neon deployment acceptance or backend TLS evidence from this loopback run.

## Questions for independent review

1. Does the fresh schema plus fresh queue satisfy the accepted Temporal plugin deployment boundary without routing prior histories to the new worker?
2. Do the exact artifact/approval/run/commit identities and released claims/permits substantiate a real production interactive run?
3. Does the exported trace substantiate same-trace ancestry, exact profile attributes and task lifetime, rather than merely listing span names?
4. Does the all-span allowlist/events/links/status audit substantiate the disclosure boundary, including Temporal-generated spans?
5. Are the unexercised repair/deferred/error paths and still-pending Neon deployment clearly distinguished from this successful local trace acceptance?
