# ADR-019: Validation command sandbox

## Status

Accepted

## Decision

Validation commands use a provider-neutral `AgentCommandSandbox` port. The default developer profile is
`trusted-local`: commands run in the task Git worktree through the fixed command policy and inherit the
developer's host permissions. Docker is not a core runtime dependency in this mode. Command policy selects
the profile; the agent cannot choose it.

The optional hardened `docker-read-only` profile is implemented by `DockerReadOnlyCommandSandbox`. Docker
Engine or Docker Desktop gives macOS, Linux, and Windows the same read-only workspace mount, `--network
none`, read-only container root, and tmpfs `/tmp` execution semantics.

`MacosReadOnlyCommandSandbox`, backed by `/usr/bin/sandbox-exec`, remains an additional native adapter for
macOS validation. A missing requested adapter or unsupported profile fails closed. There is no fallback to
the unrestricted local subprocess executor.

The native adapter explicitly rejects non-Darwin hosts. Docker invocation flags are continuously tested
through a fake Docker executable; a one-time real Docker Engine `node:24-alpine` validation observed `EROFS`
for a workspace write and no host mutation. The latter is manual validation, not CI coverage.

Only commands declared `validation` may use these profiles. Under `trusted-local`, that declaration is a
developer trust assertion and does not restrict repository command side effects. Under `docker-read-only`,
the workspace and network restrictions enforce the validation scope. A future
`workspace-write` effect requires matching leases, a writable sandbox scope, process-tree control, and
workspace/Git diff observed-impact reconciliation.

## Consequences

The sandbox boundary and execution-profile revision passed independent review. `trusted-local` is the
default developer mode, Docker read-only isolation is optional, and the macOS native adapter is developer-
only. Neither profile is complete process isolation: Docker does not manage descendants as a process group,
apply CPU or memory limits, guarantee all Docker host/daemon policies, or wire runtime cancellation through
Pi sessions; the native adapter does not isolate all readable host paths. Those are the next sandbox-runtime
capabilities.
