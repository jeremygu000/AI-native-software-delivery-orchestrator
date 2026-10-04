# Forge Interactive Coding CLI

## Purpose and baseline

This frontend builds on accepted `2a4306ec25e157647186096f9c18146f39acc2dd` on `m4/postgres-durable-authority`. A developer can enter a task and carry one exact model profile through planning, immutable approval, binding, existing setup and Temporal execution without manually copying identities between commands. Explicit commands remain the automation interface.

After `pnpm build`, run `pnpm forge` in a terminal, or invoke the workspace `forge` binary. For the existing local deployment environment, use `pnpm local:forge` without a subcommand. The wrapper keeps privileged credentials out of worker environments. Bare invocation outside a terminal exits with instructions to use `forge --help`.

## Start a coding task

1. Select **Start a coding task**. The other root entries are Resume a run, View runs, Configure model and Check environment. Configure model reuses the accepted picker; the other three currently state that they are unavailable.
2. Enter a Git repository path. The current directory is offered as a convenience. `~/` is expanded and the Git root is canonicalized. Analysis must succeed and the repository snapshot must remain stable during validation.
3. Choose **Describe task** or **Use Markdown specification**. Multiline text ends with a line containing only `.`. Consecutive pasted lines are retained. A specification path is resolved relative to the CLI working directory.
4. Select an existing execution profile. Missing Forge credentials stop the chosen provider with its existing login/API-key instructions. There is no fallback or external credential discovery.
5. Explicitly authorize the selected model to create and independently review the plan. No model request is made before consent. The existing defaults remain three planning attempts and maximum concurrency one.
6. Inspect the plan summary and optionally review its requirements, dependencies, writes, verification and conflicts. **Revise task** creates another immutable artifact. **Cancel** leaves any already created plan intact and does not approve or execute it.
7. **Approve and run** asks for a second confirmation naming the exact artifact/revision, profile, repository integration task IDs and workspace creation. Git integration authorization is confined to tasks with expected or predicted writes.
8. Forge checks the declared worker deployment against the repository and policy fingerprint, runs existing read-only preflight, and observes workflow and activity pollers on the configured Temporal queue. It does not start or manage a worker. The worker must already be configured for the chosen exact target; worker and binder checks remain authoritative if availability changes afterward.
9. The frontend generates approval/run IDs, calls the existing approval and binder, performs accepted setup, and launches the existing runtime. It shows IDs and the run directory for later diagnostics.
10. Progress polls the existing durable read model roughly once per second. Completion reports recorded task, verification, review, integration-event and lease evidence. It does not invent percentages or claim a push, PR or deployment.

## Execution and authority boundaries

File specifications and inline requests enter `planRepositoryFromSource`. Repository analysis, planning, semantic review, artifact creation and policy fingerprints use the same core. Source metadata deliberately differs: a file retains its Markdown path, while inline text is a `user-request`. Artifact identities, times and source fingerprints are not forced equal; prepared decisions and policy/snapshot identity are equivalent for equivalent facts and mocked model results.

The profile lives only in the current frontend session. The exact provider/model/reasoning values reach plan, bind and run. The existing DeepSeek policy representation and subscription execution-target semantics are retained. There is no saved profile, repository registry or separate interactive execution contract.

The global path has a necessary existing ordering:

```text
exact approval → binding
→ run preparation / persisted initial dispatch
→ signed setup admission and permitted workspace creation
→ independent generation observation, recovery evidence and handoff
→ Temporal launch
```

The local operator script is now a thin wrapper over a callable operator function. The CLI calls that function directly after explicit setup consent. It reads the same private deployment files, uses separate runtime/setup/issuer/recovery connections, and does not give those credentials to a worker. The runtime authority host/database/role/schema must match the operator configuration before connections are created. Every opened operator client is closed even if later initialization fails. Existing recovery evidence is preserved instead of replaced.

Operator configuration is deployment configuration, not repository configuration. In the existing local composition it is rooted at the CLI working directory, with `.env.local`, optional `FORGE_COMPARISON_ENV_FILE`, `.local/setup-private.pem` and existing recovery material. Prepare these using the accepted deployment/operator procedures before entering the coding workflow. The interactive CLI does not bootstrap PostgreSQL, prepare Neon schemas, modify ACLs or create a daemon. In legacy mode, existing launch preparation remains responsible for setup.

The shared run function now accepts an explicit `prepareOnly` setting. Interactive global setup requests true, and final launch requests false. Existing explicit commands still honor ambient `FORGE_PREPARE_ONLY` when this setting is absent. The frontend cannot accidentally remain in preparation mode because a shell retained that environment variable.

## Cancellation and failures

Escape/Ctrl-C restore prompt raw mode, application listeners and input flow. During model planning, abort reaches the existing SDK session and prevents subsequent model calls/artifact saving. Before planning there are no artifacts; after planning, cancellation can retain an immutable plan. Before execution preparation there are no workspaces or Temporal launch.

After the accepted initial-dispatch boundary, durable run/setup state can already exist even before Temporal starts. Cancellation uses the existing `cancelRun` path; it does not erase approvals, release uncertain authority by assumption, or settle UNKNOWN attempts. If workflow cancellation cannot be confirmed, the CLI says so and directs the operator to durable status/recovery. During a live run, Ctrl-C requests cancellation for the exact carried run once.

Repository or policy drift at binding stops execution and offers an explicit re-plan choice. It never silently reapproves a stale plan. Setup failure prevents launch. A failed launch response can be ambiguous; the CLI retains the exact run ID/directory and tells the operator to inspect it rather than retrying with a new identity. Provider/driver diagnostic bodies are not printed. Failed or cancelled durable outcomes exit unsuccessfully after the recorded summary.

## Verification and limits

Verification results are recorded in `interactive-coding-cli-review.en.md` and the synchronized progress summaries. Tests distinguish mocked frontend/operator composition, real local planning/artifact operations, and compiled PTY behavior. No mocked test is evidence of provider inference or a complete live coding run.

Live GroundGraph acceptance is deliberately scheduled after independent code review: choose one provider through the bare interactive entry, execute a small known task, and inspect setup, Temporal, verification/review, integration, claim release, unresolved permits and trace evidence. No live Neon or provider work is performed by this implementation increment.
