---
title: Persistence 与 Replay 培训指南
tags:
  - coding-orchestrator
  - persistence
  - replay
  - sqlite
status: implemented
---

# Persistence 与 Replay 培训指南

本文说明 Milestone 9 怎样保存足够的 deterministic orchestration evidence，让本地 run 在 process restart
后能恢复，并证明保存的 Scheduler decision 可以被 replay。面向没有 event log、SQLite 或 recovery system
经验的读者。

Scheduler 语义请读 [Scheduler Dispatch](./scheduler-dispatch.zh.md)。具体 write authority 请读
[Runtime Guard 与 Write Lease](./runtime-guard.zh.md)。

## 一句话说明

Persistence 回答：

> Process 停止后，系统还能重建当时知道什么、发生了什么 event、做了什么 decision，并验证这个
> decision 是否仍能从保存的 input 推导出来吗？

实现保存经过验证、可重建的 domain evidence：

```text
run input + task contract + conflict + schedule option
        +
event + Scheduler input snapshot + transition + decision
        +
current impact + conflict + lease
        |
        v
SQLite
        |
        v
validated recovery + decision replay
```

`libs/persistence` 提供 `DrizzleSqliteOrchestrationPersistence`。它使用 SQLite、Drizzle 和
`better-sqlite3`，但所有 database/driver type 都保留在 adapter 内。

## 建表前先确定 replay contract

只有 event 含义明确，保存才有价值。

### Observation event

这些 event 报告 outer runtime 已经应用到 Scheduler input snapshot 的 transition：

| Event                    | input snapshot 中要求的 state |
| ------------------------ | ----------------------------- |
| `task-completed`         | `COMPLETED`                   |
| `task-failed`            | `FAILED`                      |
| `verification-completed` | `INTEGRATING`                 |
| `workspace-integrated`   | `COMPLETED`                   |

```text
outer runtime 应用 task A -> COMPLETED
        |
        v
input snapshot 记录 A = COMPLETED
        |
        v
persist task-completed(A, COMPLETED) + input snapshot
        |
        v
Scheduler reevaluate
```

Observation event 与 input snapshot 不一致时，Scheduler 会拒绝。Persistence 因此不能永久保存 claimed
outcome 与 saved state 矛盾的 event。

### Runtime evidence event

Runtime blocker event 不同，它们是 Scheduler 自己应用到 input snapshot 的 evidence：

```text
lease-blocked(A, lease-1)
        |
        v
Scheduler 验证 A = RUNNING
        |
        v
Scheduler 请求 RUNNING -> BLOCKED，并记录 lease-1
```

Release/resolved-conflict evidence 删除 matching blocker，可能让全部 matching waiter 变为 `READY`。
这个区分记录在 [ADR-013](./adr/013-scheduler-event-replay.md)。

## Atomic reevaluation evidence

一次 reevaluation 在一个 SQLite transaction 中保存四类相关 record：

```text
event + input snapshot + requested transition + decision
        |
        v
一个 run 内正 sequence number
        |
        v
全部 commit 或全部 rollback
```

后面的 transition insert 失败时，transaction 会 rollback 前面的 event/decision insert。Recovery 不会看到
half-written reevaluation。

Run sequence 连续：

```text
saved:        1, 2, 3
next allowed: 4
```

Adapter 用 explicit promise mutex 串行 reevaluation write。即使未来 driver/check 变成 async，sequence
allocation 仍安全。

## SQLite 保存模型

一条 run 保存 replay 所需 immutable input：

```text
run identity/state
task contract
hard conflict
risk conflict
schedule option
```

Append-only scheduling evidence：

```text
scheduler_events
task_transitions
scheduler_decisions
```

Current record 按 stable run-local key upsert：

```text
task_impacts:   run ID + task ID
task_conflicts: run ID + task A + task B
write_leases:   run ID + lease ID
```

同一个 task/lease ID 在另一个 run 中独立，因为每个 key 都包含 run ID。

## 保留 domain data 的 JSON

Domain record 使用 `Set`。普通 JSON 会把 Set 静默变成 `{}`。Adapter 使用明确 round-trip 表示：

```text
Set(["core", "consumer"])
        |
        v
{ "$set": ["core", "consumer"] }
        |
        v
Set(["core", "consumer"])
```

Lease lifecycle date 恢复为 `Date`。每条 decoded record 随后必须通过 domain-owned Zod schema：

```text
TaskContract
TaskConflict discriminated union
TaskImpact required Set field
WritableResource discriminated union
WriteLease lifecycle field
ScheduleOptions
SchedulerEvent
SchedulerSnapshot
SchedulerDecision
```

Malformed JSON、invalid run state、没有 constraint 的 hard conflict、truncated impact 或 invalid lease 都会
被拒绝为 `PersistenceInputError`。

## Recovery 与 replay

Recovery 按 stable sequence order 读取 run input/evidence：

```text
SQLite file
   |
   v
validate every record
   |
   v
每个 event：
  Scheduler.reevaluate(saved event, saved input snapshot, saved input)
   |
   v
比较 recomputed decision 与 saved decision
```

Plain Scheduler decision object 使用 canonical comparison：object key 会排序，array order 保持有意义。
Scheduler 已输出 deterministic ordered decision/reason array。缺 decision 或 mismatch 会抛出
`PersistenceReplayError`，不会继续使用 ambiguous history。

Canonical comparison 在检查 object field 前把 lease `Date` 转成 ISO timestamp。因此 same-version lease retry
即使只改变 `lastHeartbeatAt` 也会被拒绝，不会误判成 identical retry。该 comparator 有意只处理这里使用的
evidence shape；`Set` 使用前述 explicit persistence encoding，而不是作为 arbitrary JavaScript object 比较。

空 run 没有 event，replay 返回 `[]`。

## Restart example

```text
process 1:
  create SQLite file
  create run
  persist sequence 1
  close database

process 2:
  reopen file
  validate evidence
  replay sequence 1
  verify decision
```

这是 local restart recovery，不是 distributed consensus 或 multi-process write fencing。

## Milestone 9 没有实现什么

它没有：

- 在 process/host 之间协调 write；
- 提供 deployed database migration tooling；
- execute agent、command 或 verification；
- observe filesystem write；
- create/integrate Git worktree；
- 把 lease lifecycle version 当成真正 write fencing token；
- 提供 `forge plan` persistence workflow。

未来 agent runtime 需要把独立 ownership-generation fencing token 传到 actual write authorization
boundary。当前 lease version 只 fence lifecycle operation。

## 验证与限制

Persistence package 有 15 个测试通过，statements 97.63%、branches 94.36%、functions 98.33%、lines
97.82%。Repository quality gate 有 219 个测试通过，全仓覆盖率为语句 97.36%、分支 92.46%、函数
99.47%、行 97.30%。`pnpm check`、`pnpm build` 和 `git diff --check` 通过。

当前 O(n) next-sequence lookup 对 local run 可接受，且由 adapter mutex 串行化。未来 high-volume
workload 只有在测量证明需要后，才以 run counter 或 `MAX(sequence)` query 替换。
