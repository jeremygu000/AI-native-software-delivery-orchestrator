# Sandboxed Agent Commands

## Purpose

Stage 14 turns command execution into explicit execution profiles. A Pi agent still selects only a fixed
command ID. The default `trusted-local` profile runs it in the developer's task worktree without requiring
Docker; the optional `docker-read-only` profile runs it through a hardened container boundary.

```text
Pi: forge_command(commandId)
        |
        v
AgentCommandPolicy (validation effect + execution profile)
        |
        v
AgentCommandSandbox
        |
        v
trusted-local OR docker-read-only
```

## Enforcement

`trusted-local` is the default developer profile. It preserves fixed command ID policy, fixed args, trusted
PATH, timeout, output limits, task worktree cwd, and durable execution identity, but inherits developer host
permissions. It is appropriate for developers running agents against repositories they trust.

`docker-read-only` is the optional hardened profile. It invokes Docker Engine or Docker Desktop with
`--network none`, a read-only workspace mount, a read-only container root, and tmpfs `/tmp`. It is intended
to have the same semantics on macOS, Linux, and Windows. A command that attempts to create a workspace file
cannot modify the host workspace. The macOS `sandbox-exec` adapter remains available as a native
developer-only validation adapter.

The runtime fails closed when the requested profile is unsupported or the required Docker/native adapter
cannot start. It does not fall back to unrestricted local command execution.

The validation sandbox and execution-profile revision passed independent review. `trusted-local` is the
default developer mode; Docker hardened mode is optional; the macOS native adapter is developer-only.

Automated tests use a fake Docker executable to continuously verify the `--network none`, read-only mount,
and container-root invocation contract. A one-time manual Docker Engine validation using `node:24-alpine`
attempted a workspace write, received `EROFS`, and confirmed no host file was created; that manual check is
not part of the automated test suite.

Timeout, cancellation, and output limits retain direct-child `SIGTERM` then `SIGKILL` escalation. Output
is bounded and command results remain structured Pi tool evidence.

## Limits

`trusted-local` is not a sandbox. `docker-read-only` is a validation sandbox, not complete process
isolation. Docker availability and daemon policy remain deployment requirements; it does not yet terminate
descendants as a managed process group, set CPU/memory limits, pin image digests, hide all Docker
host/daemon capabilities, or wire cancellation through a live Pi session. Commands are only declared
`validation`; future workspace-write commands need matching leases, writable sandbox scope, and workspace/
Git diff impact reconciliation.
