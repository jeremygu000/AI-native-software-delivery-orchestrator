# 受控 Agent Command

## 目的

Milestone 13 为 coding agent 增加第一个 command capability，但不提供 unrestricted shell access。Pi 可以用
command ID 请求 `forge_command`，但 orchestrator 决定该 ID 的含义及是否允许使用。

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

`AgentCommandPolicy` 包含有名称的 command definition。每个 definition 固定 executable 与 argument。Policy 还提供
完整 command environment。Agent 不能提供 command text、argument、executable path、working directory 或 environment
variable。

例如 orchestrator 可以允许：

```text
ID: check-types
executable: pnpm
arguments: typecheck
```

Agent 可以请求 `check-types`，但不能把它改为 `pnpm typecheck --dangerous-option` 或 `bash -c ...`。

## Execution behavior

Command 在 task workspace 内以 `shell: false` 运行。Runner 提供 orchestrator-owned `PATH` 和 explicit policy
environment；policy 不能 override `PATH` 或加入 malformed environment name/value。Standard output/error 有上限。
Timeout 或 cancellation 会向 direct child 发送 `SIGTERM`，并在 bounded grace period 后升级为 `SIGKILL`。Nonzero exit、
timeout、cancellation、output-limit 和 startup failure 都作为 Pi tool error 返回，不会静默成功。

没有 command policy 时，session 不启用 `forge_command`。每个 session 都保持 Pi built-in `bash` disabled。

## 限制

这是 policy control，不是完整 sandbox。它尚未 isolate network access、secrets、normal OS permission 以外的 filesystem
access、process descendant 或 process-tree termination、CPU/memory 或 descriptor-relative path。它也没有增加 authenticated production Pi model、
real task-spec CLI input、concurrent dispatch 或 recovery reconciliation。
