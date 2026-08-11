# Orchestration Runtime

## 目的

`libs/orchestration-runtime` 是协调已有 deterministic port 的 application layer。它保持 CLI thin，避免
Scheduler、Workspace/Git、Write Guard 和 persistence adapter 直接互相调用。

第一版有意限定为 local/serial。只接受 `maxConcurrency: 1`，使用 provider-neutral `AgentRunner` 和
`TaskVerifier` port。`FakeAgentRunner`/`FakeTaskVerifier` 证明 state machine，不启动 model、shell command 或
real coding agent。

## Runtime flow

```text
create persisted run
        |
        v
run-started Scheduler event
        |
        v
Scheduler start decision
        |
        v
create + persist workspace revision 1
        |
        v
acquire + persist write lease
        |
        +-- blocked --> persist lease-blocked event and Scheduler blocker
        |
        v
run fake agent
        |
        v
release + persist lease
        |
        v
agent-completed -> VERIFYING
        |
        v
verify
        |
        +-- failed --> task-failed -> Scheduler cancellation propagation
        |
        v
verification-completed -> INTEGRATING
        |
        v
integrate + persist workspace revision
        |
        +-- blocked --> retain INTEGRATING and INTEGRATION_BLOCKED evidence
        |
        v
workspace-integrated -> COMPLETED
```

每个 event，runtime 都会把 Scheduler input snapshot、event、decision 以及全部 non-deferred decision
transition 在一次 persistence operation 写入。之后 runtime 把 decision 应用到 memory snapshot。Agent
completion、verification completion、integration completion 和 task failure 是 observation；它们要求的
post-state 会在 Scheduler event persistence 前反映进 snapshot。这遵守 Scheduler replay contract，而不让
Scheduler 执行 side effect。

## Failure 与 recovery

Runtime 在尝试 lease release 前 persistence agent outcome：success 记录带 `VERIFYING` 的 `agent-completed`，
agent failure 记录带 `FAILED` 的 `task-failed`。如果随后 release 失败，它 persistence
`lease-release-failed`、把 run 标记为 `FAILED`，并在 verification/integration 前停止。因此 recovery 保留真实
agent outcome 和仍 active 的 lease，不会静默丢失 evidence。Lease acquisition block 会作为 runtime blocker
persistence。Agent/verification failure 发出 `task-failed`，让 Scheduler deterministic 地 cancel dependent task。

第一版 serial runtime 没有为外部 run 所拥有的 lease-blocked task 提供 retry entry point。它返回时该 task 是
`BLOCKED` 且有 persisted lease blocker。未来 runtime event loop 必须观察 owner release 并调用明确 retry policy；
不能推断 unsafe retry。

`recoverRun` 从 persisted Scheduler event/decision 重建最新 runtime snapshot，包括 lease blocker projection，
并返回 current workspace/lease record。它有意不 restart unknown in-flight agent、不 repair Git conflict、不
reclaim stale lease，也不 create integration checkout。这些需要未来 durable agent identity、ownership fencing
和 checkout provisioning policy。

## 尚未实现

- real agent SDK、prompt、streaming 或 cancellation；
- subprocess command verification；
- observed filesystem impact 与 scope enforcement；
- concurrent dispatch 或 `maxConcurrency > 1`；
- cross-process lease 和 ownership-generation write fencing；
- automatic rebase conflict repair 或 blocked integration resume；
- CLI `forge run` input 和 integration-checkout provisioning。

未来应在 runtime 添加这些 workflow，不能加入 `apps/cli` 或隐藏在既有 infrastructure adapter 中。

## 验证

Runtime test 覆盖 successful dependency execution、fake-agent failure、verification failure、lease blocking、
lease-release failure、blocked integration、eventless recovery、persisted SQLite replay 和 invalid task binding。
SQLite integration test 使用 real persistence adapter、in-memory guard 和 provider-neutral workspace port。
