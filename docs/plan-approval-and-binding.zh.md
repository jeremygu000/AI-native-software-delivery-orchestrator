# Plan Approval 与 Execution Binding

## 1. 为什么需要这一阶段

Stage 18 让 plan 成为 durable artifact，回答了“Planner 当时究竟决定了什么”。但它还没有回答：是否有人批准了
这个准确 revision、repository 是否仍是同一份 source/facts、同一个 approval 是否已被另一个 run 使用。

Stage 19 在产生任何 runtime-specific binding 之前回答这些问题：

```text
不可信 request
     |
     v
已验证 PlanArtifact       人工决定
     |                       |
     +-----------------------+
                 |
                 v
            PlanApproval
                 |
        reload + 完整性校验
                 |
       Git snapshot A
                 |
       重建 RepositoryGraph
                 |
       Git snapshot B
                 |
       拒绝移动或任何 mismatch
                 |
       原子化 single-run claim
                 |
                 v
         PlanExecutionIntent
          （还不是运行进程）
```

## 2. 为什么是三个独立记录

### PlanArtifact

Artifact 继续保持 immutable planning decision。Approval 不会修改它。Artifact fingerprint 覆盖 request、
repository evidence、policy、Task Contract、predicted impact、conflict、schedule 与 semantic review evidence。

### PlanApproval

Approval 保存稳定 `approvalId`、准确 artifact ID/revision/`planFingerprint`、provider-neutral `approvedBy`、
`approvedAt` 和覆盖 approval payload 的 fingerprint。批准时间不能早于 artifact 创建时间。

`approvedBy` 不带 GitHub、Jira、SSO 等 provider 类型。以后 provider adapter 可以从已认证身份生成它，但 core
planning contract 不依赖任何外部产品。

### PlanApprovalClaim

所有 binding check 通过后，approval 才能被一个 `runId` claim。Claim 用 atomic hard link 发布：

```text
没有 claim + run-A -> 发布 run-A claim -> 成功
run-A 重试         -> 返回原 claim      -> 成功
run-B 请求         -> 已存在 run-A      -> 拒绝
run-A/run-B 并发   -> 只有一个能发布    -> 另一个拒绝
```

同一个 run 重试会返回原始 `claimedAt`，因此 process retry 的结果保持稳定。

### PlanExecutionIntent

Intent 包含 artifact、approval、已持久化 claim、run ID、binding time 和完整记录 fingerprint。解析时会校验每个
nested record 自己的 fingerprint、cross-record identity，以及外层 fingerprint。

它只是“经过验证的执行意图”，不是正在运行的 orchestration。它没有 `AgentRunner`、workspace、Write Guard、
command policy、sandbox、model、verification 或 Git integration implementation。

## 3. Binder 的准确检查顺序

```text
1. 加载准确 artifact revision 与 approval
2. 校验两者 fingerprint 和 approval -> artifact identity
3. 抓取 repository snapshot A
4. 重建 RepositoryGraph
5. 抓取 repository snapshot B
6. 要求 A == B，拒绝 mixed-state evidence
7. 比较 artifact 中的 repository authority：
   - repositoryId
   - 物理 repositoryRoot
   - baseCommit
   - workingTreeFingerprint
   - dirty state
   - Repository Facts fingerprint
8. 比较当前 authority policy：
   - shared-resource policy fingerprint
   - verification policy fingerprint
9. 为 runId 原子 claim approval
10. 返回带 fingerprint 的 PlanExecutionIntent
```

Claim 故意放在最后。Repository 改变或校验失败不能消耗 approval authority。

## 4. Predicted facts 与 current facts

Artifact 保存产生 predicted impact/conflict 时使用的 Repository Facts。Bind 时 analyzer 会再次运行。Git commit
相同并不够，因为 tracked modification 与 untracked source 可能已经变化；working-tree fingerprint 相同也不能替代
facts comparison：source identity 和 canonical graph 必须同时一致。

这是保守策略。Repository 或 authority policy 变化后，应重新 plan 和 approve，而不是让旧 artifact 被静默重新解释。

## 5. CLI 使用方式

```sh
forge approve <artifact-id> \
  --revision 1 \
  --approved-by reviewer@example.com \
  --approval-id approval-123 \
  --repository .

forge bind <artifact-id> \
  --revision 1 \
  --approval approval-123 \
  --run-id run-123 \
  --repository .
```

如果 planning 使用 shared-resource registry，binding 必须通过 `--shared-resources` 提供同一份当前 policy。自定义
artifact directory 也必须用 `--plan-directory` 再次指定。

可确定的 binding mismatch 使用 `BINDING_REJECTED` 和稳定 mismatch ID。缺失/损坏 storage 与 configuration
error 继续作为 infrastructure failure 直接传播。

## 6. 并发与失败语义

Approval 与 claim 都用 immutable atomic publication。受支持的本地 filesystem 上，不同 run ID 的并发 claim 不可能
同时成功。Invalid ID、corrupt JSON、filename/payload 不一致、fingerprint mismatch，以及把 storage 放进 analyzed
repository 都会 fail closed。

这是 local single-host guarantee，不是跨 host database transaction、distributed consensus，也不是后续 runtime 的
cross-process lease fencing。

SHA-256 fingerprint 是 integrity link，不是 signature。能够直接改写 JSON store 的人也能重新计算一个自洽
fingerprint。Binder 会独立加载真实 artifact，因此把 approval 改成指向另一个真实 artifact 时仍会被 cross-check
拒绝；但当前 local design 不会针对 hostile storage administrator 认证 approving actor。若 deployment threat model
包含 storage administrator，就必须增加 signed approval 或 authenticated durable storage。

## 7. Package 边界

```text
domain
   ^
planning  <--- repository facts/snapshot ports
   ^
persistence  （JSON approval/claim adapter）
   ^
CLI  （只做 composition 与 JSON I/O）
```

Planning 拥有 provider-neutral record 与 binder policy；persistence 拥有 filesystem mechanism；CLI 组合 Git 与
RepositoryGraph adapter。Provider、Jira、Pi、Docker、workspace 与 runtime type 都没有泄漏进这些 contract。

## 8. 本阶段没有实现什么

- `forge run/status/resume/cancel`；
- 自动转换成 `StartRuntimeRunRequest`；
- 已认证 external approval provider 或数字签名；
- distributed approval claiming；
- runtime worktree/agent/lease/model policy 选择；
- cross-process runtime lease fencing；
- GitHub issue、webhook、PR 或 Jira workflow。

下一阶段应该定义 controlled runtime binding policy 和 application service：消费已验证的 `PlanExecutionIntent`，构建现有
runtime request，持久化 start，并支持 recovery；这些部署选择不能被塞进 CLI。

它还必须把 intent 当作 binding-time evidence，而不是永久通行证。产生副作用前，run preparation 必须重新验证
source repository，在 approved base commit 上 provision orchestrator-owned integration checkout，让 task worktree
从该 checkout 派生，然后持久化并启动 run。只解析 intent fingerprint 不等于 execution-time revalidation。
