# 受控 Runtime Binding 与启动

## 1. Stage 20 增加了什么

Stage 20 把“已批准并重新验证的 plan”变成真实 local run。这是 `forge run` 第一次可以创建 worktree、dispatch coding
agent、执行 verification、commit 并集成结果的阶段。

最重要的规则是：第一次执行副作用之前，必须再次检查 approval authority。

```text
PlanArtifact
    |
PlanApproval + single-run claim
    |
PlanExecutionIntent
    |
    +-- 重新加载 artifact 与 approval
    +-- analysis 前重新抓取 Git snapshot
    +-- 重建 RepositoryGraph
    +-- analysis 后再次抓取 Git snapshot
    +-- 比较 repository、facts 与 policy fingerprint
    |
    v
位于 approved baseCommit 的 orchestrator-owned integration checkout
    |
    +-- task worktree A -- Pi tools -- verify -- commit --+
    +-- task worktree B -- Pi tools -- verify -- commit --+--> 串行 integration branch
    |
durable SQLite run evidence
```

只 parse 一个有效 intent 不够。第二次 binder 调用关闭了 `forge bind` 到 `forge run` 之间的 TOCTOU 时间窗口。

## 2. 实现分别放在哪里

```text
apps/cli
   -> run-preparation
         -> planning（revalidation evidence）
         -> workspace-git（integration checkout 与 task worktree）
         -> orchestration-runtime
                -> scheduler
                -> runtime-guard
                -> persistence
                -> agent-runtime
```

CLI 只解析参数、路径并提供 adapter，不自己调度 task 或管理 lease。`RunPreparation` 拥有有序 authority boundary；
`LocalRuntimeBindingPolicy` 把 approved decision 转成 runtime task、impact、canonical lease plan、稳定 agent/workspace
identity 与 Git binding；`LocalRuntimeStarter` 组合既有 runtime、SQLite、Scheduler、Write Guard、Git worktree、受控 Pi
tool 与 package-script verification。

只有已经出现真实跨 package consumer 的入口才新增 re-export；infrastructure command/helper type 仍留在 adapter
内部。

## 3. Integration checkout 与 task worktree

从 run 的角度看，approved source repository 是只读来源。Git adapter 创建：

```text
<run-directory>/
└── <run-id>/
    ├── integration/       branch: forge/integration/<run-id>
    ├── tasks/
    │   ├── <task-hash>/   branch: forge/task/<run-id>/<task-hash>
    │   └── ...
    └── run.sqlite
```

Integration checkout 必须位于 source repository 之外。调用方中断后可以复用完全匹配的 checkout；commit 或 branch
不匹配则拒绝。Run ID 会校验，路径会 realpath 检查，symlink run directory 不能逃出 checkout root。

每个 task 都从 artifact 的 `baseCommit` 开始，而不是 mutable source `HEAD`。完成的 task 会逐个 rebase 并
fast-forward 到 run-specific integration branch。因此 agent 可以并行工作，但 Git integration 仍保持串行。

## 4. Runtime binding 先派生，再独立复核

Binding policy 会把 artifact 中稳定 array 形式的 impact 恢复成 `PredictedTaskImpact` Set，再从 predicted impact
派生 canonical lease plan。File/project/shared-resource 写权限来自 deterministic impact，不来自执行时 LLM 的临时
决定。

Runtime 启动前，`RunPreparation` 会独立检查：

- run ID 与 repository ID；
- 完整 durable authority record；
- task、hard conflict、risk conflict 与 schedule collection 完全一致；
- 每个 task 恰好有一个 binding 和 predicted impact；
- integration path、base commit 与 integration ref 完全一致；
- canonical lease plan 一致；
- 完整 predicted impact 一致。

因此 adapter bug 不能静默漏掉 task、弱化 hard conflict、扩大 lease、改变 impact evidence，或把 worktree 指回用户
checkout。

没有 predicted write 的 task 会得到空 lease plan。它可以读取和验证；若之后尝试写入，仍必须走 runtime scope
expansion 与 Write Guard acquire。

## 5. Durable authority 与 retry

Run row 现在保存 `RunAuthorityEvidence`：artifact ID/revision、approval ID、plan/approval/claim/execution fingerprint、
真实 repository root、approved base commit、working-tree/Repository Facts fingerprint，以及 shared-resource/
verification-policy fingerprint。

Stage 20 之前的 SQLite 数据库在打开时会增加新 column；但缺少合法 authority evidence 的旧 run 不会被猜测或静默
升级，recovery 会明确拒绝。

`startOrResumeRun()` 的语义是：

```text
没有 run row -> 创建并执行
同 run + 同 authority + ACTIVE -> 安全恢复并继续
同 run + 同 authority + terminal -> 返回 terminal evidence，不再次 dispatch
同 run + 不同 authority -> 拒绝
```

Retry 会把 persisted lease 重新载入 local Write Guard，避免本地进程重启后静默忘记 exclusion；但这不声称实现
distributed/cross-host fencing。

同一 repository/run identity 的所有 `startRun()` 与 `startOrResumeRun()` 都会进入 process-wide lifecycle queue。
这对 `PREPARING` recovery window 很关键：两个并发 caller 不能同时把同一个 attempt 视为可恢复并各自启动一次 external
agent。回归测试会并发启动两个独立 runtime object，并证明 agent 只收到一次调用。这个保证有意限定在同一 Node.js
process 内；第二个 process 或 host 仍需要未来的 durable execution claim/fencing protocol。

Runtime 也补齐了 run state 收尾：task 全部 completed/cancelled 时 run 为 `COMPLETED`；任何 task failed 时 run 为
`FAILED`；blocked/nonterminal work 继续保持 `ACTIVE`。

## 6. Agent 与 verification

Pi 仍不能使用 built-in shell 或 mutation tool，只能使用受控 `forge_read`、`forge_list`、`forge_find`、
`forge_edit` 与 `forge_write`。Stage 20 默认 binding 不授予 `forge_command`。

Pi 完成后，orchestrator 用参数数组执行每条 approved package-script rule：

```text
pnpm --filter <approved-package-name> run <approved-script-name>
```

系统不会解释 shell string；package name 与 script name 也被限制为 package-manager-safe identifier。Child process
只收到 `CI=1` 与 trusted `PATH`，父进程的 `NODE_OPTIONS` 等任意环境变量不会进入 verification。Autonomous runtime
遇到 free-form `command` verification 会 fail closed；script 失败则不会 Git integrate。

每个 task commit 都包含准确的 `Forge-Run-Id` 与 `Forge-Task-Id` trailer。若 integration checkout 已经越过 approved
base，复用时会逐个检查中间 commit 是否带有当前 run trailer，因此普通人工插入的 commit 会被拒绝，不会被误认成
Forge 进度。Trailer 是 local filesystem threat model 下的 provenance metadata，不是 signature；拥有直接 Git 写权限的
恶意 actor 仍可故意伪造。

## 7. CLI 用法

```sh
forge run <artifact-id> \
  --approval <approval-id> \
  --run-id <stable-run-id> \
  --repository <repository> \
  [--revision 1] \
  [--shared-resources shared-resources.json] \
  [--plan-directory /external/plan/store] \
  [--run-directory /external/run/store]
```

默认 run store 是 `~/.forge/runs/<repository-id>`。成功结果位于返回的 run-specific integration checkout；Stage 20
不会修改用户当前 branch，也不会 push remote。

## 8. 已测试的失败边界

测试覆盖真实的 approval 时 clean、start 前变 dirty 且 checkout 尚未产生的完整链路；两个 runtime 并发恢复
`PREPARING` 但 agent 只 dispatch 一次；以及 stale intent revalidation、dirty artifact、foreign/unrelated checkout
history、错误 checkout commit、symlink path escape、错误 durable
authority、缺失 task/impact、conflict/schedule drift、lease/impact drift、错误 workspace checkout、相同 retry、authority
变化 retry、真实 Pi tool edit、失败/free-form verification、persisted lease hydration、SQLite migration/corruption 与真实
Git checkout reuse。真实 two-clone integration test 证明：即使两个 clone 共享 origin 和 bytes，只要物理 approved root
不同，binder 仍会拒绝。Dirty-state-only binding 也有独立测试。

## 9. 有意保留的限制

- Dirty PlanArtifact 暂不能执行，因为尚未实现 dirty/untracked bytes 的准确隔离 materialization。
- Lifecycle mutex 与 lease backend 都是 process-local，不是 cross-process 或 distributed fencing service。
- 中断的 external agent attempt 会成为 `UNKNOWN`；自动 cancellation/resolution 仍是后续工作。
- 多个 sibling failure 会等待 settle，但还不会聚合成一个 diagnostic。
- 结果不会自动发布到用户 branch、GitHub branch、issue 或 pull request。
- GitHub/Jira/provider identity 不进入 deterministic domain contract。
- 当前 verifier PATH 针对已支持的 macOS/Linux local runtime；Windows path separator，以及 Corepack、Volta、自定义 pnpm
  位置需要后续 portability adapter。
- Commit provenance 使用 exact-line run trailer 与 Git ancestor check；任何 post-base commit 缺少 trailer 都会 fail
  closed。若 metadata format 以后扩展，可再引入严格 Git trailer-block parser。
- Trusted Git subprocess 目前仍继承 orchestrator environment。它与 agent-controlled verification 的 threat model 不同，
  但 minimal-environment 一致性仍登记为后续 security-review 项。
