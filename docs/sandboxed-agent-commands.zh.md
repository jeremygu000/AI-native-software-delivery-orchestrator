# 沙箱化 Agent Command

## 目的

Stage 14 把之前的 command-selection policy 变成经过测试的可移植 validation sandbox。Pi agent 仍然只选择固定
command ID。Runtime 现在通过 explicit sandbox port 运行 command，不再使用 unrestricted local subprocess executor。

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

默认 `docker-read-only` adapter 使用 Docker Engine 或 Docker Desktop，带有 `--network none`、read-only workspace
mount、read-only container root 和 tmpfs `/tmp`。它旨在让 macOS、Linux 和 Windows 具有相同语义。尝试创建 workspace
file 的 command 不能修改 host workspace。macOS `sandbox-exec` adapter 保留为 native validation adapter。

请求的 sandbox profile unsupported 或所需的 Docker/native adapter 不能启动时，runtime fail closed。它不会 fallback 到
unrestricted local command execution。

Stage 14 已通过 independent review，并在 validation-only scope 内关闭。

Automated test 使用 fake Docker executable 持续验证 `--network none`、read-only mount 和 container-root invocation
contract。一次性手动 Docker Engine validation 使用 `node:24-alpine` 尝试 workspace write，得到 `EROFS`，并确认没有
host file 创建；这项 manual check 不属于 automated test suite。

Timeout、cancellation 和 output limit 保持 direct-child `SIGTERM` 后 `SIGKILL` escalation。Output 有上限，command
result 仍作为 structured Pi tool evidence 返回。

## 限制

这是 validation sandbox，不是完整 process isolation。Docker availability 和 daemon policy 仍是 deployment requirement；它
尚不以 managed process group 终止 descendant、不设置 CPU/memory limit、不 pin image digest、不隐藏全部 Docker host/daemon
capability，也不把 cancellation 接入 live Pi session。Command 只声明 `validation`；未来 workspace-write command 需要
matching lease、writable sandbox scope 和 workspace/Git diff impact reconciliation。
