---
title: Scheduler Dispatch 培训指南
tags:
  - coding-orchestrator
  - scheduler
  - dispatch
  - architecture
status: implemented
---

# Scheduler Dispatch 培训指南

本文说明 Milestone 7 的 Scheduler 怎样把已经确定的 task dependency、predicted conflict、runtime
state 和一个 runtime event 转换成“下一步允许启动哪些任务”的确定性 decision。面向没有 Scheduler、
并发系统或前置里程碑经验的读者。

Scheduler 的 conflict 输入来自 Task Impact 与 Conflict Engine。建议先读
[Task Impact 与 Conflict Analysis](./task-impact-analysis.zh.md)，再读提供底层事实的
[RepositoryGraph 分析器](./repository-graph-analysis.zh.md)。

## 一句话说明

Scheduler 只回答一个范围明确的问题：

> 在当前 state 和这一个新 event 下，哪些 task 现在可以启动，哪些必须等待，为什么？

它不会启动 coding agent，不会写文件、申请 lease、创建 worktree、运行 Git、调用 LLM 或写入数据库。
它只返回确定性 decision，未来由外层 runtime 应用。

```text
Task Contracts + Functional DAG
            +
Hard Conflicts + Risk Conflicts
            +
Serializable Runtime Snapshot
            +
One Scheduler Event
            |
            v
Structured Task Decisions
```

实现是 `libs/scheduler/src/lib/deterministic-scheduler.ts` 中的 `DeterministicScheduler`。

## 为什么需要这一层

前面的层分别回答不同的问题：

```text
RepositoryGraph    哪些 project、file、symbol 和 dependency 存在？
Task Impact        一个 task 可能读、写或协调什么？
Conflict Engine    哪些 task pair 有风险或结构性不兼容？
Scheduler          此时此刻哪个 task 可以启动？
Runtime Guard      这一次具体 write 现在是否被允许？          [future]
```

Scheduler 不会重新计算 repository fact 或 conflict score。它分别接收已经产生的
`HardTaskConflict[]` 与 `RiskTaskConflict[]`。这种分离很重要：numeric risk score 可以解释风险，
但绝不能削弱 structural safety constraint。

## 输入

### Task contracts 与 functional DAG

每个 task 有稳定 ID、可选 priority 和 functional dependency：

```text
A = generate schema
B = update API, depends on A
C = update UI, depends on A
```

```text
A -----> B
 \
  +-----> C
```

Scheduler 在作出任何 decision 前会验证 duplicate task ID、duplicate dependency、missing dependency、
self-dependency 和 cycle。格式损坏的 functional graph 会直接失败，绝不会成为 partial schedule。

### Conflict 输入

Conflict Engine 会产生两类刻意不同的 collection：

```text
HardTaskConflict   必须执行的 structural rule
RiskTaskConflict   policy 可以解释的 scored recommendation
```

Hard constraint 包括 same-symbol write、exclusive resource、ordered resource、competing
producer-controlled write 和 directional producer-consumer access。即使解释用 `score` 是零，它们仍然
生效。

Risk conflict 可以推荐四种 action：

| Recommendation     | Milestone 7 Scheduler policy    |
| ------------------ | ------------------------------- |
| `parallel`         | 可以与另一 task 并发            |
| `guarded-parallel` | 可以并发，并保留 audit evidence |
| `stagger`          | 不可以与另一 task 重叠运行      |
| `serialize`        | 不可以与另一 task 重叠运行      |

`guarded-parallel` 目前不会真的取得 runtime guard，因为 Runtime Guard 属于 Milestone 8。它仍会被
记录，以便未来 runtime 不改变历史 decision 的语义就能增加实际保护。

### Snapshot

Scheduler 不保存隐藏的 mutable progress。调用方提供可序列化 snapshot：

```json
{
  "taskStates": [
    { "taskId": "generate", "state": "COMPLETED" },
    { "taskId": "api", "state": "RUNNING" },
    { "taskId": "ui", "state": "READY" }
  ],
  "runtimeBlocks": []
}
```

Snapshot 要包含全部 task state。`BLOCKED` task 还必须记录一个或多个具体 blocker：

```json
{
  "taskId": "api",
  "blockers": [
    { "type": "lease", "leaseId": "lease-42" },
    { "type": "runtime-conflict", "conflictId": "conflict-9" }
  ]
}
```

这些都是普通 structured data，而不是内存专属的 JavaScript `Map` 或 `Set`。未来 persistence service
可以保存它们，recovery process 可以用相同 snapshot 重算相同 decision。

### Event

每次 reevaluate 只接收一个 structured event。当前 event 含义包括：

```text
task-completed
task-failed
verification-completed
workspace-integrated
lease-blocked
lease-released
lease-stale
runtime-conflict-discovered
runtime-conflict-resolved
```

创建或解除 runtime blocking 的 event 携带 replay 所需的精确 identity：

```json
{ "type": "lease-blocked", "taskId": "api", "leaseId": "lease-42" }
{ "type": "runtime-conflict-resolved", "taskId": "api", "conflictId": "conflict-9" }
```

Scheduler 会验证 unknown event task ID、duplicate snapshot task state、duplicate runtime-block
record、unknown snapshot task，以及附在非 `BLOCKED` task 上的 runtime block。

## 选择算法

算法有意采用 greedy，不尝试求最优解或估算 duration。固定顺序是：

```text
validate task graph、conflict、snapshot 和正整数 maxConcurrency
        |
        v
apply runtime blocking 或 blocker-release event evidence
        |
        v
propagate FAILED 和 CANCELLED prerequisite outcome
        |
        v
从 functional 与 producer completion 得到 eligible candidate
        |
        v
按 priority 降序，再按稳定 task ID 排序
        |
        v
对每个 candidate：
  enforce capacity
  enforce running/selected work 上的全部 hard constraint
  apply risk recommendation policy
  以 structured reason 选择或 defer task
```

Task ID 使用直接 string comparison，不使用 host locale collation。因此不同语言环境的机器会得到相同
tie-break result。

### Functional readiness

Task 只有在每个 declared dependency 都是 `COMPLETED` 后才能启动：

```text
A = COMPLETED
B = RUNNING
C depends on A and B

Result: C 以 dependency-incomplete(B) defer
```

只有 `COMPLETED` 满足 dependency。`RUNNING`、`PENDING`、`READY`、`BLOCKED`、`VERIFYING` 和
`INTEGRATING` 都还不完整。

### Producer readiness 与 functional DAG 分开

Producer-controlled shared resource 可以产生 directional hard constraint：

```text
producer writes generated output
consumer reads generated output

producer ------ 必须先完成 ------> consumer
```

Scheduler 把它作为额外 readiness requirement，但不修改 `TaskContract.dependencies`，因为两种含义不同：

```text
functional dependency     产品/task-plan fact
producer constraint       conflict/resource-policy fact
```

方向来自 writer/read access，不来自 task ID 字母顺序。例如：

```text
Z-producer -> A-consumer
```

即使 `A-consumer` 排序更早，也必须先完成 `Z-producer`。

合并后的 functional 与 producer ordering graph 会验证 cycle。仅由 producer constraint 形成的
`A -> B`、`B -> A` cycle 也会在 scheduling 前失败，否则两边都会永久等待。

### Priority 与 capacity

Candidate 按较高 numeric priority、再按 task ID 排序：

```text
task      priority
API       10
Docs      10
Tests      5

selection order: API, Docs, Tests
```

已经 `RUNNING` 的 task 也占用 `maxConcurrency`：

```text
maxConcurrency = 2
running = [A]
ready = [B, C]

Result: B 可以 start，C 以 max-concurrency-reached defer
```

Capacity 与 priority 是 selection fact，不是 runtime failure。它们产生 `defer` decision，不会伪造
task-state transition。

## Hard constraint 与 risk policy

### Hard 永远是 hard

```text
A 和 B write 同一个 symbol
HardTaskConflict.score = 0

A 是 RUNNING
B 是 READY

Result: B 以 hard-conflict defer
```

Score 只是 explanation metadata。Scheduler 永远不会读取它来决定是否执行 constraint。

Hard constraint 同时与下面两类 task 比较：

```text
已经 RUNNING 的 task
        +
本次 decision 中更早 selected 的 task
```

这样一个 batch 不会因为开始时两者都没有 RUNNING 就错误选中两个互相冲突的 task。

### Risk action 例子

```text
A 和 B: guarded-parallel
Result: 两者可 start；B 记录 risk-policy-allowed

A 和 B: stagger
Result: 第一个 candidate 可以 start；第二个记录 risk-policy-deferred
```

第一个 candidate 由 priority 和 task-ID order 决定。Scheduler 不会为无方向 risk conflict 虚构 ordering
edge。

## Runtime blocking 与 release

Static scheduling defer 不等于 blocked。Task 只有在真实 runtime evidence 出现后才是 `BLOCKED`：

```text
RUNNING
  |
  +-- lease-blocked 或 runtime-conflict-discovered --> BLOCKED
```

调用方把 blocker 与 task 一起保存。Release 只移除完全匹配的 blocker：

```text
api blockers = [lease-42, conflict-9]

lease-42 released
        |
        v
api 仍是 BLOCKED，因为 conflict-9 仍存在

conflict-9 resolved
        |
        v
api moves BLOCKED -> READY
```

这能阻止无关 release event 提前唤醒仍不安全的任务。

## Terminal prerequisite propagation

Scheduler 防止 prerequisite 已到 terminal state 后，dependant task 静默永久等待。

### Failure

```text
A FAILED
|
+--> B depends on A
       |
       +--> C depends on B

Result:
B -> CANCELLED, dependency-failed(A)
C -> CANCELLED, dependency-failed(A)
```

Reason 标识 terminal root cause，不会包含 snapshot 内其他无关 failure。两个独立 root 同时失败时，每个
dependant 只记录与它相连的 root。

### Existing cancellation

外部取消的 prerequisite 有不同语义：

```text
A CANCELLED
|
+--> B depends on A

Result:
B -> CANCELLED, dependency-cancelled(A)
```

Scheduler 不会把它报成 `dependency-failed`，因为调用方可能因为与 execution failure 无关的原因取消
任务。该传播规则同时适用于 functional dependant 和 directional producer consumer。

## Decision 与 reason

每个结果是 per-task decision，而不是松散 ID list 加 free-form string。

可能的 action：

| Action    | Meaning                                          |
| --------- | ------------------------------------------------ |
| `ready`   | 请求合法的 `PENDING -> READY` transition         |
| `start`   | 请求合法的 `READY -> RUNNING` transition         |
| `block`   | 请求合法的 `RUNNING -> BLOCKED` transition       |
| `unblock` | 请求合法的 `BLOCKED -> READY` transition         |
| `cancel`  | 请求合法的 nonterminal `-> CANCELLED` transition |
| `defer`   | 解释当前不请求 state transition 的原因           |

常见 structured reason：

```text
dependencies-completed
dependency-incomplete
dependency-failed
dependency-cancelled
producer-must-complete
hard-conflict
risk-policy-allowed
risk-policy-deferred
max-concurrency-reached
runtime-blocked
runtime-blocker-released
task-state-not-runnable
selected-by-priority
```

Scheduler 返回 decision。外层 runtime 只有在验证和记录后才应用 state change。这样 pure scheduling
calculation 不会假装自己已经执行了工作。

## Wave 只是解释，不是 barrier

`createInitialPlan` 生成静态 wave-shaped preview：

```text
wave 0 = [A, B]
wave 1 = [C]
```

它采用相同 priority、conflict 和 capacity policy，但不拥有 runtime progress。考虑：

```text
C 只 depends on A
A 和 B 都在 wave 0
A complete 时 B 仍 RUNNING
C 与 B 不 conflict
capacity 仍在
```

正确 runtime result 是：

```text
C 可以立刻 start
```

仅因为 B 与 A 在 earlier preview wave 中就等待 B，会浪费有用并行度，也违反 Scheduler architecture。

## Defensive validation

输入不一致时 Scheduler 会 reject，而不是猜测：

```text
invalid functional task graph
non-positive 或 non-integer concurrency
conflict 引用 unknown task 或同一个 task 两次
producer-consumer endpoint 不属于其 conflict pair
unknown producer 或 consumer task
functional 与 producer ordering 的 combined cycle
duplicate task state 或 runtime-block record
runtime block 附在 non-BLOCKED task 上
snapshot 缺少 task 或包含 unknown task
event 指向 unknown task
runtime block event 指向非 RUNNING task
```

这样 malformed persisted data、adapter bug 或手工构造的 test object 不会静默地产生误导性的 dispatch
decision。

## Worked example

假设有这些 task：

```text
generate       writes generated API output, priority 10
api            reads generated API output, priority 8
ui             depends on generate, priority 5
documentation  independent, priority 1
```

Conflict Engine 增加 producer constraint：

```text
generate -> api
```

`maxConcurrency = 2` 时初始 preview：

```text
wave 0: [generate, documentation]
wave 1: [api, ui]
```

当 `generate` complete、`documentation` 仍 running：

```text
snapshot:
generate      COMPLETED
documentation RUNNING
api           READY
ui            PENDING

result:
api 可以 start，因为 producer 已 complete
ui 只有在 priority selection 后 capacity 仍在时才可以 start
```

两个 task 都不会仅因为 `documentation` 在 wave 0 就等待它结束。

如果 `generate` failure：

```text
api -> CANCELLED, dependency-failed(generate)
ui  -> CANCELLED, dependency-failed(generate)
```

## Milestone 7 没有实现什么

它没有：

- observe 真实 process、filesystem、lease 或 conflict event；
- execute agent 或 command；
- acquire、heartbeat、release 或 enforce Write Lease；
- authorize 实际 write；
- 比较 predicted impact 与 observed change；
- 保存或 recovery snapshot、event 或 decision；
- 创建 isolated Git worktree；
- rebase、merge 或 integrate change；
- 提供可用的 `forge plan` CLI workflow。

这些是刻意留给后续边界的功能。Scheduler decision 已经可以供未来 Runtime Guard、Persistence 和
Workspace/Git runtime 消费，但不能声称这些系统现在已存在。

## 验证与当前限制

Scheduler 测试覆盖 stable selection、包含 running work 的 capacity、functional/directional readiness、
zero-score hard enforcement、exclusive/ordered resource、risk policy、两种字典序的 producer order、
failure/cancellation propagation、exact blocker release、malformed input rejection、deterministic repeat
call 和 no-wave-barrier counterexample。

最终 repository quality gate 有 125 个测试通过。全仓覆盖率为语句 96.95%、分支 91.92%、函数
99.60%、行 96.88%。Scheduler 单包覆盖率为语句 98.06%、分支 95.00%、函数 100%、行 98.00%。
`pnpm check`、`pnpm build` 和 `git diff --check` 均通过。

已知限制仍然刻意保持很窄：

- Scheduler 从提供的 snapshot 重算，不维护 live queue；
- 不估计 duration、跨 run fairness 或 optimal throughput；
- 调用方负责应用和持久化返回的 transition decision；
- `guarded-parallel` 的 Runtime Guard behavior 尚未实现；
- 当前性能验证针对 deterministic core behavior，不是超大 scheduling graph 或长期 runtime recovery。
