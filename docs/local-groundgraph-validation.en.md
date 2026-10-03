# Local GroundGraph functional validation

## Isolation and prerequisites

This environment runs infrastructure in Docker and the compiled Forge CLI/worker on
the host. `docker-compose.local.yml` contains only PostgreSQL, Temporal and Temporal UI.
Ports are bound to loopback. Temporal uses `temporal` and `temporal_visibility`; Forge
uses a separate `forge` database with C collation, required by the existing strict
PostgreSQL schema audit. The bootstrap uses the existing versioned migration and
authority APIs rather than test fixture records.

The target is `/Users/isdance/Desktop/projects/ground-graph-ts`. Do not substitute a
temporary clone, manually implement the target change, insert fixture authority, reset
an uncertain owner, or declare completion from a model response alone.

## Prepare infrastructure and secrets

```sh
pnpm build
pnpm local:env
pnpm local:up
pnpm local:authority
```

`local:env` creates ignored `.env.local` with unique database passwords and mode 600;
it refuses to overwrite an existing file. Fill the host model key there, never in a
tracked file. The local setup/recovery signing keys and operational evidence live in
ignored `.local/`. The worker/CLI wrapper removes all `LOCAL_` privileged credentials
before spawning ordinary host processes. The separate operator process alone loads
setup, issuer and recovery credentials.

Set `FORGE_PI_IMAGE` to the actual built isolated SDK image's immutable digest. The
approved model for this validation is `deepseek-flash`, thinking enabled, high effort
for planning, builder, reviewer and repair. No key or reasoning content belongs in an
experiment report. Configure confined Git identity using
`node apps/temporal-worker/local/configure-git-identity.mjs`; this does not write the
target repository's Git configuration.

```sh
pnpm local:model-check
pnpm local:preflight
```

These are different observations: preflight does not call a model; model-check makes
a real paid inference request but emits only sanitized readiness metadata.

## Standalone OpenTelemetry trace check

Set `OTEL_SERVICE_NAME=forge-local`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_TRACES_EXPORTER=otlp` in the ignored,
mode-600 `.env.local`, or export them in the shell. The headers value must use
OpenTelemetry's `key=value` format, for example
`"Authorization=Basic BASE64_CREDENTIAL"`. For an OTLP/HTTP base endpoint ending
in `/otlp`, the exporter sends traces to `/otlp/v1/traces`.

```sh
pnpm local:otel-check
```

This starts one `forge.startup` span under service `forge-local`, waits for OTLP
export and prints its trace ID. It does not start a worker, access Forge authority,
or change the production execution path. Search the trace ID or service in the
collector UI. An HTTP export failure makes the command fail; the diagnostic omits
endpoint and authentication details.

Formal workflow and activity tracing uses an additional worker opt-in on a fresh
Temporal queue and authority. See `docs/forge-observability.en.md` before starting
a traced GroundGraph comparison run.

## Approve verification before planning

The original GroundGraph checkout's macOS dependencies cannot be reused as Linux
native binaries. Its checks also generate temporary coverage/artifacts. Build the
dependency-provisioned image without target source or credentials:

```sh
node apps/temporal-worker/local/build-verification-image.mjs /Users/isdance/Desktop/projects/ground-graph-ts
node apps/temporal-worker/local/configure-verification.mjs
```

The image wrapper copies the read-only mounted source to an isolated temporary
directory and overlays frozen-lockfile Linux dependencies. Runtime network access
remains disabled. The original package `check` script and quality gates remain intact.
Its approved image digest and executable temporary filesystem budget must be present
when creating a **new** plan and approval, and must match worker verification policy.
Do not retrofit a policy into an existing immutable approval.

## Real plan, metadata preparation, privileged setup and execution

```sh
pnpm local:forge plan .local/experiment.md \
  --repository /Users/isdance/Desktop/projects/ground-graph-ts \
  --plan-directory .local/plans --semantic-review \
  --review-provider deepseek --review-model deepseek-flash
pnpm local:forge approve ARTIFACT_ID \
  --repository /Users/isdance/Desktop/projects/ground-graph-ts \
  --plan-directory .local/plans --approval-id APPROVAL_ID \
  --approved-by local-user-authorized-experiment \
  --allow-repository-integration TASK_ID
```

Repository integration is an explicit execution approval for named tasks, not a
permission inferred from review acceptance or Git setup approval. For multiple tasks,
the option takes comma-separated task IDs. Preserve the exact artifact and approval.

```sh
FORGE_PREPARE_ONLY=true pnpm local:forge run ARTIFACT_ID \
  --approval APPROVAL_ID --run-id RUN_ID \
  --repository /Users/isdance/Desktop/projects/ground-graph-ts \
  --plan-directory .local/plans --run-directory .local/runs/EXPERIMENT \
  --review-provider deepseek --review-model deepseek-flash
pnpm local:prepare-workspaces RUN_ID ARTIFACT_ID APPROVAL_ID
pnpm local:worker
```

Metadata preparation reports `prepared`, not a started workflow. The operator signs a
separate Git setup decision, invokes existing restricted admission/generation/arming
and the dedicated Git permit, saves the initial workspace, revokes/stops its supervised
generation, signs real Git recovery evidence and performs the existing atomic handoff.
It saves exact signed evidence **before** binding its identity through settlement.
No SQL fixture insertion or worker-held privileged credential is involved.

In another terminal, repeat the same `run` command without `FORGE_PREPARE_ONLY` to
start the actual Temporal workflow. Observe it with:

```sh
pnpm local:forge status --run-id RUN_ID --run-directory .local/runs/EXPERIMENT
```

Later scheduler-authorized tasks require their own operator setup before execution.
Do not manually reset attempts to PREPARING or create an alternate scope to evade a
blocking owner. A COMPLETED experiment requires genuine durable builder output,
approved verification, exact independent review, confined Git integration and terminal
run state—not merely a clean worktree or passing diagnostic command.

## Failure handling and evidence

Classify failures as A repository, B planning, C model, D runtime, E verification,
F authority or G configuration. Keep run/task/attempt IDs, immutable artifact/approval
fingerprints, timestamps, test counts and Git commit IDs. Never include credentials,
raw model transcripts or hidden reasoning.

UNKNOWN/HELD_UNCERTAIN is intentionally blocking. Stop and independently confirm the
original host worker is gone, check the exact registered Docker identity and absence
of pending permits, and use the existing version-CAS reclaim only with recorded
quiescence evidence. `recover-child.mjs` and `recover-integration.mjs` are separate
local operator entry points; neither relaunches Git or a model. Lost immutable setup
settlement evidence cannot be replaced: the explicit `prepare-workspaces --abandon`
operation requires fresh independent signed shutdown/Git observations and marks the
old setup ABANDONED without creating a child or resetting settlement. Retry with a
new approved run after safe closure, never by editing authority rows.

Baseline or temporary diagnostic checks are not Forge verification records. Record
whether a command ran on pristine baseline, model output, or through the approved
worker verifier, and report unfinished experiments as unfinished.

## Recorded real experiments

The initial target was clean commit `2528d608c70e4d2b23363c8736b0b8bdb725a72f`
at the actual path above. Planning, semantic review, builder, output review and repair
used paid `deepseek-flash` with thinking enabled/high effort. Target source changes
were made by those isolated model sessions, not by the operator. No fixture authority
rows, passing-verification substitutions or manually implemented target fixes were used.

| Experiment | Genuine completed run       | Change                                                                                                         | Integrated commit                          |
| ---------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1          | `groundgraph-current-query` | Bound all three query filter arrays to 100 and test their boundaries.                                          | `672e113e35ba76dc73190dc2d68696361e991d07` |
| 2          | `groundgraph-exp2-sdkfix`   | Redact unexpected entity-list 500 details while preserving logging/authentication and test real API injection. | `814d6c9d8c55e5622784bc42e0127c02ac3fa3d3` |
| 3          | `groundgraph-exp3-current`  | Decompose clock millisecond fidelity and ISO calendar-date validity into two disjoint source/test tasks.       | `1e8835d37a0827c111291fa8a6cf4f12cc2caa68` |

Each completed run has both PostgreSQL and Temporal status COMPLETED, actual passed
verification, independent model acceptance and confined Git integration. Runtime-only
evidence reads find respectively 3, 3 and 6 claims, all RELEASED, with zero unresolved
generic or dedicated workspace permits. The third plan approved `maxConcurrency=2`
and one guarded-parallel wave, but explicitly approved repository-wide execution
resources serialized the actual writers. Its date writer ran 07:42:50.392–07:43:20.360
UTC and its clock writer 07:43:32.235–07:44:07.915 UTC on 2026-10-03. **This is a
successful decomposed run, not evidence of two simultaneous writers.**

The independent final check of integrated HEAD used the same approved immutable Linux
dependency image, read-only host source, disabled network and isolated temporary copy.
Original formatting, lint, type and architecture gates passed; unit tests passed
949/949 and architecture tests 3/3. The existing 20 lint warnings remained; no gate
was lowered. The target checkout was clean afterward. This final diagnostic supplements,
but does not replace, the individual persisted Forge verification records.

Read the retained durable facts without model transcripts or credentials:

```sh
node apps/temporal-worker/local/experiment-evidence.mjs \
  groundgraph-current-query groundgraph-exp2-sdkfix groundgraph-exp3-current
```

### Failed attempts and reproducible gaps

The successful rows do not retroactively make earlier attempts successful. Failed or
UNKNOWN runs and their evidence remain in the store. Only existing independently
proved quiescence/version-CAS recovery or signed setup abandonment closed their owners.

- **A/E — repository/verification:** pristine Linux baseline already failed two IPv6
  literal SSRF tests. A real model task fixed the literal-before-DNS check and integrated
  `e13326ac2662e3d5ddafaeace95c5912d6d919f5`. Query bounds then planned against that
  actual new base. An old worktree on the earlier base did not receive an operator rebase.
- **B/C — planning/model:** nonexistent new-file selectors were rejected rather than
  fabricated. Some real model tests failed or review findings used unknown file IDs;
  actual verification/review rejected them. Timed-out sessions became UNKNOWN, not
  COMPLETED. The default five-minute deadline was not silently increased.
- **D/F — runtime/authority:** real global launch, metadata preparation, initial STARTING
  timestamps, serialized Set/collection identity, scheduling of handed-off attempts,
  immutable evaluation retry and blocked-integration progress exposed product gaps.
  Narrow regressions cover the fixes; migrations 13–15 append to the historical ledger.
  Abandonment preserves old settlement identity and creates no child/token.
- **D — correctable tool input:** absent read paths/directories and missing/ambiguous
  edit preconditions now produce bounded tool errors only where no side effect happened.
  Writes, persistence failures, authority denial and ambiguous permit completion still
  quarantine the owner.
- **G — deployment:** supported PostgreSQL 16/C collation, Linux native dependencies,
  formatter ancestry, explicit container Git identity and a rebuilt SDK image matching
  DeepSeek reasoning continuation were required. No host global Git configuration or
  model credential was copied into a container.

The latest Forge image-enabled check passes 967/967 tests without skips, with unchanged
coverage gates. All changes remain subject to independent review. Automated setup or
recovery scheduling, genuine simultaneous same-repository writers and production
rollout are not claimed by these three local experiments.
