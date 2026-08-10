---
title: Runtime Guard 与 Write Lease 培训指南
tags:
  - coding-orchestrator
  - runtime-guard
  - write-lease
  - concurrency
status: implemented
---

# Runtime Guard 与 Write Lease 培训指南

本文说明 Milestone 8 的 Runtime Guard：在工作真正修改 repository resource 前，负责授予或阻塞
exclusive write lease 的 component。面向没有 lease、lock 或 concurrent agent execution 经验的读者。

任务预测与执行前 conflict analysis 请读 [Task Impact 与 Conflict Analysis](./task-impact-analysis.zh.md)。
调度 decision 请读 [Scheduler Dispatch](./scheduler-dispatch.zh.md)。

## 一句话说明

Runtime Guard 与 Scheduler 回答的是不同问题：

```text
Scheduler:    根据 plan 和已知 conflict，哪个 task 现在可以开始？
Runtime Guard: 此时这个具体 owner 可以持有 exclusive write authority 吗？
```

Scheduler 基于 predicted task impact。预测可能不完整或已经过期。Runtime Guard 是更晚发生的具体
ownership check。

```text
Task Contract -> Predicted Impact -> Conflict Engine -> Scheduler decision
                                                       |
                                                       v
                                            Runtime Guard acquire request
                                                       |
                                              granted 或 blocked lease
```

Milestone 8 在 `libs/runtime-guard/src/lib/in-memory-write-guard.ts` 实现 `InMemoryWriteGuard`。它是
一个 Node.js process 内的 live behavior，不是 persistent distributed lock service。

## 为什么 Scheduler 还不够

Scheduler 根据 declared scope 和已知 repository fact 判断 task 是否足够安全可以并发开始。到了 runtime，
agent 可能 retry、请求更宽 resource，或遇到未预测 scope。

例如：

```text
Task A predicts write Service.search
Task B predicts write Service.get

Scheduler result: guarded parallel 可能可以接受
```

之后 Task A 需要重写完整 `service.ts` file。Symbol prediction 不是重写该 file 的 permission。它必须
请求 file lease：

```text
Task A requests lease(file: service.ts)
Task B holds lease(symbol: Service.get in service.ts)

Result: blocked
```

未来 outer runtime 必须停止或升级处理这次 unexpected write。本 milestone 提供 lease decision，但还不会
intercept filesystem API 或 observe 实际 write。

## Writable resource hierarchy

每个 lease resource 都是 self-contained，包含足以比较两个 lease 的 ancestry，不需要再次加载
`RepositoryGraph`。

```text
Project
└── File
    └── Symbol
        └── Child symbol

Shared resource（独立的 named namespace）
```

类型是：

```text
project:         { projectId }
file:            { projectId, fileId }
symbol:          { projectId, fileId, symbolId, ancestorSymbolIds }
shared-resource: { resourceId }
```

确定性 conflict rule：

| First lease               | Second lease                  | Result   | Why                         |
| ------------------------- | ----------------------------- | -------- | --------------------------- |
| Project                   | 该 project 内任意 file/symbol | conflict | project 包含 descendant     |
| File                      | 该 file 内任意 symbol         | conflict | file 包含 symbol            |
| Parent symbol             | Descendant symbol             | conflict | ancestor 包含 descendant    |
| Same symbol               | Same symbol                   | conflict | 相同 identity               |
| Sibling symbols           | Sibling symbols               | allowed  | 两边都不包含对方            |
| Different project files   | Different project files       | allowed  | 独立 repository scope       |
| Equal shared resource IDs | Equal shared resource IDs     | conflict | 相同 coordination namespace |
| Repository resource       | Shared resource               | allowed  | 不同 namespace              |

`ancestorSymbolIds` 对 lease identity 按 set 处理。保存时会排序，因此 caller 提供的等价 ancestor
collection 即使顺序不同，仍是 idempotent retry，而不会看起来像新的 conflict request。

## Lease lifecycle

```text
acquire
  |
  +--> ACTIVE -- heartbeat --> ACTIVE（version 增加）
  |      |
  |      +-- external evidence --> STALE
  |      |
  |      +-- release -----------> RELEASED
  |
  +--> blocked（不创建 lease）
```

只有 `ACTIVE` lease 会阻塞新 request。`STALE` 和 `RELEASED` 仍作为 lifecycle record 保留在
in-memory guard 中，但不阻止 replacement 获取同一 resource。

### Acquire

Request 说明 owner 和 exact resource：

```json
{
  "runId": "run-42",
  "agentId": "agent-a",
  "taskId": "update-search",
  "resource": {
    "type": "symbol",
    "projectId": "catalog",
    "fileId": "catalog:service.ts",
    "symbolId": "SearchService.query",
    "ancestorSymbolIds": ["SearchService"]
  },
  "mode": "exclusive"
}
```

Guard 验证 non-empty identity field 与合法 symbol ancestry，然后在一个 serialized critical section
中检查所有 active lease。

```text
same active owner 和 exact resource？
        |
        +--> yes: 原样返回已有 lease
        |
        +--> no: 是否有 active lease conflict？
                     |
                     +--> yes: blocked + stable conflicting lease ID
                     |
                     +--> no: 创建 version 1 的 ACTIVE lease
```

Exact-owner retry 要求下面四部分都相同：

```text
runId + agentId + taskId + resource identity
```

改变 resource 不属于 idempotent retry。例如 owner 已有 project lease 后请求该 project 内 file lease，
会收到 `blocked`；较宽 lease 不会被静默转换成较窄 lease。

### 为什么 acquire 必须 serialized

没有 atomic boundary 时，两个 agent 都可能执行：

```text
1. inspect active lease: 没有 conflict
2. create lease
```

如果两个 inspection 都发生在任一写入之前，两个 agent 都会被错误授权。

`InMemoryWriteGuard` 把每个 public operation 串到一个 in-process promise queue：

```text
acquire A ----+
heartbeat B --+--> 一个线性 operation order
release C ----+
mark stale D -+
```

二十个 simultaneous conflicting acquire request 已验证。恰好一个得到 granted lease，其余得到
`blocked`。Guard 也会串行化同一 lease 上的 heartbeat/release 等 mixed operation。

这不是 cross-process atomicity。第二个 Node.js process 会拥有不同的 in-memory map。Milestone 9 必须
提供 persistent atomic storage 后，项目才能声称 multi-process safety。

## Version 与 heartbeat

每个 active lease 从 version 1 开始：

```text
ACTIVE, version 1
        |
heartbeat(expectedVersion = 1)
        |
        v
ACTIVE, version 2
```

Expected version 阻止 obsolete worker 在其他 operation 已改变 lease 后继续更新。

| Condition                                              | Heartbeat result                     |
| ------------------------------------------------------ | ------------------------------------ |
| Active lease 且 version 匹配                           | `active` 与 updated lease            |
| Active lease 但 version 已旧                           | `version-conflict` 与 actual version |
| Missing、released 或 stale lease                       | `not-found`                          |
| Zero、negative、non-integer、`NaN` 或 infinite version | input error                          |

Heartbeat time 由 injectable clock 提供。Production 使用普通 current-time clock；test 使用固定时间。
Clock 不会决定 lease 何时 stale。

## Evidence-based stale recovery

刻意没有如下规则：

```text
60 秒没有 heartbeat -> 自动 STALE
```

Timer 本身不能区分 slow agent 与 crashed agent。Mark lease stale 需要 outer runtime 收集 recovery
evidence，例如：

```text
agent process exited
workspace 没有 unintegrated write
last heartbeat 很旧
recovery policy 允许 reclamation
```

然后发送：

```json
{
  "leaseId": "lease-1",
  "expectedVersion": 2,
  "evidence": "Agent exited and workspace is unchanged"
}
```

Guard 验证 version 与 non-empty evidence，然后：

```text
ACTIVE version 2
        |
        v
STALE version 3
staleDetectedAt 已记录
staleEvidence 已记录
```

Stale lease 不再阻塞 replacement acquisition。对同一 lease 重复 mark stale 返回 `not-found`，因此 recovery
retry 不会改变历史 stale record。

## Release 与 cleanup

Release 使用与 heartbeat/stale marking 相同的 version fence：

```text
ACTIVE lease + matching version -> released with incremented version
ACTIVE lease + stale version -> version-conflict
RELEASED/STALE/missing lease -> not-found
```

第一次成功 release 增加 version、记录 `releasedAt` 并改为 `RELEASED`。使用成功返回 version 的 retry
会得到 `not-found`，因此 caller 已观察到完成后 cleanup 仍保持 idempotent。Version fencing 能阻止基于
旧 lifecycle view 的 delayed release 错误释放已经推进的 lease。

## Defensive input validation

Guard 拒绝 malformed request，而不是创建 ambiguous lease identity：

```text
empty run、agent、task、project、file、symbol、shared-resource 或 ancestor ID
ancestor list 包含 symbol 自己
invalid expected version
```

Lease ID 与 time source 都可注入。这保持 test deterministic，也允许未来 outer adapter 选择 production
ID generation，而不把 provider/persistence concern 放进 domain model。

## 与 Scheduler event 的关系

Guard 不 import Scheduler，也不 mutate task state。未来 outer runtime 负责连接两者：

```text
guard acquire blocked
        |
        v
emit Scheduler lease-blocked event
        |
        v
task RUNNING -> BLOCKED

guard release 或 stale recovery
        |
        v
emit Scheduler lease-released 或 lease-stale event
        |
        v
matching blocked task 重新参与 Scheduler selection
```

Scheduler 的 release event 按 blocker identity 广播。多个 task 等待同一个 released lease 时，都可能
重新进入 `READY` 并按 normal scheduling constraint 竞争。Guard 不选择 winner；下一次 serialized
acquire operation 才决定具体 ownership。

## Milestone 8 没有实现什么

它没有：

- persist lease、heartbeat、stale evidence 或 release record；
- 在 process、host 或 orchestration run restart 后协调 lease；
- 让一个 Guard instance 服务 resource ID 可能冲突的不同 repository/workspace namespace；
- observe real filesystem write 或 intercept agent write call；
- 通过 `RepositoryGraph` 解析 filesystem path 或 symbol name；
- 根据 timeout 推断 stale evidence；
- 自动 emit Scheduler event；
- create worktree、rebase、merge 或 invoke Git；
- run agent 或 verification command；
- 集成 `forge plan` 与 live runtime。

Exact in-memory lifecycle behavior 是真实且经过测试的。Storage、observation 和 integration boundary
被刻意延期，而不是被静默宣称已实现。

## 验证与当前限制

Runtime Guard package 有 23 个测试通过，statements/functions/lines 均为 100%，branches 为 96.15%。
Repository quality gate 有 154 个测试通过，全仓覆盖率为语句 97.07%、分支 92.04%、函数 99.64%、行
97.00%。`pnpm check`、`pnpm build` 和 `git diff --check` 通过。

下一个主要 architecture concern 是 Milestone 9 persistence。在保存 Scheduler event 以供 replay 前，
项目必须确定每个 event 是“snapshot 已包含 resulting state 的 state observation”，还是“Scheduler
自行应用的 runtime evidence”。In-memory guard 有意不替代这个 persistent replay contract。在 agent runtime
执行真实 write 前，后续 milestone 还必须把 lease version 作为真正 fencing token 带到 write authorization
boundary；当前 version 只 fence guard lifecycle operation。
