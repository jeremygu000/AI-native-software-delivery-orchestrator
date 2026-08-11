# Orchestration Runtime

## 目的

`libs/orchestration-runtime` 是协调已有 deterministic port 的 application layer。它保持 CLI thin，避免
Scheduler、Workspace/Git、Write Guard 和 persistence adapter 直接互相调用。

第一版有意限定为 local/serial。只接受 `maxConcurrency: 1`，使用 provider-neutral `AgentRunner` 和
`TaskVerifier` port。`FakeAgentRunner`/`FakeTaskVerifier` 证明 state machine，不启动 model、shell command 或
real coding agent。

## Durable attempt

`TaskState.RUNNING` 表示 Scheduler 已授权 dispatch，不证明 external agent 正在运行。Runtime 在同一 SQLite
transaction 内 persistence 每个 Scheduler start decision 与独立、revisioned 的 `AgentExecutionAttempt`：

```text
PREPARING -> STARTING -> RUNNING -> COMPLETED | FAILED
                         |
restart -----------------> UNKNOWN
```

`PREPARING` 是 workspace/lease preparation 必须 reconcile 的 durable evidence。`STARTING` 表示已发出 runner
invocation。Runner 在 attempt 变为 `RUNNING` 前通过 `onStarted` 提供 optional provider-neutral session evidence。
Restart 时 unresolved `STARTING`/`RUNNING` attempt 变为 `UNKNOWN`；local fake backend 不猜测 external process
是否存在。Attempt 使用 revision CAS，拒绝 stale evidence 和 same-revision conflicting evidence。

Recovery 可以安全地 re-enqueue `PREPARING` attempt，因为 external agent invocation 尚未发生。recovery binding
必须匹配 persisted attempt 的 agent ID、workspace ID 和 canonical lease-plan fingerprint，防止 caller 用不同
agent、workspace 或 ownership plan resume durable attempt。如果 runner 在 `onStarted` 前 throw，attempt/task
变为 `FAILED`；在 `onStarted` 后 throw，attempt 变为 `UNKNOWN`。`UNKNOWN` path 保留 ACTIVE lease，因为 external
actor 可能仍在 mutation workspace。两种情况 run 都标记为 `FAILED`，且不会进入 verification/integration。
completed result 没有 `onStarted` 是 durable protocol failure：它变为 `FAILED`、release lease 并停止。

## Lease plan

每个 binding 使用 `TaskLeasePlan`，不是单一 resource。Resource 按 canonical order acquire：project、file、
symbol、shared resource；每种类型内使用 stable identity order。某次 acquire blocked 时，会按 reverse order release
此前 lease，并 persistence 这些 release 后发出 `lease-blocked`。

从 predicted impact 得到的 plan 使用 project/file/shared-resource write，并把 symbol write 保守转换为 file lease。
Predicted symbol impact 没有安全 precise symbol lease 所需的 complete ancestor path。未来 runtime-derived plan 只有在
repository knowledge 提供完整 containment evidence 时才能使用 symbol lease。

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

Execution write lease 保护 active agent mutation。它在 agent outcome evidence 后、verification 前 release。它不是
integration reservation：Git rebase/fast-forward 仍是当前 integration ordering boundary。未来 concurrent runtime 如果
需要在 Git conflict handling 之外保护 ordering，必须添加 explicit integration reservation。

`recoverRun` 从 persisted Scheduler event/decision 重建最新 runtime snapshot，包括 lease blocker projection，
并返回 current workspace/lease record。它有意不 restart unknown in-flight agent、不 repair Git conflict、不
reclaim stale lease，也不 create integration checkout。这些需要未来 durable agent identity、ownership fencing
和 checkout provisioning policy。

## 尚未实现

- real agent SDK、prompt、streaming 或 cancellation；
- subprocess command verification；
- observed filesystem impact 与 scope enforcement；
- concurrent dispatch 或 `maxConcurrency > 1`；
- Pi adapter、unrestricted agent tool 或 filesystem mutation tool；
- cross-process lease 和 ownership-generation write fencing；
- automatic rebase conflict repair 或 blocked integration resume；
- CLI `forge run` input 和 integration-checkout provisioning。

Attempt schema 已验证代表性的 valid/invalid state combination，但尚未穷举所有 optional-field combination。未来
Pi backend 必须增加 backend-specific attempt/session invariant test，不能弱化 provider-neutral boundary。

未来应在 runtime 添加这些 workflow，不能加入 `apps/cli` 或隐藏在既有 infrastructure adapter 中。

## 下一步 backend

Pi 尚未集成。未来 `PiAgentRunner` 必须实现现有 provider-neutral `AgentRunner` port，通过 `onStarted` 提供
durable session evidence，并保持在 runtime 的 attempt、lease、workspace、persistence、verification 和 Git
lifecycle policy 之后。Pi 不能获得 unrestricted `bash`、`edit` 或 `write` tool。未来所有 mutation 必须经过
orchestrator-controlled `AgentToolRuntime`，由它负责 workspace scope、resource resolution、lease enforcement
和 durable observed-impact evidence。

## 验证

Runtime test 覆盖 successful dependency execution、fake-agent failure、verification failure、lease blocking、
lease-release failure、blocked integration、eventless recovery、persisted SQLite replay、unknown-attempt recovery、
multi-resource rollback 和 invalid task binding。Vertical integration test 使用 real SQLite persistence、
InMemoryWriteGuard、GitWorkspaceManager、temporary Git repository 和 deterministic writing agent，证明 committed
workspace edit 到达 integration branch。
