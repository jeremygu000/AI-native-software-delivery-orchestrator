# Pi Agent Adapter

## 目的

Milestone 12 把 Pi 作为一个 `AgentRunner` backend 接入编排器。Pi 是 coding-agent engine，不是 control
plane。Scheduler、durable attempt、lease plan、workspace、persistence、verification、Git integration、retry
和 recovery 仍由 orchestrator 负责。

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

`PiAgentRunner` 通过 private gateway 启动 Pi session。Pi 返回 session ID 后，gateway 调用
`onStarted({ sessionRef })`。这会在 Pi prompt 前把 durable attempt 从 `STARTING` 推进到 `RUNNING`。Pi 的
concrete session object/message 留在 adapter 内；持久化的 ref 只有：

```text
backend: "pi"
value: <Pi session ID>
```

Runner 会拒绝在这个 durable callback 完成前收到的 tool call。这个防御性检查避免未来 gateway
implementation 乱序修改 workspace。
这个 callback 之后，unexpected Pi gateway 或 tool failure 会重新 throw，使 orchestration runtime 记录
`UNKNOWN` 并保留 ACTIVE lease。post-start connection loss 不能当作 safe agent failure，因为 Pi 仍可能修改 workspace。

## Tool policy

Pi 使用 `noTools: "all"` 启动。唯一 custom tool 是：

```text
forge_read
forge_list
forge_find
forge_edit
forge_write
```

没有 unrestricted `bash`、Pi built-in `edit` 或 Pi built-in `write`。Pi 也不能创建 worktree、switch branch、
merge、reset、修改 persistence 或直接调用 Scheduler。

`forge_edit`/`forge_write` 使用 `AgentToolRuntime`。它验证 path 在 task workspace 内，把 path resolve 成
`WritableResource`，acquire/persist lease，然后修改文件。冲突 lease 返回 structured blocked evidence，文件不会
修改。Tool acquire 的 lease 和 observed file write 通过 `PiAgentRunner` 回到 orchestration runtime；runtime 在
agent outcome durable 后 release lease，并 persistence observed impact。

已经覆盖 requested resource 的 ACTIVE task lease 可以直接授权 write：例如 project lease 覆盖 child file。因此
runtime 不会 acquire 一个会冲突的 duplicate child lease。每次 successful write 都会立即 persistence cumulative
observed impact。Path 同时经过 lexical 和 real filesystem path 检查，所以 symlink 不能逃出 task workspace。
`PiAgentRunner.bindRuntimeAuthority` 会在每个 tool factory 创建 `AgentToolRuntime` 后提供 runtime 的 impact 和
initial lease，所以 factory 不会意外遗漏 broader lease authority。

这个 realpath check 不能消除 time-of-check/time-of-use race：concurrent malicious actor 可能在 check 后、
subsequent I/O 前替换 filesystem component。使用 descriptor-relative sandboxed I/O 是后续 hardening stage。

如果后续 tool write 被阻塞，之前已经成功的 write 不会 rollback。它们的 observed impact 和 acquired
lease 保持为 durable evidence，task 会在 verification 或 Git integration 前变成 `BLOCKED`。后续 scheduling
或 recovery policy 必须决定 resume 还是 discard 这个 isolated workspace；adapter 不会静默删除有证据的 write。

## 验证

Pi adapter test 使用 deterministic Pi session gateway，不调用 authenticated/paid model。它证明 custom
`forge_edit` 通过 tool runtime 修改 scoped workspace，并产生 provider-neutral session/observed-impact evidence。
Vertical runtime test 组合 mock Pi gateway、real SQLite persistence、InMemoryWriteGuard、real Git worktree、
verifier 和 fast-forward integration。冲突 Pi write 保持文件不变，并产生 persisted runtime blocker。

Production Pi SDK gateway 通过 injected session factory 测试，断言 `noTools: "all"` 和 custom-tool allowlist。
Deterministic unit test 会执行每个已注册 custom-tool definition，并验证 provider-neutral call 和 error-result
mapping。乱序 gateway test 还证明 durable session establishment 前的 tool call 会返回 error，不会修改文件或
acquire lease。测试不启动 real authenticated model。

完整 solution-style repository-analysis regression test 使用 scoped 30-second timeout。它会打开本仓库完整的
TypeScript workspace，在 load 下可能合理地超过 Vitest 默认的 five-second timeout；更大的 timeout 不影响普通
test case。

初始 mock-gateway 和 controlled-tool scope 已通过 independent review。当前针对 `UNKNOWN` outcome、lease authority、
symlink confinement 和 immediate observed impact persistence 的 follow-up safety hardening 正在等待 independent review。

## 当前限制

- CI 不调用 authenticated production Pi model；
- 没有 shell/command tool；
- 没有 sandbox、timeout、cancellation、network、environment-variable 或 secrets policy；
- 没有 external lease blocker 的 automatic retry；
- 没有 observed-scope replanning 或 concurrent agent dispatch。
- 没有 descriptor-relative filesystem operation 来消除 realpath TOCTOU race。
