# ADR-017: Pi agent adapter and controlled tools

## Status

Accepted

## Decision

Add `libs/agent-runtime` for provider implementations of the existing domain `AgentRunner` port. Its
first backend is `PiAgentRunner`, which delegates agent-loop/session work to
`@mariozechner/pi-coding-agent` through a private Pi session gateway. Pi session, message, tool, and
provider types never enter `domain` or `orchestration-runtime`.

`PiAgentRunner` calls the runtime-provided `onStarted` callback only after the Pi gateway establishes
a durable provider-neutral session reference. The orchestrator continues to own attempts, dispatch,
leases, workspace lifecycle, persistence, verification, integration, recovery, and model routing.
The runner rejects a tool call received before that callback completes, preventing a future gateway
implementation from mutating a workspace before durable attempt establishment.

Pi receives a minimal custom tool surface:

```text
forge_read
forge_list
forge_find
forge_edit
forge_write
```

`forge_edit` and `forge_write` call a scoped `AgentToolRuntime`. Every instance includes run, task,
attempt, agent, and workspace identity. Mutation first resolves a workspace-relative path to a
`WritableResource`, then acquires a WriteGuard lease, persists that lease, writes the file, and
persists observed-impact evidence. Tool blocking returns structured `AgentToolBlocked` evidence rather
than allowing the agent to retry an unsafe mutation blindly.
When a later tool call is blocked, earlier successful writes remain in the isolated workspace and are
reported as observed impact with their acquired leases. The runtime marks the task `BLOCKED` before
verification or Git integration; a later scheduling/recovery policy decides whether to resume or
discard that workspace rather than silently rolling back evidence-backed writes.

Pi built-in mutation and shell tools are not enabled. In particular, there is no unrestricted `bash`,
`edit`, or `write` capability. Git worktree/branch/merge/reset lifecycle remains owned by
`workspace-git`, and final validation remains owned by `TaskVerifier`.

## Consequences

The first Pi adapter is independently reviewed with deterministic gateways, without calling a paid
model. Tests prove Pi tool requests traverse the orchestration safety boundary, including rejection of
a tool call that arrives before durable session establishment. The repository self-analysis regression
test has a scoped 30-second timeout because it opens the complete solution-style workspace and can
legitimately exceed Vitest's default five-second limit under load. This does not add arbitrary command
execution, sandboxing, network/secrets policies, observed-scope replanning, concurrent agents, or
automatic UNKNOWN attempt reconciliation. Those remain later stages.
