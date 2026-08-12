# Pi Agent Adapter

## Purpose

Milestone 12 connects Pi to the orchestrator as one `AgentRunner` backend. Pi is a coding-agent
engine, not the control plane. Scheduler, durable attempts, lease plans, workspaces, persistence,
verification, Git integration, retry, and recovery remain owned by the orchestrator.

```text
OrchestrationRuntime
        |
        v
    AgentRunner
        |
        v
   PiAgentRunner
        |
        v
 private Pi session gateway
        |
        v
 controlled forge_* tools
        |
        v
 AgentToolRuntime -> WriteGuard -> persistence -> workspace filesystem
```

## Session establishment

`PiAgentRunner` starts a Pi session through a private gateway. Once Pi returns a session ID, the
gateway calls `onStarted({ sessionRef })`. This advances the durable attempt from `STARTING` to
`RUNNING` before Pi is prompted. Pi's concrete session object and messages remain inside the adapter;
the persisted ref is only:

```text
backend: "pi"
value: <Pi session ID>
```

The runner rejects a tool call received before this durable callback completes. This defensive check
keeps a future gateway implementation from mutating the workspace out of order.
After this callback, an unexpected Pi gateway or tool failure is rethrown so the orchestration runtime
records `UNKNOWN` and retains ACTIVE leases. A post-start connection loss is not treated as a safe
agent failure because Pi may still mutate the workspace.

## Tool policy

Pi starts with `noTools: "builtin"`. This disables Pi's built-in tools while preserving explicitly
registered custom tools. The same controlled names are supplied as Pi's explicit `tools` allowlist,
which filters unrelated extension/custom definitions from the session registry. The controlled tools
are:

```text
forge_read
forge_list
forge_find
forge_edit
forge_write
```

There is no unrestricted `bash`, Pi built-in `edit`, or Pi built-in `write`. Pi also cannot create
worktrees, switch branches, merge, reset, alter persistence, or call Scheduler directly.

`forge_edit` and `forge_write` use `AgentToolRuntime`. It verifies that a path remains inside the task
workspace, resolves it to a `WritableResource`, acquires and persists a lease, then changes the file.
A conflicting lease returns structured blocked evidence and does not modify the file. Tool-acquired
leases and observed file writes return through `PiAgentRunner` to the orchestration runtime, which
releases the leases and persists observed impact after the agent outcome is durable.

An ACTIVE task lease that already covers the requested resource authorizes the write directly: for
example, a project lease covers a child file. The runtime therefore does not acquire a conflicting
duplicate child lease. Each successful write immediately persists cumulative observed impact. Paths are
checked lexically and by real filesystem path, so a symlink cannot escape the task workspace.
`PiAgentRunner.bindRuntimeAuthority` supplies the runtime's impact and initial leases after every tool
factory creates its `AgentToolRuntime`, so a factory cannot accidentally omit broader lease authority.

This realpath check does not eliminate a time-of-check/time-of-use race: a concurrent malicious actor
could replace a checked filesystem component before the subsequent I/O. Descriptor-relative sandboxed
I/O is a later hardening stage.

If a later tool write is blocked, already successful writes are not rolled back. Their observed impact
and acquired leases remain durable evidence, while the task becomes `BLOCKED` before verification or
Git integration. A later scheduling or recovery policy must decide whether to resume or discard that
isolated workspace; the adapter never silently removes an evidence-backed write.

## Verification

The Pi adapter tests use a deterministic Pi session gateway, not an authenticated or paid model. They
prove a custom `forge_edit` modifies a scoped workspace through the tool runtime and emits provider-
neutral session/observed-impact evidence. A vertical runtime test combines the mock Pi gateway, real
SQLite persistence, InMemoryWriteGuard, real Git worktrees, verifier, and fast-forward integration.
A conflicting Pi write leaves the file unchanged and produces a persisted runtime blocker.

The production Pi SDK gateway is tested through an injected session factory that asserts `noTools: "builtin"`
and the custom-tool allowlist. Deterministic unit tests execute every registered custom-tool definition
and verify its provider-neutral call and error-result mapping. An out-of-order gateway test also proves
that a pre-establishment tool call returns an error without changing a file or acquiring a lease. No
test starts a real authenticated model. A separate integration test does invoke the real Pi SDK session
constructor with in-memory settings/session storage and verifies that every controlled coding tool and
planning fact tool is present while built-in `bash` is absent.

The complete solution-style repository-analysis regression test has a scoped 30-second timeout. It
opens this repository's full TypeScript workspace and can legitimately exceed Vitest's default
five-second timeout under load; the larger timeout does not affect ordinary test cases.

The mock-gateway and controlled-tool scope, including the `UNKNOWN`, lease-authority, symlink, and
immediate observed-impact safety follow-up, passed independent review. Milestone 12 is closed.

## Current limits

- no authenticated production Pi model invocation in CI;
- no shell or command tool;
- no sandbox, timeout, cancellation, network, environment-variable, or secrets policy;
- no automatic retry for externally owned lease blockers;
- no observed-scope replanning or concurrent agent dispatch.
- no descriptor-relative filesystem operations to eliminate realpath TOCTOU races.
- `forge_edit` reads before acquiring authority, which is safe only while `maxConcurrency` remains one;
  it must acquire before read before concurrent agent execution is enabled.
- filesystem writes and SQLite impact persistence are not one atomic transaction; recovery must later
  reconcile observed impact from workspace or Git changes.
