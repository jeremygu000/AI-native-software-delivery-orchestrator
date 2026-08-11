# ADR-019: Validation command sandbox

## Status

Accepted

## Decision

Validation commands use a provider-neutral `AgentCommandSandbox` port. The default portable profile is
`docker-read-only`, implemented by `DockerReadOnlyCommandSandbox`. Docker Engine or Docker Desktop gives
macOS, Linux, and Windows the same read-only workspace mount, `--network none`, read-only container root,
and tmpfs `/tmp` execution semantics. Command policy selects the profile; the agent cannot choose it.

`MacosReadOnlyCommandSandbox`, backed by `/usr/bin/sandbox-exec`, remains an additional native adapter for
macOS validation. A missing requested adapter or unsupported profile fails closed. There is no fallback to
the unrestricted local subprocess executor.

The native adapter explicitly rejects non-Darwin hosts. Docker invocation flags are continuously tested
through a fake Docker executable; a one-time real Docker Engine `node:24-alpine` validation observed `EROFS`
for a workspace write and no host mutation. The latter is manual validation, not CI coverage.

Only commands declared `validation` may use this profile. The declaration is still a policy assertion:
repository scripts can have side effects outside the sandbox's denied workspace scope. A future
`workspace-write` effect requires matching leases, a writable sandbox scope, process-tree control, and
workspace/Git diff observed-impact reconciliation.

## Consequences

The runtime passed independent review with a tested portable Docker read-only, network-denied command
boundary and a macOS native adapter for validation commands. It is not complete process isolation: it does
not manage descendants as a process group, apply CPU or memory limits, guarantee all Docker host/daemon
policies, isolate all readable host paths in the native adapter, or wire runtime cancellation through Pi
sessions. Those are the next sandbox-runtime capabilities.
