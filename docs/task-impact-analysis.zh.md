---
title: Task Impact 与 Conflict Analysis——培训指南
tags:
  - coding-orchestrator
  - task-impact
  - conflict-engine
  - architecture
status: implemented
---

# Task Impact 与 Conflict Analysis——培训指南

本文解释一个结构化任务怎样变成确定的仓库影响预测,以及系统怎样比较两个预测,判断它们能否安全
并行。本文面向没有编排器、编译器或并发控制经验的读者。

如果还不了解项目、文件、符号和依赖边从哪里来,请先阅读
[RepositoryGraph 分析器](./repository-graph-analysis.zh.md)。

## 一句话说明

Task Impact 回答:

> 如果任务遵守自己声明的合同,它可能读取、写入或协调哪些资源?

Conflict Analysis 回答:

> 给定两个预测影响,它们在哪里重叠,哪些只是风险,哪些是必须执行的调度约束?

```text
TaskContract A -----> PredictedTaskImpact A ---+
                                                 +--> TaskConflict(A, B)
TaskContract B -----> PredictedTaskImpact B ---+
                              ^
                              |
                       RepositoryGraph
                       Resource Registry
```

两个阶段都是确定性逻辑。它们不会调用 LLM,不会把源代码发送到网络,也不会修改仓库。未来可以由
LLM 帮助产生 `TaskContract`,但 LLM 不是 impact 或 conflict 领域逻辑中的权威。

## 为什么需要这一层

只有任务依赖图,不足以安全地决定并发。

```text
Task A:修改 Service.search
Task B:修改 Service.validate

Functional DAG:A 和 B 之间没有依赖
```

DAG 只说明两个任务不需要对方的结果。它没有说明两个任务是否会编辑同一个文件、同一个符号、
generated artifact、migration 目录或共享 lockfile。

Task Impact 把任务意图转换成仓库结构上的 scope,Conflict Analysis 再比较这些 scope。未来
Scheduler 会组合两个相互独立的输入:

```text
依赖关系是否 ready
        +
hard constraint 与风险策略是否允许
        |
        v
真正的运行时 dispatch decision
```

这种分离能防止一个有用但不可靠的风险分数削弱真正的依赖或强制串行规则。

## 三层证据

架构刻意分开三种证据:

```text
RepositoryGraph
  “仓库里有什么,什么依赖什么?”
          |
          v
PredictedTaskImpact
  “这个任务合同声明自己可能触碰什么?”
          |
          v
ObservedTaskImpact
  “任务运行时实际上触碰了什么?”       [目前只有合同,运行时尚未实现]
```

### Repository facts

`RepositoryGraph` 保存工具能够证明的 project、file、symbol、import、reference 与项目依赖。
这些事实与具体任务无关,并且是只读输入。

### Predicted impact

`PredictedTaskImpact` 在执行前由经过校验的 `TaskContract`、`RepositoryGraph` 和 shared-resource
registry 产生。它是保守预测,不代表列表中的每项一定会被修改。

### Observed impact

`ObservedTaskImpact` 留给运行时事实:真实 file read、create、write、delete、dependency request、
manifest change、generated output 和被修改的 symbol。领域合同已经存在,但运行时采集尚未实现。

预测不能覆盖观察,观察也不能倒过来伪装成预测。两者不一致本身就是重要证据:

```text
predicted write:file A
observed write: file A + file B
                         ^
                         unexpected scope expansion
```

未来 Runtime Guard 必须阻止或升级处理不安全的 scope expansion,不能静默地把新范围当成预先授权。

## 输入:Task Contract

Task Contract 包含任务身份、依赖、scope 和 verification 声明。Impact Analyzer 会消费以下字段:

```ts
interface TaskContract {
  id: string;
  expectedReads: ResourceSelector[];
  expectedWrites: ResourceSelector[];
  sharedResources: string[];
  // title、goal、dependencies、verification、priority 等
}
```

支持五种 selector:

| Selector          | 含义                                                         |
| ----------------- | ------------------------------------------------------------ |
| `project`         | 通过 ID、package name 或 project root 选择 workspace project |
| `file`            | 精确 graph file ID 或规范化的仓库相对路径                    |
| `glob`            | 匹配仓库相对 path pattern 的全部 graph file                  |
| `symbol`          | 通过稳定 ID、declaration path 或 simple name 选择符号        |
| `shared-resource` | 命名的非代码资源或跨文件协调资源                             |

例子:

```json
{
  "id": "change-search",
  "expectedReads": [
    { "type": "project", "value": "consumer" },
    { "type": "shared-resource", "value": "search-index" }
  ],
  "expectedWrites": [
    { "type": "symbol", "value": "SearchService.query" },
    { "type": "glob", "value": "packages/core/src/generated/**" }
  ],
  "sharedResources": ["release-channel"]
}
```

`shared-resource` selector 会保留 read/write 意图。单独的 `sharedResources` 数组表示“任务必须
通过这个资源进行协调”,会转换成 `coordinate` access。两者不是重复字段。

## Impact 的完整流程

```text
经过校验的 TaskContract
        |
        +--> 校验每个显式命名的 shared resource
        |         |
        |         +--> 未知 ID:以 UNKNOWN_SHARED_RESOURCE 失败
        |
        +--> 解析 expectedReads selectors
        |
        +--> 解析 expectedWrites selectors
        |         |
        |         +--> 保存每个 written file 进入 scope 的原因
        |
        +--> 根据 file/path 附加 registry rule
        |
        +--> 识别 exported symbol 和 generated file
        |
        +--> 反向遍历 project dependency,计算传递下游
        |
        +--> 稳定排序和规范化所有 set、access list 与 signal
        |
        v
PredictedTaskImpact
```

实现位于 `libs/task-impact/src/lib/task-impact-analyzer.ts` 中的
`RepositoryTaskImpactAnalyzer`。

## Selector 怎样解析

### Project selector

Project selector 可以匹配 project ID、package name 或规范化 project root。读取或写入 project
会记录 project scope。

Project selector 是精确 selector,因此匹配零个或多个 project 都会产生 `ambiguous-selector`
risk signal。Signal 会保留 partial result 供保守 Review,不会静默地任选一个 project。

Project write 不会假装所有已知文件都被显式选择:

```text
expectedWrites:project(core)

projectsWritten         = { core }
explicitProjectsWritten = { core }
filesWritten            = { }       <- 有意不展开
```

Analyzer 仍会检查该 project 的 package manifest 和所有已知文件,发现匹配的 shared-resource
rule。这样 whole-project task 可以发现“`migrations/**` 的变更必须有序”之类的规则,但不会制造
虚假的精确文件预测。

### File selector

Exact file selector 匹配 graph file ID 或规范化仓库相对路径。所属 project 会自动加入 scope。

```text
write file(core:index)
        |
        +--> filesWritten += core:index
        +--> explicitFilesWritten += core:index
        +--> projectsWritten += core
        +--> 查找该 file path 的 registry rule
```

`package.json` 等文件可能不在 TypeScript graph 中。Registry 仍可直接识别其 path,所以非
TypeScript coordination resource 不会丢失。Exact file selector 通常在匹配零个或多个 graph
file 时产生 `ambiguous-selector`。但如果 selector path 至少命中一条 registry rule,零匹配 signal
会被有意抑制:这表示 selector 成功识别了 graph 之外的 coordination resource,而不是未知 path。

### Glob selector

Glob 有意允许匹配零个、一个或多个 graph file。每个 match 都会记录所属 project 和 glob
provenance。匹配多个文件不算 ambiguous,因为 glob 本来就是为了 fan-out。

### Symbol selector

Symbol selector 匹配稳定 symbol ID、declaration path 或 simple name。选择 symbol 也会记录
parent file 和 project:

```text
write symbol(core:index:SearchService.query)
        |
        +--> symbolsWritten += SearchService.query
        +--> filesWritten += core:index
        +--> symbolDerivedFilesWritten += core:index
        +--> projectsWritten += core
```

Simple name 可能匹配多个 declaration。Symbol selector 匹配零个或多个 facts 时会产生
`ambiguous-selector` risk signal,不会静默地假装它是精确匹配。

### Shared-resource selector

Selector 会直接记录 `read` 或 `write` access。Impact calculation 开始前,每个命名资源都必须
通过 registry 校验。拼写错误会明确失败,不会悄悄削弱 hard scheduling policy。

## 为什么必须保存 write provenance

`filesWritten` 是保守 union。仅凭它无法解释任务的 authority 或精确度。

```text
Task A 选择 symbol Service.first
Task B 选择 symbol Service.second
两个 symbol 都位于 core:file

filesWritten(A) = { core:file }
filesWritten(B) = { core:file }
```

这可能只是 sibling-symbol 风险,不一定是 whole-file collision。但再看一个场景:

```text
Task A 同时选择 core:file 和 Service.first
Task B 选择 Service.second
```

如果只保留 union,Task A 看起来像 symbol scope,系统可能允许过多并发。因此预测会分别保存四种来源:

```text
explicitProjectsWritten   project selector
explicitFilesWritten      exact file selector
globFilesWritten          glob 触达的文件
symbolDerivedFilesWritten symbol 的 parent file
```

这些集合可以有意重叠。只要 project、file 或 glob scope 覆盖了某文件,Conflict Engine 就按
whole-file scope 处理。只有双方在该文件上都纯粹来自 symbol,并且写入不同 symbol 时,才允许
sibling-symbol 处理。

## Shared Resource Registry

并发风险不只来自仓库代码。任务还可能触碰 lockfile、migration stream、generated output、
deployment environment 或外部 coordination channel。

```json
{
  "resources": [
    {
      "id": "lockfile",
      "files": ["pnpm-lock.yaml"],
      "concurrency": "exclusive"
    },
    {
      "id": "migrations",
      "paths": ["migrations/**"],
      "concurrency": "ordered"
    },
    {
      "id": "generated-code",
      "paths": ["generated/**"],
      "concurrency": "producer-controlled"
    }
  ]
}
```

Registry 拥有 policy;Scheduler 中不会出现针对具体 filename 的条件判断。

| Policy                | 当前含义                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| `exclusive`           | 任意重叠的声明 access 都是 hard serialization constraint                 |
| `ordered`             | Access 必须按 task order stagger                                         |
| `producer-controlled` | read/read 可重叠;write/read 有 producer 方向;竞争性 write 必须 serialize |

`coordinate` 是保守意图。在 producer-controlled resource 上,coordinate/read 无法证明 producer
方向,所以会成为无方向的 hard serialization constraint。

## 下游项目展开

Repository project edge 从 consumer 指向 dependency:

```text
app ------> feature ------> core
      依赖             依赖
```

如果任务写 `core`,impact propagation 会反向遍历:

```text
write core
   |
   +--> feature 是 downstream
              |
              +--> app 是 downstream
```

遍历是 iterative、transitive、deduplicated 且稳定排序的。被写入的 project 自身不会出现在
`downstreamProjects`。

这是 impact reachability,不是写入下游 project 的权限。它只表示下游代码可能需要 verification,
或可能与另一个任务的 scope 发生关系。

## Impact Analysis 产生的 Risk Signal

| Signal               | 当前证据                                      |
| -------------------- | --------------------------------------------- |
| `ambiguous-selector` | Exact selector 匹配零个或多个 repository fact |
| `public-api-touch`   | 被预测写入的 symbol 是 exported               |
| `generated-artifact` | 被预测写入的 file 标记为 generated            |
| `high-fan-out`       | downstream project 数达到配置 threshold       |

`public-api-touch` 不声称 signature 已改变。更强的 `public-api-signature-change` 留给未来的
before/after observed analysis。

Signal 属于单个 task。只有另一个 task 确实触碰相关区域时,它才会成为 pairwise conflict reason。
一个 high-fan-out task 与完全独立的 task 之间不会仅因前者自身风险较高就制造假冲突。

## PredictedTaskImpact 输出

输出按粒度和证据来源组织:

```text
PredictedTaskImpact
├── taskId
├── projectsRead / projectsWritten
├── explicitProjectsWritten
├── filesRead / filesWritten
├── explicitFilesWritten
├── globFilesWritten
├── symbolDerivedFilesWritten
├── symbolsRead / symbolsWritten
├── sharedResources
├── sharedResourceAccesses:resource -> read | write | coordinate
├── downstreamProjects
└── riskSignals
```

所有 set 和 list 都采用稳定、与 locale 无关的顺序。同一个 repository 和 Task Contract 必须在
不同机器上产生相同的 Review 证据、cache key 输入和 scheduling decision。

## 从 Impact 到 Conflict

Conflict Engine 会按 canonical task ID 顺序比较两个 predicted impact:无论调用时哪个 task 是
第一个参数,都会先使用与 locale 无关的字符串比较对 task pair 排序。

```text
Impact A + Impact B + RepositoryGraph + Registry + Config
                         |
                         v
              比较 code overlap
              比较 shared resource
              比较 project relationship
              结合上下文处理 risk signal
                         |
                         v
              去重并稳定排序
                         |
               +---------+---------+
               |                   |
       是否有 hard constraint?     没有 constraint
               |                   |
               v                   v
       HardTaskConflict      RiskTaskConflict
```

实现位于 `libs/conflict-engine/src/lib/conflict-engine.ts` 中的
`DeterministicConflictEngine`。

## Code Overlap 规则

### 完全相同的 Symbol

两个任务预测写入同一个 symbol 时,会产生结构性 `same-symbol-write` constraint。

```text
A writes Service.search
B writes Service.search
            |
            v
hard + serialize
```

即使该 reason 的配置分数是零,它仍然是 hard。

### 同一文件里的不同 Symbol

如果两个 task 都是纯 symbol scope,并选择不同 symbol,Engine 会报告有分数的
`same-file-different-symbol` risk,不会虚构 hard constraint。

```text
A writes Service.first ----+
                            +--> 同一个物理文件 --> soft risk
B writes Service.second ---+
```

未来 Runtime Lease 只有在 observed write 始终保持在预测 symbol boundary 内时,才可能允许
symbol-level concurrency。

### Whole-file Overlap

如果任何一方有覆盖该文件的显式 project、file 或 glob scope,重叠就是 `same-file`,不是
sibling-symbol。这能防止 broad authority 伪装成精确 symbol scope。

### Repository Facts 上的 Producer-Consumer Overlap

当一个 task 预测写入某 file 或 symbol,另一个 task 预测读取它时,Engine 会增加一个有解释的
`producer-consumer` scored reason。它不会重写 functional DAG,也不会单独虚构 hard direction。
当前只有显式 producer-controlled resource policy 才会产生有方向的 hard constraint。

### Generated Overlap

当重叠 access 包含对 generated file 的预测写入时,会增加 `generated-code` reason。Generated
output 往往有更大 blast radius 或 regeneration requirement,因此需要单独的解释和权重。

## Project 与传播规则

- 两个 task 写同一个 project,产生 `same-project` reason;
- 一个 task 触碰另一个 task 写入 scope 的 downstream project,产生
  `upstream-downstream-project` reason;
- 只有 downstream 关系确实与另一个 task 相交时,`public-api-touch` 与 `high-fan-out` 才会变成
  pairwise reason。

除非同时存在独立 structural constraint,否则这些都是 scored risk。

## Hard Constraint 与 Scored Risk

这是整个设计中最重要的规则。

```text
                    TaskConflict
                         |
          +--------------+--------------+
          |                             |
 HardTaskConflict                RiskTaskConflict
 severity = hard                 severity = none | soft
 constraints = 非空              constraints = 空
 action = stagger | serialize    action = parallel | guarded |
                                          stagger | serialize
```

Hard conflict 之所以 hard,是因为存在 structural constraint,不是因为 score 超过 threshold。
Hard conflict 的 score 只用于解释。

Hard constraint 的例子:

- 完全相同的 symbol write;
- exclusive shared resource;
- ordered shared resource;
- producer-controlled 的竞争性 write 或 coordination;
- producer-controlled writer/reader 的方向约束。

Risk score 会把去重后的 reason weight 相加,并在 100 封顶。经过校验的 threshold 把非 hard
score 映射到 action。Score 为零时永远是 `parallel`,即使有人把 guarded-parallel threshold 也
配置为零。

未来 Scheduler 必须分别接收 hard conflict 与 risk conflict,绝不能按 score 过滤 hard
constraint。

## Conflict Edge 与 Ordering Edge

Pairwise conflict edge 是双向的:

```text
A <-------- 不能重叠执行 --------> B
```

Producer-consumer constraint 是有方向的:

```text
producer -------- 必须先完成 --------> consumer
```

Conflict Engine 同时保留两种含义。Canonical task ID 排序只负责稳定输出,绝不决定 producer
方向。方向来自真实 `write` 与 `read` access mode。

Milestone 6 不会修改 functional dependency graph。Milestone 7 可以根据该 constraint 推导
scheduling ordering edge,同时继续区分原始 task dependency fact。

## 完整示例

假设 project graph 和 registry 如下:

```text
web ------> search-api ------> search-core

search-index:producer-controlled
pnpm-lock.yaml:exclusive
```

Task A:

```text
write symbol search-core:SearchService.query
write shared-resource search-index
```

Task B:

```text
read project web
read shared-resource search-index
```

Impact A 包含:

```text
projectsWritten           { search-core }
filesWritten              { SearchService.query 所在文件 }
symbolDerivedFilesWritten { 同一个文件 }
symbolsWritten            { SearchService.query }
downstreamProjects        { search-api, web }
search-index access       write
public-api-touch          如果该 symbol exported
```

Impact B 包含:

```text
projectsRead              { web }
search-index access       read
```

Pairwise comparison 产生:

```text
reasons:
  producer-consumer
  upstream-downstream-project
  public-api-touch,如果适用

constraint:
  producerTaskId = A
  consumerTaskId = B

severity:hard
recommendedAction:stagger
```

Numeric score 用来解释附加风险,不会创建或删除 producer ordering。

## 失败行为

正常 analysis path 只会对显式命名但未知的 shared resource fail fast:

```text
UNKNOWN_SHARED_RESOURCE
resourceIds:经过排序的未知 ID
```

无法解析的 repository selector 不同:它会产生 `ambiguous-selector` signal。部分过期的 Task
Contract 仍可能用于保守 planning 和人工 Review,所以不会直接丢弃全部结果。

如果 Conflict Engine 收到手工构造或旧版本持久化、绕过正常 Analyzer 的 impact,它仍会对未注册
resource 保留 defensive soft fallback。

## 核心不变量

1. Repository fact 与 task prediction 相互独立。
2. Prediction 与未来 runtime observation 相互独立。
3. File 与 symbol selector 自动包含所属 ancestry。
4. Whole-file provenance 不能降级成 sibling-symbol 精度。
5. 正常 impact analysis 前,显式 shared-resource ID 必须解析成功。
6. Hard 来自 structural constraint,绝不来自 numeric threshold。
7. Producer direction 来自 write/read 语义,绝不来自 task ID 顺序。
8. Producer-controlled resource 的 read/read 保持可并行。
9. Risk signal 只有在另一个 task 触碰相关 scope 时才变成 pairwise reason。
10. 输出会去重并确定性排序。
11. Impact 与 conflict analysis 是只读的,不包含 LLM、Git、pnpm command 或 provider 逻辑。

## 本阶段不做什么

本阶段不会:

- 把自然语言任务解析成 contract;
- 证明预测写入一定发生;
- 观察 filesystem 或 process activity;
- 授予 write permission;
- 申请或强制执行 Write Lease;
- 决定哪个 ready task 现在启动;
- 执行 Agent;
- 创建 Git worktree 或 merge change;
- 持久化或恢复 orchestration run;
- 运行 verification command。

这些职责分别属于未来 planning、Scheduler、Runtime Guard、workspace、persistence、agent
execution 和 verification 层。

## 当前限制

- Selector matching 当前扫描内存中的 graph collection,还没有专门 lookup index;在已验证规模
  可以接受,但超大 graph 需要重新测量;
- project-to-file relationship 会在 impact expansion 和 conflict overlap 两处使用;任一表示
  改变时必须做一致性 Review;
- `coordinate` 有意采用保守语义,不表示 producer direction;
- Repository read/write overlap 产生 scored producer-consumer reason;目前只有显式
  producer-controlled resource 才产生有方向的 hard constraint;
- Observed impact collection 和 predicted-versus-observed reconciliation 尚未实现;
- 还没有 incremental impact cache;
- Policy configuration 当前由本地代码提供;面向用户的配置格式和 CLI integration 是未来工作。

## Milestone 7 怎样消费结果

Event-driven Scheduler 会组合四个输入,但不会把它们混成一种信息:

```text
functional DAG readiness
        +
hard scheduling constraint
        +
scored risk conflict
        +
runtime concurrency capacity
        |
        v
结构化、可审计的 dispatch decision
```

实现 dispatch 前,Scheduler event 与 decision reason 必须成为适合 persistence 和 replay 的
discriminated structured payload。Scheduler 不能引入隐藏的 execution-wave barrier,也绝不能
使用 hard conflict 的 score 判断 constraint 是否生效。
