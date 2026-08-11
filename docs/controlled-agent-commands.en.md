# Controlled Agent Commands

## Purpose

Milestone 13 adds the first command capability for a coding agent without giving it unrestricted shell
access. Pi can ask for `forge_command` with a command ID, but the orchestrator decides what that ID
means and whether it is available.

```text
Pi: forge_command(commandId)
        |
        v
AgentCommandPolicy
        |
        v
fixed executable + fixed arguments + timeout + output limit
        |
        v
NodeAgentCommandExecutor (shell: false, task workspace cwd)
```

## Policy

An `AgentCommandPolicy` contains named command definitions. Each definition fixes the executable and its
arguments. Each currently supported command is declared `validation`. The policy also supplies the
complete command environment. The agent cannot provide command text, arguments, an executable path, a
working directory, or environment variables.

For example, an orchestrator may allow this command:

```text
ID: check-types
executable: pnpm
arguments: typecheck
```

The agent may request `check-types`, but cannot turn it into `pnpm typecheck --dangerous-option` or
`bash -c ...`.

## Execution behavior

Commands run in the task workspace with `shell: false`. The runner supplies an orchestrator-owned `PATH`
from a constructor-injected trusted path and the explicit policy environment. Policy cannot override
`PATH` or add malformed environment names or values. Standard output and error are capped. A timeout or
cancellation sends `SIGTERM` to the direct child and escalates to `SIGKILL` after a bounded grace period.
Nonzero exit, timeout, cancellation, output-limit, and startup failure all return a Pi tool error instead
of silently succeeding.

No command policy means `forge_command` is not active for the session. Pi built-in `bash` remains disabled
in every session.

`validation` is an orchestrator policy assertion, not proof that a repository command has no side effects.
Commands declared to write a workspace need a future sandbox, matching write leases, and diff-based observed
impact reconciliation before they may be admitted.

The canonical policy fingerprint is persisted with each execution attempt. A PREPARING attempt cannot
resume after recovery if the caller supplies different command authority.

## Limits

This is policy control, not a complete sandbox. It does not yet isolate network access, secrets,
filesystem access outside normal OS permissions, process descendants or process-tree termination,
CPU/memory, or descriptor-relative paths. It does not add an authenticated production Pi model, real
task-spec CLI input, concurrent dispatch, or recovery reconciliation.
