# Worker deployment preflight

## Purpose and accepted baseline

M4.2 production authority is frozen at `91a5ca9`; M4.3 fleet acceptance is frozen at
`44ed2a2`. This command prepares an actual deployment without repeating fleet tests
or changing authority. It observes prerequisites; it neither authorizes a run nor
performs privileged registration, migration, cutover, setup or recovery.

## Prepare the deployment

1. Build the workspace with `pnpm build`.
2. Provision PostgreSQL and the runtime login using the existing approved migration
   and privilege procedures. Keep migration, trust administration, generation issuance,
   setup and recovery credentials outside the worker.
3. Configure an existing Temporal namespace and the intended task queue. Provision
   the namespace separately; preflight will not create it.
4. Set the normal worker environment below. Use the same environment for preflight
   and startup. Provide credentials through deployment secret injection, not source files.

| Environment variable                                        | Meaning                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FORGE_WORKER_REPOSITORY_PATH`                              | Absolute integration repository Git root with a committed HEAD.                                                                                                                 |
| `FORGE_AUTHORITY_BACKEND`                                   | `postgres` for this read-only preflight.                                                                                                                                        |
| `FORGE_POSTGRES_CONNECTION_STRING`                          | Runtime-login connection string. Never use privileged service credentials.                                                                                                      |
| `FORGE_POSTGRES_SCHEMA`, `FORGE_POSTGRES_ROLE`              | Installed authority schema and matching runtime login.                                                                                                                          |
| `FORGE_AUTHORITY_ID`                                        | Credential-free deployment identity computed by the existing `authorityConfigurationFingerprint` helper; must match the configured backend, endpoint/database, schema and role. |
| `TEMPORAL_SERVER_URL`                                       | Temporal endpoint; defaults to `http://localhost:7233`.                                                                                                                         |
| `TEMPORAL_NAMESPACE`                                        | Existing namespace; defaults to `default`.                                                                                                                                      |
| `TEMPORAL_TASK_QUEUE`                                       | Intended queue; defaults to `forge-run`.                                                                                                                                        |
| `FORGE_WORKER_REVIEW_PROVIDER`, `FORGE_WORKER_REVIEW_MODEL` | Approved provider/model identity resolved by normal worker startup.                                                                                                             |
| `FORGE_WORKER_AUTHORITY_MODE`                               | `legacy` by default; explicit `global` requires PostgreSQL GLOBAL_READY.                                                                                                        |
| `FORGE_PI_IMAGE`, `FORGE_GIT_IMAGE`                         | Global mode only: approved local images pinned by repository digest or immutable `sha256:` image ID.                                                                            |
| `FORGE_MODEL_API_KEY`                                       | Global mode only: host model credential, never passed to isolated containers.                                                                                                   |

Legacy mode requires LEGACY_ALLOWED. Global mode requires the installed global schema,
runtime privilege audit and GLOBAL_READY gate. An identity/schema/mode mismatch must
be repaired by the appropriate deployment operator, not by relaxing the checks.
SQLite normal worker support is unchanged, but this preflight refuses SQLite because
opening its current persistence implementation could create or update schema.

## Run the compiled check

```sh
node apps/temporal-worker/dist/main.js --preflight
```

The command emits a JSON report with `status`, `mode`, `authorityId`, `namespace`,
`taskQueue` and an array of named `passed`/`failed` checks. Exit code **0** means ready
for the checked prerequisites; **1** means not ready. Invalid configuration or invocation
produces a fixed error message. Driver exceptions, connection strings and API keys are
not included. Treat the report as deployment metadata; namespace and queue names remain visible.

| Check                   | Observation                                                                             | Operator action if failed                                                      |
| ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `repository`            | Canonical configured path is a Git root and HEAD resolves to a commit.                  | Correct the path or prepare the repository/initial commit.                     |
| `authority`             | PostgreSQL login/schema privileges and selected mode gate pass existing startup checks. | Independently check runtime identity, migration and cutover state.             |
| `temporal`              | Endpoint connects and the configured namespace can be described within the timeout.     | Check endpoint/namespace access and provision the namespace separately.        |
| `pi-image`, `git-image` | Global-mode digest-pinned images are locally inspectable.                               | Independently build or obtain the approved images; preflight never pulls them. |

All applicable checks are collected even if one fails. Preflight never starts a worker,
polls a queue, creates a run, starts a container or sends a model request. It does not
check model credential validity, run-specific approval/handoff, image behavior or a
queue's existing workflow compatibility. Passing is an observation at that instant,
not a reusable capability or a promise that later admission will succeed.

## Start and observe a real run

After the checks pass, start the same compiled worker without `--preflight`:

```sh
node apps/temporal-worker/dist/main.js
```

Use the existing plan/approve/bind/run CLI flow and operator-controlled scope/setup
procedures. In global mode, the production builder must consume its already committed
approved execution child; a ready deployment does not mint that child. Retain normal
startup and per-mutation checks. Monitor durable run/attempt/claim/permit state through
the existing status tooling. UNKNOWN or HELD_UNCERTAIN and orphan permits remain blocking
until independent/manual recovery; do not release them merely because a process exited
or a preflight report was ready.

## Verification performed for this increment

Tests exercise fixed aggregate/redacted reports, real Git observations, real Temporal
namespace success/failure, the compiled entry point against isolated PostgreSQL and
Temporal, and the accepted global production fixture with both pinned images. Global
preflight leaves persisted record counts unchanged. The image-enabled full check passes
950 tests with no skips and includes compiled CLI/worker build acceptance. Provider
authentication and a paid-model deployment still require the actual deployment's own
credentials and approved run; no such external rollout is claimed here.
