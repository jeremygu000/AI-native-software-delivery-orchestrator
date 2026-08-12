# 语义计划复审

## 为什么需要这个阶段

Stage 16 能证明一个 proposal 在结构上可以安全分析与调度，却不能证明它包含了用户要求的全部工作。

例如用户要求：

```text
增加 Google 登录、持久化用户资料、增加退出登录，并补充测试。
```

Planner 可能只生成“修改登录按钮”这一项。这个 task 仍可能拥有合法 ID、真实 file selector、无环 dependency
以及真实 test script，因此所有 deterministic check 都会正确判断“这个 task 合法”。但这并不等于“整个 plan
覆盖了用户需求”。

Stage 17 增加第二个语义角色，以降低这种遗漏风险。

## 完整边界

```text
用户请求 / Markdown specification
                 |
                 v
          Planner proposal
             （不可信）
                 |
                 v
       deterministic validation
 schema -> DAG -> verification -> impact
          -> conflicts -> Scheduler
                 |
         invalid | valid
         +-------+---------+
         |                 v
         |       Semantic Plan Reviewer
         |              （不可信）
         |                 |
         |       revise    | accept recommendation
         |          +------+------+
         |          |             v
         +----------+       再次执行完整
        Planner          deterministic validation
        revision                |
                                v
                    PreparedOrchestrationPlan
                         （仍无执行权）
```

三层判断回答不同问题：

| 组件                   | 回答的问题                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| Deterministic pipeline | Contract、selector、dependency、verification、conflict 和 schedule 是否合法？ |
| Semantic Reviewer      | Proposed task 是否看起来覆盖了 source 中的每一项要求？                        |
| 未来 human approval    | 是否允许这个准确 plan 在这个准确 repository snapshot 上执行？                 |

Reviewer 不能替代 deterministic validation，也不能替代 human approval。

## Provider-neutral 合同

`libs/planning/src/lib/semantic-plan-review.ts` 定义：

```ts
interface SemanticPlanReviewer {
  review(request: SemanticPlanReviewRequest): Promise<unknown>;
}
```

返回 `unknown` 是有意设计。Provider adapter 不能仅凭 TypeScript 类型声明，就把 model response 变成可信数据。

Response 必须把具体 requirement 映射到 task ID：

```json
{
  "recommendation": "accept",
  "summary": "每项要求都有对应 task。",
  "requirements": [
    {
      "requirement": "增加退出登录",
      "status": "covered",
      "taskIds": ["auth-logout"],
      "detail": "auth-logout 实现并验证退出登录。"
    }
  ]
}
```

每一项只有三种状态：

- `covered`：必须引用至少一个已知 task ID；
- `missing`：plan 中没有充分覆盖该要求的 task；
- `ambiguous`：source 或 task 意图不足以确认覆盖。

只有全部 requirement 都是 `covered` 时，`accept` 才合法。`revise` 必须至少包含一个 `missing` 或
`ambiguous`。Requirement 文本按大小写无关方式保持唯一；task ID 会去重并稳定排序；未知 task ID 会 fail
closed。

这些规则不会把语义判断变成 deterministic truth。它们使判断结构化、可检查，并避免内部自相矛盾。

## Revision 怎样工作

Missing 或 ambiguous item 会变成 `SEMANTIC_REQUIREMENT_GAP`：

```json
{
  "code": "SEMANTIC_REQUIREMENT_GAP",
  "requirement": "持久化用户资料",
  "status": "missing",
  "detail": "没有 task 负责资料持久化与验证。"
}
```

下一次 Planner attempt 会收到这个 diagnostic。Reviewer 要求的 revision 与其他 planning correction 共用正数
`maxAttempts` budget，因此 Planner 和 Reviewer 不会无限争论。最后一次仍存在 gap 时，phase 会用最后一组 gap
抛出 `AutonomousPlanningError`。

Malformed Reviewer JSON 不属于 Planner 能修复的问题，因此会立即抛出 `SemanticPlanReviewError`。Reviewer
provider failure 也会保持原始错误向外传播。

## 为什么要验证两次

第一次 deterministic pass 保证 Reviewer 只看到合法 candidate。Reviewer 给出 `accept` 建议后，phase 会通过
schema clone Task Specification，并再次执行：

```text
Task Contract validation
functional DAG validation
verification authority validation
repository selector 与 impact analysis
hard/risk conflict analysis
Scheduler validation
```

这在 probabilistic review 之后重新建立 deterministic trust boundary。测试中甚至有一个 adversarial fake
Reviewer 会修改内存中的 dependency；第二次验证能发现新出现的 missing dependency，并拒绝返回这个 candidate。

## 只读 Repository Facts

`PiSemanticPlanReviewer` 位于 `libs/agent-runtime`，Pi SDK 类型不会进入 planning contract。Reviewer 使用新的
one-response session，并且只能使用：

- `forge_projects`；
- `forge_files`；
- `forge_symbols`；
- `forge_relationships`。

`forge_relationships` 查询既有 `RepositoryGraph` 的 project dependency、file dependency 或 symbol reference。
它支持 incoming、outgoing、either direction filter；即使 caller 绕过 tool schema，每页仍最多返回 500 条 edge。
因此 Reviewer 可以检查“API 是否引用这个 domain file”等事实，而不需要 shell 或 live filesystem。

所有工具只读取已构建的内存 graph，不能修改 worktree，也不能运行 command。Session 在成功和失败后都会
dispose。如果 provider operation 与 disposal 同时失败，原始 provider failure 会继续作为主要 diagnostic。

## 显式数据外发授权

CLI 用法是：

```sh
forge plan request.md --repository . --semantic-review
```

`--semantic-review` 是必需参数。它明确授权独立 Pi review call 接收 specification 与只读 Repository Facts。
没有该参数时，Commander 会在 planning composition root 启动前拒绝命令。

Automated test 不代表已经执行 live model smoke。对 private repository 运行命令前，operator 仍需确认当前配置的
model destination。

## Result 代表什么

`PreparedOrchestrationPlan.semanticReview` 会保存已接受的 recommendation 与 requirement map，供人类检查和
未来 audit 使用。但它不授予任何 capability。

Result 仍缺少：

- human approval record；
- plan 与 repository snapshot fingerprint；
- run 和 agent identity；
- worktree binding；
- canonical lease plan 与 command policy；
- durable planning history。

这些属于后续 Plan-to-Run binding 与 approval 阶段。

## 已测试的失败边界

测试覆盖：

- accepted requirement map；
- missing/ambiguous revision；
- semantic revision budget 耗尽；
- malformed JSON 与非 object output；
- duplicate requirement；
- recommendation 与 item status 不一致；
- covered requirement 没有 task citation；
- unknown task citation；
- Reviewer infrastructure failure 传播；
- post-review deterministic revalidation；
- relationship direction、stable identity、sources、pagination 与 server-side cap；
- explicit CLI consent；
- disposal 同时失败时仍保留 primary provider failure。

## 已知限制

- Model 可能没有识别出 source 中的一项要求。Structured map 能降低并暴露遗漏风险，但不能从数学上证明自然
  语言完整性。
- Planner 与 Reviewer 使用独立 session，但目前可能仍使用同一个已配置 Pi provider。未来 model routing 可以选择
  不同 Reviewer model。
- Malformed Reviewer output 目前不会独立 retry。
- Review evidence 尚未持久化，也没有与 repository snapshot 做不可替换绑定。
- 目前仍没有 execution approval 或 `forge run`。
