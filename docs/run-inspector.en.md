# Forge Run Inspector

The inspector is a local, read-only browser tool for one explicitly selected Forge deployment. Its React Flow graph shows the run lifecycle and its task lanes. Select a node to inspect the observations supporting its state. The graph does not approve, start, cancel, retry, settle or recover a run.

## Start it

Use the repository's existing Node 24+ runtime and install workspace dependencies with pnpm. The inspector does not require OpenTUI or experimental FFI.

```bash
pnpm build
pnpm inspector \
  --deployment-env-file .env.local \
  --env-file .local/neon-comparison.env \
  --repository .local/neon-comparison-deepseek \
  --task-queue forge-neon-comparison-deepseek \
  --label "Neon comparison"
```

Open `http://127.0.0.1:4777`, enter a run ID and choose **Inspect run**. An optional `?runId=<id>` URL pre-fills the input. It does not start execution. Use **Refresh**, optional five-second auto-refresh, task filtering, graph pan/zoom and the overview minimap. Selecting a node opens its evidence panel; **Copy evidence / IDs** copies that node's observations.

`--port` changes the loopback port. `--operator-root` selects the checkout containing the run-scoped `.local` evidence files and defaults to the current directory. No external browser or network listener is automatically opened. The page uses the browser window, with graph/evidence columns on wider screens and a stacked layout on narrower screens.

## Select the environment explicitly

The selected `--env-file` must contain these existing runtime settings:

```text
FORGE_WORKER_AUTHORITY_MODE=global
FORGE_POSTGRES_CONNECTION_STRING=<query-free runtime-role URL>
FORGE_POSTGRES_SCHEMA=<exact authority schema>
FORGE_POSTGRES_ROLE=<runtime role>
FORGE_POSTGRES_SSL=verify-full
FORGE_AUTHORITY_ID=<existing canonical authority fingerprint>
```

The backend and Temporal settings must either be in that same file or in the explicitly supplied `--deployment-env-file`:

```text
FORGE_AUTHORITY_BACKEND=postgres
TEMPORAL_SERVER_URL=http://localhost:7233
TEMPORAL_NAMESPACE=default
```

Only those three deployment settings can be filled from the deployment file. Authority URL/schema/role/identity never fall back to that file or to shell variables. Preserve the accepted identity and transport settings; do not synthesize a different fingerprint to bypass a mismatch. Local loopback PostgreSQL can use its existing explicit `false` transport setting. Remote PostgreSQL retains verified TLS requirements.

Repository and queue are required command arguments because comparison's generated authority file does not contain its provider-specific checkout/queue. If the selected file also contains worker repository/queue settings, they must match. The environment banner displays label, global mode, host/database, schema, runtime role, queue, namespace and canonical repository. Every inspection request includes this environment identity. A missing run or a confirmed repository/scope/queue mismatch stops the inspection; another database is never queried as fallback.

The inspector needs the existing runtime-role connection, not owner/trust/issuer/setup/recovery/database-owner connections. Private credentials remain on the server. The GET-only loopback bridge sends allowlisted observations to React; it never sends credentials, permit verifiers, signed envelopes, prompt/response bodies or provider/driver diagnostics.

## Interpret the graph

| State    | Meaning                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| complete | Direct evidence supports this specific stage.                                                               |
| active   | An explicit observed state says work is active.                                                             |
| pending  | An explicit record says pending/ready/preparing; it is not a claim about missing setup.                     |
| failed   | An explicit observed terminal failure/rejection/revocation/cancellation. The raw state remains in evidence. |
| unknown  | Missing, unavailable or conflicting evidence; it does not prove failure or non-occurrence.                  |

Approval and repository binding show recorded identities. Run metadata is complete when the durable run record exists even if the run itself remains ACTIVE. The separate terminal node shows the actual durable run state and timeline. PREPARING builder attempts are pending, while their unobserved setup stages remain unknown.

Each builder attempt has setup nodes for admission, generation, arming, permit, worktree observation, persistence, attestation, settlement and execution-child handoff. Task lanes also show builder/repair attempts, leases, verification, review and integration. The Temporal node lists observed workflow/activity identifiers and states. Edges organize the lifecycle; they do not prove upstream completion. A persisted child does not retrospectively mark arming complete. The phase record may have moved on without retaining earlier arming evidence, so that node can remain unknown on a successful run.

PostgreSQL uses existing audited recovery readers and `ForgeReadModel`, plus SELECT-only global observations. Observation sessions set `default_transaction_read_only=true`; supplemental queries run in a read-only transaction. The inspector does not call authority recovery methods that lock or mutate claims. Temporal describe/history, current Git worktree listing and exact run/task-scoped files are separately labelled. An absent current worktree cannot erase recorded integration. A local evidence file is an observation, not a verified signature or settled authority decision.

When Temporal answers that the exact workflow ID is not currently known in the selected namespace, the source is marked **observed**, the workflow node stays **UNKNOWN**, and its evidence says `lookupResult=not-found`. This is distinct from an unavailable Temporal connection. A not-found lookup does not establish that a workflow never ran; it may also have been removed after retention. Confirmed task-queue mismatches still stop inspection.

For readability, the graph and detail panel show the known reason instead of a generic UNKNOWN label: **NO EVIDENCE**, **CONFLICTING EVIDENCE**, **NO CURRENT WORKFLOW**, **SOURCE UNAVAILABLE**, or **INSUFFICIENT EVIDENCE**. The first means no evidence was attached to that node. A current Temporal not-found lookup gets **NO CURRENT WORKFLOW**, which does not claim the workflow never existed. These are presentation reasons; the underlying state remains `unknown`, and the evidence and source availability remain inspectable.

These sources are not read atomically together. Source availability and observation timestamps remain visible; a disconnected auxiliary source becomes UNKNOWN. A required PostgreSQL read failure stops inspection. This first slice supports global PostgreSQL deployments and ordinary configured Temporal endpoints; it adds no SQLite fallback, deployment discovery, remote hosting or administration service.

## Evidence boundary for this implementation

The reported PREPARING Neon run is covered as a labelled regression fixture, including its ACTIVE run, first PREPARING attempt, second PENDING task and missing setup/worktree/local observations. Browser checks exercise that fixture and the actual compiled frontend. Separately, a GET-only live observation of the same run in the explicitly selected `forge_comparison_20261005` Neon schema returned HTTP 200. It showed ACTIVE run metadata, RUNNING and PENDING task states, UNKNOWN setup admission, and observed PostgreSQL/Git/local sources. Temporal observation was unavailable at that read, so its node stayed UNKNOWN; the inspector does not infer whether the workflow was absent or the source could not be reached. The live browser rendered the run with 35 visual nodes including two task lane labels and no console errors. This was not a new coding E2E, an authority mutation or a worker restart. Live deployment acceptance remains a separate milestone.

The implementation design is in [run-inspector-design.en.md](run-inspector-design.en.md), and the independent review handoff is in [run-inspector-review.en.md](run-inspector-review.en.md).

## Diagnosing the reported PREPARING run

A later read-only Neon comparison for `fe89c1bf-0ec8-4aee-80da-b14d2e0918fa` compared the graph with the underlying authority tables. The exact run has zero matching global claims, generations, workspace permit lineages and unresolved generic permits. Therefore the UNKNOWN setup stages reflect missing durable rows in those queried surfaces; they are not existing rows omitted by the graph projection. The run metadata and first PREPARING builder attempt are present. This narrows the durable boundary to after run metadata was recorded and before a run-scoped setup claim was persisted. It does not identify the operator error that interrupted setup or prove that an unpersisted worktree never existed. A direct Temporal lookup returned `WorkflowNotFoundError`; the inspector now preserves that lookup outcome without treating it as historical proof.
