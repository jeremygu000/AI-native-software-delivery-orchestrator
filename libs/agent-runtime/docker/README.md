# Isolated Pi SDK image

This image runs the actual pinned Pi SDK through `runIsolatedPiSession`. It has no
model credential or repository checkout. The host supplies inference and Forge
tool results over the already-validated stdio broker.

From the repository root, build with a digest-pinned Node 24 base:

```sh
node libs/agent-runtime/docker/build-image.mjs \
  node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 \
  forge-isolated-pi:acceptance
docker image inspect forge-isolated-pi:acceptance --format '{{.Id}}'
```

Use the returned immutable `sha256:...` image ID locally, or publish the image and
use its registry `name@sha256:...` digest. Tags are not accepted by the gateway.
The deployment must approve the image; repository/task input cannot choose it.
The build uses the separate checked-in npm lock solely to install image runtime
dependencies inside Linux, avoiding host-specific workspace symlinks and native
artifacts. Workspace dependencies continue to use pnpm. Installation scripts are
disabled. Updating the pinned SDK requires updating this image lock as well as
the workspace dependencies and repeating these acceptance tests.

```sh
FORGE_TEST_PI_SDK_IMAGE=sha256:<image-id> pnpm exec vitest run \
  libs/agent-runtime/src/lib/docker-pi-sdk.integration.spec.ts \
  apps/temporal-worker/src/postgres-workspace-recovery.integration.spec.ts \
  --config vitest.config.ts -t 'actual containerized Pi SDK|takeover'
```

Configure `DockerPiSessionGateway` with `/usr/local/bin/node` and arguments
`['/opt/forge/entrypoint.mjs']`, plus an approved host model proxy. The gateway
enforces non-root execution, read-only root, no network, no mounts and resource
limits regardless of the image defaults. Tests exercise real SDK inference via a
controlled host HTTP provider, cancellation, and real PostgreSQL-fenced writes.
They do not require a paid model provider or constitute production cutover.

The legacy production worker still refuses `GLOBAL_READY`. Durable recovery of an
interrupted model/container session, dynamic global resource expansion and full
worker composition remain separate work. No recovery or database credentials may
be placed in this image.
