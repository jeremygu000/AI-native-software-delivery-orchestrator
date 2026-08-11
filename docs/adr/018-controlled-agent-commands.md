# ADR-018: Controlled agent commands

## Status

Accepted

## Decision

Add a provider-neutral command policy to `domain` and an orchestrator-controlled `forge_command` tool
to `agent-runtime`. Pi never receives arbitrary shell text, executable paths, or user-selected arguments.
It can request only a command ID present in the runtime-supplied `AgentCommandPolicy`.

Each policy entry is declared `validation` and supplies a fixed executable, fixed argument vector, timeout, and output limit. The
executor runs with `shell: false`, the task workspace as its working directory, an explicit policy
environment plus a constructor-injected trusted `PATH`, and no inherited ambient environment. Policy cannot
override `PATH` or provide malformed environment names or values. Command output is bounded. Timeout and
cancellation terminate the direct child with `SIGTERM`, then escalate to `SIGKILL` after a bounded grace
period; startup failure is returned as sanitized command evidence rather than exposing a host process error.

`forge_command` is not an operating-system sandbox. It does not create a container, restrict network
access, control descendants after the direct child exits, filter file descriptors, or enforce secrets
isolation. The runtime leaves command capability disabled unless a task binding explicitly supplies a
policy. Pi built-in `bash` remains disabled.

The canonical command-policy fingerprint is persisted with the execution attempt. PREPARING recovery
rejects a binding whose policy differs from the durable attempt, preventing a resumed execution from
gaining different command authority.

`validation` is a policy assertion, not proof that the executable has no filesystem side effects. A
future `workspace-write` command effect must acquire matching write authority, execute in a sandboxed
scope, and reconcile workspace or Git changes before it can be admitted.

## Consequences

The command boundary passed independent review: the agent selects one known command ID, while the
orchestrator owns process details. This stage enables safe local validation commands with fixed policy,
but a future sandbox adapter must provide process-tree termination, network controls, filesystem
isolation, resource limits, and descriptor-safe workspace confinement before arbitrary command execution
or concurrent production agents are enabled.
