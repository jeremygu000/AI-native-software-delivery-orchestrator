---
title: Workspace 与 Git Lifecycle 培训指南
tags:
  - coding-orchestrator
  - workspace
  - git
  - integration
status: implemented
---

# Workspace 与 Git Lifecycle 培训指南

本文说明 Milestone 10：task 怎样获得 isolated local Git worktree，怎样安全 rebase，通过
fast-forward-only merge integrate，怎样保留可恢复的 integration block，以及怎样不静默删除 dirty work。

Scheduler 语义请读 [Scheduler Dispatch](./scheduler-dispatch.zh.md)。持久化 integration evidence 请读
[Persistence 与 Replay](./persistence-replay.zh.md)。

## 一句话说明

Workspace/Git 层回答：

> 一个 task 怎样在 isolation 中修改 repository，并在不混入 incomplete work 或丢失 Git conflict 的
> 情况下加入 integration branch？

```text
base ref
   |
   v
isolated task worktree + task branch
   |
   v
task commit completed work
   |
   v
rebase onto integration ref
   |
   v
fast-forward-only merge
   |
   +--> INTEGRATED
   |
   +--> INTEGRATION_BLOCKED + Git evidence
```

实现是 `libs/workspace-git/src/lib/git-workspace-manager.ts` 中的 `GitWorkspaceManager`。

## 为什么需要 worktree

多个 task 不应该同时编辑一个 checkout。Git worktree 给每个 task 独立 directory/branch，同时共享一个
underlying Git repository object store。

```text
integration repository
  main
    |
    +-- task worktree A, branch orchestrator/run-1/A
    |
    +-- task worktree B, branch orchestrator/run-1/B
```

每个 task 可以独立 commit。Worktree path 有意放在 integration checkout 外，因此 Git 不会把 sibling
worktree directory 误当成 integration repository 的 untracked file。
创建要求 target path 尚不存在，且 task branch name 是新的。任一已存在时，manager 都会以 stable
`GitWorkspaceError` 停止；不会把新 workspace 接到先前 task 的 branch。

## Workspace identity

Persisted `TaskWorkspace` 记录：

```text
workspace ID
run ID
task ID
integration repository path
worktree path
task branch name
base ref
integration ref
positive revision
integration phase
optional integration commit/block evidence
```

Workspace 使用独立于 `TaskState` 的 lifecycle：

```text
READY_TO_INTEGRATE
        |
        +-- rebase conflict
        +-- dirty integration repository
        +-- fast-forward failure
        |
        v
INTEGRATION_BLOCKED
        |
        +-- resumeIntegration
        +-- abortIntegration
        |
        v
READY_TO_INTEGRATE 或 INTEGRATED
```

这是有意设计。Task 到达 `INTEGRATING` 时，normal execution/verification 已完成。Git conflict 不能通过
下面这种有信息损失的方式抹掉这个事实：

```text
INTEGRATING -> BLOCKED -> READY
```

`INTEGRATION_BLOCKED` 保存当前是在修复 Git integration，而不是重新执行 task。

每次返回 state-changing result 都递增 revision。SQLite persistence 只接受更高 revision，或同一 revision
且完全相同的 retry；stale revision 和同 revision 的不同 evidence 都会拒绝。因此延迟到达的
`READY_TO_INTEGRATE` record 不能覆盖已经 persistence 的 `INTEGRATED`/blocked workspace。

## Create

Workspace creation 先验证两个 ref：

```text
git rev-parse --verify <base ref>
git rev-parse --verify <integration ref>
git worktree add -b <task branch> <workspace path> <base ref>
```

Git 在一个 operation 内创建 branch 并 materialize checkout。不存在单独的 `--no-checkout` phase，因此 process
interruption 后 retry 不会把未 checkout 的 directory 误认为 ready workspace。

Process interruption 后 create 可以 retry。如果 target path 已是 requested branch 上的 valid Git worktree，且
其 `HEAD` 与 integration repository 中该 branch 匹配，create 返回等价的 revision-1 workspace。不是该 exact
worktree 的已存在路径仍是 collision，会被拒绝。

此 reuse path 只用于首次 successful persistence 前的 interruption，不能恢复之后的 workspace revision；recovery
必须从 persistence 加载该 record。对已有更高 revision 的 workspace retry `create` 会产生 revision 1，随后由
persistence revision CAS 拒绝，不能覆盖较新的 integration evidence。

## Integration model

Integration 有两个刻意步骤：

```text
task branch
   |
   v
git rebase <integration ref>
   |
   v
integration checkout switch 到 <integration ref>
   |
   v
git merge --ff-only <task branch>
```

Rebase 在 merge 前纳入最新 integration history。`--ff-only` 阻止 manager 发明 implicit merge commit。
Integration ref 不能直接前进到 task branch 时，manager 返回 structured block，不会自行选择 merge strategy。

Switch/merge 前 integration repository 必须 clean。Dirty repository 返回：

```text
phase: INTEGRATION_BLOCKED
blocker.type: repository-dirty
blocker.conflictPaths: changed path
```

这保护 integration checkout 内无关的 manual work。

该 checkout 不能是用户的 working directory。`integrationRepositoryPath` 必须是 orchestrator-owned integration checkout，
例如 `.forge/integration/<repository-id>`，因为 integration 会 switch 到 integration ref。未来 application layer
负责 provision 并 exclusive-own 这个 directory；没有 portable 的方式检测 editor/shell 是否正在使用 checkout。

## Rebase conflict handling

当 task branch/integration ref 修改 incompatible line：

```text
task branch:         value.txt = task value
integration ref:     value.txt = integration value
        |
        v
git rebase conflict
```

Manager 返回：

```text
phase: INTEGRATION_BLOCKED
blocker.type: rebase-conflict
blocker.conflictPaths: ["value.txt"]
```

Outer runtime/human 在 task worktree repair file 并 stage。然后：

```text
resumeIntegration
  -> git -c core.editor=true rebase --continue
  -> rebase 成功后 fast-forward integration
```

放弃 repair：

```text
abortIntegration
  -> git rebase --abort
  -> READY_TO_INTEGRATE
```

Dirty integration repository/fast-forward failure 没有 active rebase 可 continue/abort。外部原因修复后，
`resumeIntegration` 只会 retry normal integration。

## Persistence 与 recovery

`TaskWorkspace` 按下面 key persistence：

```text
run ID + workspace ID
```

因此 SQLite recovery 可以在 restart 后保留 structured `INTEGRATION_BLOCKED` record：

```text
recovered workspace
  phase: INTEGRATION_BLOCKED
  blocker: rebase-conflict
  paths: ["value.txt"]
```

未来 outer runtime 可以选择 `resumeIntegration`/`abortIntegration`，不会把当前 phase 与 normal task dispatch
混淆。

## Disposal

移除 workspace 永远是 explicit：

```text
git status --porcelain=v1
        |
        +-- clean --> git worktree remove + git branch -D
        |
        +-- dirty --> return dirty path
```

默认安全：

```text
dispose({ workspace, force: false })
  -> { status: "dirty", paths: [...] }
```

删除 dirty work 必须：

```text
dispose({ workspace, force: true, reason: "..." })
```

Adapter 会在 forced removal 前验证 reason non-empty。Reason 属于 caller audit layer；当前 local Git
adapter 不自己 persistence audit event。

Disposal 支持 retry。如果前一次 removal 已删除 worktree directory，manager 跳过 dirty check/worktree removal，
并只在 task branch 仍存在时删除它。这样可完成 partial disposal，不会把 missing worktree 当成 error。

所有 Git command 使用 asynchronous child-process execution。Dirty/conflict path query 请求 NUL-delimited Git
output，保留包含 space、quote 或 line break 的 path。

## Milestone 10 没有实现什么

它没有：

- execute agent/task command；
- observe filesystem write 或与 predicted impact 比较；
- 实际 write 时 acquire/release Runtime Guard lease；
- 自动 repair conflict；
- 协调 multiple repository/process/host；
- 支持 merge commit、squash merge 或 cherry-pick strategy；
- persistence Git command output，除 structured workspace blocker evidence 外；
- 把 lease lifecycle version 变成真实 write fencing token；
- 提供 end-to-end `forge plan`/`forge run` command。

Manager 是 local Git lifecycle adapter。未来 agent/runtime layer 必须把它与 Scheduler decision、Runtime Guard
ownership、verification、persisted transition 和 actual write observation 协调起来。

## 验证与当前限制

Workspace-git package 有 26 个测试通过，statements 99.02%、branches 94.44%、functions 100%、lines 99%。
Test 使用 real temporary Git repository 验证 main lifecycle，使用 injectable command runner 验证 deterministic
command-failure path。Repository quality gate 有 248 个测试通过，全仓覆盖率为语句 96.76%、分支 91.86%、
函数 99.13%、行 96.73%。`pnpm check`、`pnpm build` 和 `git diff --check` 通过。

实现只在 local single-repository worktree 范围验证。声称适合 many concurrent worktree、network filesystem、
remote repository 或 multi-process workspace ownership 前，必须重新测量和扩展。
