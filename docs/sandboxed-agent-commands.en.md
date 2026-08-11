# Sandboxed Agent Commands

## Purpose

Stage 14 turns the previous command-selection policy into a tested portable validation sandbox. A Pi agent
still selects only a fixed command ID. The runtime now runs that command through an explicit sandbox port
instead of an unrestricted local subprocess executor.

```text
Pi: forge_command(commandId)
        |
        v
AgentCommandPolicy (validation effect)
        |
        v
AgentCommandSandbox
        |
        v
DockerReadOnlyCommandSandbox
        |
        v
Docker: network denied, workspace read-only
```

## Enforcement

The default `docker-read-only` adapter invokes Docker Engine or Docker Desktop with `--network none`, a
read-only workspace mount, a read-only container root, and tmpfs `/tmp`. It is intended to have the same
semantics on macOS, Linux, and Windows. A command that attempts to create a workspace file cannot modify
the host workspace. The macOS `sandbox-exec` adapter remains available as a native validation adapter.

The runtime fails closed when the requested profile is unsupported or the required Docker/native adapter
cannot start. It does not fall back to unrestricted local command execution.

Stage 14 passed independent review and is closed for its validation-only scope.

Automated tests use a fake Docker executable to continuously verify the `--network none`, read-only mount,
and container-root invocation contract. A one-time manual Docker Engine validation using `node:24-alpine`
attempted a workspace write, received `EROFS`, and confirmed no host file was created; that manual check is
not part of the automated test suite.

Timeout, cancellation, and output limits retain direct-child `SIGTERM` then `SIGKILL` escalation. Output
is bounded and command results remain structured Pi tool evidence.

## Limits

This is a validation sandbox, not complete process isolation. Docker availability and daemon policy remain
deployment requirements; it does not yet terminate descendants as a managed process group, set CPU/memory
limits, pin image digests, hide all Docker host/daemon capabilities, or wire cancellation through a live Pi
session. Commands are only declared `validation`; future workspace-write commands need matching leases,
writable sandbox scope, and workspace/Git diff impact reconciliation.
