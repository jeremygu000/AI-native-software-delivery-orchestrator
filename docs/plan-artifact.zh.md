# Durable Plan Artifact（持久化计划制品）

本文解释：为什么一个已经通过验证的计划，在绑定准确仓库状态并保存为不可变证据之前，仍然不能安全执行。

## 1. 问题：正确计划也会过期

假设规划阶段分析的是 commit `abc123`，并判断两个任务可以并行。十分钟后，有人修改 package manifest、移动
文件，或者 pull 到 `def456`。旧计划在 JSON 结构上仍然合法，但它描述的 impact 和 conflict 已经不是当前仓库。

```text
规划时仓库                           执行时仓库
----------------                    ----------------
HEAD abc123                          HEAD def456
file A -> file B                     file A -> file C
task A/B 相互独立                    task A/B 发生重叠

             旧计划不能跨过这条边界
```

Stage 18 解决“身份和持久化”问题，但还不批准或执行 artifact。

## 2. Prepared Plan 与 Durable Artifact

`PreparedOrchestrationPlan` 仍是 Planner/Reviewer 有限循环中的内存结果。它包含 Set，也没有持久化仓库身份。

`PlanArtifact` 是不可变、可 JSON 序列化的决策记录：

```text
PreparedOrchestrationPlan
          +
Planning source
          +
Git repository snapshot
          +
Repository Facts fingerprint
          +
Policy fingerprints
          |
          v
   createPlanArtifact()
          |
          v
 immutable PlanArtifact revision
```

分开这两个概念，可防止“Planner 返回了它”被误认为 execution authority。

## 3. Repository Snapshot 证明什么

Snapshot 包含五个关键字段：

```text
repositoryId             标识 origin repository（没有 origin 时使用本地 root）
repositoryRoot           canonical real filesystem root
baseCommit               Git commit 基线
workingTreeFingerprint   当前 tracked + untracked non-ignored 内容
dirty                    Git 是否报告工作树改动
```

只有 `baseCommit` 不够。同一个 `HEAD` 下，一个 worktree 可能还有未提交修改。Working-tree fingerprint 会 hash
路径、filesystem mode、entry kind 和文件 bytes。对于 symlink，它 hash link text，不跟随 target。

Ignored cache/build 文件有意排除，因为它们不是 Git source state。如果 repository analyzer 有意索引某个 ignored
文件，它产生的 Repository Facts 仍会进入独立的 facts fingerprint。

## 4. 避免 Mixed-State Analysis

Repository 分析需要时间，分析过程中可能有文件被修改。因此 CLI 会在分析前后各抓一次 snapshot：

```text
snapshot A
    |
    v
RepositoryGraph analysis
    |
    v
snapshot B
    |
    +-- A == B --> 可以创建 artifact
    |
    +-- A != B --> fail，必须重新规划
```

这是 change detection，不是 filesystem lock。未来产品 workflow 最好在 orchestrator-owned immutable checkout
中规划，以获得更强隔离。

## 5. Repository Facts Fingerprint

Artifact 会规范化并 hash：

- project identity、root、manifest、dependency、script、source root 和 tsconfig；
- project dependency edge 及其 evidence source；
- file 与 symbol；
- file dependency 与 symbol reference；
- repository diagnostic。

Map 和无序 collection 会使用不依赖 locale 的比较器排序。因此同一批事实即使 Map 插入顺序不同，也会得到同一
fingerprint。

## 6. Policy Fingerprint

即使源码没变，policy 变化也可能改变计划。例如 shared resource 从 `ordered` 改为 `exclusive`，会改变调度
authority。Stage 18 因此绑定：

- normalized shared-resource policy；
- autonomous verification policy 的 version/rule。

Artifact 只保存 fingerprint，不引入 provider 或 Pi type。

## 7. Cross-Record Validation

Schema 不只检查字段类型，还检查关系：

```text
Task IDs
  |-- 每个 task 恰好一个 predicted impact
  |-- 每个 task 在 execution wave 中恰好出现一次
  |-- 每个 conflict endpoint 必须存在
  `-- 每个 semantic-review 引用必须存在

hardConflicts -> 只能是 hard
riskConflicts -> 只能是 none/soft
wave index    -> 0, 1, 2, ...
set-like JSON array -> 已排序且无重复
```

这能阻止“JSON 结构正确，但计划关系已经损坏”的 artifact。

## 8. Fingerprint 与 Integrity

`planFingerprint` 覆盖完整 payload：artifact ID、revision、创建时间、source、repository binding、policy
fingerprint、task、impact、conflict、schedule 和 semantic evidence。

只修改一个字段、不更新 fingerprint，parse 会失败。这能发现损坏或意外 mutation，但它不是 digital signature：
拥有 filesystem 写权限的恶意方仍可能同时替换内容与 hash。不可变存储和未来 approval/audit 是下一层保护。

## 9. Immutable File Storage

默认情况下，`forge plan` 保存：

```text
~/.forge/plans/<repository-id>/<artifact-id>.r1.json
```

File adapter 先写唯一临时文件，再用 atomic hard link 发布：

```text
temporary file --link--> final immutable revision
      |
      `-- publish 后删除
```

另一个 process 已经保存完全相同内容时，save 是 idempotent success；同一 artifact ID/revision 下不同内容会被
拒绝。可用 `--plan-directory <path>` 指定其他目录，但 destination 必须位于被分析仓库之外，否则保存 artifact
本身就会让 snapshot 失效。Boundary check 前会解析已经存在的 symlink ancestor；save 会在创建 destination
directory 前、创建后，以及临时文件写入前立即做 confinement check。因此，如果原先不存在的 ancestor 在路径
选择后被换成指向仓库内部的 symlink，系统会在发布前 fail closed。若发布已经产生主要错误，后续临时文件清理
失败不会掩盖该主要错误；若 cleanup 是唯一错误，它仍会返回给 caller。

## 10. Stage 18 仍然不能授权什么

PlanArtifact 仍然不能：

- 自己批准自己；
- 创建 run；
- 创建 worktree；
- 获取 lease；
- dispatch agent；
- 执行 verification；
- Git integration。

下一阶段必须创建引用准确 artifact ID、revision 与 `planFingerprint` 的 approval record，然后重新确认 repository
snapshot 仍匹配，才能绑定成 canonical runtime request。

## 11. 当前限制

- Snapshot capture 是本地 Git/filesystem infrastructure，不是 distributed lock。
- 任意 ignored file 不会作为 source bytes hash。包含 Git submodule 的仓库会 fail closed，直到实现 nested
  working-tree fingerprint。
- Unicode NFD normalization 与 lowercase conversion 后冲突的 path 会 fail closed，保证可移植文件身份；这里不
  声称实现完整的 Unicode case folding。
- Origin URL 提供跨 clone repository identity；没有 origin 时退回 real local root，因此不同路径的 clone 会有意
  得到不同的 repository ID。
- 等价的 SSH 与 HTTPS origin 写法尚未 normalization，因此会有意得到不同的 fail-closed ID。未来 distributed
  worker 需要 provider-neutral canonical remote identity policy。
- Artifact file 由应用行为保证不可变，但无法阻止 OS administrator 删除。
- Pathname recheck 能降低普通 symlink race，但不能提供抵御 hostile local process 的 atomic
  directory-descriptor confinement；这超出当前 single-user threat model。
- Fingerprint 是 content identity，不是 signature。
- `repositoryBindingMismatches` 已实现并测试，但 Stage 18 没有 production caller。Stage 19 的
  `PlanExecutionBinder` 必须在创建 runtime request 前拒绝任何 `repositoryId`、`baseCommit`、
  `workingTreeFingerprint` 或 `factsFingerprint` mismatch；human approval 与这个强制调用点属于 Stage 19。
