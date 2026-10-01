# 项目进展说明(中文版)

> 面向对象:没有相关工作经验、需要快速了解"目前做完了什么"的读者。
> 本文只讲"做了什么、为什么这么做、现在能做到什么",不涉及具体代码写法。

## 这个项目要解决什么问题

设想有很多个"编码任务"(比如"给某个类加个方法"、"改一个接口的返回值"),需要交给多个
AI Agent 同时去写代码。如果两个 Agent 同时改同一个文件,或者一个任务其实依赖另一个任务先
完成,同时开工就会冲突或出错。

这个项目要做的,是一个**编排器**:在真正让 Agent 动手写代码之前,先通过分析代码库结构、
任务之间的依赖关系、任务会读写哪些文件/资源,自动算出"哪些任务可以安全地同时进行,哪些
必须排队"。目标是让并行开发的决策**有依据、可解释、可复现**,而不是"AI 感觉应该没问题"。

目前项目仍处于**打确定性地基的阶段**,但已经能够把真实 pnpm + TypeScript 仓库分析到
文件和代码符号层。它还不能计算任务对代码的实际影响,也不能调度 Agent 或让 Agent 写代码。

## 阶段一:搭建工程骨架

这一步不写业务逻辑,只是把"团队能开始写代码"的基础设施搭起来,相当于装修前先把水电线路
铺好。具体做了:

- **选定编程语言和运行环境**:用 TypeScript(一种给 JavaScript 加上类型检查的语言)写
  这个工具,运行在 Node.js 上。
- **建立多包仓库结构**:把项目拆成几个独立的"包"(package),而不是全部代码堆在一起。
  当前有三个包:
  - `apps/cli`:命令行入口,用户/其他程序通过命令行使用这个工具的地方。
  - `libs/domain`:核心业务概念的定义(下面阶段二详细讲)。
  - `libs/dag`:任务依赖关系图的计算引擎(下面阶段三详细讲)。
- **建立命令行外壳**:用一个叫 Commander 的库搭了命令行程序 `forge`,其中 `analyze`
  已在阶段六和阶段七实现;`plan` 仍然只是可发现的占位命令,要等规划引擎实现。
- **建立自动化质量检查**:
  - 自动格式化代码,保证团队每个人写的代码风格一致(工具:Oxfmt)。
  - 自动检查代码里的明显错误和坏味道(工具:Oxlint)。
  - 自动运行测试,验证代码行为是否符合预期(工具:Vitest)。
  - 这些检查合并成一条命令 `pnpm check`,提交代码前跑一下就知道有没有问题。

**这一阶段的成果**:一个能装进版本控制系统、能被任何团队成员一键搭建起来的空壳项目,
所有自动化检查工具都已就位。

## 阶段二:定义核心业务概念(领域模型)

这一步开始设计"这个编排器到底需要知道哪些信息才能做出判断",但暂时只写"定义",不写
"怎么计算"。可以理解成先把表格的列名定好,不急着填数据算法。

具体定义了 6 组核心概念:

1. **任务契约(Task Contract)**:描述一个编码任务长什么样——它叫什么、目标是什么、
   依赖哪些其他任务、预计会读哪些文件/写哪些文件、任务完成后要用什么方式验证(跑测试还
   是跑某个命令)。这一部分专门做了**格式校验**:比如不允许一个任务自己依赖自己,不允许
   重复填两个一样的依赖,不允许两个任务用同一个 ID。这些校验能在任务被真正执行前就拦截
   明显写错的任务定义。

2. **代码仓库结构图(Repository Graph)**:定义了"项目""文件""符号(比如某个类、
   某个函数)"这三层结构应该怎么表示,以及它们之间的依赖关系、引用关系怎么记录。阶段六和
   阶段七已经能用真实仓库的数据填充这张图。

3. **任务影响与冲突(Impact & Conflict)**:定义了"一个任务实际会影响到哪些项目/文件/
   符号""两个任务之间冲突有多严重(用 0-100 分表示)""冲突了该怎么处理(完全并行、
   加锁并行、错开时间、还是排队执行)"。这些都还只是"定义了长什么样",真正"怎么算出
   冲突分数"的逻辑还没写。

4. **执行计划(Execution）**:定义了"执行计划"应该是什么样子——一批一批的"波次
   (wave)",每一波里的任务可以同时跑。同样,"怎么排出这些波次"的算法还没写,这里只
   定义了结果长什么样。

5. **写入锁(Write Lease)**:这是防止冲突的关键机制——如果一个 Agent 要修改某个文件,
   必须先"申请一把锁",申请成功才能动手,防止另一个 Agent 同时改同一个地方。这一部分
   定义了锁的层级关系(比如:锁了整个项目,就等于锁住了里面所有文件和符号;锁了一个类,
   就等于锁住了它所有的方法),并且已经**写出了真正能运行的资源冲突判断逻辑**——给定
   两个可写资源,能准确判断它们的租约是否会冲突,这部分附带了测试。真正存储和管理活动
   租约的服务还没有实现。

6. **任务状态机(Task State)**:定义了一个任务从"待处理"到"完成"要经过哪些状态
   (待处理→就绪→运行中→阻塞/验证中→完成/失败/取消),以及哪些状态之间的跳转是合法的
   (比如不能从"待处理"直接跳到"已完成",必须按顺序走)。这部分**已经写出完整实现**,
   有测试覆盖了所有可能的状态跳转组合。

**这一阶段的成果**:6 组核心概念的"数据结构说明书"基本定稿,其中"写入锁冲突判断"和
"任务状态跳转规则"已经是可以直接使用的功能,其余部分是给后续阶段的实现打好的地基。

### 深入理解:Write Lease 是什么,怎样工作

**Write Lease(写租约)**是一份临时、独占的写入许可。Agent 在修改某个项目、文件、代码
符号或共享协调资源之前,必须先取得对应的租约。只有当前没有其他活动租约覆盖相同或包含关系
上的资源时,系统才会批准这次申请。

可以把 Lease 理解为"有所有者、有过期时间的预约"。普通 Lock 往往只有"已锁定/未锁定"
两个状态;Lease 还会记录谁持有它、属于哪一次运行和哪个任务、什么时候取得、什么时候过期,
以及当前版本是多少。如果 Agent 崩溃后没有执行释放,过期机制也能避免资源被永久占用。

#### 为什么只有任务依赖还不够

DAG 只能回答任务顺序是否允许两项任务同时开始,不知道它们写入的代码是否重叠。例如一个
任务修改 `ProductService` 整个类,另一个任务修改 `ProductService.search` 方法。两个任务
可能没有声明依赖,但类包含这个方法,同时写入可能让其中一个 Agent 的改动丢失。

三个层次的职责是:

```text
DAG             从任务依赖来看,逻辑上允许并行吗?
Conflict Engine 执行前预测的代码影响范围会重叠吗?
Write Lease     运行时这一次具体写入现在有授权吗?
```

预测出来的影响范围可能不完整。租约是运行时的安全边界:意外出现的写入也必须先取得许可。

#### 可写资源的层级

仓库里的可写资源具有明确的包含关系:

```text
项目(Project)
└── 文件(File)
    └── 符号(Symbol)
        └── 子符号

共享资源(独立的命名空间)
```

- **项目租约**覆盖该项目里的所有文件和符号。
- **文件租约**覆盖该文件里的所有符号。
- **符号租约**覆盖该符号及其子符号。
- **共享资源租约**覆盖一个命名的协调资源,例如数据库 schema、依赖集合、生成代码输出或
  API schema。

文件资源同时携带 `projectId` 和 `fileId`;符号资源携带 `projectId`、`fileId`、`symbolId`
以及完整的 `ancestorSymbolIds` 祖先列表。把完整层级存进资源身份以后,租约从数据库恢复时,
Guard 不需要重新加载 Repository Graph,也能知道某个方法属于哪个类。

#### 当前已经实现的精确冲突规则

确定性的 `areWritableResourcesConflicting(a, b)` 函数按以下顺序判断:

1. 共享资源只有在两边都是 shared resource 且 `resourceId` 相同时才冲突。
2. 不同项目里的仓库资源不冲突。
3. 同一个项目里,项目租约与任何文件或符号租约冲突。
4. 不同文件里的资源不冲突。
5. 同一个文件里,文件租约与任何符号租约冲突。
6. 两个符号指向同一个符号,或者其中一个是另一个的祖先时冲突;同级符号不冲突。

示例:

| 租约 A                  | 租约 B                  | 结果 | 原因         |
| ----------------------- | ----------------------- | ---- | ------------ |
| `project:catalog`       | `catalog/product.ts`    | 冲突 | 项目包含文件 |
| `product.ts`            | `ProductService.search` | 冲突 | 文件包含方法 |
| `ProductService`        | `ProductService.search` | 冲突 | 类包含方法   |
| `ProductService.search` | 同一个方法              | 冲突 | 相同符号     |
| `ProductService.search` | `ProductService.get`    | 允许 | 两个同级方法 |
| `catalog/product.ts`    | `catalog/price.ts`      | 允许 | 不同文件     |
| `database-schema`       | `database-schema`       | 冲突 | 相同共享资源 |
| `database-schema`       | `graphql-schema`        | 允许 | 不同共享资源 |

冲突函数是对称的:A 对 B 的判断结果永远和 B 对 A 相同。

#### 申请内容和租约所有权

一次租约申请需要说明:

- `runId`——属于哪一次编排运行;
- `agentId`——哪个 Agent 正在申请;
- `taskId`——正在执行哪个任务;
- `resource`——要写入哪个项目、文件、符号或共享资源;
- `mode`——目前固定为 `exclusive` 独占模式。

申请成功会返回 `granted`,其中包含租约 ID、版本、状态、取得时间和最近 heartbeat 时间;申请被阻塞会返回
`blocked`,并附上造成冲突的活动租约 ID。这样 Scheduler 可以解释"任务正在等谁",而不是
只报告一个原因不明的等待状态。

`runId` 可以避免旧运行留下的数据和新运行混淆,即使两次运行碰巧用了相同的 task ID 或
agent ID。它不代表不同 run 可以自动同时写一个 checkout;未来的 Guard 仍然必须检查保护
同一个工作区的所有活动租约。

#### Heartbeat、版本与失活恢复

长时间运行的任务需要持续发送 heartbeat。请求包含租约 ID 和 Agent 认为当前应该存在的版本。
如果数据库里的版本仍然一致,Guard 就增加版本号并记录新的存活证据;租约已经不存在时返回
`not-found`;存在更新版本时返回 `version-conflict` 和实际版本号。

这属于乐观并发控制。系统不能仅仅因为固定时长已过就释放租约;必须综合 heartbeat、Agent
存活状态、worktree 状态、宽限策略和明确的恢复证据,才能把租约标记为 `STALE` 并回收。

Release 携带 caller 的 expected lease version。匹配的 ACTIVE lease 返回带递增 version 的 `released`；
旧 version 返回 `version-conflict`；不存在或 non-active lease 返回 `not-found`。使用成功结果 version
重试时 cleanup 保持 idempotent，同时 delayed stale release 不会结束已经推进的 lease。

#### 未来 Runtime Guard 必须怎样安全地申请租约

完整服务需要执行:

```text
解析并校验资源身份
        ↓
读取 ACTIVE 租约并评估存活证据
        ↓
读取可能重叠的活动租约
        ↓
执行 areWritableResourcesConflicting()
        ↓
以原子方式创建新租约,或者返回 blocked
        ↓
长任务持续 heartbeat,有证据才标记 stale,集成完成后释放
```

"检查是否冲突"和"创建新租约"必须是一个不可分割的数据库操作。如果两个 Agent 都能在
对方写入租约之前看到"没有冲突",它们就可能同时被错误批准。未来的持久化实现必须使用
事务、串行化机制或等价约束,保证"检查 + 创建"具有原子性。

#### 当前已经实现什么,还没有实现什么

现在已经实现:

- 可写资源身份和完整层级;
- 确定、对称的包含关系冲突判断;
- acquire、heartbeat、mark-stale、release 的请求和结果合同;
- run、agent、task、版本、状态、取得时间、heartbeat、释放和 stale 证据字段;
- 主要冲突组合和独立资源组合的测试。

还没有实现:

- 具体的 `WriteGuard` 服务;
- 活动租约存储或 SQLite/Drizzle 持久化;
- 原子申请事务;
- heartbeat 处理、存活判断和 stale 恢复;
- 在 Agent 真正写入之前进行强制拦截;
- 阻塞任务队列、唤醒和崩溃恢复;
- 根据 Repository Graph 解析并校验资源身份。

准确的当前状态是:**租约合同和资源冲突判断已经可以工作;真正的租约申请、存储、heartbeat、
stale 恢复、释放和强制执行仍是未来工作。**

还有一个重要的实际限制。同一个文件里的两个同级方法可以分别取得符号租约,但如果两个 Agent
都采用"重写整个文件"的方式修改代码,Git 层面仍然可能冲突。只有实际写入范围能够限制并
校验在符号边界内时,符号级租约才安全;否则 Scheduler 必须申请更保守的文件级租约。未来的
独立 worktree、diff 边界校验、租约升级和受控合并必须与租约一起工作。Write Lease 是写入
授权层,不是 Git 集成的替代品。

## 阶段三:任务依赖图引擎(DAG)

这是第一个从头到尾完成的核心功能,也是后续所有规划引擎的排序地基。

### 什么是 DAG,它解决的是什么问题

DAG 全称 **Directed Acyclic Graph**(有向无环图)。拆开看三个词:

- **图(Graph)**:一堆"节点"(点)加上连接它们的"边"(线)。
- **有向(Directed)**:边是有方向的,不是双向的。比如"任务 B 依赖任务 A"画成一根箭头,
  从 A 指向 B,不能反过来理解成"A 依赖 B"。
- **无环(Acyclic)**:沿着箭头方向走,不可能走回到出发点。也就是不允许出现
  "A → B → C → A"这种绕一圈又回到起点的情况。

日常例子包括做菜的步骤依赖("先切菜"必须在"炒菜"之前)和大学选课的先修课要求
("线性代数"必须在"机器学习"之前)。项目管理甘特图里的任务依赖箭头也可以用 DAG 表示。

### 什么是甘特图

**甘特图(Gantt chart)**是一种用时间轴规划和跟踪项目的图表。左边每一行写一个任务,
时间从左向右展开。每个任务会画成一条横向长条:长条从哪里开始,表示任务什么时候开始;
在哪里结束,表示预计什么时候完成;长条有多长,表示预计需要多长时间。

一张常见的甘特图可以展示:

- **任务**——每一行具体要做的工作;
- **开始和结束时间**——任务长条在时间轴上的起点和终点;
- **持续时间**——任务长条的长度;
- **依赖关系**——例如用箭头表示"开发完成以后才能开始测试";
- **并行工作**——时间上互相重叠的任务长条;
- **里程碑**——重要但持续时间为零的检查点,通常画成菱形;
- **完成进度**——一项任务已经完成了多少;
- **关键路径**——决定整个项目最早完工时间的那条连续依赖链。关键路径上的任务一旦延期,
  如果没有从其他地方追回时间,整个项目也会跟着延期。

例如,一个简单的软件项目可以安排"设计"在第 1–2 天完成,"API 开发"和"界面开发"在
第 3–5 天同时进行,等两项开发都结束后再开始"集成测试"。甘特图的作用是让人一眼看懂
这些任务在日历上的安排。

甘特图和 DAG 有关系,但不能互相当成同一个东西。DAG 只记录"A 必须在 B 之前完成"这类
逻辑规则,不需要知道具体日期和预计工期;甘特图则把任务放到日历上,增加工期、截止时间、
完成进度,有时还包括人员或资源分配。调度器可以用一张合法的 DAG 加上工期估算来生成
甘特图,但 DAG 自己并不知道一个任务需要几个小时或几天。

这个项目目前只实现了 **DAG 依赖关系引擎**,还不会生成甘特图、估算任务工期、安排日历日期、
计算基于时间的关键路径或记录完成百分比。未来可以增加甘特图式界面来展示执行计划,但甘特图
只会是可视化结果,不会取代依赖图成为事实来源。

**它解决的核心问题是**:一堆"谁必须先做谁才能做"的规则,怎么保证这些规则本身没有逻辑
矛盾,并且能算出一个可执行的顺序。具体拆成三个子问题,正好对应这一模块实际实现的三个
功能:

- **这批依赖关系本身合法吗?**——检查一批任务的依赖关系是否合法:有没有任务 ID 填重了、
  有没有依赖了不存在的任务、有没有任务依赖了自己、有没有出现"A 依赖 B,B 又依赖 A"这种
  死循环(循环依赖下,没有任何一个任务能真正"先"完成,因为每个任务都在等一个最终等到
  自己的任务,永远排不出顺序)。如果有问题,会给出清晰的错误报告,而不是让程序莫名其妙
  卡死或算错。
- **如果合法,应该按什么顺序执行?**——在没有循环、没有缺失依赖的前提下,算出一个
  "先做哪个后做哪个"的合理顺序,并且当多个任务同时满足"可以开始"的条件时,会按照任务
  设置的优先级来决定先做哪个,保证"同样的输入,任何时候算出来的顺序都一样"(这个
  "顺序稳定性"是特意验证过的)。
- **现在这一刻,哪些任务可以立刻开始?**——给定"已经完成的任务列表"和"暂时不可用的
  任务列表",算出剩下的任务里哪些现在就可以开始执行(所有前置依赖都已完成)。这是判断
  "能不能并行"的直接依据——如果两个任务同时出现在"现在可以开始"的列表里,说明它们
  之间没有依赖关系,理论上可以同时执行。

这个模块经过特别验证,即使给它几万个连续依赖的任务(A 依赖 B,B 依赖 C,一直往下排几万
层),也能正确、快速地算出结果,不会因为任务数量太多而卡死或报错。

### DAG 在这个项目里解决的是哪一层问题

判断"哪些编码任务能安全并行"需要综合很多因素——依赖关系、代码冲突、共享资源占用、写入
锁等。**DAG 只负责其中"依赖关系"这一个维度**,回答的是最基础的问题:"不看代码冲突、
不看资源占用,单纯从任务声明的先后关系来看,这些任务的执行顺序有没有逻辑问题,以及现在
能开始的任务有哪些。"

后续规划的 Conflict Engine(判断两个任务是否会改同一段代码)、Scheduler(把"可以开始的
任务"和"冲突风险"结合起来,真正决定哪几个任务放进同一批并行执行)都是在 DAG 给出的
"合法顺序"基础之上,再叠加别的判断维度。DAG 是地基,不是全部答案——它保证的是"顺序不
出逻辑错误",不保证"两个顺序上没有依赖关系的任务改代码时不会打架"(那是 Write Lease
和 Conflict Engine 要解决的问题,目前还没实现)。

**这一阶段的成果**:一个可以直接拿来用的"任务排序计算器",输入一批任务及其依赖关系,
输出"这批任务有没有问题"以及"该按什么顺序、以什么节奏执行"。

## 阶段四:简化工作区工具链

项目根据当前规模建立了一套职责明确、容易检查的工作区工具组合:

- 用 pnpm(一个包管理工具)负责"几个包之间怎么互相引用"。
- 用 TypeScript 自带的"项目引用"功能负责"先编译哪个包、后编译哪个包"。
- 用 Vitest 自带的多项目功能负责"一次性跑完所有包的测试"。

这个决定写入了 ADR-009,并列出重新评估构建编排的可测量条件:包数量、CI 时长、重复的
affected/build-order 逻辑、watch 模式成本和可量化的缓存收益。

同时,这次改动顺手修复了一个真实问题:命令行工具(`apps/cli`)之前的配置文件里"声明"
了它用到 `domain` 和 `dag` 这两个包,但实际代码里根本没有用到,这是一个配置错误。这次
清理把这个错误的假依赖也一起删掉了。

**这一阶段的成果**:项目采用"多个包放在一个仓库里"的结构,工具职责清楚、配置可直接检查,
并且所有检查和构建结果都重新验证过。

## 阶段五:简化技术栈——统一 TypeScript 版本

TypeScript 最近出了一个"原生版本"(第 7 代),用其他编程语言重写了编译器核心,速度快
很多,但因为是新版本,一些老工具还没跟上,只支持"老版本"(第 6 代)提供的某些底层
接口。项目最初为了兼容"以后可能用到的老接口",同时装了第 6 代和第 7 代两个版本的
TypeScript。

后来发现:第 6 代版本目前完全没有代码在用它,纯粹是"预留",而两个版本同时存在会增加
维护负担、也容易让人搞不清楚"到底用的是哪个版本在检查代码"。于是把第 6 代版本删除,
项目现在只用一套 TypeScript(第 7 代)。

架构决策记录里也更新了说明:如果未来真的有某个功能(比如"读代码文件、理解代码结构"的
分析功能)确实需要老版本才能提供的接口,到时候再单独给那个功能加上,而不是现在就提前
装好、放着不用。

**这一阶段的成果**:项目现在只有一套编译器版本,减少了一个长期需要维护、解释、担心版本
不一致的负担。

## 阶段五b:用于持久化执行的 Temporal 运行时地基

这一阶段加入了第一个基于 Temporal 的持久化执行切片。目标不是一次把所有生产服务都接完,
而是先把工作流边界定下来,证明它可以用 Temporal 自己的 worker 和测试环境来验证,并保持
工作流的确定性。

Temporal 运行时现在有两个清晰职责:

- **工作流**只负责编排持久化步骤,输入和输出都保持为紧凑的 ID 和枚举;
- **Activity 层**则是以后真正运行 Forge 服务的地方,因为 side effect 只能放在 Activity 里。

### 现在这个 Temporal 切片做了什么

Temporal 运行时包现在包含:

- 工作流输入和结果的紧凑 Zod 合同;
- builder 执行、repair admission、输出集成和运行最终化的紧凑 Activity 合同;
- 一个 Scenario A 工作流,会重新评估运行、执行已授权 builder、评估输出、把 repair
  admission 从 repair execution 中拆开,并在最后完成 run state finalization;
- 一个 worker factory,它不再默认猜测 Activity 实现,而是要求显式传入 Forge Activities;
- 一组工作流测试,覆盖无任务、accept、repair、再次 reevaluate 这些路径。

### 第一次切片后修正了什么

第一次 M3.3 切片之后,review 发现了三个 authority 问题,并且已经在 workflow/contracts 层
修正:

- 工作流现在消费的是已授权的 builder start,而不是原始 scheduler 状态;
- repair admission 变成了独立的 Activity,放在 repair execution 之前;
- 工作流会在处理中再次 reevaluate,并且在结束时 finalizes run state。

### 现在已经验证了什么

下面这些检查已经通过:

- `pnpm exec tsc -b libs/temporal-runtime/tsconfig.lib.json apps/temporal-worker/tsconfig.app.json --force`
- `pnpm exec vitest run --config vitest.config.ts libs/temporal-runtime/src/lib/temporal-runtime.spec.ts`

Temporal 测试证明工作流可以正确走到这些分支:

- 没有任何已授权工作时的运行;
- 一个在评估后被接受的任务;
- 一个需要 repair admission 和 repair execution 的任务;
- 一个在 reevaluate 之后又发现了新已授权任务的运行。

### 还有什么没有完成

生产 worker 的 composition root 还没有接完。当前 `apps/temporal-worker` 包里仍然需要一个
真正的 adapter,用来构造 Forge services 并把它们传给 Temporal worker。现在的 worker 已经可以
更安全地关闭,但它仍然只是 runtime shell,还不是最终的生产 wiring。

### 这一阶段下一步能做什么

这一阶段让下一步可以直接去写真实的生产 worker composition root,而不用再猜工作流 contract
应该长什么样。下一阶段可以把持久化运行时依赖接进 Activity 层,而不是再修改 workflow 边界。

## 阶段六:读取真实的 pnpm 工作区

在这一阶段之前,"代码仓库结构图"还只是一套关于"仓库信息应该长什么样"的定义。测试可以
手工创建几个项目节点和依赖关系,但程序还不能打开一个真实仓库、自己找出这些信息。这一阶段
第一次打通了"磁盘上的真实文件"到"代码仓库结构图"之间的连接。

目前支持的输入是 **pnpm 工作区(pnpm workspace)**。pnpm 工作区就是一个包含多个 Node.js
项目包的仓库,其中 `pnpm-workspace.yaml` 文件负责说明这些包放在哪些目录;每个包里的
`package.json` 则记录这个包叫什么、依赖哪些其他包。新的分析器会依次完成以下工作:

1. 确认用户指定的目录确实是一个 pnpm 工作区。
2. 读取 `pnpm-workspace.yaml` 里的包路径规则,包括"排除某些目录"的规则。
3. 找到仓库根包以及所有符合规则的工作区包。
4. 读取每个包的名称,以及普通依赖、开发依赖、可选依赖和同级依赖。
5. 把"本仓库里的包互相依赖"转换成项目图里的连线。第三方依赖不会进入项目图,因为它们
   不是这个仓库里可以修改的项目。
6. 按固定顺序输出结果,保证同一个仓库没有变化时,每次分析得到的 JSON 都完全一致。

例如,如果一个应用声明自己依赖本地的 `domain` 包,结果里就会出现一条"应用 → domain"的
连线。这个方向表达的是"前一个项目需要后一个项目",和文件夹在磁盘上恰好按什么顺序排列
没有关系。

分析器也会保护输入边界。如果 YAML 或 JSON 写坏了、包没有可用名称、两个包重名、一个包
依赖自己、显式写了 `workspace:` 依赖但目标包不存在、仓库目录无法读取,或者工作区路径跑到
仓库外面,系统都会返回带错误类型的明确诊断,而不是悄悄生成一张不可信的图。

代码中保留了一个很小的"通用 Provider 接口",把"我要工作区事实"和"pnpm 具体把信息存
在哪里"分开。目前只实现 pnpm,因为它是现在唯一真实存在的需求。只有未来真的出现需要支持的
其他仓库格式时,才会增加新的 Provider。

`forge analyze` 现在已经不再是占位命令。运行:

```sh
forge analyze /某个/pnpm-工作区路径
```

会输出实际使用的 Provider、规范化后的仓库路径、发现的项目、项目目录、源码目录,以及项目
之间的本地依赖关系(JSON 格式)。实现既用专门准备的测试仓库验证过,也经过了命令行集成测试;
还真正分析了这个项目自身,正确找出了 5 个工作区项目和 4 条依赖关系。

### 真实仓库验证:Ingestion and Matching

分析器还实际运行在现有本地仓库上:

```text
~/Desktop/research-repositories/ingestion-and-matching
```

命令成功选择了 `pnpm-workspace` Provider,并识别出 3 个项目:

| 项目                        | 仓库内根目录    | 源码根目录          |
| --------------------------- | --------------- | ------------------- |
| `ingestion-and-matching`    | `.`             | 未声明              |
| `api`                       | `workspace/api` | `workspace/api/src` |
| `ingestion-and-matching-ui` | `workspace/ui`  | `workspace/ui/src`  |

结果中本地项目依赖边为 0 条。这个结果必须按当前能力范围理解:两个 workspace 包没有在
分析器目前读取的 `package.json` 依赖字段中,把对方声明成本地依赖。它**不能证明** API 和
UI 在代码层面完全没有关系。通过 TypeScript path alias、共享源码 import、生成类型、tRPC
合同或普通 import 建立的关系不属于当前阶段的分析范围;只有完成文件和符号分析后,这些关系
才会进入仓库图。

在阶段六结束时,CLI package 还没有注册 `forge` 可执行入口,因此当时经过验证的调用方式是:

```sh
node apps/cli/dist/main.js analyze \
  ~/Desktop/research-repositories/ingestion-and-matching
```

阶段七已经注册了可执行入口,改用 `pnpm exec forge`,见下一节。所以阶段六结束时的准确
能力是:**给定一个可读取的 pnpm workspace,构建后的 CLI 能发现
workspace 包,以及 package manifest 中明确表达的本地依赖关系;如果代码层关系没有写在这些
manifest 中,它目前还不能推断出来。**

### 当前阶段的"分析"到底是什么意思

`analyze` 这个词很容易让人误以为"AI 正在阅读和理解代码"。**目前完全不是这样**。这条
命令不会访问网络、不会把仓库内容发送给 LLM,也不做任何带概率的判断。它就是一个普通的、
确定性的程序:读取几个已知配置字段,再按照写死并经过测试的规则进行转换。因此只要输入没有
变化,无论谁来运行、有没有 AI 服务,都应该得到同一张项目图。

它也不等于一个简单的"递归列出所有文件"命令。目前它不会打印仓库里的每个目录和文件,只会
读取工作区定义、各包的 `package.json`,以及包里是否存在 `src` 目录。然后根据这些事实建立
一张**有业务含义的项目级地图**:包的身份、包的位置、源码根目录的位置,以及本地包之间的
依赖关系。

下面记录的阶段七已经使用确定性的 TypeScript 解析与类型检查 API,读取 TypeScript 文件、
import/export、声明和符号引用。未来 LLM 可以帮助把自然语言需求转换成结构化任务,或者真正
执行编码任务;但项目发现、依赖事实、冲突规则、写入授权和验证结果不能依赖 LLM 猜对。

阶段六刻意只做到**项目层级**;紧接着的阶段七已经消除了这项限制。

**这一阶段的成果**:编排器现在能打开一个真实的 pnpm 多包仓库,建立代码仓库地图的第一层。
这是项目第一次完整打通"用户输入 → 命令行 → 真实分析结果"的可用路径。

## 阶段七:RepositoryGraph——TypeScript 文件与符号分析

阶段六找出了 pnpm 仓库里有哪些项目包。阶段七继续把这份项目清单扩展成一张确定性的代码仓库
地图:每个项目拥有哪些 TypeScript 文件、文件里声明了哪些代码符号,以及项目、文件和符号之间
有哪些依赖或引用关系。

这**不是 LLM 分析**。`forge analyze` 不访问网络,不把源码发送给模型,也不会修改被分析仓库。
它把 pnpm manifest 与固定版本的 TypeScript 7 原生 API 组合起来,再把编译器确认的事实转换成
与具体工具无关的 `RepositoryGraph`。

更详细的代码级说明见[《RepositoryGraph 分析器——实现与工作机制》](./repository-graph-analysis.zh.md)。

### RepositoryGraph 包含什么

```text
RepositoryGraph
├── projects: ProjectNode[]
├── files: FileNode[]
├── symbols: SymbolNode[]
├── projectDependencies: Project -> Project
├── fileDependencies: File -> File
├── symbolReferences: Symbol -> Symbol
└── diagnostics: 分析警告
```

- `ProjectNode` 表示一个 pnpm workspace package。
- `FileNode` 表示一个由项目拥有的真实 TypeScript 文件。
- `SymbolNode` 表示 class、function、interface、method、property 等有名字的声明。
- 图中的边表示 TypeScript 或 package manifest 确实解析出了这条关系。它是事实证据,还不是
  “某个编码任务一定会修改这里”的预测。

### `forge analyze` 是怎样工作的

```text
forge analyze <repository>
        |
        v
解析仓库路径并选择 provider
        |
        v
PnpmWorkspaceGraphProvider
  ├── 读取 pnpm-workspace.yaml
  ├── 查找 package.json
  ├── 建立 ProjectNode
  └── 建立 manifest 项目依赖边
        |
        v
TypeScriptRepositoryAnalyzer
  ├── 查找根 tsconfig.json
  ├── 递归跟随 project references
  ├── 打开真实 TypeScript Program 与 Checker
  ├── 归属并去重源码文件
  ├── 建立文件依赖边
  ├── 把代码声明建立成 SymbolNode
  ├── 建立符号引用边
  ├── 反推出跨项目依赖
  └── 报告缺失、空项目和未覆盖文件
        |
        v
输出简洁摘要,或通过 --full 输出完整图
```

#### 1. 从 pnpm 发现项目

`PnpmWorkspaceGraphProvider` 读取 `pnpm-workspace.yaml`,展开其中的 package pattern,再解析根目录和
各 workspace 的 `package.json`。Package name 成为稳定项目 ID;仓库相对的 package root 和
source root 成为项目元数据。

Workspace package 之间声明的依赖会形成第一批项目依赖边。Provider 会拒绝损坏的 manifest、
重复 package name、自依赖、缺失的 `workspace:*` 目标、不可读仓库,以及解析后跑出仓库边界的
workspace 路径。

Provider 边界可以替换:领域图不依赖 pnpm 类型。pnpm 是当前已经实现的输入 provider,不是未来
所有仓库格式唯一的事实来源。

#### 2. 发现 TypeScript 配置

分析器从每个项目根 `tsconfig.json` 开始,解析支持注释和尾逗号的 TypeScript JSONC,并递归
跟随 `references`,找到真正参与编译的配置:

```text
tsconfig.json
├── tsconfig.app.json
├── tsconfig.spec.json
└── config/tsconfig.build.json
```

缺失、损坏、循环、不可读或跑出仓库的 reference 都会被确定地处理;非法输入会返回结构化错误,
而不是成功产生一张空图。普通 tsconfig 和“根配置只有 references”的 solution-style 仓库都能
正确分析。

所有已发现配置会交给固定版本的 TypeScript 7 原生 API。它建立的 Program 和 Checker 会遵守
目标仓库真实的 compiler options、module resolution、path alias、package exports 和 workspace
link。`unstable` API 路径只存在于 `libs/repository-analysis` 内部;原生 AST 和 Checker 不会进入
领域模型,项目也没有重新安装 TypeScript 6。

#### 3. 文件归属、身份和安全边界

每个源码文件归属于“真实文件路径上最具体的 pnpm 项目”。分析它的编译配置也必须属于同一个
项目,所以根项目或兄弟项目不能随意把自己的 Checker 借给其他项目源码。

在判断归属、仓库边界、图身份和去重以前,文件系统 symlink 会先解析成真实路径。因此多个
symlink 指向同一文件时,图里只有一个 `FileNode` 和一套符号。真实目标位于 `node_modules` 或
仓库外部的 symlink 会被排除。因为身份使用真实文件,`FileNode.path` 可能与 import 中写下的
symlink 路径不同。

文件 ID 由“所属项目 ID + 真实仓库相对路径”组成:

```text
api:workspace/api/src/modules/work/router.ts
```

生成文件路径会单独标记。ID 不包含行号,所以只在文件内移动声明不会改变身份。

当 production 和 spec/test 配置同时包含一个文件时,production context 优先。如果两个
production 配置重叠,当前用配置路径字母序最靠前者作为确定性 tie-break;这只保证结果可复现,
不代表它的 compiler options 在语义上更优。

#### 4. 建立文件依赖边

文件关系来自 TypeScript 已解析的 module 信息,不是字符串搜索。因此普通 import、export、
`export *`、多跳 re-export、path alias、bare workspace package 和共享源码 import 都可以解析到
真实目标 `FileNode`。

跨项目文件边还会提升成项目依赖边,再与前面从 manifest 得到的依赖合并。即使 workspace
manifest 没有显式声明依赖,图仍可能通过真实源码引用发现它。

#### 5. 建立符号索引和稳定身份

分析器会索引顶层 class、function、interface、type alias、enum、namespace 和 variable,以及
constructor、method、accessor 和 property。Namespace 内容会递归处理。父子层级、公开 export
状态和 private/protected 可见性都会保留。

Class/namespace declaration merging 使用固定 kind 优先级,并用 `mergedKinds` 记录所有参与类型,
因此结果不依赖声明顺序。动态 computed property 使用经过转义的表达式身份;getter/setter 共用
一个 callable symbol;多余外层括号会归一化;重复 property 只在相同表达式的出现次数中编号。

符号 ID 在文件 ID 后面增加稳定声明路径:

```text
api:workspace/api/src/modules/work/router.ts:createWorkRouter
```

#### 6. 建立符号引用边

TypeScript Checker 会把 identifier use 解析到真实 declaration。分析器把这些结果转换成去重后的
`Symbol -> Symbol` 边,包括跨文件、alias、re-export 和跨 workspace 项目的引用。请求会分成有
上限的 batch,控制临时 native handle 和内存压力。

#### 7. Diagnostics 与资源清理

分析成功后仍可能带 warning:

- `MISSING_TYPESCRIPT_CONFIGURATION`:项目没有根 TypeScript 配置;
- `EMPTY_TYPESCRIPT_PROJECT`:配置合法,但没有产生属于该项目的源码;
- `UNCOVERED_TYPESCRIPT_FILES`:磁盘上存在 TypeScript 文件,但没有被任何已发现配置覆盖。
  Diagnostic 会列出仓库相对路径,而不是静默猜一个错误的 Checker。

未覆盖文件比较会排除依赖、构建/覆盖率输出和嵌套 pnpm workspace。有意排除的生成文件仍可能
形成诊断噪声;未来策略可以把生成文件与手写文件分成不同严重级别。

Native 资源一定会清理:snapshot dispose 与 API close 都会尝试执行。原始结构化分析错误优先于
cleanup error,并保留原始 stack;只有 cleanup 失败时也不会静默忽略。

### CLI 用法和真实仓库结果

构建以后可以运行:

```sh
pnpm exec forge analyze /仓库路径
pnpm exec forge analyze /仓库路径 --full
```

摘要模式输出数量、项目、项目依赖和 diagnostics。`--full` 还会输出所有文件、符号、文件边和
符号边,大型仓库的 JSON 会非常大。

分析器已经反复在下面的真实研究仓库运行:

```text
~/Desktop/research-repositories/ingestion-and-matching
```

最终独立 Review 的最近一次采样是:

| 图中的事实      |   数量 |
| --------------- | -----: |
| 项目            |      3 |
| TypeScript 文件 |    959 |
| 建立索引的符号  |  7,224 |
| 项目依赖        |      3 |
| 文件依赖        |  3,424 |
| 符号引用        | 13,037 |
| Diagnostics     |      1 |

研究仓库仍在活跃修改,所以不同运行之间出现少量数字变化是正常的。稳定结论更重要:图一直能发现
`ingestion-and-matching-ui -> api`;唯一 warning 会列出磁盘上存在、但没有被
`workspace/api/tsconfig.json` 覆盖的 API scripts。

这些数字不表示工具理解了 7,224 个符号的业务含义。它表示系统建立了一份确定的结构索引:
声明在哪里,TypeScript 怎样解析它们之间的关系。这就是 Task Impact Engine 的事实输入。

### 加固时间线

多轮独立 Review 使用临时对抗仓库、本项目自分析和真实研究仓库验证边界。这里只保留简短时间
线,因为最终行为比逐轮 Review 叙事更重要:

| 顺序                 | 发现的问题                                                                | 简单修复                                                                                       |
| -------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 第一轮加固           | 嵌套 namespace、声明合并、modifier、computed name 和项目归属存在边界问题  | 增加递归索引、确定的 merged kinds、有类型的 modifier 检查、稳定 computed ID 和严格项目 context |
| Solution 布局 Review | 只有 references 的根配置可能得到 `0 files / 0 symbols`                    | 增加 JSONC 与递归 project-reference 发现;损坏 reference 明确失败                               |
| 归属/诊断 Review     | 项目子目录配置被拒绝、部分未覆盖文件静默消失、native 失败清理缺少集成测试 | 按最具体项目归属配置,增加 `UNCOVERED_TYPESCRIPT_FILES`,并测试真实 snapshot/API cleanup         |
| Symlink Review       | 同一真实文件通过多个 symlink 变成重复文件和符号                           | 真实路径统一负责归属、去重、边、ID 和仓库边界                                                  |
| 最终收尾             | 存在一次重复 `realpath`,公开路径语义不够明确                              | 删除重复系统调用,明确 FileNode 使用真实路径                                                    |

最终 Review 没有发现 Critical、High 或 Medium,并同意结束 RepositoryGraph 事实层专项 Review。

### 当前限制

- 只有被已发现配置覆盖的 TypeScript 系列文件会建立语义索引;它不是 JavaScript、SQL、数据库、
  CDK 或基础设施的万能分析器。
- 当前索引支持的有名声明类别,不是每一种匿名或深层 AST 结构。
- 已记录 export 状态,但还没有提取规范化 callable/type signature。
- 当前是全量扫描,还没有暴露增量 refresh 合同。
- 项目依赖边现在会记录 manifest、`workspace:` protocol、TypeScript project reference 和
  TypeScript import 这些大类证据;目前还没有继续细分 production/test/generated/runtime/type-only。
- 额外未覆盖文件 glob 只在约一千文件规模验证,还没有为数万文件仓库做 benchmark。
- 摘要 JSON 包含仓库绝对路径,分享日志时可能暴露本机用户名。
- `forge plan` 仍不可用;`forge analyze` 不会调度 Agent,也不会修改源码。

**这一阶段的成果**:`forge analyze` 已经能为真实 pnpm TypeScript 仓库建立经过测试的项目、
文件、符号、依赖、引用和 diagnostic 地图。架构里程碑 5 与 RepositoryGraph 事实层专项 Review
已经完成。下一阶段是 Task Impact Engine:把任务 selector 解析到这张图,再扩展出可解释的影响
范围。

### 进入 Task Impact 前的架构校准

在实现 Task Impact 前,项目按照最终产品责任边界重新检查了现有合同,并修正了几项受早期实现
形态影响的假设:

- `WorkspaceGraphProvider` 现在只表示“提供通用工作区事实”。pnpm 实现先返回
  `WorkspaceGraph`,TypeScript 分析器再把它丰富成 `RepositoryGraph`。
- 每个项目现在保留 `packageJsonPath`、依赖名称/版本/类型、`workspace:` 使用情况、scripts、
  source roots,以及属于该项目的全部已发现 `tsconfig` 路径。
- 项目依赖边带有 provenance。Manifest、workspace protocol、TypeScript reference 和
  TypeScript import 证据已经可以确定地生成与合并。
- Verification 支持带可选 `cwd` 的通用命令,也支持按 package name 指定 package script。
- Task Impact 分成 `PredictedTaskImpact` 与 `ObservedTaskImpact`;Planner 保持为另一个未来组件。
- Conflict 把 hard structural constraint 与 scored risk 分开;Scheduler 方法分别接收两组输入,
  不再接收一个混合的 scored list。
- Scheduler 合同改为事件驱动;初始 wave 只用于可视化,不是运行时 barrier。
- Task state 在验证与完成之间增加 `INTEGRATING`。
- Write Lease 使用 `ACTIVE`/`RELEASED`/`STALE`、带版本 heartbeat 与基于证据的 stale 恢复,
  不再因为固定时间到期就自动释放。

本次校准修改了合同和事实输出,但没有开始实现 Task Impact、Conflict Engine、Scheduler 或真实
Write Guard。改动后再次分析研究仓库,得到 3 个项目、963 个文件、7,263 个符号、3 条项目依赖、
3,440 条文件依赖、13,121 条符号引用;仍然只有同一条 API scripts 的 25 文件
`UNCOVERED_TYPESCRIPT_FILES` warning。项目依赖边现在能说明当前证据来自
`typescript-import`。

#### 独立 Review 后的修正

本轮独立合同 Review 没有发现 Critical,并确认两阶段 facts pipeline、provenance 方向与合并、
predicted/observed 边界、事件驱动形态和非 TTL 租约语义正确。进入 Task Impact 前已处理它提出的
High 与清理问题:

- `TaskConflict` 改成判别联合。`HardTaskConflict` 必须携带非空 constraint tuple,只能建议
  stagger/serialize;`RiskTaskConflict` 不能包含 constraint。Scheduler 方法把 hard 与 risk
  collection 作为两个独立必填参数。
- 删除重复的可选 `sourceRoot`,只保留 `sourceRoots`。
- 改为 `RepositoryGraph extends WorkspaceGraph`,共享事实字段由类型系统保证一致。
- 删除没有消费者的 `RepositoryAnalyzer` 和重复 `RepositoryAnalysisRequest`,不再为未实现的
  incremental analysis 保留抽象。
- 删除只有一个取值的 `ExecutionPlan.kind`,并增加显式 `lease-stale` scheduler event。
- 除层级租约测试外,增加“完全相同 symbol”租约冲突的独立测试。

Review 还指出 integration conflict 未来可能需要可恢复阻塞。当前状态机仍让 `INTEGRATING` 走向
终态,因为单一 `BLOCKED` 状态无法记住应该恢复到执行还是集成阶段。在 worktree integration
里程碑前必须设计 phase-aware resume model;现在增加一个有信息损失的 transition 只会掩盖问题。

Follow-up 独立 Review 已确认 H1、M1–M3、L1–L3 全部关闭,没有 Critical、High 或 Medium,并批准
结束合同校准、正式开始 Task Impact Engine。只剩一条不阻塞的 Low 记录:
`HardTaskConflict.score` 仍用于解释,所以未来 Scheduler 实现必须通过测试证明不会按 score
过滤或选择性执行 hard conflict。这是 Scheduler 里程碑的实现 Review gate,不是 Task Impact
的阻塞项。Review 对活跃研究仓库的最新采样为 963 个文件、7,265 个符号、3,440 条文件依赖和
13,123 条符号引用;相对上一次多 2 个符号属于研究仓库持续变化的正常漂移。

### Milestone 6 前的正式架构 Gate Review

第一次正式 architecture/code gate 已通过,没有 Blocker。Review 确认了 domain 依赖方向、Task
Contract、DAG、Repository Facts Layer、symbol graph、conflict 判别联合、lease 层级和 scheduler
边界。两项面向后续的 High 被作为新里程碑约束接受,不是里程碑 1–5 的缺陷:

- 预测分析必须区分“触碰 exported symbol”和“已经证明公开 API signature 改变”;
- Scheduler 实现前,event 和 decision reason 必须改成适合审计、持久化与 replay 的结构化 payload。

Review 同时保留了 worktree 阶段的 phase-aware integration blocking 设计,并要求 shared-resource
并发语义继续集中在 registry 中。没有要求返工 RepositoryGraph 或 DAG。

### Milestone 6:Task Impact、Shared Resource Registry 与 Conflict Engine

Milestone 6 已经实现为两个单向依赖的库:

```text
domain
  ^
task-impact
  ^
conflict-engine
```

`RepositoryTaskImpactAnalyzer` 会在只读 `RepositoryGraph` 上解析 `project`、`file`、`glob`、
`symbol` 与 `shared-resource` selector。文件和符号会自动补齐所属项目;写入项目会沿反向项目依赖
递归扩展,得到全部下游消费者。精确 selector 匹配 0 个或多个事实时会产生稳定、可解释的 ambiguity
signal;glob 则允许有意匹配多个文件。

可配置的 `SharedResourceRegistry` 会校验 resource ID 唯一性,支持 `exclusive`、`ordered` 和
`producer-controlled`。它能通过精确文件或 path pattern 附加规则,包括没有进入 TypeScript
semantic file graph 的 `package.json`。预测影响保留规范化的 `read`、`write`、`coordinate`
访问模式,不再把所有 shared-resource 使用压成一个 boolean。

任务可能写 exported symbol 时,风险信号现在明确叫 `public-api-touch`,不会声称
`public-api-signature-change`;后者必须等未来 observed before/after signature comparison 提供证据。
Generated write、下游高 fan-out 和 selector ambiguity 也会单独报告。

`DeterministicConflictEngine` 会按规范化 task pair 生成稳定 reasons、0–100 分数与建议动作。
Same-symbol write 和已注册 resource policy 会独立于分数形成 hard structural constraint。同文件的
sibling-symbol 写入、同项目写入、producer/consumer scope 重叠、generated code、上下游项目关系、
public API touch 与 high fan-out 保持为可解释的 scored risk。显式但未知的 shared-resource ID
会让 impact analysis 直接失败,不会静默削弱原本想要的 hard policy。Conflict Engine 只为绕过
正常验证的手工构造或旧持久化 impact 保留 soft fallback。

新增测试直接证明:

- 即使 same-symbol 权重配置为 0,它仍然是 hard conflict;
- 同文件 sibling symbols 是 soft risk,不会自动变成 hard conflict;
- exclusive、ordered、producer-controlled 保持三种不同语义;
- producer-controlled 的 read/read 可以并行;
- producer-controlled write/read 不受 task ID 排序影响,会保留 producer→consumer 方向;
  write/write 仍是无方向 serialization;
- sibling-symbol 只有两边都来自 symbol parent 且没有 project/file/glob 更宽 scope 时才成立;
- 即使配置 `guardedParallel: 0`,零分仍然只能建议 parallel;
- registry 已解析的 `package.json` 不会被误报成未解析 TypeScript 文件;
- 独立项目得到 0 分和 parallel 建议。

完整质量门已有 99 个测试通过。覆盖率为:语句 96.67%、分支 91.26%、函数 99.51%、行
96.60%。`pnpm build` 也通过。项目自分析现在得到 7 个项目、40 个 TypeScript 文件、477 个
符号、13 条项目依赖、62 条文件依赖、811 条符号引用和 2 条预期 root-project diagnostic。

本阶段完成后再次分析活跃研究仓库:3 个项目、968 个文件、7,309 个符号、3 条项目依赖、
3,446 条文件依赖、13,192 条符号引用,仍然只有一条覆盖 25 个 API scripts 的
`UNCOVERED_TYPESCRIPT_FILES` diagnostic。这次运行是 Repository Facts Layer 的回归验证。
`forge analyze` 仍然只返回仓库事实;Task Impact 与 Conflict Engine 当前是 library API,还没有
接入新的 CLI command。

#### Milestone 6 独立 Review 加固

独立 Review 没有发现 Critical,发现一项 High 的 shared-resource 发现缺口。Symbol selector 会
把所属文件和项目加入 impact,但没有把该文件交给 registry path rule。结果是:通过 symbol 表达的
migration 任务可能漏掉 `ordered` resource,而通过 file selector 表达的另一个任务却能找到。
现在 registry lookup 统一由 file recording 负责,file、glob、symbol selector 共用同一条路径。
新增集成回归测试会分析一个 symbol 任务和同一 ordered stream 中另一个不同文件任务,并强制要求
产生 `ordered-resource` hard constraint。

相关的 Medium project-selector 缺口也已关闭。Whole-project scope 会检查项目 manifest 和所有
已知所属文件的 resource rule,但 `filesWritten` 仍保持为空,不会把项目级 scope 伪装成“显式写
每一个文件”。对于第二项 Medium 设计问题,项目选择 fail-fast:显式未知 resource ID 会产生按
稳定顺序排列的 `TaskImpactAnalysisError`,code 为 `UNKNOWN_SHARED_RESOURCE`。

Low 的稳定排序观察也已关闭:reason/constraint comparator 增加 detail 作为最终 tie-break。
默认 `guardedParallel = 1` 保持不变,这是有意的保守默认值:只要检测到非零风险,至少需要 guard;
部署方仍可通过已校验的配置提高 threshold。

Follow-up Reviewer 独立重跑了 coverage、TypeScript build、Oxlint 与 whitespace validation,并
手工追踪 symbol/file ordered-resource 场景以及 project/unknown-ID 路径。93 个测试与覆盖率数字
完全一致,没有发现新问题,正式接受 Milestone 6:H1、M1、M2、L1 全部关闭,L2 按文档接受。

只保留一条非阻塞维护建议:project-level resource discovery 当前会独立遍历所属文件,没有与
`recordFile` 共用 helper。如果未来 per-file 行为不只 registry lookup,应提取一个无副作用的
resource-discovery helper,避免 project-level 路径漂移。本次不会仅为了这个 cosmetic seam 在验收
以后继续改代码。

#### 第二次正确性 Review:provenance、方向与零分动作

后续 ChatGPT Review 又发现三项 Milestone 6 正确性缺口。第一,保守的 `filesWritten` union 没有
保存文件为什么进入集合。一个同时声明 whole-file 与 symbol scope 的任务可能被误判成安全的
sibling-symbol 编辑。Predicted impact 现在分别保存显式 project write、显式 file write、glob
展开写入和 symbol-derived parent file。只有两边都是 symbol-derived,且没有更宽 scope 覆盖该
文件时,才允许 sibling-symbol 处理。

第二,producer-controlled resource 原来只有双向“不可并发”约束。现在一个 writer 加一个 reader
会形成机器可读的 `producer-consumer` constraint,携带真实 producer/consumer task ID,不依赖
canonical pair 排序。Read/read 仍可并行;writer/writer 仍为 hard serialization,不会虚构方向。
Conflict edge 仍是双向关系,该 constraint 则为未来 Scheduler 单独提供 ordering edge。

第三,自定义 `guardedParallel: 0` 可能让零分、`none` severity 的 conflict 建议 guarded parallel。
现在 action calculation 会在读取 threshold 前先让零分返回 `parallel`。六个回归场景覆盖 whole-file
provenance、project/glob coverage、canonical 排序两侧的 producer ID 和零分行为。Hard constraint
仍然与权重无关。本次 follow-up 严格限制在 Milestone 6,没有包含 Scheduler 工作。

最终独立 Review 重新运行了 99 个测试及覆盖率、TypeScript build、Oxlint 和 whitespace
validation,并且不只依赖测试断言,还手工推导了 provenance、task ID 反向排序和零 threshold 的
关键路径。Review 没有发现 Critical、High 或 Medium,并批准正式关闭 Milestone 6。保留两条供
后续 Review 注意的 Low 观察:

- project selector 展开影响时会处理一次 project-to-file 关系,Conflict Engine 用显式 project
  scope 与写入文件比较时也会处理一次。当前两处语义一致;未来任一表示发生变化时,必须一起
  检查一致性;
- producer-controlled resource 上的 `coordinate` 有意采用保守语义。它表达协调意图而不是
  有方向的 write,所以 coordinate/read 会形成无方向的 hard serialization constraint,不会虚构
  producer-consumer edge。

这两项都不改变已验收行为,也不阻塞 Milestone 7。

#### 独立 Task Impact 培训文档

Milestone 6 现在有独立的中英文培训补充文档:
[Task Impact 与 Conflict Analysis](./task-impact-analysis.zh.md)及其
[English edition](./task-impact-analysis.en.md)。文档面向没有编排器经验的读者,使用 ASCII
流程图和完整例子解释三层证据、selector resolution、write provenance、shared-resource policy、
downstream propagation、hard constraint 与 scored risk、conflict edge 与 ordering edge、当前
限制以及怎样把结果交给 Milestone 7。文档只描述已经验收的实现,没有引入新行为。

独立文档 Review 没有发现 Critical 或 High,并确认中英文结构、例子和结论等价。Review 发现一项
Medium 教学缺口:ambiguity 行为只在 symbol 小节说明,而 exact file 仅通过 shared-resource
registry path 解析时的例外仍是隐含的。两个版本现在都明确说明 project、file、symbol selector
会报告零个或多个 exact match;如果 registry path rule 已成功解析 graph 之外的资源,零个 graph
file match 则不算 ambiguous。Canonical task ordering 第一次出现时也补充说明了与 locale 无关的
task ID 排序不受调用参数顺序影响。本次没有改变任何实现行为。

#### OpenCode 接手文档

详细的操作 handover 已保存为 [OpenCode Engineering Handover](./opencode-handover.md)。它记录了
准确 Git 与 Review 状态、必须保护的未提交文件、已经废弃的 Nx/npm 选择、工具链与 package
边界、Milestone 1–6 已验收行为、真实仓库基线、已知限制、用户要求的 Review/commit/Obsidian
流程,以及 contract-first 的 Milestone 7 实现顺序、对抗测试和验收条件。文档明确区分强制架构
不变量与仍需显式设计决定的 Scheduler policy,避免接手 Agent 把建议直接变成产品行为。

## 阶段七:事件驱动 Scheduler

Scheduler 现在已经是一个可工作的库:每次收到运行时事件后,它会决定哪些任务可以启动。它不会运行
AI Agent,也不会修改文件。它的职责更窄且完全确定:把任务依赖、冲突事实、当前任务状态和剩余并发
容量组合成下一步可解释的决定。

在本阶段前,Scheduler contract 只有 event 名称和自由文本 reason。这样的信息不足以审计、持久化或
replay。现在 contract 改为结构化 event variant、runtime blocker record、task-state snapshot 和逐任务
decision reason。例如 lease release 会带准确的 lease ID;被阻塞任务会记录自己正在等待的 lease 或
runtime conflict。因此 release 只会唤醒真正匹配的任务,不会错误地解除全部任务的阻塞。

实现采用固定的 greedy policy:

```text
已完成的 functional dependency
        +
已完成的 directional producer
        +
priority,再按稳定 task ID
        +
hard constraint 与 risk policy
        +
剩余 concurrency
        |
        v
ready / start / block / unblock / cancel / defer decision
```

Hard constraint 绝不会按解释用的 score 过滤。当前还没有 Runtime Guard,因此 `parallel` 与
`guarded-parallel` risk 可以同时运行;后者仍会保留机器可读的审计证据。`stagger` 与 `serialize`
会 defer 后一个 candidate。Directional producer/consumer constraint 保持真实 writer-to-reader
方向,即使 task ID 的排序方向刚好相反也不会改变。

终态 prerequisite 不再让 dependent work 静默留在 pending。失败会为全部仍未终态的传递 functional
dependant 以及由 directional producer constraint 产生的 consumer 返回带 `dependency-failed` 的
cancellation decision。snapshot 中已经 `CANCELLED` 的 prerequisite 也会传递取消,但使用独立的
`dependency-cancelled` evidence,不会伪装成 failure。Runtime blocking 同样明确:只有 `RUNNING` task
可以进入 blocked;只有 snapshot 中 blocker 对应的 lease 或 runtime conflict release 才能让它回到 ready。

初始 wave plan 可以作为解释视图,但不会成为 runtime barrier。测试证明:A 和 B 同在 preview wave 0,
C 只依赖 A;当 A 完成、B 仍在运行时,只要 capacity 和 conflict 允许,C 可以立刻启动。

本阶段新增 `libs/scheduler`,它只依赖 `domain` 和 `dag`,不包含 LLM、pnpm、repository provider、Git、
workspace、persistence 或 agent-runtime 行为。由于还没有经过测试的 task-spec 输入路径或 execution
runtime,`forge plan` 仍然没有接入 Scheduler。

更详细的代码级教学模型见 [Scheduler Dispatch](./scheduler-dispatch.zh.md) 及其
[English edition](./scheduler-dispatch.en.md)。两份指南说明 Task Impact、Conflict Engine、Scheduler
与未来 Runtime Guard 的边界、structured snapshot/event、selection/risk policy、producer direction、
terminal propagation、exact runtime blocker release、no-wave-barrier rule，以及刻意未实现的 runtime
边界。

对抗测试覆盖 invalid graph/options、稳定 priority 排序、already-running capacity、零分 hard
constraint、same-symbol serialization、ordered/exclusive resource、sibling-symbol guarded risk、两种
字典序下的 producer direction、completion readiness、failure propagation、准确 runtime blocker release、
determinism 和 no-wave-barrier counterexample。

完整质量门有 125 个测试通过。覆盖率为:语句 96.95%、分支 91.92%、函数 99.60%、行 96.88%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

新增 Scheduler 后的本仓自分析得到 8 个 projects、44 个 TypeScript files、518 个 symbols、16 条
project dependencies、66 条 file dependencies、956 条 symbol references,仍是 2 条预期 root
diagnostic。活跃研究仓仍只有同一条已知的 25-file uncovered-script diagnostic;当前 3 个 projects、
1,010 个 files、7,617 个 symbols、3 条 project dependencies、3,592 条 file dependencies 和
13,893 条 symbol references 属于活跃仓库正常漂移,不是 Repository Facts Layer regression。

## 阶段八:Runtime Guard

项目现在包含一个内存 Runtime Guard：它是在一个 Node.js process 内授予或阻塞 exclusive write lease
的 live component。这是第一个能对具体 runtime write ownership 作出决定的层，不再只是在任务开始前
预测风险。

Guard 使用已有的 project/file/symbol/shared-resource hierarchy。较宽的 project lease 会阻塞该项目
内的 file 和 symbol；file lease 会阻塞其中 symbol；parent symbol 会阻塞 descendant；sibling symbol
可以独立；相同名称的 shared resource 会冲突。Guard 会串行化全部 operation，因此同时到达的冲突请求
不可能都看到空状态并同时获得 permission。

同一个 run、agent、task、resource 的 agent retry 会返回已有 ACTIVE lease。这让 retry 安全，但不会让
不同 agent 分享 lease。其他 owner 会收到稳定排序的 active conflicting lease ID list。

Lease 从 version 1 的 `ACTIVE` 开始。Heartbeat 必须提供 expected version；成功后 version 增加并记录
新的 liveness time。Stale transition 也要求 current version 和 outer runtime 提供的非空 evidence，例如
已确认 agent loss 且 workspace 未变化。Guard 刻意没有固定 timeout，绝不会仅因为时间流逝就判定
stale。`STALE` lease 不再阻塞 replacement。释放 active lease 返回 `released`；重复 release 返回
`not-found`，因此 cleanup 保持 idempotent。

当前实现有意保持 in-memory 和 process-local。它不会持久化 lease、在 process restart 后恢复、协调多个
Node.js process、把 user path 解析到 repository graph、观察 filesystem write，或自动通知 Scheduler。
这些边界留给后续 persistence 和 runtime integration。

有一项 Scheduler contract refinement 已记录到后续工作，而不会在本次 Runtime Guard 阶段顺手改动。
`task-failed` 会验证提供的 snapshot 已显示 `FAILED`；runtime blocker event 会自行应用 blocking
transition。其他 observation event 目前只请求重新 evaluation。在实现 event persistence/replay 前，项目
必须选择：要么为每个 observation event 验证匹配的 post-event state，要么在 domain contract 中把
state-observation event 与 runtime-evidence event 拆开。这是明确的 **Milestone 9 entry gate**，不是
可选 cleanup note：persistence 不能把当前隐含 convention 固化成永久 replay API。

Runtime Guard package 只依赖 `domain`，clock 和 lease-ID factory 可注入以支持 deterministic test，且不包含
database、Git、pnpm、CLI、provider 或 agent logic。对抗测试覆盖 hierarchy overlap、independent resource、
retry idempotency、concurrent acquisition、version conflict、stale evidence、stale replacement、release
idempotency、malformed request 和 duplicate generated ID。

更详细的代码级教学模型见 [Runtime Guard 与 Write Lease](./runtime-guard.zh.md) 及其
[English edition](./runtime-guard.en.md)。两份指南说明 resource containment、exact retry identity、
in-process operation serialization、versioned heartbeat、evidence-based stale recovery、idempotent
release、Scheduler event integration，以及有意未实现的 persistence 和 filesystem-enforcement behavior。

完整质量门现在有 154 个测试通过。覆盖率为语句 97.07%、分支 92.04%、函数 99.64%、行 97.00%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

独立 Review 没有发现 Critical、High 或 Medium。两个 Low finding 已在交接前修复：symbol lease 的
idempotency 现在把 ancestor collection 当作与顺序无关；一个不可达的 resource-comparison fallback
已删除。Follow-up test 还覆盖 broader-resource retry、concurrent heartbeat/release serialization 以及
invalid non-finite version。Guard package suite 现在有 22 个测试通过，statements/functions/lines 均为
100%，branches 为 96.15%。

## 阶段九:Persistence 与 Replay

本阶段让 orchestration evidence 能够在 process restart 后恢复。新的 `libs/persistence` 使用 SQLite、
Drizzle 和 `better-sqlite3`，但所有 SQLite、Drizzle 和 native driver type 都保留在 adapter 内。Domain
contract 保持 provider-neutral，因此未来其他 database 可以实现同一个 port。

建表之前，Scheduler replay contract 已经明确。Observation event 现在携带要求的 post-event task state：
completion/workspace integration 要求 `COMPLETED`，failure 要求 `FAILED`，verification completion 要求
`INTEGRATING`。如果提供的 input snapshot 未匹配，Scheduler 会拒绝 observation。Runtime blocker event
仍不同：它们是 Scheduler 自己应用到 input snapshot 的 evidence。

每次 persisted reevaluation 是一个 SQLite transaction：

```text
event + input snapshot + requested task transition + decision
        |
        v
一个正的 run-local sequence number
        |
        v
全部 commit 或全部 rollback
```

Run 保存 task contract、hard/risk conflict 和 schedule option。Current task impact/conflict/lease 按稳定
run-local key upsert。Event、transition、decision 是 append-only evidence。Structured JSON 保留 domain
`Set` collection 和 lease date。Recovery 会验证 stored JSON，而不是信任任意 database text，然后用保存的
input snapshot 让 Scheduler replay 每个 event。Replayed decision 必须完全匹配 persisted decision，否则
recovery 报告 integrity failure。

Follow-up persistence hardening 会验证 saved transition 精确匹配每个 non-deferred state-transition
decision，写入前和 replay 时都会验证。重复保存同一 sequence 只有全部 evidence 匹配才是 idempotent；
不同 evidence 会被拒绝。Impact/conflict/lease 的 relational key 必须匹配 payload identity，persisted lease
snapshot 不能 version regression，也不能用不同 evidence 覆盖同一 version。

SQLite adapter 有意只做 local scope。它不提供 multi-process write fencing、agent runtime、filesystem
observation、Git worktree、deployed database migration、automatic task execution 或 CLI command。实际 agent
write 被 enforce 前，后续 runtime 还必须使用 ownership-generation fencing token，而不是普通 heartbeat
lifecycle version。

更详细的代码级教学模型见 [Persistence 与 Replay](./persistence-replay.zh.md) 及其
[English edition](./persistence-replay.en.md)。两份指南说明 event meaning、input snapshot、atomic
reevaluation evidence、SQLite recovery、domain schema validation、decision replay，以及有意未实现的
cross-process 和 agent-runtime boundary。

Persistence test 覆盖 complete recovery、SQLite file reopen、Set/date round-trip、event-transition-decision
atomicity、transaction rollback、append-only sequence、decision replay mismatch、current-record upsert 以及
corrupted stored-state rejection。

完整质量门现在有 281 个测试通过。覆盖率为语句 96.68%、分支 91.63%、函数 98.61%、行 96.64%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

## 阶段十二:Pi Agent Adapter

Orchestrator 现在有第一个 real coding-agent backend seam。`libs/agent-runtime` 通过 private gateway 使用
`@mariozechner/pi-coding-agent` 实现 `PiAgentRunner`。Pi 保持在 provider-neutral `AgentRunner` port 之后：
Pi session object、message、tool definition 和 provider detail 不会进入 domain contract 或 orchestration runtime。

Pi gateway 创建 session 后调用带 provider-neutral session ref 的 `onStarted`。只有此时 durable attempt 才变为
`RUNNING`。Adapter 把 task goal 作为 Pi prompt，但 Pi 不能选择 scheduling、lease、workspace、persistence、
verification、Git integration 或 recovery policy。

Pi 使用 `noTools: "builtin"` 启动。唯一可用 tool 是 `forge_read`、`forge_list`、`forge_find`、`forge_edit` 和
`forge_write`。Mutation tool 经过 `AgentToolRuntime`：它把 path 限制在 task workspace 内，把 file resolve 成
resource，acquire/persist write lease，并记录 observed file write。冲突 tool write 不修改文件，返回 runtime
blocker，不允许 unsafe retry。没有 unrestricted shell、Pi built-in edit/write 或 agent-controlled Git lifecycle。

Pi test 使用 deterministic session gateway，不调用 paid model。Vertical scenario 组合 mock Pi tool request、
real SQLite persistence、InMemoryWriteGuard、GitWorkspaceManager、verifier 和 fast-forward integration，证明从
Pi intent 到 integrated repository change 和 durable evidence 的完整 controlled write path。

详细代码教学见 [Pi Agent Adapter](./pi-agent-adapter.zh.md) 和其
[English edition](./pi-agent-adapter.en.md)。

本阶段没有提供 authenticated production model setup、command sandbox、timeout/cancellation policy、
network/environment/secrets policy、automatic external-blocker retry、observed scope replanning 或 concurrent
execution。这些是后续 runtime hardening stage。

Pi SDK 使用 `noTools: "builtin"` 配置；这个配置禁用 built-in tool，同时保留 orchestrator 的 custom
`forge_*` tool。CI 不启动 production Pi model call。Injected session factory 验证 SDK tool configuration；deterministic test 会执行每个
custom tool definition，并覆盖 controlled call 和 error-result mapping。Runner 会拒绝乱序的 pre-establishment
tool call，避免它 acquire lease 或修改 workspace。真实 solution-style repository-analysis regression test 现在使用
scoped 30-second timeout，因为 full-workspace TypeScript analysis 在 load 下可能合理地超过 Vitest 默认 five-second limit。

后续 safety hardening 让 post-establishment Pi gateway 或 tool failure 重新 throw 给 runtime；runtime 会记录
`UNKNOWN` 并保留 ACTIVE lease，而不会把可能仍在运行的 Pi session 当作 safe failure。Tool write 会复用已经覆盖
目标的 task lease，立即 persistence cumulative observed impact，并拒绝 real target 逃出 task workspace 的 symlink path。
`PiAgentRunner.bindRuntimeAuthority` 会在每个 tool factory 创建 `AgentToolRuntime` 后提供 runtime 的 initial
impact 和 lease，避免某个 factory 意外遗漏复用 broader task lease 所需的 authority。
这个 realpath check 是 best effort，不能消除 concurrent filesystem TOCTOU replacement；descriptor-relative
sandboxed I/O 仍是后续 hardening。

完整质量门现在有 281 个测试通过。覆盖率为语句 96.68%、分支 91.63%、函数 98.61%、行 96.64%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

## 阶段十三:受控 Agent Command

Orchestrator 现在可以让 Pi agent 请求一个明确批准的 validation command，而不提供 arbitrary shell access。
`forge_command` 只接受 command ID。Runtime binding 提供 `AgentCommandPolicy`，为每个 ID 固定 executable、
argument vector、timeout、output limit 和完整 environment。Agent 不能选择 shell command、extra argument、
不同 working directory 或 environment variable。

Concrete local executor 在 task workspace 内用 `shell: false` 运行固定 command。它捕获有上限的 standard output/error，
把 nonzero exit 作为 tool error 返回，在 timeout/cancellation 时发送 `SIGTERM` 并在 bounded grace 后升级为
`SIGKILL`，同时报告 sanitized startup failure。
没有 command policy 时，Pi session 根本不启用 `forge_command`；Pi built-in `bash` 仍保持 disabled。

Command authority 是 durable execution identity 的一部分：canonical command-policy fingerprint 和 trusted path 会随
每个 attempt 保存，PREPARING recovery 会拒绝 changed authority 或缺少 identity 的 legacy attempt。Executor 接收
constructor-injected trusted path，而不是 ambient host `PATH`。当前 command definition 只声明 `validation`；这是一项
policy assertion，不是没有 side effect 的证明。Workspace-writing command 需要未来的 sandbox、matching lease 和基于 diff
的 observed-impact reconciliation。

这是 policy boundary，不是 operating-system sandbox。它不 isolate network access、secrets、filesystem permission、
process descendant、CPU 或 memory。这些控制需要后续 sandbox adapter，并且必须在允许 arbitrary command 或 concurrent
production agent 前完成设计。

详细代码教学见 [Controlled Agent Commands](./controlled-agent-commands.zh.md) 和其
[English edition](./controlled-agent-commands.en.md)。

完整质量门现在有 320 个测试通过。覆盖率为语句 96.72%、分支 91.74%、函数 98.69%、行 96.68%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

## 阶段十四:沙箱化 Validation Command

Validation command 现在通过 provider-neutral `AgentCommandSandbox` port 和 explicit execution profile 运行。默认
developer profile 是 `trusted-local`：固定 policy command 在 task worktree 内使用 developer host permission 运行，不需要
Docker。可选 hardened `docker-read-only` profile 使用 Docker Engine 或 Docker Desktop，在 macOS、Linux 和 Windows 上提供
network denial、read-only workspace mount、read-only container root 和 tmpfs `/tmp`。macOS `sandbox-exec` adapter 保留为
native developer-only option。Unsupported selected hardened profile 或缺少 adapter 时 fail closed；runtime 不会 fallback 到
unrestricted subprocess。

只有 `validation` command 使用这些 profile。`trusted-local` 是 developer trust model，不是 sandbox enforcement；
`docker-read-only` 限制 workspace 和 network effect。两者都不允许 workspace-writing command。Process descendant、
resource limit、image pinning、Docker daemon policy、native execution 的完整 readable-host isolation、live Pi cancellation
wiring、lease 下的 writable effect 和基于 diff 的 observed impact reconciliation 仍是未来 sandbox-runtime work。

详细代码教学见 [Sandboxed Agent Commands](./sandboxed-agent-commands.zh.md) 和其
[English edition](./sandboxed-agent-commands.en.md)。

完整质量门现在有 337 个测试通过。覆盖率为语句 96.68%、分支 91.59%、函数 98.59%、行 96.67%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

## 阶段十五:并行 Agent Execution

Runtime 现在会在 scheduler 配置的 `maxConcurrency` 范围内并发启动 independent task agent。每个 agent 仍有自己的
worktree、durable attempt 和 lease plan。Lease acquisition 发生 conflict 时，task 会在 agent 启动前 block；conflicting
lease release 后，现有 Scheduler unblock/retry evidence 允许 task 稍后运行。

Concurrency 有意只限于 external agent execution。Runtime 会串行化 workspace/lease preparation、durable attempt
transition、Scheduler event、verification、commit 和 Git integration。这样在 agent 工作真正重叠时仍保护 shared
integration ref，并维护 deterministic persistence/replay evidence。`forge_edit` 现在会在 read file 前 acquire write
authority，关闭原有 read-modify-write race。

并行执行使用 fail-stop structured concurrency。一个 fatal task error 会停止 dispatch 新 pending task，但
`startRun()` 会等待所有已启动 task pipeline settle 后才返回第一个 fatal error。这防止 caller 收到 run failure 后仍有
detached agent work 继续运行。
后续 sibling failure 当前会 settle，但不会 aggregate 到返回的 diagnostic 中。

Cross-process coordination、integration reservation、agent cancellation、unknown-attempt resume 和 writable-command
side-effect reconciliation 仍是未来工作。

完整质量门现在有 343 个测试通过。覆盖率为语句 96.62%、分支 91.39%、函数 98.62%、行 96.61%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

## 阶段十:Workspace 与 Git Lifecycle

Deterministic core 现在可以为每个 task 提供 isolated local Git worktree，并把完成的 task branch 安全
integrate 到一个 local integration ref。本阶段不运行 agent；它提供未来 outer runtime 在 task execution/
verification 可用后所需的 workspace/Git lifecycle。

创建 workspace 时，从 explicit base ref 创建 task branch，并把它放到 integration repository directory
外。Task 可以独立 commit，不会把 untracked worktree directory 放进 integration checkout。Integration
有意保守：

```text
task branch
   |
   v
rebase onto integration ref
   |
   v
fast-forward-only merge into integration ref
```

不会创建 implicit merge commit。Merge 前 integration repository 必须干净，并成功切换到指定
integration ref。Rebase conflict、dirty integration repository 或 failed fast-forward 都会创建 phase-aware
`INTEGRATION_BLOCKED` workspace record，保存 structured reason/conflict path。

Workspace integration state 有意独立于普通 task execution state：

```text
READY_TO_INTEGRATE
        |
        +--> INTEGRATION_BLOCKED
        |       |
        |       +--> external repair 后 resumeIntegration
        |       +--> abortIntegration
        |
        +--> INTEGRATED
```

这样不会使用有信息损失的 `INTEGRATING -> BLOCKED -> READY` shortcut。已经完成 execution/verification 的
task 即使 Git 需要人工修复，仍是 integration work。Rebase block 使用 `rebase --continue`/`rebase --abort`；
dirty-repository/fast-forward block 在外部原因修复后 retry normal integration。

Workspace record 按 run ID/workspace ID persistence，包含 blocked phase evidence。Explicit dispose call 才会
删除 worktree/task branch。默认 disposal 保护 uncommitted workspace change：返回 stable dirty path，而不是
删除。丢弃 dirty work 必须 `force: true` 并由 caller 提供 explicit reason。

Workspace record 还有 positive revision。Persistence 接受更高 revision 或 identical same-revision retry，拒绝
stale/conflicting evidence。Create/disposal 能恢复最小 interrupted lifecycle：matching existing worktree 可以复用，
removed worktree 但 branch 仍存在时可完成 disposal。Git command 是 asynchronous，NUL-delimited Git path output
会保留 unusual filename。

Git adapter 用真实 temporary Git repository 测试 create、rebase、fast-forward integration、conflict
block/abort/resolve/resume、dirty repository blocking、dirty disposal 和 cleanup。窄的 injectable Git command
runner 用于 deterministic process-failure diagnostic，不让 Git process type 进入 domain contract。

更详细的代码级教学模型见 [Workspace 与 Git Lifecycle](./workspace-git.zh.md) 及其
[English edition](./workspace-git.en.md)。两份指南说明 isolated worktree、phase-aware Git integration
blocking、rebase/resume/abort、fast-forward-only integration、persisted workspace evidence 和 dirty disposal
protection。

本阶段仍不 execute agent、不 observe filesystem write、不比较 observed/predicted scope、不在 write 时
acquire lease、不协调 multiple repository/process，也不自动修复 conflict。这些需要未来 agent/runtime layer
和 ownership-generation write fencing。

完整质量门现在有 281 个测试通过。覆盖率为语句 96.68%、分支 91.63%、函数 98.61%、行 96.64%。

## 阶段十一:Orchestration Runtime

Deterministic library 现在有一个 local application layer，可以演示它们组合后的 lifecycle。
`OrchestrationRuntime` 与 CLI 分开。它接收 Scheduler、persistence、WorkspaceManager、WriteGuard、
AgentRunner 和 TaskVerifier 的 domain port，因此这些 component 都不需要 import 或 trigger 另一个
infrastructure adapter。

第一版 runtime 有意只接受 `maxConcurrency: 1`。这样 Scheduler 的 `RUNNING` state 对应一个实际 serial
fake-agent execution，不会把 queued task 当作已经 running。Run 由 persisted `run-started` event 开始。每个
Scheduler start decision，runtime create/persist workspace、acquire/persist lease、调用 provider-neutral
fake agent、persistence agent outcome、release/persist lease、verify，最后 Git integrate。每个 Scheduler event 都会先 persistence input
snapshot、event、decision 和 non-deferred transition，之后 runtime 才更新 current snapshot。

Task observation 保留既有 replay rule：agent completion 先记录 `VERIFYING`，verification completion 先记录
`INTEGRATING`，successful integration 先记录 `COMPLETED`。Agent/verification failure 记录 `FAILED`，让
Scheduler cancel dependent task。如果随后 lease release 失败，runtime persistence `lease-release-failed`、把 run 标记为
`FAILED`，并在 verification/integration 前停止。Lease contention 记录 runtime blocker，但第一版 serial scope 没有
automatic retry。Integration block persistence 更新后的
workspace revision，并让 task 保持 `INTEGRATING` 以等待后续 recovery policy；第一版不 auto-repair/resume Git
conflict。

接入 real coding-agent backend 前，本阶段完成了 hardening。Scheduler `RUNNING` 现在只表示 dispatch
authorization；atomically persisted、revisioned 的 `AgentExecutionAttempt` 记录 external execution 是
`PREPARING`、`STARTING`、`RUNNING`、terminal 或 `UNKNOWN`。Restart 会把 unresolved start/run 变成 `UNKNOWN`，
不会假设 agent 存在。Task binding 现在包含 canonical multi-resource `TaskLeasePlan`。Runtime 以 deterministic
order acquire resource；如果后续 acquire blocked，会按 reverse order release 先前 lease，不留下 partial ownership。
Predicted-impact conversion 在没有完整 symbol ancestor evidence 时保守地把 symbol write 提升为 file lease。

后续 dispatch hardening 让 `PREPARING` attempt 可在 recovery 后安全继续 workspace/lease preparation。Project-wide
predicted write 会 dominate child file/symbol lease，不会错误缩小。Runner 在 `onStarted` 前 exception 会记录确定的
attempt/task failure；在 `onStarted` 后 exception 会记录 `UNKNOWN` outcome，并保留 ACTIVE lease，因为 external
actor 可能仍在 mutation workspace。两种情况都停止 verification/integration，并把 run 标记为 failed。
`PREPARING` recovery resume 前验证 persisted agent/workspace/lease-plan identity。Attempt schema 现在强制
state-specific timestamp/failure evidence。

新增 vertical test 组合 real SQLite persistence、InMemoryWriteGuard、GitWorkspaceManager、temporary integration
repository 和 deterministic writing agent。它证明 committed worktree edit fast-forward 到 integration branch，
durable attempt/workspace/lease evidence 可 recovery，并且 Scheduler replay 保持 deterministic。

Recovery 从 persisted event/decision evidence 重建 latest snapshot，包括 lease blocker projection，并返回 current
workspace/lease record。它有意不 restart unknown in-flight agent 或 reclaim lease：安全恢复这些 action 需要本阶段
之外的 durable agent identity 和 ownership-generation write fencing。

详细代码教学见 [Orchestration Runtime](./orchestration-runtime.zh.md) 和其
[English edition](./orchestration-runtime.en.md)。Test 覆盖 dependency chain success、agent failure、verification
failure、same-run/external-run lease blocking、lease-release failure evidence、pre-start/post-start runner throw、completed-without-onStarted protocol failure、identity-validated durable attempt recovery/resume、multi-resource rollback、real Git vertical integration、blocked Git integration、eventless recovery、current evidence recovery、
invalid binding 和 real SQLite replay。

完整质量门现在有 281 个测试通过。覆盖率为语句 96.68%、分支 91.63%、函数 98.61%、行 96.64%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

## 目前整体状态(截止到本文写作时)

- 架构规划的 12 个里程碑已全部实现。这不代表完整产品 100% 完成：authenticated model setup、command
  sandboxing、observed-scope enforcement、concurrent dispatch、provider routing 和 CLI runtime command 仍是
  当前 milestone 计划外的重要能力。
- `pnpm check` 会完成格式、lint、TypeScript 7 类型检查和测试。当前 281 个测试全部通过。
- 覆盖率为:语句 96.68%、分支 91.63%、函数 98.61%、行 96.64%;四项都达到至少 90% 的门槛。
- `pnpm build` 通过。`forge analyze` 已在 968 个文件的真实仓库验证;`forge plan` 仍然刻意
  保持不可用。
- Milestone 6 第二次正确性加固和 Milestone 7 实现都已经通过独立 Review 与 follow-up Review,没有
  Critical、High 或 Medium。Scheduler 中记录的 review finding 已修复，并在提交前独立重新验证。
- Milestone 8 Runtime Guard 已完成接受的 process-local in-memory scope，并已通过独立 Review。
- Milestone 9 Persistence 已完成接受的 local SQLite scope，并已通过独立 Review。
- Milestone 10 Workspace/Git 已完成接受的 local single-repository scope，并已通过独立 Review。Review 还
  重新验证 Date-aware lease idempotency 和 clean-target task-branch collision handling。
- Milestone 11 Orchestration Runtime 已完成接受的 local serial fake-agent scope，正在等待独立 Review 后才能提交。
- Milestone 12 Pi Agent Adapter 已在 independent review 后完成并关闭。Follow-up hardening 保留 post-start
  `UNKNOWN` ownership、复用 broader task lease、拒绝 static symlink escape、立即 persistence observed impact，并防止
  tool factory 遗漏 runtime authority。启用 concurrent dispatch 前，`forge_edit` 必须先 acquire authority 再 read；
  recovery 还必须从 workspace 或 Git change reconcile filesystem write 与 SQLite evidence 非原子窗口。
- Milestone 13 Controlled Agent Commands 已在 independent review 后完成并关闭。它只允许 fixed-policy command ID，
  有 runtime schema enforcement、executor-owned `PATH`、bounded output，以及 direct-child `SIGTERM` 到 `SIGKILL`
  escalation。Durable command-policy identity 防止 PREPARING recovery 时 authority 变化。它仍是 policy control，
  不是 process-tree 或 operating-system sandbox。
- Milestone 14 Sandboxed Validation Commands 已在 independent review 后完成并关闭。`trusted-local` 是带 fixed command
  policy 和 host permission 的默认 developer mode；`docker-read-only` 是在 macOS、Linux 和 Windows 上使用 Docker
  read-only workspace 和 network denial 的可选 hardened mode；macOS native adapter 是 developer-only。Writable command、
  process-tree control、resource limit 和 observed-impact reconciliation 仍是后续 sandbox work。

## 还没有实现的部分

- 调用 authenticated production Pi model 或 verification command。
- 在 sandbox policy boundary 内执行 arbitrary command。
- Dispatch 多个 concurrent agent、recovery unknown in-flight agent 或协调多个 process。

简单说:**编排器现在能为真实 TypeScript pnpm 仓库建立确定的结构地图,预测任务影响、比较冲突,
在事件发生后确定地决定哪些任务可以启动，在一个 process 内保护 exclusive write，从 SQLite 恢复
经过验证的 local orchestration evidence，用 Git integrate 一个 local task worktree，并把 mock Pi tool intent
经过 controlled lease 和 workspace write。它仍不会运行 authenticated production coding agent、观察完整 real-write
scope 或协调多个 process。**

## 阶段十六:自主 Plan 阶段

项目现在可以把用户请求或 Markdown specification 转换成经过确定性验证、理解仓库结构的 execution
proposal。这补上了“理解仓库”和“形成可以进入编排的安全任务”之间缺失的一层。

新增的 `libs/planning` 是 application layer，不是 model package，也不是 domain package。它定义
provider-neutral `PlannerAgent` port，并把每次 proposal 都当作不可信的 `unknown` 输入。Proposal 必须通过
完整流水线：

```text
用户请求 / Markdown specification
                 |
                 v
        PlannerAgent proposal
          （不可信 JSON）
                 |
                 v
        Task Contract 验证
                 |
                 v
          functional DAG 检查
                 |
                 v
    基于 Repository Facts 的 verification 检查
                 |
                 v
       selector 解析 + predicted impact
                 |
                 v
         hard/risk conflict 分析
                 |
                 v
         Scheduler plan 验证
                 |
                 v
        prepared orchestration plan
```

Malformed JSON、无效 Task Contract、缺失 dependency、dependency cycle、无法唯一解析的 exact
selector、未知 shared resource、不存在的 package script，以及无法调度的 constraint 组合都会在 dispatch
前被拒绝。这些错误会变成 structured diagnostic。Planner 可以收到 diagnostic 后重写 proposal，但循环受正数
`maxAttempts` 限制。次数耗尽后会 fail closed，并抛出 `AutonomousPlanningError`。Provider 或 authentication
失败会立即向外传播，因为这不是重写 task plan 能修复的问题。

Pi 是第一个 Planner adapter，但所有 Pi concern 仍留在 `libs/agent-runtime`。Isolated resource loader 会禁用
project context file、extension、skill、prompt template 和 theme；Planning session 启动时也会禁用全部 built-in
tool，只提供三个 Repository Facts tool：

- `forge_projects` 列出准确 project/package facts；
- `forge_files` 按 project/path prefix 过滤并分页读取 file identity；
- `forge_symbols` 搜索并分页读取 symbol identity。

这些工具查询已经构建好的内存 `RepositoryGraph`。它们不能读取任意 live filesystem path、不能运行
command，也不能修改 workspace。Stable pagination 避免把大型 symbol graph 一次性塞进 prompt。Pi 的
session、message 和 tool type 不会进入 domain 或 planning contract。

`forge plan <specification.md>` 现在是真实命令。它读取 Markdown，分析目标仓库，使用已配置的 Pi model，
执行有限次验证/修订循环，最后输出可 JSON 序列化的 Task Contract、predicted impact、结构上分离的 hard/risk
conflict、schedule option 和解释性 execution-wave preview。`--max-attempts` 与 `--max-concurrency` 都必须是
正整数。

本阶段有意停在 execution 前。Prepared plan 仍需绑定 run identity、agent、worktree、canonical lease plan、
command policy 和 persistence，并需要用户可见的 approve/run workflow，之后才能交给
`OrchestrationRuntime.startRun()`。因此 `forge plan` 不会创建 worktree、申请 lease、dispatch coding agent、
运行 verification、commit 代码或执行 Git integration。Planning wave 仍然只是解释，不是 runtime barrier。

CLI 现在可以通过 `--shared-resources` 读取可选的 JSON shared-resource policy。没有提供时会有意使用 empty
registry；如果 plan 引用了未知 resource，CLI 会明确提示缺少 policy file，而不是只让用户误以为 planner
输出错误。Command verification 仍可供非 autonomous 的 Task Contract caller 表达，但 autonomous planning 会
拒绝它；未来只有选择 validated command-policy ID、而不是携带 executable text 的新规则才能重新开放。
Explicit model routing/failover、plan persistence、human approval、自动 reviewer revision，以及
runtime `run/status/resume/cancel` command 也仍未实现。

第一次 Stage 16 独立 Review 发现了三个阻塞性 integration defect。第一，Pi SDK 0.73.1 会把
`noTools: "all"` 解释为空 allowlist，连 custom tool 也一起过滤，因此之前的 coding adapter 和新的 planning
adapter 在真实 session 中都可能没有任何 tool。两者现已改用 `noTools: "builtin"`；一条不 mock SDK 的
integration test 会验证所有受控 coding/planning tool 都真实进入 session，同时 built-in `bash` 不存在。两个
adapter 还会把受控名称作为 Pi 的显式 `tools` allowlist，排除无关 extension/custom tool definition。第二，
CLI test resolver 已补上 planning 的传递 DAG source dependency，因此 clean checkout 不需要预先 build package
output 也能测试。第三，planning 只会把 `SchedulerInputError` 当作可修订的 proposal rejection；unexpected
scheduler defect 会立即向外传播。

同一轮加固还引入了完全不执行 Pi project/global resource discovery 的 static planning resource loader、
project/file/symbol tool 的服务端 pagination cap、上述 shared-resource policy 入口，以及
`PreparedOrchestrationPlan` 尚未绑定 runtime、不能直接执行的类型注释。一个已知 selector 限制仍保留：glob
目前只能解析已经存在的 repository fact；如果 glob 只描述未来将创建的文件，在设计 planned-creation
selector 前仍会被拒绝。

独立修复复审已经同意关闭 Stage 16。复审留下的两个非阻塞测试建议也在交接前补齐：CLI test 现在锁定
missing file、malformed JSON 和 schema validation policy error 都会直接向外传播；fact-tool test 则覆盖
zero、negative、fractional、non-finite、non-numeric 和超过上限的 pagination limit。这些 test 只增加回归
保护，不改变已经通过复审的 production behavior。

最后一次 Plan-to-Run closure review 又发现两个 verification authority 缺口和一个 provider lifecycle 缺口。
现在每个 autonomous task 都必须至少包含一条由 Repository Facts 验证的 package-script rule；任何 free-form
command verification 都会被拒绝，即使同一个 task 还带有合法 package script。这个 policy 只放在
`libs/planning`，没有修改通用 Task Contract，因此 manual 或未来 non-autonomous workflow 仍保留原有 domain
表达能力。Pi planning adapter 也会通过 `finally` 在成功、provider failure 或 malformed response 后 dispose
每一个 one-response session。Planner prompt 会说明同样限制，但真正的 authority 仍是 deterministic validation。

更详细的初学者说明见英文文档 [Autonomous Planning](./autonomous-planning.en.md)。ADR-020 记录 trust
boundary、revision rule，以及 prepared plan 与 runtime authority 之间的边界。

最终 local quality gate 有 380 个 test 全部通过。覆盖率为语句 96.48%、分支 91.67%、函数 97.20%、行
96.46%。`planning` package 的 standalone gate 四项均达到 100%；`agent-runtime` standalone 分支覆盖率为
90.79%。`pnpm check`、`pnpm build` 和 `git diff --check` 均通过。

Repository Facts regression 也通过。Self-analysis 当前得到 14 个 project、89 个 file、1,252 个 symbol、
46 条 project dependency、158 条 file dependency、2,266 条 symbol reference，以及两个已知 root
configuration diagnostic。活跃的 ingestion-and-matching 研究仓库得到 3 个 project、1,010 个 file、7,617
个 symbol、3 条 project dependency、3,592 条 file dependency、13,893 条 symbol reference，以及同一个已知
`UNCOVERED_TYPESCRIPT_FILES` warning：API 的 25 个 script file 未被现有 tsconfig 覆盖。

本次没有对该研究仓库执行 live Pi-backed `forge plan` smoke test。该操作会把 repository-derived
project/file/symbol facts 发送给当前配置的 external model destination，而本 session 没有得到该数据外发的明确
授权。Deterministic fake-planner、Pi gateway/tool、isolated resource-loader、CLI composition 和 rejection
path test 已完成；经过授权的 live-model smoke 是后续 review/deployment check，不能在这里被暗示为已经成功。

## Stage 17：Semantic Plan Review

Stage 17 把“task plan 结构合法”与“task plan 看起来覆盖了用户需求”拆成两个不同问题。Deterministic
repository/scheduling logic 无法证明自然语言需求完整性，因此项目现在定义 provider-neutral
`SemanticPlanReviewer`，把它作为第二个不可信 semantic role。

Reviewer 接收原始 source、已经通过 deterministic validation 的 Task Specification，以及已经构建好的
RepositoryGraph。Response 在 `semanticPlanReviewSchema` 接受 structured requirement map 前始终是 `unknown`。
每项 requirement 只能是 `covered`、`missing` 或 `ambiguous`。Covered item 必须引用至少一个已知 task；只有全部
item covered 时 `accept` 才合法；`revise` 必须指出至少一个 gap。Duplicate requirement、unknown task ID、互相
矛盾的 recommendation、malformed JSON 和非 object value 都会 fail closed。

Missing/ambiguous item 会变成稳定的 `SEMANTIC_REQUIREMENT_GAP`，交给下一次 Planner attempt。它们共享现有正数
`maxAttempts` budget，因此 semantic revision 不会无限循环。Reviewer formatting/provider failure 不会被包装成
Planner revision，因为 Planner 无法修复这条 infrastructure path。Reviewer 给出 accept recommendation 后，系统
会从 schema-cloned specification 再次执行完整 Task Contract、DAG、verification、impact、conflict 与 Scheduler
pipeline，之后才能返回 `PreparedOrchestrationPlan`。

`PiSemanticPlanReviewer` 位于 `libs/agent-runtime`，使用独立 one-response Pi session 和与 planning 相同的 isolated
resource boundary。Fact surface 现在增加第四个只读工具 `forge_relationships`，用于分页查询 project dependency、
file dependency 与 symbol reference。它支持 incoming/outgoing/either filter，并在 server 端限制每页最多 500 条
edge。Planner 与 Reviewer 都没有 live filesystem mutation 或 command capability。Session cleanup 也已加固：如果
provider operation 与 dispose 同时失败，原始 provider failure 不会被 cleanup error 覆盖。

CLI 现在要求 `--semantic-review`，作为 additional model call 接收 specification 与只读 repository facts 的显式
consent gate。没有该参数时，Commander 会在 planning composition root 运行前拒绝命令。Accepted semantic
recommendation 会作为 advisory evidence 一起序列化，但它不是 human approval，也不能启动 run。

ADR-021 记录了这个 trust boundary。独立初学者培训文档见[英文](./semantic-plan-review.en.md)与
[中文](./semantic-plan-review.zh.md)。Human approval、plan/repository fingerprint、durable planning evidence、
runtime binding 和 `forge run` 是下一阶段的 Plan-to-Run 工作。

Stage 17 local gate 有 29 个 test file、397 个 test 全部通过。覆盖率为 statement 96.46%、branch 91.33%、
function 96.85%、line 96.43%；`pnpm check`、`pnpm build` 与 `git diff --check` 通过。Self-analysis 得到 14 个
project、93 个 file、1,285 个 symbol、46 条 project dependency、171 条 file dependency、2,331 条 symbol
reference，以及同样两个已知 root configuration diagnostic。Ingestion-and-matching 研究仓库保持稳定：3 个
project、1,010 个 file、7,617 个 symbol、3 条 project dependency、3,592 条 file dependency、13,893 条
symbol reference，以及一个已知的 25-file `UNCOVERED_TYPESCRIPT_FILES` diagnostic。本阶段没有执行 live Planner
或 Reviewer model call；automated adapter test 使用 controlled gateway，真实 CLI 数据外发现在需要显式 review
consent。

## Stage 18：Durable Plan Artifact 与 Repository Snapshot Identity

Stage 18 关闭第一个 Plan-to-Run authority gap：已经验证的内存计划现在会成为 durable、immutable decision
artifact，并绑定规划时使用的准确 repository evidence。本阶段仍然不会批准或执行 artifact。

`PlanArtifact` 有 schema version 且完全 JSON-safe。它记录 artifact ID/revision/time、完整 planning source、source
fingerprint、repository identity 与 real root、Git base commit、working-tree fingerprint 与 dirty state、canonical
Repository Facts fingerprint、shared-resource/verification policy fingerprint、Task Specification、predicted impact、
hard/risk conflict、schedule、execution preview、semantic-review evidence，以及覆盖完整 payload 的总 fingerprint。
Predicted Set 会序列化成稳定、唯一的 array。

Schema 不只验证 field shape，也验证关系：每个 task 必须恰好有一个 impact、并在 execution wave 中恰好出现一次；
wave index 必须连续、满足声明的 dependency order，且 wave 宽度不能超过 `maxConcurrency`；conflict endpoint 必须
是两个不同的已知 task，同一个无序 task pair 不能在 hard/risk collection 内部或之间重复；semantic-review task
citation 必须存在于 Task Specification；hard/risk collection 不能互换。Array 形态的 shared-resource access、access
mode 与 risk signal 会被规范化，并由 schema 校验唯一、canonical 顺序。只修改 source 或 decision 而不更新
fingerprint 会 fail closed。

`GitRepositorySnapshotProvider` 绑定的不只是 `HEAD`。它会对所有 tracked 和 untracked non-ignored entry 的
length-framed path、filesystem mode、kind 与 bytes 做 hash；symlink hash link text，不跟随 target。Origin URL 用于
跨 clone repository identity，没有 origin 时使用 real local root，因此不同 real path 的 clone 会有意得到不同 ID。
Ignored build/cache state 有意不属于 Git source identity；Git submodule 与 Unicode NFD normalization + lowercase
conversion 后冲突的 path 都会 fail closed，系统不会假装已经 fingerprint mutable nested worktree 或不可移植的文件
身份。这里不声称实现完整的 Unicode case folding。

真实 CLI 会在 RepositoryGraph analysis 前后各抓一次 snapshot。Repository ID/root、base commit、working-tree
fingerprint 或 dirty state 只要变化，就抛出 `RepositorySnapshotChangedError`，不会发布 mixed-state artifact。
`repositoryBindingMismatches` 为未来 approval/runtime binder 提供明确的 repository-ID、commit、working-tree 与
facts mismatch。它已经实现并测试，但 Stage 18 有意没有 production caller。Stage 19 的
`PlanExecutionBinder` 必须在创建 runtime request 前拒绝任何 `repositoryId`、`baseCommit`、
`workingTreeFingerprint` 或 `factsFingerprint` mismatch。

`JsonFilePlanArtifactStore` 在 infrastructure persistence package 中实现 planning store port。它先写唯一临时文件，
再用 atomic hard link 发布 `<artifact-id>.r<revision>.json`。并发保存完全相同内容是 idempotent；不同内容不能覆盖
同一 revision。Corrupt content、filename/payload 不一致、path traversal ID、非法 revision 与 fingerprint mismatch
都会 fail closed。`forge plan` 默认把 artifact 保存到 `~/.forge/plans/<repository-id>`，也可以用
`--plan-directory` 指定仓库之外的其他位置。位于仓库内或通过 symlink 指回仓库内的 destination 会 fail closed，
因为 artifact persistence 不能让刚刚记录的 snapshot 自己失效。Save 会在 directory 创建前、创建后，以及临时
文件写入前立即重新解析并检查 destination，覆盖“原先不存在的 ancestor 在保存前被换成仓库内 symlink”的场景；
cleanup failure 不会掩盖已经产生的 publish/immutability 主要错误，而 cleanup-only failure 仍会返回。Planning 仍
不会创建 runtime
run/worktree/lease，不会 dispatch agent、执行 verification 或 Git integration。

第一次 Stage 18 独立 Review 发现一个 Critical storage-boundary race、三个 High 加固缺口和三个 Medium
一致性/文档缺口。本轮已在 save 内重新解析 path、对不可移植 path collision fail closed、保留 primary error、规范化
array-shaped impact evidence，并拒绝 self-conflict、duplicate conflict pair、违反 dependency 的 wave 和超过 schedule
上限的 wave。Review 同时确认 repository runtime comparison 属于 Stage 19 binder responsibility，且 local-root fallback
具有 path-specific 语义。新增对抗测试锁定这些保证；没有新增 runtime execution capability。

修复复审独立重现了 race test、完整项目 gate、planning-only coverage、Scheduler readiness 行为与 runtime dispatch
行为，并同意关闭 Stage 18。其余非阻塞建议也已在关闭前处理：storage 在写入前增加第三次 confinement check；新增
正常非冲突 path 与 cleanup-only failure propagation 专项测试；Unicode 措辞与真实的 NFD + lowercase 算法一致；
ADR-022 明确点名 `PlanExecutionBinder` 与四个必须校验的 binding field。

最终 whole-architecture gate 针对 commit `2356dc062967703c75094a7707dfc0739f9b4bd5` 给出 Stage 18 **PASS /
CLOSED**。它确认 durable identity、dirty/untracked source binding、Repository Facts binding、mixed-state rejection、
canonical cross-record validation、immutable publication、repository-external storage 与未来 rebinding contract 已共同
形成完整的 Plan/Execute authority boundary，没有发现新的 Stage 18 P1。

仍有两个明确的非阻塞 deployment limitation。第一，repository identity 直接 hash 原始 origin URL，所以同一 remote
的 SSH 与 HTTPS 写法会得到不同的 fail-closed ID；remote canonicalization 属于未来 distributed-worker/product
integration。第二，多次 real-path check 能降低普通 symlink race，但 pathname API 无法提供抵御 hostile concurrent
local process 的 atomic directory-descriptor confinement；更强保证不属于当前 single-user local threat model。

ADR-022 记录该边界。独立初学者培训文档见[英文](./plan-artifact.en.md)与[中文](./plan-artifact.zh.md)。Architecture
文档也已修正 observed write 的旧描述：受控 `forge_write`/`forge_edit` capture 已实现；完整 observed-impact
reconciliation 与 dynamic conflict recomputation 仍未实现。

Stage 18 local gate 有 32 个 test file、427 个 test 全部通过。覆盖率为 statement 96.28%、branch 91.32%、
function 97.16%、line 96.24%。Planning-only gate 有 41 个 test，覆盖率为 statement 99.06%、branch 95.70%、
function 98.68%、line 99.01%。`pnpm check`、`pnpm build` 与 `git diff --check` 通过。Self-analysis 得到 14 个 project、99 个 file、1,388 个 symbol、49 条 project dependency、188 条 file dependency、2,510 条 symbol reference，以及
同样两个已知 root configuration diagnostic。Ingestion-and-matching 研究仓库保持 3 个 project、1,010 个 file、
7,617 个 symbol、3 条 project dependency、3,592 条 file dependency、13,893 条 symbol reference，以及已知的
25-file `UNCOVERED_TYPESCRIPT_FILES` diagnostic。本阶段没有执行 live Pi plan，因为 Stage 18 修改的是 deterministic
artifact authority 和本地 persistence，不是 model behavior。

Stage 19 正式定义为 **Approval + Execution Binding**。`PlanApproval` 是独立、provider-neutral 的事实记录，必须包含
准确 artifact ID、revision、`planFingerprint`、approving actor 与 approval time；它不能成为嵌入 immutable
PlanArtifact 的 `approved: true` flag。`PlanExecutionBinder` 必须加载并验证该准确 artifact、验证 exact approval、重新
抓取 repository snapshot 与 Repository Facts、拒绝所有 repository binding mismatch、重新验证当前 shared-resource
与 verification authority fingerprint，然后才能生成唯一 canonical runtime request。CLI 只负责 composition/I/O，
不能手工拼装 agent、workspace、lease、command-policy、sandbox、model 或 runtime binding。

## Stage 19：Plan Approval 与 Execution Binding

Stage 19 已完成并通过独立 Review。它关闭 Plan-to-Run boundary 中 deterministic approval 的一半，但不会
假装“approved plan”已经是可运行的 deployment request。

`PlanApproval` 是独立、带 schema version 和 fingerprint 的记录。它把 provider-neutral actor 与 approval time
绑定到准确 artifact ID、revision 和 `planFingerprint`，不会修改 immutable artifact。Approval time 早于 artifact、
content tampering、非法 identity，以及 artifact ID/revision/fingerprint mismatch 都会 fail closed。Actor string
有意不采用 GitHub、Jira、SSO 或 Pi type；authentication 与 signature policy 仍属于 adapter/deployment concern。

`PlanApprovalClaim` 增加 atomic single-run consumption boundary。`JsonFilePlanApprovalStore` 使用 durable artifact
相同的 temporary file + hard-link 方式发布 approval 与 claim。相同 approval 写入是 idempotent；same-run claim retry
返回原 claim 和 timestamp；different run 会被拒绝。专门的双 run 并发测试证明只有一个 atomic publication 能成功。
Corrupt JSON、nested fingerprint 损坏、filename/payload 不一致、path traversal 与 repository 内 storage 都会用
approval-specific error fail closed。

`PlanExecutionBinder` 是 Stage 18 repository comparison contract 的 mandatory production call site。它加载并验证
准确 artifact/approval，抓取 Git evidence，重建 Repository Facts，再抓一次 Git evidence并拒绝 moving repository；
随后比较 repository ID、base commit、working-tree fingerprint、facts fingerprint，以及当前 shared-resource 与
verification-policy fingerprint。只有所有检查通过后，系统才原子 claim approval 并返回带 fingerprint 的
`PlanExecutionIntent`。Repository/policy 检查失败不会消耗 approval。Intent parser 同时校验 nested artifact、
approval、claim 各自的 fingerprint、cross-record identity 与外层 execution fingerprint。

CLI 新增 `forge approve` 和 `forge bind`；`BINDING_REJECTED` 会输出稳定 mismatch ID。CLI 仍只负责 composition 和
JSON I/O，不会构建 agent、workspace、Write Guard、command、sandbox、model、verification 或 Git integration
binding。因此 `PlanExecutionIntent` 是 authority evidence，不是 `StartRuntimeRunRequest`；在 controlled runtime
binding policy 出现前，`forge run` 继续延后。

ADR-023 记录该边界。独立初学者培训文档见
[英文](./plan-approval-and-binding.en.md)与[中文](./plan-approval-and-binding.zh.md)。

Stage 19 local gate 有 34 个 test file、452 个 test 全部通过。覆盖率为 statement 95.82%、branch 91.02%、
function 96.70%、line 95.79%。Planning-only gate 有 54 个 test，覆盖率为 statement 98.38%、branch 95.07%、
function 97.84%、line 98.54%。`pnpm check`、`pnpm build` 与 `git diff --check` 通过。Self-analysis 得到 14 个
project、104 个 file、1,490 个 symbol、49 条 project dependency、205 条 file dependency、2,716 条 symbol
reference，以及同样两个已知 root configuration diagnostic。Ingestion-and-matching 研究仓库保持 3 个 project、
1,010 个 file、7,617 个 symbol、3 条 project dependency、3,592 条 file dependency、13,893 条 symbol
reference，以及已知的 25-file `UNCOVERED_TYPESCRIPT_FILES` diagnostic。本阶段不需要 live Pi call，因为 approval
与 binding 是 deterministic authority operation。

Stage 20 应实现 **Controlled Runtime Binding and Start**：消费已验证 execution intent，通过明确 deployment policy
提供现有 runtime 所需的 agent/workspace/lease/command/sandbox/model/verification collaborator，持久化 start
boundary，并提供第一个 recoverable `forge run` workflow。必须继续保证 CLI 不会成为 hidden orchestrator。

### Stage 19 独立 Review 加固

第一次独立 Review 发现一个 High correctness gap：execution binding 会比较稳定 repository identity、commit、content
与 facts，却没有比较物理 repository root。同一 remote 的两份 clone 在 bytes 相同时可能绑定同一个 artifact，虽然
Stage 20 会从不同位置创建真实 workspace。`repositoryBindingMismatches` 现在也强制准确 real `repositoryRoot`；同时
新增 recorded dirty-state 比较，让每个 snapshot authority field 都有明确 binding check。专门的 binder 测试复现
same-origin/same-content/different-root 场景，并证明系统会在 approval claim 前拒绝。

Review 的 Medium observation 也全部关闭。文档现在明确说明 SHA-256 fingerprint 不是 signature：有 JSON store
直接写权限的人可以重新计算它，因此 local threat model 依赖 filesystem access control 与 binder cross-check。
未被真实跨 package 使用的 Stage 19 barrel export 已删除；internal schema、mismatch type、integrity error 与 provider
port 在出现真实 consumer 前保持 private。Approval/claim store 新增专属 symlink TOCTOU regression case，并用一个
能通过自身 fingerprint 校验的 approval 单独锁定纯 `artifact-revision` mismatch branch。

Follow-up Review 独立重现了 452-test gate 与 planning-only coverage，并验证 `repositoryRoot` 确实来自 realpath、
准确 pre-claim rejection path、declaration emit 后 public API 可用、approval/claim 两条 dynamic TOCTOU injection，
以及 revision-only mismatch。Review 没有发现剩余 correctness 或 architecture 问题，并批准 Stage 19 **PASS /
CLOSED**。

两项非阻塞 test-organization 改进登记到 Stage 20 integration coverage：其一，用两份真实、共享同一 origin 的 clone
做端到端测试并证明 binder 拒绝第二份 clone；其二，只改变 dirty state 的隔离测试。现有测试已经分别证明底层语义与
production comparison 存在，因此这两项不会重新打开 Stage 19。

针对 commit `9982ddd749ba5e30ea7d6beb7bbf37c03c1d8476` 的最终 whole-architecture Review 再次给出
Stage 19 **PASS / CLOSED**，并更准确地定义 Stage 20 P1：`PlanExecutionIntent` 只证明 bind 时 repository、facts
与 policy 匹配；它不是 repository lock，可能在数秒或数小时后才被消费。Stage 20 必须在副作用前重新验证 authority，
provision 一个 base commit 与 approved artifact 一致的 orchestrator-owned integration checkout，让 task worktree 从
该 checkout 派生，持久化 run-creation boundary，然后才能调用现有 runtime。不能只 parse intent 就调用
`startRun()`。

Review 也把 shared-resource policy fingerprint 的 representation sensitivity 列为可能的 P2。当前 CLI production
path 已经 semantic canonical：`SharedResourceRegistry` 会 normalize/sort file/path pattern，并按 ID 排序 definition；
planning 与 binding 都使用 `registry.list()`，因此 JSON input 重新排序不会导致误拒绝。Generic binder 仍接收
`unknown` policy 并 hash array representation，所以未来任何不经过 registry 的 adapter 必须用同一 domain registry
或专用 authority fingerprint function 做 canonicalization。这是 future-adapter contract concern，不是 Stage 19
defect。当前也不需要单独持久化 intent：same-run rebinding 会重新加载并验证 durable artifact/approval/claim，并生成
相同 execution fingerprint。未来 run record 应保存 execution、plan、approval 与 claim fingerprint 以便 traceability。

## Stage 20：受控 Runtime Binding 与启动

Stage 20 已完成并通过独立 Review。它提供第一条真实、可恢复的 `forge run` 路径，同时没有把
orchestration 塞进 Commander 或 Pi adapter。

`RunPreparation` 会在任何 execution side effect 之前，立即通过 `PlanExecutionBinder` 重新验证已 claim 的 execution。
如果当前 Git source、物理 repository root、Repository Facts、shared-resource policy 或 verification policy 不再一致，
旧 intent 即使 fingerprint 合法也会被拒绝。Clean-only execution 是明确边界：dirty PlanArtifact 会在创建 checkout 前
失败，因为 Stage 20 还不能在隔离 worktree 中准确 materialize approved dirty/untracked bytes。

`GitIntegrationCheckoutProvisioner` 会在 source repository 外、approved base commit 上创建 run-specific
`forge/integration/<run-id>` checkout。完全相同的 retry 可以复用；错误 commit/branch、非法 run identity、位于 source
内部的 checkout root 与 symlink escape 都 fail closed。每个 task worktree 都从该 checkout 与 approved commit 派生，
source checkout 永远不是 agent 或 integration workspace。

`LocalRuntimeBindingPolicy` 恢复 predicted impact、派生 canonical lease plan，并生成 deterministic agent/workspace
identity。Dispatch 前，`RunPreparation` 会独立比较 durable authority、task、hard/risk conflict、schedule、impact、lease
plan 与 Git workspace binding。空 write set 现在可以生成合法空 lease plan；任何意外写入仍必须动态 acquire。

`RunAuthorityEvidence` 会持久化到 SQLite，包含 artifact/revision/approval identity，以及 plan、approval、claim、
execution、working-tree、Repository Facts、shared-resource 与 verification-policy fingerprint。旧数据库会增加新 column；
缺少合法 authority 的 legacy row 会明确拒绝 recovery。`startOrResumeRun()` 对相同 terminal run 不会再次 dispatch，
会恢复匹配的 ACTIVE evidence，并拒绝同 run ID 但 authority 变化的 request。Persisted lease 会重新载入 local guard。
Runtime 还补齐了 durable run state 收尾，不再出现 task snapshot 已完成而 run row 仍为 `ACTIVE` 的情况。

`LocalRuntimeStarter` 组合既有 Scheduler、SQLite adapter、Write Guard、Git workspace manager、受控 Pi agent 与
post-agent package-script verifier。默认 agent binding 不授予 `forge_command`；verification 仍由 orchestrator 管理。
后续 whole-architecture Review 发现原 verifier 仍会在 host 直接执行 package script；下方 security hardening 小节取代
原 executor。成功输出保留在 run integration checkout，不会 push 或 merge 到用户 branch。

Stage 19 的两项 test-organization follow-up 已关闭：真实 integration test 会创建两份共享相同 origin 和 bytes 的 clone，
并证明第二个物理 root 会在 claim 前被拒绝；另一个测试只改变 dirty state。真实 local runtime test 则完整经过受控 Pi
edit、task worktree、lease、verification、commit、串行 integration、SQLite recovery 与 identical retry。

ADR-024 记录此边界。面向初学者的机制说明见[英文](./controlled-runtime-start.en.md)与
[中文](./controlled-runtime-start.zh.md)。

Stage 20 follow-up gate 有 38 个 test file、491 个 test 全部通过。覆盖率为 statement 95.44%、branch 90.90%、function
96.51%、line 95.39%；新增 `run-preparation` package 独立达到 statement 100%、branch 98.33%、function 100%、line
100%。`pnpm check`、`pnpm build`、CLI help 与 `git diff --check` 通过。Self-analysis 得到 15 个 project、114 个 file、
1,620 个 symbol、59 条 project dependency、241 条 file dependency、3,007 条 symbol reference，以及同样两个已知
configuration diagnostic。Ingestion-and-matching 研究仓库得到 3 个 project、1,010 个 file、7,617 个 symbol、3 条
project dependency、3,592 条 file dependency、13,893 条 symbol reference，以及已知的 25-file
`UNCOVERED_TYPESCRIPT_FILES` diagnostic。

本轮没有在研究仓库执行 live external Pi model call。端到端 runtime test 使用 controlled Pi gateway 与真实
filesystem/Git/SQLite/pnpm 操作。真实 `forge run` 会执行 model-backed code change，因此必须针对有意准备并批准的
artifact 执行，不能把研究仓库当作未受控 mutation target。

仍明确延后的工作包括 distributed/cross-process lease fencing、dirty-snapshot materialization、agent cancellation 与
`UNKNOWN` resolution、multi-failure aggregation、publication/PR integration，以及 GitHub/Jira/provider trigger。这些限制
不会削弱 local clean-snapshot authority chain，而是定义后续 productization stage。

### Stage 20 独立 Review 加固

第一次独立 Review 重现了原始 484-test evidence，并发现一个 Critical local recovery race：两个并发 caller 可以同时
看到同一个 durable `PREPARING` attempt，并在 SQLite 后续 optimistic check 检测到竞争之前分别调用 external agent。
现在每个 `startRun()` 与 `startOrResumeRun()` 都会进入以 repository/run identity 为 key 的 process-wide queue。回归测试
会让两个独立 runtime instance 并发恢复同一个 attempt，并证明 agent 只 dispatch 一次。它关闭同一 process 内的重复
dispatch，但不会被描述为 cross-process fencing。

Integration recovery 现在可以区分普通 foreign commit 与 Forge 进度。Runtime 创建的 task commit 带准确的
`Forge-Run-Id`、`Forge-Task-Id` trailer；checkout reuse 会验证 approved base 之后的每个 commit。合法 integrated history
仍可复用，干净的人工 commit 与完全 unrelated history 都 fail closed。Trailer 是 provenance metadata，不是抵御直接 Git
writer 故意伪造的 signature。

Verification 不再继承父进程环境，只接收 `CI=1` 与 trusted `PATH`；package/script identifier 也增加明确字符 allowlist。
真实 child-process 测试会给父进程设置非法 `NODE_OPTIONS`，并证明 approved pnpm script 不继承它且仍能成功。Lease
hydration 现在明确只选择 ACTIVE lease；SQLite recovery 也增加 NULL 与 malformed JSON authority 的直接测试。

最后，真实 Git integration test 会在 clean 状态完成 bind，随后把 repository 改为 dirty，再调用 `RunPreparation`；fresh
`PlanExecutionBinder` 会在 checkout provision 之前拒绝。没有真实跨 package consumer 的新增 barrel export 已删除。这些
改动关闭初审的 C1 与 H1-H3，并在不扩大 Stage 20 scope 的前提下处理 M1-M5。

### Stage 20 Follow-up Review：PASS / CLOSED

Follow-up reviewer 独立重现了 491-test gate 与完全一致的 coverage，并用真实 SQLite persistence 完成三组对抗实验：
两个 runtime instance 并发恢复同一 `PREPARING` attempt 时只产生一次 agent call；authority 变化的请求排在 in-flight
run 后仍会被拒绝；前一个排队操作失败也不会污染或永久阻塞后一个请求。这证明 module-level queue 会跨 runtime
instance 共享，reject 后正确释放，并且不会绕过 authority check。

Reviewer 还做了 mutation test，临时恢复父进程 environment inheritance；新增 `NODE_OPTIONS` regression test 立即
失败，还原 whitelist 后重新通过，证明测试能真实捕获目标安全退化。真实 Git clean-at-bind/dirty-before-start 测试、
ACTIVE-only lease hydration、SQLite NULL/malformed authority 测试、identifier allowlist、unrelated-history rejection 与
public export 清理也都被直接核实。Stage 20 因此正式 **PASS / CLOSED**，可以开始 Stage 21。

在当时 Review 节点，四项非阻塞 follow-up 被登记为技术债：若 provenance format 扩展，改用
严格 Git trailer parser；继续保留所有 post-base commit 必须带 run trailer 的 fail-closed 规则；让 verification
executable PATH 在 Windows 上可移植，并支持 Corepack、Volta 或自定义 pnpm 路径；在后续 security review 中决定
trusted Git subprocess 是否也应使用 minimal environment。当前没有证据表明这些事项能绕过 Stage 20 authority 或造成
重复 dispatch。

### Stage 20 Whole-architecture Review：Sandboxed verification 修复待复审

后续 whole-project Review 找到一个之前 Stage 20 Review 没有暴露的 P1 architecture violation：orchestrator 在 release
execution lease 后，会直接在 developer host 执行可由 Agent 修改的 `package.json` script。固定参数与 minimal
environment 能防 shell/environment injection，却不能约束 script 自身；它仍可能写 task workspace 之外、读取 host
secret、访问 network，或在 Write Guard 外启动 child process。

当前 working-tree fix 已删除 host package-script execution。Verification policy v2 包含准确 pinned-digest Docker
profile，完整 profile 会进入 approval policy fingerprint。`LocalRuntimeStarter` 在 persistence/dispatch 前重新计算该
fingerprint，只通过 approved RepositoryGraph 解析 package，然后把固定命令委托给 `AgentCommandSandbox`：

```text
approved package-script rule
        -> approved RepositoryGraph project root
        -> fingerprinted Docker profile
        -> npm --prefix <project-root> run <script>
        -> read-only workspace, no network, disposable /tmp
```

Container 以 non-root user 运行，drop 全部 Linux capability，启用 `no-new-privileges`，root/workspace 只读，并限制
memory、CPU 与 PID，只接收明确 environment。Docker/image 缺失、未知 package、free-form command、policy drift、
sandbox 启动失败或 script 非零退出都会 fail closed，绝不 fallback 到 trusted-local。固定官方 Node image 只使用自带
npm 调用已批准 script，不安装 dependency。需要 pnpm 或缺失 dependency 的 script 暂时 fail closed，直到提供专用
verifier image。

Docker adapter 现在会在替换 environment 前把 host Docker CLI 解析成 absolute path。这是由真实对抗测试发现的：
bare `docker` 配合空 PATH 时 sandbox 根本无法启动。Host Docker client 现在只收到运行所需的最小 HOME，而 container
继续只收到明确批准的 environment。

每个 verification container 有唯一 run-scoped name。Timeout、cancellation 与 output-limit path 会请求 Docker daemon 对该
name 的 container 执行 `kill` 与 `wait`，再 cleanup 后才让 verifier 报告 command settled。Docker CLI process 退出不算
container 已停止。Verification image policy 拒绝 mutable tag，要求 immutable sha256 digest。

测试证明准确 sandbox delegation、runtime policy mismatch、未知 package/free-form rule、Docker hardening flag 与
sandbox fail-closed。最终默认 gate 共 38 个 test file，494 个通过、1 个 opt-in Docker test 跳过（总计 495）；覆盖率为
statement 95.40%、branch 90.76%、function 96.32%、line 95.36%。显式启用后，真实 Docker test 会启动 malicious
package script、观察到它的 marker，并证明其 workspace write 被拒绝。`pnpm check`、`pnpm build` 与
`git diff --check` 全部通过。Self-analysis 为 15 个 project、114 个 file、1,635 个 symbol、59 条 project dependency、
243 条 file dependency、3,031 条 symbol reference，以及同样两个 root diagnostic。研究仓库稳定为 3 个 project、
1,010 个 file、7,617 个 symbol、3 条 project dependency、3,592 条 file dependency、13,893 条 symbol reference，
以及已知的 25-file diagnostic。文档同步与独立 follow-up Review 已完成。

同一 Review 也澄清两项 Git boundary：linked worktree 能保护用户 checkout file，但其 branch 与 registration 仍会写
source repository 共享的 `.git` metadata；真正 metadata isolation 需要 dedicated orchestrator clone。另外，若 process
在 branch 创建后、worktree materialization 前中断，可能遗留 branch-only partial state，需要显式 reconciliation。这些
是已登记 P2 limitation，不会再把 linked worktree 描述为完整 security boundary。

Stage 20 在独立 follow-up Review 后为 **PASS / CLOSED**。建议下一 product stage 先做 **Observed Impact
Reconciliation**：在 verification/integration 前，把实际 Git change 与 predicted impact、lease authority 对账。

## Stage 21：Observed Impact Reconciliation

Stage 21 关闭了第一个 observed-effect authority 缺口。agent 完成后、verification 开始前，local runtime
会让 Git 报告 task worktree 的真实变更路径，包括 untracked file。每个路径都通过已批准的 RepositoryGraph
映射，而不是接受 model 提供的 identifier。结果会以 created、modified、deleted file 的 durable observed
evidence 形式保存。

reconciliation 会将每个实际写入文件与已批准的 predicted write scope 及此次 execution 持有的 ACTIVE
write lease 对照。没有匹配 ACTIVE lease 的变更会在 verification 或 integration 前使 task fail。位于
approved predicted impact 之外但仍有 lease 的文件，会明确保存为 `runtime-scope-expanded` evidence，而不会
被静默当作已经批准的计划范围。

lease 会一直保持 ACTIVE 到 reconciliation 完成。之后在 verification 前释放，因为 approved verifier 在独立的
read-only Docker container 中运行，不能执行 repository write；这就是 controlled agent mutation 与
verification 的边界。发现 unleased observed change 时，task 和 run 在该释放前已经失败，因此不会有后续 task
dispatch 将已释放 resource 当作 failed run 中可安全继续工作的资源。

如果 expansion 与另一 task 的 predicted write scope 重叠，runtime 会持久化 hard
`runtime-scope-expansion` conflict。该 conflict 会加入下一次 scheduler reevaluation，因此仍处于
verification 或 integration 的 task 也会阻止随后变为 eligible 的冲突 task 启动。scheduler 保留原有的
concurrently selected task 排序，同时将 conflict protection 扩展到这些 in-flight lifecycle state。

ACTIVE run restart 时，已持久化的 runtime conflict 会被重新读取，并在恢复 dispatch 前触发 durable
`runtime-reconciliation-recovered` reevaluation。因此 runtime conflict collection 是刻意可变的 runtime state，
并且与 approved immutable plan conflict 分离。

实现将 Git parsing 保留在 `workspace-git`，graph/path ownership 放在 `run-preparation`，provider-neutral
reconciliation contract 放在 `domain`。它暂不推断 symbol、dependency、manifest、generated output，也不会
在实际 file scope 之外构造 dynamic conflict。cross-process write fencing、dirty snapshot materialization、
cancellation/UNKNOWN reconciliation 和 operator workflow 仍属于后续 stage。

verification boundary 仍有一项 non-blocking correctness limitation。task 的 execution lease 会在
read-only verifier 开始前释放，这对 verifier mutation 是安全的；但该释放不能阻止另一项合法 task 在之后
获得新 lease 并写入同一文件，因此 verifier 读到的内容未必是 immutable post-agent snapshot。后续 stage
应评估 verification-read reservation 或 repository snapshot，使 verification 可以绑定到不可变状态。这不是
authorization bypass：后续写入仍需要自己的 lease，且 verifier 不能写入。

已通过 focused verification：TypeScript project-reference build、Oxlint、scheduler/runtime tests、真实
local worktree/SQLite runtime test，以及新增 reconciliation tests，覆盖 actual-diff precedence、leased scope
expansion 和 unleased-change rejection。

### Stage 21 closure：sequenced runtime knowledge

runtime scope conflict 现在会作为 mutation，在首次使用它的同一个 durable scheduler sequence 中提交。replay
只从其 `effectiveFromSequence` 起应用 mutation，因此能重现历史 decision，而不会把后来的 conflict 错误带入
更早的 scheduling。expansion matching 现在将实际 `WritableResource` 与其他 task 的 canonical lease plan
比较，保留 project、file 和 symbol hierarchy，而不再只比较 file ID。

durable retry boundary 也包含 runtime conflict mutation。已经提交的 scheduler sequence 只有在 event、
snapshot、transition、decision 和同 sequence runtime conflict 都是 exact evidence match 时才允许 retry；
mutation set 变化会 fail closed。这保留了 run uncertain-commit idempotency rule；对于已经 serialize 的
task pair，后续 observation 仍属于 diagnostic follow-up，而不会重写最初 conflict evidence。

## Stage 22：Build Review And Repair Loop

Stage 22 先建立一个刻意收窄的 review-evidence boundary。task workspace 完成 verification 后，独立
reviewer 只能使用 read、list 和 find tool 检查它。它必须返回严格 JSON review：没有 finding 的 `accept`，
或者带唯一 ID、severity、affected file ID、description 与可选 requirement reference 的 `repair`。runtime
collector 会解析这份不可信 response，并按 run、task 和 review iteration 做 idempotent persistence。

reviewer session 只定义并激活这三个只读 tool，而不是先定义更宽的 tool set 后依赖 active-tool filter。
真实 Pi SDK regression test 会验证没有 built-in shell，也没有 Forge edit、write 或 command tool 处于 active 状态。

每份 review 现在绑定 builder attempt、workspace identity 与 revision、workspace-change fingerprint、
observed-impact fingerprint 和 verification fingerprint。同一 review iteration 的 subject 变化会 fail closed；
引用不存在 repository file 或 symbol ID 的 finding 会在 persistence 前被拒绝。这只是 evidence binding：现有
integration path 尚未把 review acceptance 作为 authority。下一次 repair increment 必须先为 exact output 产出
durable workspace-change 与 verification fingerprint，才能 review 或 integrate。

reviewer 不能写文件、运行 command、批准 integration 或 dispatch repair。repair 目前尚未实现：现有 runtime
对每个 task 只有一条 durable builder-attempt lineage，而安全 repair loop 需要独立建模 repair attempt、bounded
budget、再次 verification 与 review、recovery semantic 及 integration-admission rule。ADR-025 记录了此
boundary，以便下一次 Stage 22 increment 在不削弱 attempt provenance 的前提下实现 repair。

下一次 Stage 22 increment 先加入 repair authority record，但尚不 dispatch repair agent。`TaskRepairAttempt`
有独立的 revisioned lineage、parent review iteration 与 subject、bounded repair budget、session/failure
evidence 和独立 SQLite storage。integration admission policy 只接受 builder attempt、workspace revision/change、
impact 与 verification subject 都与 current output 精确匹配的 durable `accept` review。repair、再次 verification
与再次 review 的 dispatch 仍是下一个 composition step。

repair admission 现在是 exact-once durable evidence。对同一个 parent review 的 retry 会返回既有 repair
attempt，而不会分配新的 iteration 或再次消耗 budget。SQLite 在一个 serialized transaction 内查找 parent review
subject、检查 task budget、分配 iteration 并存储 attempt。后续 revision 可以增加 lifecycle evidence，但不能改变
repair lineage identity。实际 repair dispatch、post-repair reconciliation、verification 与 re-review 仍刻意未实现。

下一个 prerequisite 也已完成：passed verification 可以作为独立的 exact-idempotent evidence 存储。其 identity
包含 run/task/attempt、workspace revision、实际 worktree-content fingerprint、verification-policy fingerprint、
verified-at time 与 self fingerprint。factory 使用真实 Git snapshot，而不是派生 placeholder。repair dispatch
仍保持锁定，直到 runtime composition 在每次 verification 后持久化该 evidence，并把它的 fingerprint 写入新的
review subject。

verification evidence 现在会在写入与恢复时校验自身 fingerprint；格式正确但与内容不匹配的 digest 会 fail
closed。其 factory 会拒绝非 completed attempt，以及任何 attempt/workspace 或 snapshot/workspace identity
不匹配。因此 repair loop 拥有 exact content 与 verification authority prerequisite，而不是 opaque 的 caller
提供 digest。

repair execution composition 现在作为独立 coordinator 可用。它会持久化 repair `STARTING`，在 controlled-agent
`onStarted` 后才进入 `RUNNING`；如果 post-start failure 使 workspace mutation 变得不确定，则记录 `UNKNOWN`
并保留 active lease。正常完成时，workspace 依次经过 Stage 21 reconciliation、sandbox verification、exact
verification evidence、repair-output review subject 和新的只读 review。它尚不会自动 integrate task output：
integration 仍由 exact accepted review gate 控制，并刻意留给下一个 composition boundary。

repair contention 现在是 durable state，而不再伪装成 failure。动态 lease block 会使 repair attempt 进入带
lease evidence 的 `BLOCKED`，释放该 repair 当前持有的 lease，并发送 explicit feedback 供后续 scheduling
integration 使用。compare-and-swap resume 会将同一 repair lineage 返回 `PREPARING`；stale resume 不能覆盖
新的 lifecycle evidence。repair scope expansion 同样通过该 feedback boundary 报告。main runtime 仍需要
scheduler-visible repair phase，`forge run` 才能自动消费这些 feedback event 并恢复 repair。

在最终 repair-scheduler composition 建立两侧共同的 evidence contract 前，builder 与 repair path 的 lease
release 仍刻意保持独立。最终 Stage 22 increment 必须增加并行且可恢复的 repair view：当 blocker lease
释放时用 CAS 恢复 BLOCKED repair；不得把 repair state 塞进原始 builder task-state snapshot。

code review policy 现在是独立于 verification policy 的 approved authority。其 semantic fingerprint 绑定
reviewer implementation、agent backend、provider/model、read-only tool profile、review schema version 与
prompt version，并排除 transient session 与 path。artifact creation、execution binding、durable run authority 和
local startup 都会独立拒绝 code-review-policy drift。Pi reviewer 会通过 Pi model registry 解析 approved
provider/model，并将 exact resolved SDK model 传给 session；如果 approved model 不可用则 fail closed，不会
回退到 Pi 默认 model selection。

最终 Stage 22 composition 现已在正常 `forge run` 中启用。builder verification 后，runtime 会捕获真实 Git
worktree、持久化 exact verification evidence、构造 review subject，并调用已批准的 read-only Pi review。只有
持久化的 `accept` review 与当前 output subject 完全一致时，才能 integration。`repair` review 也必须先作为
匹配的 durable evidence 被恢复和确认，才能 admission repair。

repair admission 现在会在同一个 SQLite transaction 中保存独立 repair lineage 与不可变
`TaskRepairWorkItem`。该 work item 记录 builder attempt、workspace、lease-plan 与 impact fingerprint、
parent/next review iteration，以及 verification/review policy fingerprint，从而为 repair dispatch recovery
提供所需输入。runtime 通过 controlled agent tools、Stage 21 reconciliation、verification evidence 和
re-review 执行有界 repair；只有新的 exact accepted review 才能 commit 并 integration repaired output。整个
loop 中 builder task state 始终与 repair state 分离。

repair scope expansion 会进入 Stage 21 的 durable runtime-conflict replay；lease block 只刷新并行 repair
view，不会改变 builder snapshot。restart recovery 会把 active repair 变为 `UNKNOWN` 并 fail closed。恢复后的
`BLOCKED` repair 自动 resume 仍未实现，因为安全重试前必须重建所有 durable controlled-dispatch 与
lease-acquisition authority。Stage 22 已通过 `pnpm check` 验证（565 passed、1 skipped、90.07% branch coverage）
以及 `pnpm build`。

repair coordinator 现在会在 admission 前独立读取 durable review evidence。调用方不能只传入一个 `repair`
值就创建 repair：持久化的 task/iteration review 必须具有相同的七字段 subject。commit 和 integration 前，
runtime 会再次 capture workspace；workspace identity、revision 或 worktree fingerprint 发生变化都会被拒绝。
因此即使未来 runtime 增加 asynchronous mutation point，review 之后的 output drift 仍会 fail closed。本次
hardening 已通过 `pnpm check` 验证（567 passed、1 skipped、90.05% branch coverage）以及 `pnpm build`。

review-to-integration drift guard 现在也有 production-style regression test。该测试使用真实 Git task
worktree 和 controlled Pi builder edit，再让已接受的 reviewer 修改同一个真实 worktree。runtime 会在
integration 前拒绝，integration checkout 保持不变。这补齐了独立审查指出的最后一个 Stage 22 测试深度缺口。
完整 suite 现已通过 `pnpm check` 验证（568 passed、1 skipped、90.01% branch coverage）以及 `pnpm build`。

### Runtime V2 Migration

已验证的 Stage 22R legacy runtime 已归档为 `stage22r-legacy-runtime-2486fe0` 和
`archive/stage22r-legacy-runtime`。Runtime V2 在独立 migration branch 上开始。ADR-027 保留 Forge 的
deterministic authority，并先通过窄的 Temporal 和 Restate spike 选择 durable execution substrate，再进行完整
migration。PostgreSQL evidence storage 是 scaling candidate，而不是 Runtime V2 prerequisite。

选定的 durable runtime 负责记住 execution 在哪里，SQLite 当前负责记住 Forge 已授权什么，未来的 repository
memory service 负责记住学到了什么；三者都不能替代 Forge 的 deterministic decision authority。正式产品 UI 等待
durable-runtime-neutral Forge read model 以及 inspect/status/cancel API。Runtime V2 期间可先定义 information
architecture、evidence drawer contract、status vocabulary 和 visual language，但不绑定 legacy runtime。

Temporal candidate 现已拥有 isolated 的真实 worker、workflow 和 Activity skeleton，并用 Temporal test environment
验证。Workflow history 只包含 run ID 与 scenario discriminator。

**当前 spike 状态：**

- M1 spike contract：CLOSED
- M2.1 Temporal skeleton：CLOSED
- M2.2 Activity infrastructure：CLOSED
- M2.3A Authority adapter hardening：REOPENED（见下方）
- M2.3B Repair seam authority shape：CLOSED

**Scenario A - 控制流形状（CLOSED）：**

- `ForgeBuilderExecutionService`：已实现（Seam 1: ExecuteBuilder）
- `ForgeBuilderOutputEvaluationService`：已实现（Seam 2: EvaluateBuilderOutput）
- `ForgeRepairExecutionService`：已实现（Seam 3: ExecuteRepair）
- `ForgeAcceptedOutputIntegrationService`：已实现（Seam 4: IntegrateAcceptedOutput）
- `ForgeScenarioAServiceRunner`：组合层已实现
- 四个 narrow Temporal Activities 已定义并接入 workflow
- Workflow 已重构为调用四个 narrow Activities，替换 opaque `runBuildReviewRepairIntegrate`
- 遗留的 `runBuildReviewRepairIntegrate` 已废弃但保留以保持向后兼容
- Durable continuation 现已启用：每个 activity 调用创建独立的 continuation boundary
- `createTemporalSpikeScenarioService` adapter：接受可选的 `ForgeScenarioAServices` 用于真实委托，未提供时回退到 stubs

### M3.3：Temporal runtime 的 Scenario A 垂直切片

这一阶段把真实的 Temporal runtime 包继续推进到更接近生产的形状。重点不是一次性做完所有 Forge 服务接线，而是证明 workflow 层、activity 合同、worker factory 和测试能够用同一套 Scenario A 语言协同工作。

本阶段完成了什么：

- `libs/temporal-runtime/src/lib/contracts.ts` 增加了 Scenario A 的紧凑 schema：Scheduler 重新评估、builder 执行、builder 输出评估、repair 执行、accepted output 集成。
- `libs/temporal-runtime/src/lib/activities/forge-activities.ts` 定义了 worker 进程必须提供的 activity 表面。
- `libs/temporal-runtime/src/lib/workflows/forge-run.ts` 现在按照 `accept`、`repair`、`reject` 分支顺序编排 Scenario A 流程，并依次调用窄 activity。
- `libs/temporal-runtime/src/lib/worker-factory.ts` 现在要求显式提供 Scenario A activity 实现，不再静默回退到旧的 bootstrap stub。
- `apps/temporal-worker/src/main.ts` 现在传入了占位的 Scenario A activity 映射，使新的 worker 形状是显式的。
- `libs/temporal-runtime/src/lib/temporal-runtime.spec.ts` 现在覆盖三个 workflow 场景：没有任务就绪、accept 路径、repair 路径。

这一阶段证明了什么：

- Temporal workflow 可以在不把业务逻辑放进 workflow sandbox 的前提下，完成真实的多步骤编排。
- workflow history 保持紧凑：输入和输出都是 ID 与小型枚举，而不是大型领域对象。
- worker 和测试环境都能够注册 workflow 所期望的同一组 activity 名称。

已经做过的验证：

- `pnpm exec tsc -b libs/temporal-runtime/tsconfig.lib.json apps/temporal-worker/tsconfig.app.json --force`
- `pnpm exec vitest run --config vitest.config.ts libs/temporal-runtime/src/lib/temporal-runtime.spec.ts`

当前限制：

- 生产 worker 入口仍然使用会抛错的占位 activity，因此真实 Forge 服务接线还没有完成。
- 现在验证的是 Temporal runtime 的 workflow 形状，但还不是 worker 进程里真实的端到端 Forge 编排。

这一步为下一阶段做了什么准备：

- 下一阶段可以把 worker 的占位 activity 替换成真正调用 Forge 服务的适配器。
- 一旦接线完成，Temporal runtime 就可以从“已验证的骨架”升级为真正的生产执行路径。

**M2.3A - Authority adapter hardening（REOPENED）：**

- 原始 commits 尝试移除假数据但部分仍存在
- Spike adapter 仍传递空的 `files`/`symbols` maps 作为 repository（stub，非真实）
- `verificationPolicyFingerprint` 使用空字符串而非真实 policy fingerprint
- Workflow 移除了 `repair-${Date.now()}` fallback - Forge 必须提供真实的 repairAttemptId
- Commit: `531445e`（部分修复），仍需额外工作

**M2.3B - Repair seam authority shape（CLOSED）：**

- 修复了 P1-4 崩溃 bug：`ForgeRepairExecutionService` blocked case 在 result 为 undefined 时访问了 `result!.verification`
- 创建了 `RepairExecutionOutcome` 联合类型，包含 `completed`、`blocked` 和 `unknown` 状态
- 更新了 `ForgeRepairExecutionService.execute()` 返回 `RepairExecutionOutcome`
- 更新了 `forge-scenario-a-service-runner.ts` 以在访问属性前检查状态
- `UNKNOWN` 状态现在 fail closed（抛出错误）而非变成 'repair' recommendation
- Commit: `7812ac5`、`23b819f`

**Scenario B - Durable wait/signal 基础（GROUNDWORK）：**

- 将 signal 从 `repairAuthorizedSignal` 重命名为 `repairWakeSignal` - Temporal 仅负责 wake，不负责 authorization
- `repairWakeSignal` 携带 `leaseState: 'RELEASED' | 'STALE'` 用于 Forge CAS authority（在 activity 内部处理）
- Workflow 使用 `condition()` 等待有效 signal，然后才调用 `executeBlockedRepairResume`
- 不相关的 signal 被忽略（workflow 继续等待）
- 移除了任意的 30 天 condition timeout
- Forge CAS authority 仍需在 `executeBlockedRepairResume` activity 内部实现
- Commit: `temporal-spike-workflow.ts` 已更新

**剩余 P1 项目：**

1. **Forge CAS blocked resume** ✅ 已实现：`executeBlockedRepairResume` 现在加载 repair，验证 BLOCKED@N，加载 blocker lease，验证 RELEASED/STALE，执行 CAS BLOCKED@N → PREPARING@N+1

2. **Restart persistence 已证明** ✅ 基础工作：Temporal `condition + signal` durable wait 在测试环境中已证明。真正的跨 worker 重启需要真实 Temporal cluster（而非测试环境）。

3. **Shared SQLite authority harness** ⚠️ 部分完成：`TemporalSpikeDriver` 已实现并连接 `DurableExecutionSpikeDriver` 接口到持久化。完整端到端测试需要真实 Temporal cluster（而非测试环境）。Harness 断言逻辑已通过单元测试验证。

**架构决策仍待确定：**

正确路线是：

- 完成 Temporal spike 概念验证 ✅ 已完成
- 停止 TEMPORAL ✅ 已完成
- 用相同 harness 评估 Restate candidate（进行中）
- ADR-028 决策
- Winner only：集成 Bootstrap / RuntimeStarter / CLI 切换

在 candidate winner 选定之前，不做集成 Bootstrap。

**已完成：**

- 已将 `temporal-spike` 作为 workspace 依赖添加到 CLI package.json
- Signal 重命名：`repairAuthorizedSignal` → `repairWakeSignal`（Temporal 仅负责 wake）
- `executeBlockedRepairResume` 现在实现真正的 Forge CAS authority seam
- `UNKNOWN` 状态 fail closed（抛出错误）
- 不相关的 signal 被忽略（workflow 继续等待）
- 移除了任意的 30 天 condition timeout
- Durable wait 测试证明 `condition + setHandler` 工作正常
- STALE leaseState 也能正确触发 resume
- `TemporalSpikeDriver` 已实现 `DurableExecutionSpikeDriver` 接口
- 创建了 `restate-spike` 包，包含 SDK 结构
- `RestateSpikeDriver` 已实现 `DurableExecutionSpikeDriver` 接口
- Restate Activities 和 Workflow 已使用 `@restatedev/restate-sdk` 定义
- Restate 测试结构已完成 - 测试需要 Docker/testcontainers（CI 环境中 Docker 不可用）

**OutcomeCollector 模式（两个候选都适用）：**

- **关键架构修复**：从两个候选都移除了 harnessOutcome/harnessRegistry
- 之前的 harness 模式是 FALSE-POSITIVE - 循环验证：harness 预构造正确结果、作为输入传给 workflow，然后断言通过
- 两个候选现在都执行真实的 Forge seam，在执行期间写入 evidence
- OutcomeCollector 在 workflow 完成后从 evidence store 读取
- 结果是 OBSERVED（观察到的），不是预构造的
- Temporal：6 个通过测试，使用 OutcomeCollector + InMemoryEvidenceStore
- Restate：5 个通过测试，使用 workflow state evidence 收集

**Restate Spike 状态：**

- **Scenario A**：`workflowSubmit + rs.result()` 成功完成（3 个测试通过）
- **Scenario B**：`workflowSubmit` 成功，durable wait 模式已实现
- **已修复**：移除了 harnessRegistry（不是 durable），使用 workflow state 收集 evidence
- **ADR-028**：重新开放 - OutcomeCollector 模式已在两个候选上验证

**架构决策：ADR-028 重新开放 - 决策待定**

- 两个候选现在都使用 OutcomeCollector 模式（真实执行，观察到的结果）
- Temporal：6 个通过测试，真实 workflow 执行
- Restate：5 个通过测试，真实 workflow 执行
- 两个候选都证明了 durable execution，无需预构造结果
- 下一步：完成公平比较和决策

### Stage 22R：Repair Continuation 设计

Stage 22R 现已完成 blocked-repair continuation。runtime 维护一个按 repair attempt ID 去重的并行队列。新的
repair recommendation 会持久化 admission 和 work-item evidence，然后 enqueue work，而不是在 builder review call
内递归执行。durable `RELEASED` 或 `STALE` blocker 会选择精确的 `BLOCKED` repair，依据当前 authority 校验其
evidence，通过 CAS 恢复，并且只 enqueue winner。restart 后 `PREPARING` repair 也会进入队列；
`STARTING`/`RUNNING` repair 仍会变成 `UNKNOWN`，绝不 auto-resume。

每个 queued repair 推进一个 durable cycle：controlled execution、reconciliation、verification evidence、fresh
review，然后执行 exact integration 或 admission/enqueue 下一次有界 repair attempt。因此重复的 `repair`
recommendation 会重新进入同一个 non-recursive driver，不引入 continuation phase，也不把 repair state 写入
builder snapshot。recovery coverage 已证明 released、stale、active、CAS-loser、`PREPARING`、`UNKNOWN`、repeat-review
和 re-blocked outcome。live multi-task regression 还证明 unrelated release 不会动作，而 matching builder lease
release 只会产生一次 resumed repair dispatch。`pnpm check` 通过：570 passed、1 skipped、90.12% branch coverage；
`pnpm build` 也通过。Stage 22 已关闭。

### Stage 23: Observed Impact Reconciliation（观察性影响对账）

Stage 23 关闭了观察性影响对账缺口。运行时现在跟踪代理在实际执行过程中读取了哪些文件，并验证这些读取是否在预测的影响范围内。

`AgentToolRuntime` 现在在其 `observedImpact()` 中跟踪文件读取。当代理调用 `read()`、`list()` 或 `find()` 时，访问的文件 ID 会记录在 `#readFileIds` 集合中。这些信息通过 `PiAgentRunner` 流向 `OrchestrationRuntime`，在那里 `RepositoryImpactReconciler` 将观察到的读取与预测读取进行比较。

`RepositoryImpactReconciler.reconcile()` 现在计算 `unauthorizedReadIds`：代理读取了但不在预测 `filesRead` 集中的文件。这作为调度器事件日志中的新的 `unauthorized-read` 事件呈现，而不是直接使任务失败——读取是范围违规，但不是安全边界违规（与无租约写入不同）。

对账结果类型 `TaskImpactReconciliation` 增加了一个可选的 `unauthorizedReadIds` 字段。`RepairRuntimeFeedback` 接口增加了一个可选的 `unauthorizedRead()` 方法用于修复时回调。

`pnpm check` 通过：572 passed、1 skipped、90.04% branch coverage；`pnpm build` 也通过。Stage 23 已关闭。

### Stage 24: Run Operations and Recovery Control（运行操作和恢复控制）

Stage 24 为 CLI 添加了运行操作和恢复控制命令。

`forge status` 命令查询 SQLite 运行数据库，返回当前运行状态，包括 task、lease 和调度器事件，格式为 JSON。它使用 `DrizzleSqliteOrchestrationPersistence.recoverRun()` 重建运行状态，并从转换历史中格式化 task 状态。

`forge cancel` 命令通过调用 `DrizzleSqliteOrchestrationPersistence.updateRunState()` 并传入 `CANCELLED` 状态来取消活跃的运行。它验证运行存在且处于可取消状态（ACTIVE），拒绝已取消或已完成/失败的运行。

两个命令都支持 `--run-directory` 指定自定义数据库位置，默认为 `~/.forge/runs/<run-id>`。

`pnpm check` 通过：578 passed、1 skipped、90.31% branch coverage；`pnpm build` 也通过。Stage 24 已关闭。

## Stage M3.3：Temporal runtime Scenario A slice

这一阶段先做出了 Forge runtime 的第一个真实 Temporal workflow 切片，随后根据评审结果修正了它的授权模型。目标是证明：workflow 只携带紧凑的标识符，而更重的编排工作由 worker 侧 activity 承担。

做了什么：

- 为 workflow 输入、结果、已授权任务数据、builder 执行、评估、repair admission、repair 执行、集成和最终收尾创建了紧凑的 Zod 合同；
- 实现了 Scenario A workflow：先调用 `reevaluateRun`，再执行 builder，单独做 repair admission，只集成被接受的输出，最后执行 run 收尾；
- 定义了与 workflow 边界一致的 Temporal activity 接口；
- 编写了 workflow 测试，覆盖空运行、接受输出、修复输出、第二次 repair admission、以及最终收尾失败；
- 更新 worker factory，使其必须显式提供 Forge activities，不再默认伪造一个实现。

为什么这样做：

- workflow 不能自己决定谁有执行权限，这个权限属于 `reevaluateRun`。
- repair admission 必须与输出评估分开，这样 workflow 才能在没有 repair attempt 的情况下 fail closed，而不是默认假定一定有 repair。
- workflow 必须从 `finalizeRunState` 返回最终运行状态，不能手写一个成功标记就结束。

验证了什么：

- `libs/temporal-runtime` 和 `apps/temporal-worker` 的 TypeScript 构建通过；
- Temporal workflow 测试通过，包括修正后的授权模型和第二次 repair 的回归场景。

当前限制：

- 对 Scenario A 来说，这一阶段已经收口并冻结，没有剩余阻塞。

这一阶段为下一步提供了什么：

- M3.4 可以复用已经冻结的 Scenario A 授权 seam，继续做可恢复的 BLOCKED repair continuation；
- 下一步要做的是重启安全的 lease hydration、signal/wake 处理、精确 blocker 校验，以及同一个 repair attempt 的 CAS resume。

## Stage M3.3 收口：持久化授权与生产化接线

最早的 M3.3 只证明了 workflow 合同本身，但评审发现 worker 仍像合成 harness。因此这一阶段继续推进，直到 worker 边界本身也变成可持久恢复、可生产使用的形态。

后续补齐的内容：

- 在 `apps/temporal-worker/src/forge-worker-composition.ts` 中实现了真实的 `createForgeWorkerComposition()`，接入 worker 实际使用的生产服务；
- 在 `libs/orchestration-runtime/src/lib/forge-run-progression-service.ts` 中新增 progression seam，统一负责 scheduler reevaluation、dispatch 持久化和 finalization；
- builder 和 repair 执行都加入了对 PREPARING attempt 的严格校验，Temporal 传入的紧凑标识符会先还原成持久化运行时再授权；
- repair 现在会把新的评审结果持久化为 `parentIteration + 1`，而不是继续沿用 builder review 的身份；
- workflow 在集成后会再次 reevaluate，这样最小的 `A -> B` 依赖链才能真正向前推进；
- worker 侧新增 progression 测试，验证 fresh run 能创建并持久化新的 PREPARING attempt，集成后还能恢复出同一个授权，最终把 run 推进到 completed。

为什么这一步重要：

- worker 现在从 SQLite 恢复绑定、attempt、评审和 impact，而不是自己编造授权；
- reevaluation、repair admission、integration 和 finalization 都落在同一套持久化授权模型上；
- Temporal 重试时可以恢复同一组授权，不会重复发明新的合成工作。

验证了什么：

- `libs/orchestration-runtime` 和 `apps/temporal-worker` 都能编译；
- 新的 orchestration progression 测试通过；
- Temporal runtime workflow 测试通过；
- `apps/temporal-worker/src/forge-worker-composition.spec.ts` 的生产 worker 纵向测试通过。

这一阶段之外的 lease hydration、BLOCKED repair 续跑和重启恢复，已经在 M3.4 作为独立的 Scenario B 保证完成。

## Stage M3.4：BLOCKED repair 的重启与持久续跑

这一阶段完成了 Scenario B，同时没有重新打开已冻结的 M3.3 worker authority 模型。它为生产 worker 补齐了重启安全的 BLOCKED repair 续跑能力。

完成的内容：

- 持久化 repair work item admission，记录续跑所需的 builder、workspace、lease plan、review、impact 和 policy lineage；
- 以 `repairAttemptId` 为范围的 repair wake signal，支持多次 BLOCKED -> wake -> resume，以及 early wake 处理；
- 与 `BLOCKED` -> `PREPARING` CAS 原子写入的 revision-bound resume dispatch，使 Temporal 丢失响应和 CAS loser 都能恢复同一份授权，而不是创建新工作；
- CAS 前对 repair attempt、work item、binding、已完成 builder attempt、parent repair review、精确 review subject 和 policy fingerprints 进行完整 continuation 校验；
- 每个 run 独立的 write guard，从 SQLite 当前 ACTIVE leases 水合，并在每次 wake 和 repair 执行前刷新，防止已 RELEASED 的 durable lease 留在内存里变成 stale authority；
- 真实 SQLite restart vertical test：process A 持久化 BLOCKED repair，process B 打开同一数据库，处理 early wake，观察外部 durable lease release，恢复同一个 repair attempt，产出 fresh review，并集成 accepted output。

为什么它和 M3.3 分开：

- M3.3 已经完成 Scenario A 的生产化接线；
- M3.4 专注于 BLOCKED repair 的重启与持久续跑语义。

验证了什么：

- persistence、orchestration runtime、Temporal runtime 和 Temporal worker 的 TypeScript 构建；
- 41 个 SQLite persistence 测试，包括 durable dispatch recovery；
- worker composition 测试，覆盖 restart、early wake、lease release、同一 repair 的精确 resume、lost-response recovery、fresh review 和 integration；
- Temporal workflow 测试，覆盖 Scenario A 与 Scenario B 的 wake/resume 行为；
- orchestration runtime 的 progression、reevaluation 和 finalization 测试。

阶段结果：

- M3.4 的 Scenario B 已关闭并冻结。除非后续发现真实 contract regression，否则不能再修改它的 authority semantics。

这一阶段为下一步提供了什么：

- M3.5 可以在已经冻结的 Scenario A 与 Scenario B 运行时行为之上，增加 status、cancellation 和 operational control surface。

## 历史说明：早期 worker composition-root 表述

早前的草稿把 worker composition root 单独写成一个阶段；这部分工作已经并入 M3.3，不应再当作独立的 M3.4 交付物。

## Stage M3.5：持久化取消授权与运维控制

M3.5 在不重新打开已冻结的 M3.3 Scenario A 和 M3.4 Scenario B 授权合同的前提下，补齐运维控制能力。它的目标是让取消操作可持久化、可观察，并且不会在可能修改 workspace 的工作旁产生错误授权。

完成的内容：

- 取消采用两阶段的持久化状态变化：ACTIVE run 先进入 CANCEL_REQUESTED，只有已经取得授权的 mutation 工作全部完成后，才进入 CANCELLED；
- builder 和 repair 执行开始前会原子地取得 ACTIVE run 授权。取消请求发出后，任何新的 mutation 都不能再取得这份授权；
- 对于无法确认外部执行是否已经停止的 attempt，系统会记录为 UNKNOWN，而不是直接当作已取消。operator 必须在独立确认外部工作已经停止后，显式进行 settlement；
- accepted-output integration 也有独立的持久化 in-flight claim。worker 会在 run 仍为 ACTIVE 时、调用面向 Git 的 integration 前取得它；取消 finalization 会一直保持 pending，直到该 claim 被释放。因此终态 CANCELLED 不会与仍可能修改 workspace 的 integration 并发发生；
- 如果 worker 在取得该 claim 后崩溃，或丢失 integration outcome，operator 可以使用 `forge settle-integration-cancellation`，并提供精确的 run、task、workspace 和 output-attempt tuple。它只会在 run 为 CANCEL_REQUESTED 时移除匹配的 orphaned claim，使取消可以完成，而不会让 claim 变成永久 tombstone；
- Pi agent 的取消现在区分“发出请求”和“已经确认”。只有 provider session 成功确认 `abort()` 后，runner 才会报告 cancelled。abort 失败或含义不明确的错误会向上传播，已有的 builder 和 repair 路径会保留 active lease 并持久化 UNKNOWN，而不是错误地释放授权；
- CLI 提供 `forge status`、`forge cancel`、`forge settle-cancellation` 和 `forge settle-integration-cancellation`，让 operator 可以查看 run、请求取消，并显式协调不确定的 builder、repair 或 integration 工作。

为什么这很重要：

- 发出取消请求不等于外部进程、agent 或 Git 操作已经停止；
- 持久化 claim 会把“是否允许 mutation”的判断与 run 状态做成原子操作，覆盖 integration read gate 与外部 Git effect 之间极窄但关键的时间窗口；
- 对不确定的工作保持 UNKNOWN，可以避免后续执行误以为 workspace 已安全，而此前的进程实际上仍可能修改它。

验证了什么：

- worker 和 SQLite persistence 的聚焦回归套件通过，其中包括 accepted-output integration 被暂停时取消必须保持 pending，直到 integration 完成的场景；
- Pi gateway 和 Pi runner 的聚焦套件通过，其中包括 provider `abort()` 失败必须向上传播、不能被误判为取消确认的场景，即使 prompt completion 先赢得最初的 race；
- `pnpm typecheck` 通过；
- `pnpm lint` 通过；
- `pnpm test` 通过：676 passed，1 skipped；
- `pnpm build` 通过，包括 TypeScript project-reference build 和 CLI bundle。

当前限制：

- 取消并不是对任意外部工具的强制终止保证。对 UNKNOWN attempt 使用 `forge settle-cancellation`，或对 orphaned integration claim 使用 `forge settle-integration-cancellation` 前，operator 必须独立确认外部进程或 Git 操作已经停止，并且不再可能修改 workspace；
- 本阶段没有引入通用的跨进程 fencing protocol、外部发布流程或远程触发控制面。

阶段结果：

- M3.5 的持久化取消授权与运维控制范围已经关闭并冻结。除非发现真实的 contract regression，否则不能修改 M3.3、M3.4 和 M3.5 的 authority semantics。

## Stage M3.6：Legacy 与 Temporal Runtime V2 差分验收

M3.6 证明 legacy `OrchestrationRuntime` 与生产 Temporal Runtime V2 workflow 在 ADR-027 定义的迁移场景中会得到相同的持久 Forge authority outcome。验收 suite 为每个 runtime 使用独立的 SQLite authority database、run ID、workspace identity 和 repository target。它比较归一化后的持久 Forge evidence，而不比较框架特有的 event history 或 workflow 实现细节。

该 suite 使用真实 legacy runtime、真实 Temporal workflow、生产 Temporal worker composition 以及 Drizzle SQLite persistence。确定性的测试 seam 只替代外部 Git、agent、verifier、model、snapshot 和 reconciliation 副作用。两侧都使用生产 `SnapshotTaskCodeReviewSubjectProvider` 与 `TaskVerificationEvidenceFactory`，因此 canonical impact fingerprint 以及精确 review、repair 和 integration authority evidence 仍由生产代码构造。这样既能使测试可重复，又仍然会执行迁移必须保留的 runtime authority boundary、persistence、review lineage、repair admission、integration admission 和 recovery behavior。

已构建：

- normal-path fixture 会在两个 runtime 中执行 build、verification、请求 repair 的 review、一次 repair、repair verification、accepted review，以及精确 accepted-output integration；
- blocked-repair fixture 会持久化 `BLOCKED` repair，释放它精确的 blocker lease，恢复同一个 repair ID，递增持久 revision，写入一个 authorization dispatch，完成 repair，并在两个 runtime 中集成 accepted output；
- legacy recovery 现在会将 resume authorization 传入已有的原子 repair-resume persistence operation。持久 repair-state transition 与唯一 resume-dispatch record 会一起提交，因此 recovery retry 不会为同一个 blocked snapshot 授权额外执行；
- legacy runtime integration 现在会在 workspace integration 后，从精确 admitted review subject 持久化 outcome。`WorkspaceManager` 仍然只是 Git adapter，不能编造或猜测 accepted output attempt；
- SQLite outcome collector 会先按持久 verification timestamp、再按 attempt 与 evidence identity 排序 verification evidence，再选择最终 evidence。即使 timestamp 相同，也不会依赖偶然的数据库行顺序。

已验证：

- 两个 runtime 都独立满足共享 durable-outcome contract 中的 `build-review-repair-integrate` 和 `blocked-repair-restart-resume`；
- 归一化后的 legacy 与 Temporal outcome 相等。归一化会替换 runtime 生成的 ID、由其派生的 verification fingerprint、timestamp 以及 runtime-local absolute revision value。它保留 authority structure，同时每个 runtime 都独立证明 blocked-to-resumed revision relationship；
- blocked 场景为两个 runtime 都证明了精确 blocker release、相同 repair attempt ID、blocked-to-resumed relationship、一个 dispatch、最终 accepted review 和精确 integration output binding；
- Temporal 侧使用真实 test Temporal server、worker、生产 workflow、生产 worker composition，以及生产 builder/evaluation/repair/integration service。只有外部 adapter 是确定性的 seam。Legacy 侧使用真实生产 `OrchestrationRuntime` topology 与 coordination service；
- blocked 场景会在两个 runtime 中跨越真实 restart boundary。每个 phase 都关闭 SQLite connection，并针对同一个 authority database 重建对应 runtime 的 worker 或 runtime，然后才通过已释放 blocker 恢复 repair。Temporal 侧会先 await worker A 到达 `STOPPED`，之后才会在同一个 task queue 上创建 composition B 和 worker B。

范围与剩余工作：

- 本阶段刻意不包含 runtime-conflict parity。ADR-027 将跨 runtime 的 conflict behavior 延后到 Stage 22/22R suite；
- 确定性 seam 并不声称替代真实 Git、外部 agent session 或 model-provider integration coverage。这些外部副作用仍由专门的 integration test 覆盖；
- M3.6 在这两个 ADR-027 迁移场景范围内已经关闭并冻结。除非发现真实的 contract regression，否则不能修改 M3.3 至 M3.6 的 authority semantics。

## Stage M3.7：Provider-neutral Forge runtime composition

M3.7 将生产 Forge activity composition 从 Temporal worker application 中提取出来，但不改变选定的 durable runtime，也不改变任何 Forge authority rule。ADR-028 仍然选择 Temporal。本阶段的目的是让未来 provider adapter 能复用 SQLite-backed Forge service stack，而不是在另一个 worker 中复制它，或把较早的 Restate spike 当成生产证据。

已构建：

- `forge-runtime-contracts` 现在拥有紧凑的 Forge run、activity、repair-wake 与 activity-port contract。这些 contract 只包含可序列化的 identifier 和 result；不会暴露 Temporal、Restate、persistence-provider、compiler 或 domain implementation object；
- `forge-runtime-composition` 现在拥有原生产 Temporal worker composition：SQLite recovery、write-guard hydration、ACTIVE-only claim、builder/evaluation/repair/integration service、cancellation reconciliation、精确 blocked-repair continuation，以及 run progression/finalization；
- 共享 composition 不导入 Temporal SDK。provider 可以选择提供一个包含 cancellation signal 的 activity execution context。没有该 signal 不会产生 authority，也不会绕过任何 durable validation；
- 共享 composition 拥有 neutral 的默认 authority-store 位置 `dist/forge-runtime.sqlite`。provider 仍可通过已有的 persistence override 或 `FORGE_WORKER_DATABASE_PATH` configuration 选择不同的 store；
- Temporal worker 现在是很小的 compatibility adapter。activity 在 Temporal 下运行时它提供 `Context.current().cancellationSignal`；direct composition test 则安全地不提供 signal；
- 现有 Temporal contract export 作为刻意的 compatibility boundary 仍可从 Temporal package 获取，但实现由 neutral contracts library 提供；
- `SandboxedPackageScriptVerifier` 已从已有的 `run-preparation` public boundary 导出，因此提取后的 composition 不再进入其他 package 的 source tree。

已验证：

- 提取后的 composition 会与 contracts library、Temporal runtime 和 Temporal worker 一起通过 type-check；
- 既有 production composition test 仍然通过，其中包含 durable recovery、cancellation、integration-claim 和 blocked-repair authority coverage；
- 真实 Temporal workflow topology test 仍然通过，证明 workflow bundle 能消费已迁移的 compact contract；
- 新 composition library 不依赖 `@temporalio/*` 或 Temporal runtime package。

范围与剩余工作：

- 这只是 extraction。不新增 Restate production runtime、Restate worker 或 Restate parity claim；
- synthetic `restate-spike` 与其 authority fixture 仍是历史 candidate evidence，不是生产 Forge execution path；
- 未来 provider adapter 必须复用 neutral contracts 与 composition，然后独立证明 production-stack parity 以及所需的 split service/executor restart behavior；
- M3.3 至 M3.6 仍然冻结。M3.7 保留其 durable authority semantics，只改变代码所有权和 provider boundary。

## Stage M3.8：Restate provider coordination adapter

M3.8 新增了一个隔离的 Restate runtime adapter，它消费 M3.7 的 provider-neutral `ForgeActivities` port。它不改变 ADR-028：Temporal 仍然是选定的 durable-execution substrate。这个 adapter 证明第二个 provider 可以 journal Forge coordination，同时把 authority decision 保留在 compact activity port 及其最终连接的 SQLite-backed composition 中。

已构建：

- `restate-runtime` 拥有这个 adapter 的全部 Restate SDK import，并导出 `createRestateForgeRunService`；
- 它的 Forge run workflow 镜像已选 provider 的 compact control flow：scheduler reevaluation、builder execution、output evaluation、repair admission/execution、accepted-output integration，以及 final run state；
- blocked repair 通过精确 repair attempt ID 关联。wake 会先到达 `resumeBlockedRepair`；只有 durable `resumed` result 才能再次执行该 repair；
- Restate durable promise 是 one-shot，因此 adapter 会在 execution 可能报告 `BLOCKED` 前 arm durable wake generation，并在每次 resume authorization 前 arm successor。成功 resumed 的 execution 期间仍保留当前 repair 的 armed state，因此同一 repair 可以 durable BLOCKED、resume 后再次 BLOCKED，而不会丢失下一次匹配 wake。wake 始终只是 hint，不是 authority；
- 新 runtime 不导入历史 `restate-spike` 或其 synthetic scenario service。

已验证：

- 一个 live `RestateTestEnvironment` test 使用 scripted compact activity port 运行新 service；
- 错误 repair ID 不会产生 resume attempt；
- Forge 已到达 `BLOCKED`、但 activity response 尚未返回时收到的一次匹配 wake 会被 buffer 并重新授权；
- Forge 正在判定前一次 resume 为 `ignored` 时收到的一次后续 wake 会为已 arm 的 successor generation 保留；
- 已成功 resumed 的 repair 再次执行期间收到的一次匹配 wake，在该 repair 返回 `BLOCKED` 后仍会保留，并针对同一 repair ID 重新授权；
- 后续匹配 wake 返回 `resumed` 时会执行同一 repair ID、集成它的 accepted output、reevaluate 并 finalize run；
- adapter 能通过 type-check、lint、format，并参与 workspace build 与 test configuration。

范围与剩余工作：

- M3.8 只证明 provider coordination。它没有新增 Restate worker application、没有把真实 Forge runtime composition 接入 Restate，也不声称与 Temporal 或 legacy execution 存在生产 SQLite authority parity；
- `RestateTestEnvironment` 会打包 Restate server 与 service endpoint。成功的 wait/wake test 不是独立替换 executor 后仍能恢复 pending workflow 的证据；
- 后续 production parity stage 必须使用 shared composition、隔离的 authority store、归一化 durable outcome，以及 split server/service-process restart fixture，之后才可作出更强的结论；
- M3.3 至 M3.7 仍然冻结。M3.8 是 additive，不改变既有 Forge authority semantics。

## 阶段 M3.9：完整 Stage 22/22R authority differential parity

M3.9 完成面向生产的 legacy 与 Temporal V2 authority 对比。测试让真实 legacy
`OrchestrationRuntime` 与真实 Temporal workflow 加 production Forge composition 分别使用隔离的
SQLite database、run ID、workspace 和 repository target。Git、agent、review-model、verifier、snapshot
与 reconciliation effect 使用确定性 adapter seam；它们不会替换 production builder、evaluation、repair、
integration、progression 或 persistence service。

本阶段完成：

- runtime scope expansion 现为 provider-neutral conflict calculation。builder 或 repair 发现超出预测
  lease scope 的写入时，会在激活它的同一个 durable scheduler reevaluation 中持久化 hard conflict；该
  conflict 会影响 replay 和之后的所有 scheduling；
- 两任务 scope 场景证明 project-level predicted lease 与观察到的 `core:expanded.ts` 写入冲突。任务 B
  只能在任务 A durable completed 后获得 authorization；
- 套件通过不可变的 review recommendation `repair`、`repair`、`accept` 证明两次 repair，并验证最终
  evidence、accepted review 与 integration identity 都绑定 repair two；
- repair-budget exhaustion 保留两次 completed repair 和第三次 review/evidence、拒绝继续 admission 且
  不 integration。Temporal 将其视为 durable validation decision 而非 transient work，因此不可重试；
- post-session builder 和 repair failure 会持久化带 session evidence 的 `UNKNOWN` 并 fail closed。
  Temporal 对这些 agent activity 最多执行一次，保留未决 authority，并与 legacy run-state boundary 一致，
  而不重试不安全且 state-invalid 的 activity；
- blocked accepted-output integration 现在是 additive provider-neutral continuation。其精确身份为 run、
  task、workspace 和 accepted output subject。continuation 会重新验证 reviewed workspace content，通过
  已有 integration claim fence Git work，只调用 `resumeIntegration`，绝不重跑 builder、repair、
  verification、review 或 commit；
- Temporal 具有独立的精确 integration wake signal。wake 只是 hint：错误或过期 target 会被忽略，重复
  block 会继续等待；新的 worker 可在同一个 authority database 上恢复现有 workflow。Legacy 只在显式
  `recoverAndResumeRun` recovery 中进行等价 retry；
- dependency progression 通过 canonical scheduler start authority 比较：任务 B 只会在任务 A 已于 input
  snapshot 中 durable integrated completed 后被授权；
- 一个 scheduler authorization snapshot 现在会以稳定顺序并发启动独立 builder。同一 run 的普通 lease
  contention 保留原 builder attempt 的 `PREPARING` 状态、回滚 partial lease、持久化 `lease-blocked`，且
  不启动 agent。精确 lease release 会重新授权同一个 attempt ID，使其随后完成；
- compact builder result 现为 completed-or-blocked union。blocked builder 不会进入 evaluation、repair 或
  integration。scheduler dispatch 在 unblock 后会复用匹配的 `PREPARING` attempt，而非创建重复 attempt；
- 一个 composition 现在在整个生命周期内为每个 run 保留一个 hydrated write guard。并发 builder activity
  会共享该 guard，而不会在 refresh 时替换它，因此同一 run 的 lease acquisition 只有一个有效 authority
  view。在 durable continuation 使用该稳定 identity 前，当前 SQLite lease record 会 reconcile 到同一个
  serialized guard object，因此后续的 `RELEASED` 或 `STALE` transition 可以可见，而无需替换 guard。
  hydration 也保留 released lease history 和 active lease；released lease 不会阻塞工作，但其 ID 与
  version 会阻止重建 activity 复用旧 lease ID 并触发 SQLite version check failure；
- builder mutation authority 现在会在同一个 ACTIVE-run claim 中原子持久化完整 acquired lease plan 与
  `PREPARING -> STARTING` transition。workspace creation 只会在 claim 胜出后开始。因此 cancellation
  先胜出时 attempt 保持 PREPARING、不会创建 workspace，也不会持久化 active lease；claim failure 会先
  rollback in-memory acquisition，不会留下 durable lease evidence；
- run-level integration summary 现更新 latest status。逐任务 authority 仍由 integration claim、workspace
  record、accepted review subject、attempt、lease 和 scheduler history 保存。

已验证：

- 真实 legacy 与 Temporal 差分场景覆盖 normal repair/integration、blocked repair restart 与 exact lease
  resume、runtime scope expansion、repeated repair、budget exhaustion、builder/repair `UNKNOWN`、blocked
  integration（包括错误 wake、repeat block 和 worker restart）、dependency progression 以及同一 run 的
  concurrent competing builder；
- scope conflict 在两侧具有相同 durable task-pair、constraint、resource、severity、effective sequence 与
  replay behavior。比较特意忽略 framework-specific event 名称；
- concurrent builder wave 会在任一 builder complete 前启动 durable authorization snapshot 中全部任务。
  lease-blocked builder 没有 STARTING lifecycle claim 或 agent session、会跳过所有 downstream work，并在
  exact blocker release 后以原 attempt identity 运行；
- 对抗测试强制两个同 run builder 在任一 acquire lease 前并发 hydrate，证明共享 guard 会阻塞第二个
  builder。独立的 service 与 SQLite 测试证明 cancellation-lost start claim 不会创建 workspace 或 active
  lease。真实 repair continuation test 会在 blocker 仍为 ACTIVE 时 hydrate stable guard，再通过另一 SQLite
  connection 将 blocker release，然后证明 resumed repair 能 acquire 原先冲突的 resource，而不会因 stale
  guard state 再次 blocked；
- blocked integration restart 证明 worker A 在 worker B 使用同一 SQLite database 与 task queue 重建
  composition 之前已经到达 `STOPPED`。匹配的 legacy 场景也会在 recovery 前重建 runtime 与 persistence；
- `pnpm lint`、`pnpm typecheck`、`pnpm test` 与 `pnpm build` 都通过。全量 suite 报告 71 个 test file、
  703 个 passing test 和 1 个 skipped test。一次全量测试出现 transient timeout 后，也已单独重跑
  cancellation workflow test 并再次完成完整 suite。预期的 Temporal test-server warning 与 intentional
  failure-path activity log 不代表测试失败。

范围与剩余工作：

- M3.9 已关闭所验证的 isolated、same-run Forge authority 场景的 Stage 22/22R parity：runtime conflict、
  multi-task dependency progression、repeated repair 与 budget、fail-closed UNKNOWN、blocked integration
  recovery，以及 concurrent competing lease behavior；
- same-run 是明确边界。当前 SQLite-backed write guard 从单个 run 的 lease 重建，并没有 repository-wide
  active-lease recovery query。因此本阶段不声称 cross-run competing-lease 或 horizontally distributed
  SQLite-worker parity；
- 本阶段不使用真实 Git/model-provider side effect，不改变 ADR-028 的 Temporal selection，也不修改已冻结的
  M3.3 至 M3.8 authority semantics。cross-run locking 或 distributed-worker support 需要后续设计
  provider-neutral global lease authority，不能通过 workflow shortcut 实现；
- M3.9 对已验证的 same-run Stage 22/22R boundary 已关闭并冻结。后续工作可进入选定 Temporal 的
  production cutover、observability/read model、production end-to-end hardening、API/UI、advisory memory，
  并仅在 scaling 需要时引入 PostgreSQL。

## Stage M3.10：Temporal 启动桥接

M3.10 开始已选定 Temporal 的 production cutover，但不把 Forge authority 移入 Temporal。CLI 仍会准备并
验证已批准的 run，但不再构造 `LocalRuntimeStarter` 在进程内执行。`TemporalRunLauncher` 会先在已配置的
SQLite store 中持久化 run、binding、conflict、schedule 和初始 `run-started` authority decision，然后才请求
Temporal 以紧凑的 run ID 启动 `forgeRunWorkflow`。初始 dispatch 使用从不可变 run authority 派生的 evidence，
因此 retry 或 concurrent launcher 只能持久化相同的 sequence-one `run-started` decision 和 PREPARING attempt ID。
sequence one 已持久化后，即使该 attempt 已推进，后续 launch 也不会重新评估 Forge scheduling，只会请求 Temporal
复用 workflow。progression service 会从新鲜 authority 再次检查 sequence one，dispatch 写入边界也会将陈旧的
sequence-one 写入作为 no-op，因此持有空快照的 launcher 不会在另一个 launcher 初始化 run 后创建 sequence two。
该 no-op 仅限专用的 initial-dispatch persistence 边界；通用 progression dispatch 仍会持久化每一个返回的
authorization。若每个 sequence-one `start` decision 没有 durable attempt evidence，或其不可变的 agent、workspace、
lease、command-policy、trusted-path authority 与 task binding 不一致，初始 history 也会被拒绝。initial-dispatch
transaction 在将等价的既有 sequence one 作为 no-op 前也会执行相同的 evidence 检查。

Temporal client 使用稳定的 workflow identity `forge-run:<runId>` 和 Temporal `USE_EXISTING` conflict
policy。相同 authority 的重复启动复用同一个 durable Forge request 和 workflow identity。若复用的 run ID
具有不同 authority、binding、task、conflict 或 schedule，会在联系 Temporal 前 fail closed。

第一版 deployment boundary 有意只支持一个显式配置的 authority scope。`forge run` 和独立 worker 都要求
非空的绝对路径 `FORGE_WORKER_DATABASE_PATH` 与 `FORGE_WORKER_REPOSITORY_PATH`；CLI 还会拒绝 worker scope 外的
repository path。CLI 只是 Temporal client，不启动 worker；worker 仍是独立运行的进程，并读取同一个已配置 SQLite
authority store。

验证：

- launch 测试证明首次初始化、初始 dispatch 之前崩溃后的恢复、concurrent launcher 的相同 retry evidence、初始
  attempt 已开始后以及门控的 stale empty-history read 后的 authority-neutral relaunch、稳定 workflow identity 和
  authority mismatch rejection；
- CLI command 测试和 Temporal client 测试通过；
- launch acceptance 测试通过 `TemporalRunLauncher` 初始化 authority，经 production `startForgeRun` 启动 workflow，
  并由使用同一个临时 authority 文件的独立 SQLite connection 和 production Forge composition 的独立实例化 worker
  完成；
- `pnpm lint`、`pnpm typecheck`、`pnpm test` 和 `pnpm build` 通过。全套测试为 72 个 test file、707 个通过、
  1 个跳过。

范围和剩余工作：

- M3.10 不删除 legacy runtime，不引入 dynamic per-run worker routing，也不宣称 multi-host worker fleet；
- 此 boundary 不修改已冻结的 M3.3 至 M3.9 scheduler、lease、cancellation、review、repair 或 integration
  authority semantics；
- 此测试环境证明 launch/worker authority boundary，但不证明独立部署的 worker process、真实 external provider
  effects 或 operational production readiness。

独立 review 后，M3.10 已 **PASS / CLOSED / FROZEN**。除非证明存在 contract regression，或另行设计新的阶段，
不得修改这个 launch authority boundary。

## Stage M3.11：Temporal production deployment 与 process boundary

M3.11 验证了 M3.10 有意保留的 deployment boundary。现在除 CLI bundle 外还会构建可运行的 worker bundle，因此
`node apps/cli/dist/main.js` 与 `node apps/temporal-worker/dist/main.js` 可以作为独立进程运行。CLI 仍只是
Temporal client：它在已配置 SQLite 文件中持久化 launch authority 并启动 workflow；它不会构造 worker 或 runtime
composition。

当提供 `FORGE_WORKER_DATABASE_PATH` 时，operational command 会使用该显式 authority SQLite，而不会悄悄打开
`--run-directory` 下每个 run 的数据库。只有未配置 deployment authority path 时才保留 legacy per-run 路径回退。
已配置路径必须非空且为绝对路径。因此 `forge status`、`forge cancel` 与 cancellation settlement 会读取并修改独立
worker 所观察的同一个 durable authority。

worker app 保持真实 Pi、Git 和 Docker composition 作为默认值。仅为 hermetic process test，在 app boundary 提供了
范围受限的 `FORGE_WORKER_COMPOSITION=acceptance` mode；它提供确定性的 builder、reviewer 和 verifier adapter，
但不会把 deployment policy 放入 provider-neutral composition library。未知 mode 会 fail closed。测试启动具有
child-reachable 随机地址的 local Temporal server，再以同一个绝对 SQLite authority path、repository scope 和唯一
task queue 启动编译后的 CLI 与独立 Node worker。

worker restart recovery 会在 builder 已 durably completed 且 evaluation 暂停后执行。可安全重试的 evaluation activity 现在有
五秒 heartbeat timeout，acceptance reviewer 在暂停时持续 heartbeat。worker 死亡后，替代 worker 会接收重试 activity。
当 immutable builder attempt、workspace snapshot 与 policy identity 相同，verification evidence 会复用，因此在
evidence 持久化后崩溃不会因生成新的随机 evidence 而使重试失败。builder 和 repair activity 仍保留 one-attempt
boundary，因为它们可能执行 non-idempotent external work。也会先恢复完全匹配的 iteration-one review subject 与
review，才会再次调用 reviewer，因此 review 已持久化后 Activity response 丢失不会重复 nondeterministic model call，
也不会与 durable review authority 冲突。

验证：

- compiled-process acceptance 启动真实 local Temporal server、compiled CLI subprocess 及独立 compiled worker
  subprocess；正常执行在 durable SQLite 中达到 `COMPLETED`，且只有一个初始 authority event 和一个 builder attempt；
- restart acceptance 在 heartbeat-protected evaluation 期间杀死 worker A，再以相同 server、queue、repository 与
  SQLite 文件启动 worker B，并证明完成时没有第二个初始 event、builder attempt、workspace，或已持久化 review 后
  lost response 导致的第二次 reviewer call；
- worker A 与原始 launch process 退出后，由新的 compiled CLI process 发出 cancellation，worker restart 后仍达到
  durable `CANCELLED`；
- 即使 `--run-directory` 指向不同的空位置，status 仍读取已配置 authority SQLite；CLI 与 compiled-worker 测试均会
  拒绝相对 authority database path；
- `pnpm build`、目标 CLI/runtime 测试以及 compiled-process acceptance 均通过；
- `pnpm test` 会先运行 non-worker project，再在独立的串行 Vitest process 中运行 legacy differential、composition 与
  compiled-process worker spec，在保留其他项目并行的同时避免 local Temporal resource contention；最终全套测试为
  73 个 test file、713 个通过、1 个跳过。

范围和剩余工作：

- M3.11 证明的是 local Temporal server 和 SQLite-backed single authority scope，不是 multi-host fleet 或 PostgreSQL
  deployment；
- 默认 executable 仍使用真实 provider adapter，但 live Pi/Claude/Git/Docker smoke 是 M3.12 的 opt-in external
  integration 工作，不进入默认 test suite；
- 本阶段不重新设计已冻结的 scheduling、lease、repair、review、integration 或 M3.10 launch authority contract。

独立 review 后，M3.11 已 **PASS / CLOSED / FROZEN**。除非证明存在 process-boundary deployment contract regression，
或另行设计新的阶段，不得修改这个边界。

## M3.12：外部副作用 Smoke Harness

M3.12 先提供一个刻意 opt-in 的真实外部副作用 smoke runner。它不属于默认 test suite；只有 operator 显式提供以下
全部配置时，才会调用 provider：

- `FORGE_M312_EXTERNAL_SMOKE=1`：授权本次特定的 external smoke；
- `FORGE_M312_CREDENTIALS_CONFIRMED=1`：确认 provider-owned credential 已配置；
- `FORGE_M312_CODING_AGENT_CONFIRMED=1`：确认允许真实 coding agent 执行；
- `DEEPSEEK_API_KEY`，以及 `FORGE_M312_REVIEW_PROVIDER=deepseek` 与
  `FORGE_M312_REVIEW_MODEL=deepseek-flash`：当前 closure run 获明确批准的 identity。

任一值缺失或为空时，runner 会在创建 Temporal server、worker、Git fixture、Docker container 或 model session
之前失败；若 provider/model 不等于获批准 identity，或 Pi 的本地 model registry 无法解析该 identity，也会在此前失败。规划、semantic review、builder coding、repair
coding 与 task code review 都显式使用同一个已解析 Pi model 和 durable review policy，任何 smoke role 都不能回退到 Pi 的隐式
默认 model。builder 和 repair runner 共用一个 provider-neutral gateway override，因此即使 nondeterministic review 建议 repair，也
不会选择隐式 model。它始终创建 disposable temporary Git repository，而不会把本 orchestrator repository 当作目标。获得明确授权后，runner
执行 production path：带 semantic review 的 compiled `forge plan`、approval、compiled `forge run`、独立启动的 compiled
worker、真实 Pi coding/review adapter、真实 Docker verifier、Git integration，以及 durable Temporal/SQLite completion check。
harness 比较 fixture base commit 与 integrated checkout 的 `HEAD`，要求该范围中只有 `src/index.ts`、文件内容精确匹配且
integrated working tree 干净。`pnpm smoke:m3.12` 会先构建 runnable artifact 再调用该 guarded runner；设置
`FORGE_M312_KEEP_FIXTURE=1` 可保留 disposable fixture 供 operator 排查。

当前 verification：

- unit test 已证明缺少 authorization、credential attestation、coding-agent attestation、DeepSeek credential、provider、空 model
  或其他未获批准 model 配置时会 fail closed；
- composition regression 会强制产生 `repair` recommendation，并证明同一个注入的 coding gateway 同时服务 builder 和
  repair session；Pi gateway test 则独立证明显式解析的 model 会传入每个 session factory；
- 已在没有 authorization 的情况下调用 compiled runner；它以
  `M3.12 external smoke requires FORGE_M312_EXTERNAL_SMOKE=1` 停止，未执行任何外部 provider 或 Docker 操作；
- 一次使用 `deepseek/deepseek-flash` 的获授权真实 smoke 已完成：compiled CLI 与独立启动的 worker 经由 local
  Temporal、configured SQLite authority、真实 Pi adapter、Docker verification 和 Git integration 成功完成；harness
  记录该精确 identity 的 `COMPLETED` 结果。

M3.12 经独立 review 后为 **PASS / CLOSED / FROZEN**。已记录的运行使用精确、由
operator 确认的 `deepseek/deepseek-flash` identity。其 `DEEPSEEK_API_KEY` 只注入 smoke subprocess，不会写入
repository evidence。成功结果记录了精确 provider/model 与 `COMPLETED` outcome。本变更不修改已经冻结的 M3.10 或
M3.11 runtime contract。后续对该 external-effect boundary 的修改必须由已证明的 regression 或单独设计的
stage 驱动。

## M3.13：可观测性与 Provider-Neutral Read Model

M3.13 增加 operator-facing read boundary，不改变 scheduling、execution 或 provider behavior。`ForgeReadModel`
位于 orchestration runtime，只读取 provider-neutral durable authority record：persisted run、task transition、
builder attempt、repair attempt、verification evidence 与 code review。它产出 `ForgeRunReadModel`、task/attempt
summary、当前 blocking reason、verification/review reference，以及有序 durable timeline。

repair lineage 来自 durable record，而不是从 review iteration 推断。repair attempt、它的 verification evidence 与
后续 review 都同时关联原始 builder `attemptId` 和 repair `repairAttemptId`。lease resource 使用 structural、
discriminated summary，完整保留 symbol ancestry；runtime blocking reason 保留 lease 与 runtime-conflict reference，
使 API 或 UI 不必重建 scheduler history 即可呈现。

每条 read-model record 都带 provider-neutral correlation object。在可用时它包含 durable identifier：`runId`、
`taskId`、`attemptId`、`repairAttemptId` 与 `workspaceId`。CLI 再加入稳定的 workflow correlation
`forge-run:<runId>`，以及 `execute-builder`、`execute-repair`、`evaluate-output`、`reevaluate-run` 等 operation
label。read model 从不 import Temporal type，因此未来 API 或 UI 可复用同一 summary，而不会耦合 workflow SDK。

`forge status` 现在打开 configured SQLite authority store，并委托 `ForgeReadModel` 投影；它不再在 CLI 内构造第二份
durable-state interpretation。这使 `status` 与 production launch、worker、cancel 使用的 explicit authority database
保持一致。专门 regression 覆盖了 blocked task 的 builder/repair lineage、verification、review、timeline 以及全部必要
correlation。read model 也保留 durable lease summary，避免 `forge status` 在改用统一 projection 后丢失既有的
lease observability。该 regression 使用 repair verification evidence 与 iteration-two repair review，防止把 repair
evidence 错报成只属于 builder 的 attempt。

M3.14 的准备工作刻意保持 non-destructive。`docs/runtime-v2-cutover-preparation.en.md` 及其中文副本盘点保留的
legacy differential runtime 和 frozen prototype package，说明当前 production route、cutover assertion 与 deletion
order。它们明确禁止在 M3.12 记录成功的 authorized external-effect smoke 前删除最终 legacy runtime，或宣称 Runtime V2
已完成。

验证：

- focused read-model 与 CLI status test 验证 projection 和 JSON surface；
- `pnpm lint`、`pnpm typecheck` 与 `pnpm build` 通过；
- `pnpm test` 通过 74 个 file、720 个通过和 1 个跳过，其中包括单独调用的 Temporal worker phase；
- `pnpm check` 仍会在本阶段之外既有的 formatting issue 处停止，会如实报告，绝不静默修改 inherited file。

M3.13 经独立 review 后为 **PASS / CLOSED / FROZEN**。对该 durable read-model contract 的后续修改必须由已证明的
regression 或单独设计的新阶段驱动。M3.12 已在独立 review 后成为 PASS/CLOSED/FROZEN；没有执行任何
destructive M3.14 cutover 工作。

## M3.14：非破坏性 Cutover Readiness

M3.14 将 Runtime V2 尚存的 migration inventory 从描述性文档转换为 machine-checkable cutover gate。
`docs/runtime-v2-destructive-cutover-manifest.json` 分类保留的 legacy runtime、differential test、frozen prototype
package、test-only spike support 与可复用 application service；它还记录 caller、M3.12 通过后是否可删除，以及
destructive stage 必须满足的最终 assertion。`ForgeRunProgressionService` 与 `ForgeReadModel` 等可复用 orchestration
service 被明确保留，不能与 legacy in-process `OrchestrationRuntime` 混为一谈。

`apps/cli/src/runtime-v2-cutover-readiness.spec.ts` 使 production boundary 可执行验证：compiled CLI 不含 legacy
runtime、`LocalRuntimeStarter`、worker-composition 或 stale spike dependency；production package root 将可复用
service 与显式 `/legacy` entrypoint 隔离；`forge run` 使用 `TemporalRunLauncher` 与 `startForgeRun`；只有独立部署的
worker 组合 Temporal activity。同一测试还要求 manifest 保持 non-destructive，并保留完整 inventory 与 9 条最终
cutover assertion。

cutover preparation 文档现在说明 manifest、直接 caller、deletion order 与严格 gate。M3.14 不删除任何内容，也不引入
alternate runtime path。

验证：

- cutover-readiness architecture regression 与 CLI command test 通过；
- `pnpm lint`、`pnpm typecheck` 与 `pnpm build` 通过；
- non-worker `pnpm test` phase 通过 72 个 file、692 个通过和 1 个跳过，但冻结的 M3.9 same-run
  competing-lease differential 在 Temporal worker phase 及 isolated rerun 中超时，因此完整 suite 当前并非全绿；
- `pnpm check` 仍在本阶段以外既有的 formatting issue 处停止，会如实报告且不修改 inherited file。

M3.14 当前为 **CUTOVER READY / M3.12 PASS-CLOSED-FROZEN / AWAITING DESTRUCTIVE-STAGE REVIEW**。production root
已与 `/legacy` entrypoint 显式隔离。成功的 M3.12 smoke 已满足该 prerequisite，但在另行设计并审查 destructive stage
前，不得执行 destructive cutover、legacy deletion，或宣称 Runtime V2 已完成。该 stage 还必须将 normal worker
review-policy selection 变为显式 deployment configuration，并证明它与 CLI durable authority policy 匹配；当前仅用于
smoke 的 DeepSeek override 不满足这项 normal-production assertion。

## M3.14 Sequence B：Destructive Runtime V2 Cutover

Sequence B 删除已退休的 in-process `OrchestrationRuntime`、`LocalRuntimeStarter`、它们的 legacy entrypoint
与测试、legacy-versus-Temporal differential suite，以及全部 frozen Temporal/Restate spike package 和 harness。
package export、workspace reference、build/test script、Vitest coverage exclusion 与 pnpm lockfile 均不再保留这些
asset。可复用的 production service 继续保留在 `libs/orchestration-runtime`；唯一的 production execution route
仍是 CLI launcher、Temporal workflow 与独立部署的 worker。

保留的 production test 保护精确、不匹配及重复的 blocked-integration wake。一个 local Temporal server 测试等待
worker A 达到 STOPPED 后才启动 worker B，并明确标记精确 wake 后的 resume activity 由 B 执行；另一 composition 测试关闭临时 SQLite authority database 的第一个连接并为
worker B 重新打开，证明错误 wake 不解除阻塞，精确 wake 仅集成一次，重复 wake 不重复执行。bounded repair 测试在第三次
repair recommendation 耗尽预算后，仍保留两个已完成 repair、三条 review 与 verification evidence，且没有
integration claim 或 `workspace-integrated` event。核心 repair-execution 测试保留 post-start `UNKNOWN` authority
行为；本阶段未独立断言完整 Temporal repair-UNKNOWN nonterminal 场景。cutover manifest 与 regression 继续证明
retired path 已不存在，并保留 M3.12 external-smoke evidence。

normal production review authority 现在是显式配置，而不是 composition default。CLI 的 `plan`、`bind` 和 `run`
会在 authority persistence 前 canonicalize 并解析必填 provider/model。worker 要求
`FORGE_WORKER_REVIEW_PROVIDER` 与 `FORGE_WORKER_REVIEW_MODEL`，在 polling Temporal 前解析相同 canonical policy，并在
blocked-repair resume、scheduler reevaluation 等 mutation entrypoint 前检查 durable run policy。错误 policy 的
worker 不会将 BLOCKED repair 恢复或写入 resume dispatch。neutral composition 接收显式 path、policy 和
application-owned adapter factory，不再读取
deployment environment 或自行选择 provider/model。

独立复审前，M3.14 Sequence C 为 **IMPLEMENTED / M3.12 PASS-CLOSED-FROZEN / AWAITING INDEPENDENT REVIEW**。由 worker 而不是
neutral composition library 根据已解析的 normal deployment identity 装配 Pi coding/review adapter。它不删除 M3.12
evidence，也不改变 production Temporal route。

对 `ba640de` 的独立复审确认了最终 worker replacement 证据和 manifest 的 evidence 记录准确性，且不再有 P0 或 P1。
M3.14 现为 **PASS / CLOSED / FROZEN**；Runtime V2 migration 已 **COMPLETE**，M3 为 **COMPLETE / FROZEN**。
manifest 将 destructive cutover 记录为已执行、已独立复审，同时保留 M3.12 成功的真实 external-effect smoke。
上述 production route 与可复用 application service 仍是后续架构；这份 closure 记录不授权额外删除。

## M4.1A：PostgreSQL Durable Authority 契约盘点

M4 在 `m4/postgres-durable-authority` 分支从冻结的 M3 commit `e585640` 开始。第一步不替换 SQLite，
也不扩展 run authority；而是在 `docs/m4-postgres-durable-authority-parity.en.md` 及同步的中文版中比较
SQLite 参照 adapter 与已有 `postgres-persistence` package。

PostgreSQL package 当前只有配置校验和可关闭的候选 client，尚无 Forge 表、迁移或
`OrchestrationPersistence` 实现。统一契约 `libs/persistence/src/lib/durable-authority.contract.test.ts`
用同一临时文件的两个独立连接验证 SQLite：涵盖精确 run authority 和 task binding、initial dispatch
重试、竞争的 builder claim、repair admission/预算和 resume-dispatch CAS、不可变 review/verification、
workspace/impact 恢复、integration cancellation settlement 及终态。PostgreSQL 测试导入**同一套**
契约，但在真实 adapter 与数据库 fixture 到位之前显式跳过；skip 不代表 parity。M4.1A 还列出后续需要
纳入共同契约的 SQLite 行为，跨 run 写入 fencing 和多 run acceptance 分别留给 M4.2、M4.3。

M4.1A 当前为 **AUDITED / SQLITE CONTRACT EXECUTABLE / POSTGRESQL PARITY BLOCKED**。这是独立的 M4
阶段；M3 仍为 COMPLETE / FROZEN。共享契约的 SQLite 实例 8 项全部通过；PostgreSQL 实例明确显示 8 项
跳过、1 项 fixture 待实现，不能视为 parity 通过。完整 `pnpm test` 已通过：非 worker 阶段 63 个测试文件，
605 项通过、8 项跳过、1 项待实现；worker 阶段 3 个测试文件，22 项通过。`pnpm lint`、
`pnpm typecheck`、`pnpm build`、改动文件格式检查和 diff 检查均通过。`pnpm check` 在全仓格式检查处
被三个未改动文件阻断：`libs/agent-runtime/src/lib/pi-agent-runner.spec.ts`、
`libs/domain/src/lib/task-repair-attempt.ts` 和
`libs/orchestration-runtime/src/lib/repair-execution-coordinator.spec.ts`。

独立复审 `4cef6a4` 后，共享 suite 又补充了 repair start 的原子 PREPARING-to-STARTING claim：
SQLite 两个连接只能出现一个 revision-CAS 赢家，不能留下额外的 attempt 或 work item。另一契约验证
cancellation 先获得持久化 authority 后，builder、repair、integration 三种 claim 均拒绝且不新增
mutation evidence。Parity 盘点明确写入这三种 claim 与 `requestCancellation()` 的 PostgreSQL
事务/CAS 缺口，以及 `PostgresEvidenceStore` 候选类型本身接口不完整的问题。同步 SQLite 上的
`Promise.all` 仅验证可观察结果，不能证明事务重叠；真实 PostgreSQL parity 还需人为控制重叠并验证
确定的失败方。目前 SQLite 共享契约 10 项通过，PostgreSQL 10 项显式跳过、1 项 fixture 待实现。
M4.1A 的这次修复仍待独立复审；未实现 PostgreSQL，也未修改 M3 语义。

下一轮复审发现 cancellation-first 契约仍漏查 builder lease 副作用。现在 builder claim 携带真实候选
lease，共享 suite 要求取消后该 claim 被拒绝、lease 不落库、builder 保持 PREPARING，且 run 仍为
CANCEL_REQUESTED。SQLite 共享契约仍为 10 项通过；PostgreSQL 仍为 10 项显式跳过、1 项 fixture
待实现。M4.1A 的这项契约补正仍待独立复审。

独立复审 `348f823` 确认非空 lease 的 cancellation-first 契约关闭了最后一个 P1，没有 P0/P1。
**M4.1A Durable Persistence Contract Audit 现为 PASS / CLOSED。** SQLite 参照 adapter 的
10 项共享契约全部通过；PostgreSQL 仍为 **尚未实现 / 尚未验证**（10 项跳过，1 项 fixture
待实现）。这套共享契约是 M4.1B 真实 PostgreSQL adapter 与数据库 fixture 的验收基线，仍须加入
可控重叠事务测试；整个 M4.1 和 PostgreSQL parity 尚未关闭，冻结的 M3 行为不变。

## M4.1B：真实 PostgreSQL Durable Authority Adapter

M4.1B 在 `libs/postgres-persistence` 增加 `PostgresOrchestrationPersistence`，没有修改冻结的 SQLite
运行时。adapter 校验所选 PostgreSQL role/schema，存储 run 与带唯一键的 evidence，并在每个写事务中
锁定 run 行，使取消、builder/repair revision claim、integration claim、repair 预算/恢复以及初始
dispatch 共用同一 run 的串行化边界。一致的只读快照重建 run，供 provider-neutral ForgeReadModel 使用。

fixture 在本机启动隔离的 PostgreSQL 服务，每项测试使用新 schema；两个独立连接现在执行与 SQLite
**同一套 10 项共享契约**。另有五项 PostgreSQL 专属测试覆盖错误 schema/role/损坏 run、缺失初始
证据和重开连接后的 replay，并以 `pg_blocking_pids` 证实两个 builder claim，以及取消与 builder/repair/integration
claim 的真实事务重叠。上方的 skipped 计数记录 M4.1A 历史审计基线，不是新 adapter 的结果。
CLI/worker 仍然使用 SQLite；M4.2/M4.3 是后续独立范围。

M4.1B 当前为 **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**。真实 PostgreSQL 用例通过，但未启用
PostgreSQL 生产路由。双语 parity 盘点说明 schema、迁移及更广的证据/恢复契约仍须审查。
M3 保持 COMPLETE / FROZEN。

复审补正将同一套共享 suite 扩至**每种 backend 16 项契约**。SQLite 和真实 PostgreSQL fixture
现在都会拒绝格式错误的 reevaluation、身份不符的证据、缺失或损坏的 task binding，以及无效的
verification 自指纹；两种 backend 均证明 UNKNOWN builder/repair 精确取消结算不会释放无关 lease。
PostgreSQL 重开连接的用例恢复完整的 provider-neutral Forge read model，包括 repair 血缘、
阻塞原因和时间线。定向 parity 运行 **38 项通过**（32 项共享用例、六项 PostgreSQL 专属）；
仓库全量测试、lint、typecheck、build 通过。生产 CLI/worker 仍使用 SQLite。在切换 PostgreSQL
生产路由前，**必须**建立版本化迁移、schema 兼容检查，以及与 migration owner 分离、启动时无
DDL 权限的最小权限 runtime role；单次 `recoverRun` 快照不能保证 read model 的多次恢复调用
具有原子性。M4.1B 仍为 **IMPLEMENTED / AWAITING INDEPENDENT REVIEW**，尚未关闭。

独立复审 `a6c1884` 未发现 P0/P1，确认共享损坏证据与 UNKNOWN 结算契约、真实 PostgreSQL
事务重叠测试，以及新连接上的 `ForgeReadModel` 恢复。**M4.1B 现为 PASS / CLOSED**，M4.1A
审计也已关闭。这只关闭 adapter 与真实 fixture 阶段，**整个 M4.1 尚未关闭**：PostgreSQL
生产路由 **NOT READY / NOT ENABLED**，CLI/worker 仍使用 SQLite。任何生产切换前，后续
M4.1C 必须实现版本化迁移、fail-closed schema 兼容闸门、独立的 migration-owner 和无启动
DDL 权限的最小权限 runtime role，并完成真实升级与权限验收。read model 的独立恢复调用仍不
共享原子快照。

## M4.1C：PostgreSQL 可运维 schema 与 runtime 身份

PostgreSQL adapter 现在只打开已安装且版本兼容的 authority schema。独立的迁移所有者 API
安装 v1 的 run/evidence 表、v2 的查询索引，并在带校验和的账本中记录版本；升级由事务和
schema 专属 advisory lock 保护。重复安装安全；不支持的版本、账本篡改、未管理的旧表、
错误的所有权和降级请求均拒绝。迁移者只向不同的 runtime role 授予 schema 使用权、账本
只读及必要的数据表权限。正常 `PostgresOrchestrationPersistence.connect()` 不执行 DDL，
在提供 authority 操作前拒绝权限过多或不足、对象缺失、列或主外键被改动、同名但定义错误
的索引和不兼容的迁移账本。

本地 PostgreSQL 验收 fixture 现在分别配置迁移者与受限 runtime，每个用例安装全新 schema。
两个独立的受限 runtime 连接运行 **16 项 SQLite/PG 共用契约**，另有 PostgreSQL 事务
重叠、恢复和 schema 生命周期测试：定向 suite 中 **29 项 PostgreSQL 测试通过**。真实数据库
测试还验证 v1 升级 v2 后数据保留、重复安装与拒绝降级、账本缺失／未来版本／损坏、schema
和表及临时对象的 DDL 被拒、账本不可写、撤销 runtime 权限、必需索引缺失、列的非空
约束变更、主键删除，以及同名索引被改指错误列。此阶段让
schema 运维边界可独立复审，尚未为 CLI 或 worker 启用 PostgreSQL。M4.1C 状态为
**已实现／待独立复审**，M4.1 仍**进行中**，应用的显式路由留给 M4.1D。M3 保持
COMPLETE / FROZEN；M4.2/M4.3 的跨 run 能力不属于本阶段。

独立复审指出 M4.1C 还需要三类控制。迁移者现在重整 runtime 的精确表权限（账本只读、run
表读／写入／更新、records 表读／写入／更新／删除），启动闸门拒绝多余授权。schema 检查
还区分永久普通表与 unlogged 或分区表，拒绝 RLS、额外的 trigger/rule 和账本时间戳默认值
变更。迁移入口在创建 schema 前拒绝不支持的目标版本。真实 PostgreSQL 回归覆盖多余授权的
重整、上述结构篡改及非法版本；**39 项 PostgreSQL 专项测试通过**。本轮仍是待独立复审的
实现，不代表 M4.1C 已关闭或 PostgreSQL 生产路由已启用。

余下的复审问题是 PostgreSQL 的**有效权限**：只检查表级权限会漏掉仅作用于列的账本写入和
可转授的权限。M4.1C 启动现在拒绝禁止的列级授权、允许的 schema／表／列操作上的转授权，
以及可通过 `SET ROLE` 激活的其他角色成员关系。迁移重跑清除直接多余授权，成员关系须由
凭据管理另行移除。支持范围明确限定 PostgreSQL 14–16，避免 PG17 新增 `MAINTAIN` 权限
绕过尚未扩展的闸门。真实 PG14 测试证明列级账本修改、启动拒绝、迁移清除，以及其他列级／
转授权和成员关系拒绝；**50 项 PostgreSQL 专项测试通过**，其中 16 项为 SQLite／PG 共用
契约。M4.1C 仍为**已实现／待独立复审**；生产 CLI／worker 仍使用 SQLite，M4.1D 尚未开始。

随后的独立复审发现：仅检查 `current_user` 不能证明 PostgreSQL 会话受限。高权限
`session_user` 可以通过 `SET ROLE` 临时切换为 runtime，再恢复自己的权限。M4.1C 的启动
闸门现在要求会话身份和当前权限身份**同时等于**配置的 runtime 角色。真实 PostgreSQL 测试
证明高权限 LOGIN 角色切换为 runtime 后，启动检查和 adapter 均拒绝连接；修正后的 PG14
`NOINHERIT` 测试证明不自动继承的成员关系仍可通过 `SET ROLE` 激活并被拒绝。
**51 项 PostgreSQL 测试通过**（16 项共享契约、35 项 PG 专项）。M4.1C 仍待独立复审，
生产 SQLite 路由和未来的 M4.1D 路由均未改变。

又一次独立复审指出：超级用户还可以通过 `SET SESSION AUTHORIZATION` 修改 `session_user`，
只检查两个 SQL 身份仍不能证明实际连接使用受限 runtime 凭据。M4.1C 现在要求 adapter 连接
URL 明确使用与配置一致的 runtime 用户名，且在连接前拒绝所有 URL 查询参数；schema 启动
闸门还检查客户端连接池实际选用的登录用户，再验证两个 SQL 身份。真实 PostgreSQL 14 测试覆盖会话授权伪装与
恢复、启动拒绝及缺失或覆写用户名的拒绝。**53 项 PostgreSQL 测试通过**（16 项共享契约、
37 项 PG 专项）。M4.1C 仍为**已实现／待独立复审**；生产 CLI／worker 继续使用 SQLite，
M4.1D 尚未开始。

对受限 runtime 登录凭据修正的独立复审未发现 P0 或 P1 问题。**M4.1C 现为 PASS / CLOSED /
FROZEN**。M4.1 整体仍为**进行中**：M4.1D 尚未开始，生产 CLI 与 worker 均继续使用
SQLite，PostgreSQL 生产路由尚未启用。未来的 TLS 与连接安全选项应通过明确的强类型
adapter 配置表达，而不是通过可能绕过登录闸门的 URL 查询参数表达。

## M4.1D：生产 backend 选择与独立进程路由

M4.1D 让已经复审过的 PostgreSQL durable adapter 可由生产 CLI 和 Temporal worker 显式
选择。统一持久化工厂解析 backend 配置，打开原有 SQLite authority 或预先迁移完成的
PostgreSQL adapter，并校验不包含凭据的部署身份。旧部署和按 run 存储的运维命令仍默认
SQLite；PostgreSQL 则必须由两个独立进程同时显式提供 runtime 连接、schema、角色与
匹配的 `FORGE_AUTHORITY_ID`。backend 或 scope 配置不一致时直接拒绝。PostgreSQL 启动
仍执行 M4.1C 的 schema、角色和权限闸门；迁移由 schema owner 单独完成，CLI／worker
启动不会建表。

CLI 的启动、status read model、cancel 和取消结算现在使用同一个选定 backend；在绑定
计划或创建 checkout 之前预检 PostgreSQL。worker 将所选存储注入可复用 composition，
后者不再从进程环境或默认路径推断数据库。CLI 仅作为 Temporal client 启动工作流，
worker 保持独立进程。编译产物验收用真实已迁移的 PostgreSQL 14 数据库、独立 CLI／
worker、本地 Temporal 服务完成一次 run；另一数据库连接核对持久化证据和 status。
另一个 PostgreSQL run 在启动 CLI 退出后被取消，status 及独立连接可见
`CANCEL_REQUESTED`，worker 随后完成为 `CANCELLED`；错误 backend／schema 身份被拒绝。
显式 SQLite 编译产物验收和工厂级默认兼容
行为也保留。部署变量、身份约定和迁移先决条件详见
`docs/m4-postgres-durable-authority-parity.zh.md`。

M4.1D 目前是**已实现／待独立复审**，M4.1 整体仍为**进行中**；M3 和 M4.1A–C 维持
冻结。本阶段不包含跨 run repository fencing、多 run 并发或 API/UI；TLS 连接配置
需要另行设计强类型 adapter 策略。

验证结果：工厂／CLI／composition 定向测试 52 项通过（工厂 5、CLI 32、composition 15）。
编译产物 Temporal worker 阶段的 composition 15 项、进程验收 5 项、smoke 配置 3 项均通过。
Lint、typecheck
和 build 通过。非 worker 测试阶段有 668 项通过，但未改动的 Restate 容器测试因环境找不到
可用容器运行时而失败，因此全套测试未完成。`pnpm check` 仍在三个原有、未改动文件的格式
问题处停止：`libs/agent-runtime/src/lib/pi-agent-runner.spec.ts`、
`libs/domain/src/lib/task-repair-attempt.ts`、
`libs/orchestration-runtime/src/lib/repair-execution-coordinator.spec.ts`。

M4.1D 的独立复审发现：显式 SQLite 部署路径可省略 `FORGE_AUTHORITY_ID`，使独立进程绕过
部署身份约定。现在只要明确设置 `FORGE_AUTHORITY_BACKEND=sqlite` 或 `postgres` 就必须提供
预期身份；仅历史上未设置 backend 的 SQLite 路径允许省略，而且提供时也一定校验。工厂测试
证明指向 SQLite B 的 worker 不能使用 CLI SQLite A 的身份；编译产物验收证明该 worker 在
Temporal polling 之前退出。M4.1D 仍为**已实现／待独立复审**，M4.1 整体仍为**进行中**。

对显式 SQLite 身份修正的独立复审未发现 P0 或 P1 问题。
**M4.1D 和 M4.1 现均为 PASS / CLOSED / FROZEN**。M3 与 M4.1A–C 继续冻结，
M4.2、M4.3 尚未开始。未设置 backend 的历史
SQLite 兼容路径仍然可用，而两种显式 backend 均要求匹配的 `FORGE_AUTHORITY_ID`。

## M4.2 设计获批与实现起点

M4.2 要解决的问题与 M4.1 不同：使用同一个 authority store 的两个 run，不能同时取得
修改同一 repository 内冲突资源的权限。已复审的设计把经过批准的 repository 身份显式映射到
不透明的 authority scope。一个持久化 claim 原子取得多个资源时，所有资源共用一个递增
token。同一 scope 内的 repository 级权限与所有写入资源冲突；实际写入授权则有方向性：
范围较广的 lease 可以覆盖范围较窄的写入，反过来不行。受控写入 callback 必须校验当前
持久化权限，并持有执行中的 permit，避免释放或交接越过尚在执行的 callback。

针对远端精确 SHA `84adcedb06b4295a88f562b83b8a52a573cfa271` 的最终独立复审未发现
剩余的 P0 或 P1 设计阻塞。关键规则是覆盖整个部署的旧 writer 切换屏障：所有 scope 的旧
writer admission 必须先关闭，然后才能盘点和激活。盘点包括 repository ID 尚未注册或
未知的历史 run 与未解决 owner。如果无法确认某个未解决 owner 所属的 scope，则所有
scope 都不能激活，直到明确分类或独立证明它已停止。已知 scope 但资源不明时，以
repository 级不确定权限阻塞该 scope。这样就不会因某个别名的局部清单为空，漏掉使用另一
别名的旧 writer。

**M4.2 DESIGN 为 PASS / APPROVED FOR IMPLEMENTATION。** 这只批准实现依据，不代表
M4.2 的实现已经验收。provider-neutral 类型与 repository 资源语义已有初稿；domain 类型
检查和定向资源测试通过。剩余工作包括完整的 provider-neutral contract、SQLite 和
PostgreSQL 两种持久化实现、全 store 切换证据、真实受控写入拒绝、PostgreSQL 有控制的
重叠事务竞态，以及第三连接对持久化状态的核验。切换竞态还需分别证明两种先后顺序：
旧 admission 先取得序列化点时必须纳入盘点；屏障先取得序列化点时必须拒绝后来的旧
admission。M3 与 M4.1 保持 PASS / CLOSED / FROZEN；M4.3 尚未开始。详细实现契约见
`docs/m4-cross-run-fencing-proposal.en.md`。

对实现起点 SHA `3b095cfb9db0e5933adf860e68e36b808f799cab` 的独立复审指出两个
P1 契约缺口。初稿把所有转换都描述为 repository scope 锁保护，但所属 scope 未知的旧
writer 无法依此序列化；初稿还提供执行中 callback permit，却没有要求释放和交接等待
permit 结束。现已在契约中区分覆盖部署的 cutover、旧 admission、分类与 readiness 闸门，
以及 repository scope 内的 claim、permit 和交接序列化；涉及 run 资格的操作继续保持
scope 先于 run 的锁序。仍有 permit 未结束时，释放与不确定 owner 的回收必须拒绝；进程
丢失后的恢复需要独立验证的停止证据，在结算前继续阻塞其他 owner。共享、与 backend
无关的测试工厂定义了 callback 与交接的两种先后顺序，以及不确定 owner 的回收场景。
这些是契约修正和未来 adapter 的验收测试，**并不证明两种持久化 adapter 已通过**。
M4.2 实现仍未关闭，本轮修正还需独立复审。

对 `6c002e7b976c885a85797dd5e058132f3c7a6e79` 的独立复审认可锁层级和正常
callback 交接语义，但指出两个仍缺失的 P1 验收契约。共享测试工厂现定义旧 admission
与覆盖部署的 cutover 两种先后顺序。fixture 必须调用真实旧 writer 创建入口，并证明
事务确实在 gate 上等待：使用未注册别名 B 的 writer 若先获准，必须出现在全 store
盘点中；屏障若先获准，后来的 builder、repair、integration 和 dynamic lease admission
都必须被拒绝，且持久化 writer 证据不变。别名 A 已注册到 scope S 时，别名 B 下尚未
分类的历史 run 仍必须阻止 S 激活。provider-neutral API 现在也可以恢复未结束的
durable permit，包括准确的 ID、scope、claim、owner、token 与 resource。共享测试工厂
定义了 owner 连接丢失后由独立连接恢复 permit、孤儿 permit 存在时拒绝释放及回收、
凭停止证据结算后仍保持 `HELD_UNCERTAIN`，最后才允许回收并给新 owner 分配更高 token。
这些仍是**尚未接入后端的验收定义**：SQLite 和 PostgreSQL 都未运行这些场景；M4.2
继续为 OPEN，等待本轮契约独立复审及两种 adapter 实现。

对 `311abdd51a6ae6a817c87845541ef1d1febfe4fc` 的复审又指出三个
provider-neutral 契约 P1。现在正常 callback permit 带有一次性的完成密钥，恢复 API
绝不返回该密钥；恢复到的 permit 证据不能充当普通 callback 完成权限。共享测试要求在
callback 仍执行时由 peer 尝试伪造完成，并证明旧 claim 继续阻塞。状态转换也已分开：
普通 release 只能关闭 `ACTIVE`；`HELD_UNCERTAIN` 必须在所有 permit 正常结束或经
特权结算后，凭停止证据通过 reclaim 关闭。孤儿场景现验证 settlement 前必须先标记
`HELD_UNCERTAIN`，并验证 settlement 后普通 release 不能绕过 reclaim。最后，旧
admission 先赢的 cutover 场景现覆盖 builder、repair、integration、dynamic lease
四类入口，逐一核对未知别名的全 store 清单中对应的 writer 类型。这些仍是尚未执行的
共享 adapter 契约，不能据此关闭 M4.2，也不能宣称 SQLite／PostgreSQL durable fencing
已获证明。

针对远端 SHA `f179d0f480e768bbe67ad3e2ba1f0e281c8f7a4f` 的独立复审已接受
M4.2 的 provider-neutral 契约和共享验收基线。正常 callback 的完成能力与可恢复 permit
证据已经分离；不确定 claim 不能经普通 release 关闭；旧 admission 先赢和 cutover 先赢的
场景均覆盖 builder、repair、integration 和 dynamic lease。此次通过使契约可以作为后端
实现依据，尚不代表 M4.2 关闭。

SQLite 持久化实现已经开始。新的 adapter 在现有 SQLite authority 数据库中保存 scope 与
别名绑定、部署级切换状态、全 store 历史 owner 清单、claim、lease、permit 与审计证据。
写入转换使用 immediate transaction，旧 writer 创建入口在同一个持久化切换闸门下检查。
四个共享受控 permit 场景现在通过两个独立 SQLite 连接执行；另一个定向 SQLite 场景
验证了未注册历史别名、切换后 integration claim 被拒，以及资源未知时导入 repository
级 `HELD_UNCERTAIN`。现有 SQLite 持久化回归仍通过。旧 admission 竞态共享工厂尚未
接入 SQLite；PostgreSQL 尚无 M4.2 adapter；真实生产写入边界与 PostgreSQL 第三连接
证据也仍未完成。**M4.2 实现继续为 OPEN。**

对首个 SQLite 增量 SHA `0d17eefb1f8a7f92336e0994b3fcf615960a9b40` 的独立复审
指出两个身份边界 P1。导入未注册的历史 repository ID 时，现在会与阻塞性 claim 在同一个
事务中写入该 ID 到 scope 的别名映射和历史 run 的不可变绑定；以后调用 `registerScope`
不会把同一身份分裂到第二个 scope。新的 global claim 现在必须对应 bound run 中真实存在的
builder 或 repair attempt，该 task 属于 run，run、task、agent 与可选 workspace 身份
均须匹配。builder 还须匹配已批准的 task execution binding，repair 须有对应的已准入
work item。只有 `PREPARING` attempt 可以获得新 claim；冲突检查通过后，同一个 SQLite
事务才将其推进到 `STARTING`。被阻塞的 claim 不推进 attempt；精确重试要求原 attempt
仍为 `STARTING` 或 `RUNNING`。定向 SQLite 测试覆盖上述修正，包括原未知别名下的新
run，以及 builder 和 repair admission。修正仍待独立复审；受控 cutover 竞态、
PostgreSQL adapter 和真实生产写入边界继续未完成。

针对 `53855c7e9a1d037ac919607fb116b011190517e9` 的独立复审确认了别名分类与
attempt 身份修复，但发现合法 attempt 仍可申请超出已批准 lease plan 的文件，甚至申请
repository 级 authority。现在 SQLite 的 claim 准入会读取持久化 task execution binding
里的 lease plan，并按有方向的覆盖关系检查每项申请资源是否落在已批准资源内。repair
还须先证明其已准入 work item 的 lease-plan fingerprint 与该 binding 一致，才能使用
binding 的资源计划。因此获准写 file-A 的 attempt 不能申请 file-B 或更宽的 repository
lease。定向 builder 和 repair 回归检查这两类拒绝、没有 claim 或 lease、没有消耗 token、
attempt 保持 `PREPARING`，以及随后批准资源可以获得 claim。超出原计划的动态扩展仍需
单独的持久化授权证据、新 claim 和新 token；本次增量尚未实现这条路径。SQLite 资源授权
修复仍待独立复审。SQLite 受控 cutover 竞态、PostgreSQL M4.2 adapter 与生产受控写入
边界仍未获证明；M4.2 继续为 OPEN。

对 `a925255e7e32685adb78c2ad0ad2eee944f60b0c` 的独立复审已接受 SQLite 资源授权
修复。SQLite 现在接入共享的旧 writer 切换竞态契约，通过独立 worker 连接运行 builder
start、repair start、integration start 和 dynamic lease 创建的两个序列化顺序。旧 admission
先取得 SQLite 写入闸门时，真实事务会在提交前暂停；cutover 等待，随后必须把未注册历史
别名下的该 writer 准确纳入全 store 清单。cutover 先赢时，随后到达的四类 writer 均须等待
并被拒绝，不能留下 attempt、lease 或 integration claim 持久化证据。两个顺序中，尚未
解决的历史 run 都会阻止部署进入 ready 状态和 scope activation。这构成受控的 SQLite
验收证据，仍待独立复审；PostgreSQL adapter、生产受控写入边界和 M4.2 其余工作继续为
OPEN。

对 `6608fcebf8dd9046f05ac531ebd7a9b018299fd5` 的复审指出，builder 与 repair 的
竞态原先调用的是通用 `persistAttempt(STARTING)` 和 `persistRepairAttempt(STARTING)`，而非
生产路径的 `claimBuilderStart` 与 `claimRepairStart` 事务。SQLite fixture 现在预置真实的
`PREPARING` attempt，再使这两个生产准入入口与 cutover 竞争。builder start 会在同一事务
中写入 `STARTING` attempt 与 ACTIVE 本地 lease；admission 先赢时，全 store 清单必须
同时包含这两类 owner。cutover 先赢时，明确检查 builder 与 repair attempt 仍为
`PREPARING`、没有 builder lease，也没有 repair start/history 记录。通用 STARTING
持久化入口仍受同一持久化闸门约束，但不再充当本次受控竞态中的主准入路径。这项修正仍待
独立复审；M4.2 继续为 OPEN。

对 `5cd194213cfd4a9ae0431410ee7ab11a207cf11a` 的独立复审已接受 SQLite 的受控
cutover。PostgreSQL M4.2 现在有显式 migration-owner 安装的版本 3 schema，用于保存部署
控制状态、scope／alias／run 绑定、历史 owner 清单、claim、lease、permit 与审计记录。运行时
启动会核对迁移账本、表与约束的准确形态，以及各表所需的最小权限；现有 M4.1 adapter
仍可在版本 2 启动，而新的 global authority gate 必须要求版本 3。版本 3 的 PostgreSQL
orchestration 连接会先取得部署闸门，再锁定已绑定 scope 和 run。生产 builder、repair、
integration start、ACTIVE lease 持久化，以及通用 STARTING／RUNNING attempt 持久化，
都在同一事务中于 `LEGACY_ALLOWED` 关闭后拒绝。
在版本 3 迁移前已打开的连接不会取得这个新闸门；部署 activation 仍须证明这些旧 worker
已停止或替换。真实隔离 PostgreSQL server 上的 parity
suite 有 55 项通过。本增量只建立 schema 与旧 writer 准入闸门，**尚未实现** PostgreSQL
`GlobalMutationAuthority` adapter、受控 PG overlap、第三连接持久状态验证或生产 fenced
write 边界。M4.2 继续为 OPEN，本增量仍待独立复审。

针对 PostgreSQL 基础增量 SHA `a3d80a05eac936374827a0f8f9a17a6f5f1eee7b` 的独立
复审发现一个 P1 启动权限缺口。PostgreSQL 可以只授权修改某一列，即使表级 UPDATE 检查
显示没有权限；旧闸门因此可能允许运行角色偷偷改写 repository 到 scope 的不可变绑定，或把
run 重新绑定到另一 scope。现在版本 3 启动闸门会对全部九张全局 authority 表同时核验表级
与列级权限，拒绝转授权限，并检查列 ACL 中的额外授权；即使已有表级授权掩盖了冗余的列级
授权，也会拒绝。真实 PostgreSQL server 上的回归覆盖 alias／run binding 改绑、其他列级
授权及转授权限，并验证 owner 重跑迁移能清除漂移，使启动恢复通过。另有案例验证对所有数据库
用户授予的列权限也能被发现和清除。PostgreSQL 定向测试 71 项全部通过，格式、类型与静态检查
通过。完整 `pnpm check` 中有 735 项测试通过、1 项跳过；但本机缺少容器运行环境，导致无关的
Restate 集成测试无法启动，因此整条命令未能通过。这项修正针对复审指出的权限漏洞，仍待独立
复审验收。PostgreSQL global adapter、受控重叠事务与第三连接证明、生产
fenced-write 边界仍未实现，因此 M4.2 继续为 OPEN。

对 `f47c24532c372d5d41fa44c7bb5c48c03f7f278c` 的独立复审已接受这项权限修正：
九张表的 PostgreSQL 版本 3 schema 和旧 writer 闸门可作为 global adapter 的已认可起点。
本次增量新增 `PostgresGlobalMutationAuthority`，在现有版本 3 表上以受限运行账户实现
共享的 `GlobalMutationAuthority` 契约。scope 将必须共用写入权限的 repository 别名组合
在一起，run 则绑定到一个 scope。adapter 在同一个 PostgreSQL 事务中依次锁定整个部署
的切换闸门、scope 和 run。它可以注册身份；切换时盘点、分类并导入历史 writer；启动
全局 claim；授予 claim 前核验已持久化的 run、任务绑定、attempt 与资源授权；并把
builder 或 repair attempt 升级到 STARTING，同时原子保存 lease 和 token。有冲突的
ACTIVE 或 HELD_UNCERTAIN lease 会阻挡后来的 claim。带一次性完成密钥的 permit 保护
正在进行的受控写入；丢失 worker 后只有提供停机证据，才能清理孤儿 permit 或收回
不确定的 claim，避免悄悄将权限转交其他 run。读取 PostgreSQL BIGINT token 时先精确
解析，超过 JavaScript 安全整数范围前会拒绝分配。

真实 PostgreSQL fixture 现在运行四项共享 permit 场景、八项受控 cutover 竞态；后者
覆盖 builder、repair、integration 和动态 lease 准入，并验证部署闸门两种先后顺序。
其他回归检查伪造或过宽的 claim、repair 历史原子更新、未知别名历史 owner 的导入、
token 耗尽时不留下部分状态，以及独立第三连接观察同 scope 不同 run 的阻挡和交接。
PostgreSQL 定向测试 88 项全部通过。本增量仍待独立复审；生产 CLI／worker 写入入口
尚未通过这个 adapter 和受控写入端口接线。已有版本 3 迁移与旧 writer 闸门未改动。
部署级 token 计数器的实现形态、对外 token 的 BIGINT 安全契约和诊断用途资源 ID 的
歧义仍需后续处理。生产 fenced-write 边界及其验收证据实现并复审之前，M4.2 继续
**OPEN**；多 run 部署验收属于 M4.3。
格式检查、TypeScript 项目引用类型检查与静态检查均通过。完整 `pnpm check`
报告 752 项通过、1 项跳过，但由于本机缺少可用容器运行环境，无关的 Restate 集成测试
无法启动，因此整条命令仍以失败退出。

针对已提交的 PostgreSQL adapter `37a730a`，独立复审未发现新的 P1 问题，但尚未接受其
M4.2 重叠事务证据：之前第三连接只做顺序检查，冻结的验收要求两个事务同时运行，并证明
PostgreSQL scope 行锁的真实阻塞关系。版本 4 是单独记录校验值、仅由迁移账户安装的新迁移；
版本 3 的迁移及其校验值保持不变。它为每个 scope 增加非空的 `next_token` 计数器，以该
scope 已保存的最大 claim token 初始化（包括已释放和不确定状态），并移除原先整个部署
共用的计数器。迁移账户重复运行时不会重置计数器。运行时 adapter 现在要求版本 4。
部署切换和历史 owner 处理仍按部署闸门、scope、run 顺序取锁；读取不可逆的
`GLOBAL_READY` 状态后，日常 claim、permit、释放和收回只锁定所属 scope，必要时再锁
对应 run。不同 scope 可以独立推进，同一 scope 的冲突 writer 则被串行化。现有 M4.1
run 生命周期仍先经过部署闸门，再锁已绑定 scope 和 run，因此与全局 claim 互斥。

独立的真实 PostgreSQL fixture 会在第一个操作已经持有 scope 锁后故意暂停它。
`pg_blocking_pids` 证明另一 run 的冲突 claim，或者竞争中的取消、终态更新，确实在
等待第一个连接的 scope 行锁。解除暂停后，独立第三连接读取持久化的 claim、run、
attempt 和 permit 证据：冲突 claim 只有一方获胜，失败方不留下 claim 或 STARTING
残留；生命周期先完成时，随后到达的 claim 被拒绝，不消耗 token，也不启动 attempt。
取消覆盖 `CANCEL_REQUESTED` 和 `CANCELLED`，终态还覆盖 FAILED、COMPLETED。
释放以及不确定 claim 的收回也与旧的受控写入重叠：旧写入等待 scope 锁，所有权结束后
其回调不会执行。另一项受控测试证明：第一个 scope 的 claim 仍持有行锁时，另一个 scope
可以独立签发 claim，且各自使用独立计数器。升级回归从已有数据的版本 3 schema 出发，
验证原有 claim token、各 scope 最大计数器以及版本 3 校验值在升级与重跑后不丢失。
PostgreSQL 定向测试 96 项全部通过。这次增量补足了复审指出的受控重叠证据，尚待独立复审；生产 CLI／worker
的 fenced-write 边界接入并验收之前，M4.2 仍为 **OPEN**。对外 token 类型的 BIGINT
范围以及诊断用途资源标识的歧义仍需另外解决。
格式检查、TypeScript 项目引用类型检查与静态检查均通过。完整 `pnpm check` 报告
760 项通过、1 项跳过，但由于本机缺少可用容器运行环境，无关的 Restate 集成测试无法启动，
因此整条命令仍以失败退出。

独立复审已接受提交 `15cde7f` 的 PostgreSQL 版本 4 迁移、按 scope 独立的计数器、全局
authority adapter，以及 96 项真实数据库受控重叠测试。这项认可针对持久化权限提供者，
并不等于生产写入准入已经完成：CLI 创建 run 时尚未将它绑定到已注册的全局 scope，worker
仍使用旧的 builder、repair、integration 和动态 lease 准入。在 `GLOBAL_READY` 状态下，
旧 writer 闸门会拒绝这些准入。当前全局 claim 契约仅授权 PREPARING 的 builder 和 repair
attempt，尚无独立的 integration 准入。因此，只给 worker 传入 authority 并不能让生产
写入既安全又可用。

下一个小步在 agent 工具运行时建立受控写入接缝。传入准确的 claim 与
`FencedMutationPort` 时，运行时先检查 claim 的 owner 是否与 run、task、attempt 和 agent
一致。文件写入或编辑会针对解析后的文件资源申请 permit；permit 覆盖编辑前的读取、
实际文件写入及影响记录，直到回调结束后才完成。Pi 命令可能改动工作区里的任意文件，
所以命令执行需要整个 repository 的权限。旧 token 或不足以覆盖资源的权限不会启动
写入回调。未传入全局 claim 时，仍按原有本地 lease 流程运行。定向测试在真实临时文件上
验证过期 edit/write 无法改动内容、影响记录仍处于 permit 保护下，以及 repository
permit 被拒时 Pi 命令执行器根本不会启动。

这是可供后续接线复用的底层边界，**还不是**生产启用：CLI 和 worker 尚未传入全局
claim／port，builder、repair 仍获取旧 lease，Git 工作区创建、集成与继续集成也尚未
受到保护。完成 M4.2 还需要持久化 run 绑定、worker 中原子的全局准入、所有文件系统／
命令／Git 副作用入口的 permit 覆盖，以及对这些生产路径的独立验收。M4.2 继续
**OPEN**，M4.3 的多 run 部署工作尚未开始。对外 token 的 BIGINT 范围和诊断用途资源
标识歧义仍是 P2 后续事项；版本 3 有活跃 writer 时升级到版本 4，还可能需要先静默
writer 或针对 PostgreSQL 死锁 `40P01` 重试。
agent 工具和 Pi runner 的定向测试 33 项全部通过。格式、TypeScript 项目引用类型检查与
静态检查均通过。完整 `pnpm check` 报告 764 项通过、1 项跳过，但仍以失败退出：本机
缺少可用容器运行环境，导致无关的 Restate 集成测试无法启动。

独立复审已接受提交 `6536ab8` 的 agent 工具与 Pi 受控写入接缝，但没有接受生产侧
M4.2。下一轮生产组合层增量先解决全局 worker 路径尚未建成时的一种危险模式选择错误。
当前生产 worker 创建的是旧的、每个 run 单独管理的持久化和编码服务。部署关闭旧 writer
准入后，它不能再安全工作：如果仅因构造工具时漏传可选的全局 claim 而继续走本地写入
路径，就会绕开预期的全局权限。现在生产 worker 在创建编码服务**之前**，先向 SQLite
或 PostgreSQL 持久化存储确认旧 worker 组合仍被允许。两个后端都读取数据库保存的切换
状态，而不是依赖配置开关。切换开始后，组合直接失败，不会悄悄选择本地权限；对已经建立
连接的 PostgreSQL 存储，也会重新读取当前状态。如果切换与这次启动检查并发，原有数据库
写入准入检查仍阻止新建旧 writer。测试注入的持久化对象继续只是明确的测试接缝，不承担
生产模式选择。

工具运行时现在还接受实际 workspace ID。若持久化 claim 的 owner 指定了 workspace，
它必须与该 ID 以及 run、task、attempt、agent 同时匹配，才能创建工具。运行时组合层从
builder 或 repair 请求传入 `workspace.id`；scope、token、owner 和资源的最终 permit
判断仍由持久化权限提供者完成。测试覆盖 workspace ID 缺失、不一致和一致的情况；真实
SQLite 切换后 worker 创建会被拒绝；真实 PostgreSQL 测试覆盖已经 GLOBAL_READY 的
worker，以及连接建立之后才发生切换的情况。四组定向测试共 135 项通过。

这只是对**旧**生产路径的 fail-closed 保护，并未启用全局路径。生产 builder／repair
尚未获得全局 claim，也没有强制传入 mutation context；CLI 的 run／scope 绑定、动态
全局扩展以及 integration／Git permit 边界仍未实现。切换时仍须独立停机并验证已运行的
旧 worker：启动检查无法撤销已经运行的进程。M4.2 继续 **OPEN**，M4.3 尚未开始。
今后全局编排路径接入时，如果文件写入已经成功而影响记录保存失败，上层也必须保留
不确定状态的全局 claim，不能自动释放。对外 number token 的范围以及诊断资源 ID 的
歧义仍是 P2 后续事项。

本次增量的验证：四组定向测试 135 项全部通过；格式检查、TypeScript 项目引用类型检查、
静态检查与 `git diff --check` 均通过。完整 `pnpm check` 尚未通过：报告 768 项通过、
1 项跳过；无关的 Restate 集成测试因本机缺少容器运行环境无法启动。编译版 CLI／worker
验收测试还曾有一个用例触发 10 秒子进程时限（`CLI failed (null)`）；第一次单独重跑整组
测试时，另一用例触发同一时限。两个受影响用例分别单独运行均通过，此后再完整重跑
编译版 CLI／worker 验收套件，5 项全部通过。原始 `pnpm check` 仍是失败结果，因为
Restate 缺少容器运行环境；原始运行中的跨进程套件也并未通过。

独立复审已接受提交 `ae5cf89` 中对旧 worker 的切换保护和 workspace owner 校验。
本轮生产接线让新的 PostgreSQL 版本 4 run 在**创建时**就取得不可变的全局 scope 绑定，
而不是等 worker 将来写入时再猜测它属于哪个 scope。授权操作人员必须预先通过全局权限
提供者注册 repository alias；CLI 不会自动建别名，也不会猜测不同仓库名称是否指向同一个
实际检出目录。对于版本 4，run launcher 要求持久化提供者在同一数据库事务中写入已批准的
run、任务绑定及全局 run／scope 绑定。事务检查旧 writer 准入是否仍开放，查询已注册的
alias，先锁部署闸门和 scope，再插入新 run。别名不存在或准入已经关闭时，不会留下创建了一半
的 run。SQLite 和 PostgreSQL 版本 2／3 的旧启动路径保持原行为。底层不带绑定的
`createRun` 仍可供历史测试和迁移使用；生产 launcher 在版本 4 选择带绑定的接口。

启动重试或恢复时，launcher 在初始调度及 Temporal workflow 启动前，同时核对已批准
计划的指纹和持久化的 run／repository／scope 身份。绑定缺失或不一致会直接拒绝；若切换
已经关闭旧路径准入，也会拒绝启动。CLI 在创建检出目录前先检查旧 worker 的部署状态；
事务中的最终检查还能阻止检查之后才发生切换的竞态。真实 PostgreSQL 测试证明：
未注册 alias 不会创建 run；注册之后，run 与绑定原子写入，另一个连接也能看到；
repository 不匹配会被拒绝；切换之后无法继续启动。launcher 测试覆盖启动 workflow 前
的拒绝及恢复时的拒绝。两组定向测试共 102 项通过。

本轮只为今后的全局 claim 准备 run 身份，**尚未**启用 `GLOBAL_READY` worker。
builder、repair 仍需要原子的全局准入和强制 mutation context；动态资源扩展及
integration／Git 写入仍缺少受控 permit；切换时已经运行的旧 worker 仍须受控停机。
M4.2 继续 **OPEN**，M4.3 尚未启动。对外 number token 与 BIGINT 范围的差异、
诊断资源 ID 的歧义仍是 P2 后续事项。

格式检查、TypeScript 项目引用类型检查、静态检查以及 102 项 launcher 和 PostgreSQL
定向测试均通过。完整 `pnpm check` 报告 771 项通过、1 项跳过，但因无关的 Restate
集成测试在本机找不到可用容器运行环境而以失败退出；其清理阶段也因环境未成功建立而报错。

独立复审已接受提交 `dae9ffc` 中的 run／scope 绑定。本轮为 builder 和 repair 准入
准备接缝，但尚未启用全局 worker。run 已经把获批准的 repository 身份不可变地绑定到
不透明的全局 scope。现在 SQLite 与 PostgreSQL 的全局权限提供者都可以从数据库保存的
run、alias 和 scope 记录读取该绑定；其中任何一处缺失或不一致，读取都会失败。worker
绝不能从 workspace 目录反推 scope。新增的 `GlobalBuilderRepairAdmission` 使用这个
读取结果，并接收批准的任务绑定和处于 PREPARING 状态的 builder 或 repair attempt。
它将 run、task、attempt、agent、workspace 身份一起带入全局 claim；持久化提供者
在把 attempt 原子推进 STARTING 的同一事务内，重新核对已批准的 run 与 task、资源
计划、repair work item 和 attempt 状态。竞争者只会得到阻塞证据，不会推进自己的
attempt。准入成功后返回 mutation context 与受控回调入口，逐次通过
`FencedMutationPort` 判断资源权限。释放后的旧 token 不能发起新回调；project 的
claim 也不能授权 repository 级回调。repair agent 可以不同于任务绑定里的 builder
agent；持久化提供者核对的是获准的 repair work item 和 repair attempt。

新增测试使用真实 SQLite 持久化和第二个连接，验证未绑定 run、未获准 work item 的
repair 均被拒绝；合法 builder 与 repair 进入 STARTING；竞争 builder 保持
PREPARING；释放 claim 后回调被拒绝。已有的 SQLite 和隔离 PostgreSQL 测试也核对
确切的持久化 run／scope 读取。三组定向测试共 116 项通过。这仍只是**准入与 permit
构件**，不是生产 worker 的全局模式开关：生产 worker 仍走旧准入，并在切换后拒绝
启动。它尚未消费新增接缝，也未在 builder／repair 执行过程中强制传入返回的 mutation
context；Git workspace 创建、动态资源扩展与 integration 写入仍无全局围栏。将来
生产路径还必须在外部写入已成功、影响记录却未能保存时保留不确定的所有权，不能自动
释放。M4.2 继续 **OPEN**，M4.3 尚未启动。对外 number token 与 PostgreSQL
BIGINT 的范围差异、诊断资源 ID 的歧义继续作为 P2 后续事项。

本轮 `pnpm check` 的格式、TypeScript 项目引用类型检查、静态检查及全部 773 项测试
均通过，但命令仍以失败退出：整体覆盖率中语句为 87.73%、分支为 82.41%、代码行
为 87.64%，这三项低于配置的 90% 门槛。三组定向测试 116 项全部通过。

独立复审发现 `6cd682c` 的准入构件存在一处阻断性的崩溃恢复缺口：此前每次 builder
或 repair 准入都随机生成新的 claim ID，并且只允许 PREPARING attempt。如果数据库
已经提交 claim 及 STARTING 状态，worker 却在收到响应前重启，它便无法取回 token：
持久化的 STARTING attempt 被本地校验拒绝，而旧 PREPARING 对象会生成另一 claim ID。
现在初始 claim ID 由操作类型、run ID 和 attempt ID 经 SHA-256 稳定生成。
PREPARING、STARTING、RUNNING 可以进入持久化提供者，但只有 PREPARING 可以
创建新 claim；STARTING／RUNNING 必须匹配已有的 ACTIVE claim、相同 owner 与资源。
因此恢复不会凭空创造权限。准入结果还会检查所有 lease 处于 ACTIVE，且资源集合与
请求的规范化资源集合完全一致。

真实 SQLite 回归现在会丢弃首次准入响应，使用另一提供者连接读取已保存的 STARTING
builder 与 repair，再验证恢复得到相同 claim ID、token 和 leases。测试也确认没有
匹配 claim 的 STARTING attempt 会被拒绝，没有额外 ACTIVE claim，下一笔真正的
新 claim 只取得下一个 token。生产 worker 仍拒绝 GLOBAL_READY，尚未消费该构件；
Git、integration 与动态资源写入仍未形成生产围栏。M4.2 继续 OPEN，M4.3 尚未启动；
对外 number token／BIGINT 范围差异和诊断资源 ID 歧义仍为 P2。本次修复等待独立复审。

本次修复的 `pnpm check` 中，格式、TypeScript 项目引用类型检查、静态检查以及全部
773 项测试通过，但整体命令仍因原有的 90% 覆盖率门槛而失败：语句 87.96%、分支
82.73%、代码行 87.88%。该门槛失败与此次准入重放问题是两个独立事项。

独立复审已接受 `b58b2eb` 中可在崩溃后重放的准入构件。本次生产写入边界增量新增
`GlobalBuilderRepairExecutionBoundary`，面向一笔已经准入、与工作区绑定的 builder
或 repair claim。可以把全局 claim 理解为修改指定仓库的权限，把围栏 permit 理解为
某次具体写入正在执行的短期持久化记录。新边界要求 run、task 和 workspace 身份均与
已批准绑定完全相符。Git 工作区创建及随后保存工作区记录都在**仓库级** permit 的
回调内执行；只有项目级权限时，Git 回调根本不会启动，因此不能创建 worktree 或
分支。如果回调开始后 Git 或其记录失败，claim 转为 HELD_UNCERTAIN，继续阻挡新
owner 接管，直至独立证明外部写入者已停止。Git 返回的工作区身份若与批准绑定
不符，也会被拒绝。该边界还会明确把已准入的 mutation context 交给 agent 工具：
文件写入及影响记录使用对应文件／项目 permit，可能修改仓库的命令必须取得仓库级
permit，两者均不会退回进程内 lease。如果文件已改变但其影响记录保存失败，claim
同样会被标为不确定，而非悄悄允许其他 owner 写入。

连接不同 SQLite 持久化提供者的真实测试验证：只有项目权限时 Git 创建函数不会
执行，合法文件写入可执行而过期权限不能再次写入；显式批准仓库权限时，Git 和
保存记录均发生在有效 permit 内；Git 完成后保存记录失败，或文件写入后影响
记录失败，都会保留不确定占用。agent 工具测试还确认：已启动的命令出错或 permit
结束失败时保留不确定占用，而无法取得 permit 的命令不会执行。这些测试证明了回调
边界及工作区身份，但**尚未**启用 GLOBAL_READY 生产 worker：
现有 worker 仍拒绝这一模式，旧 builder／repair 服务尚未被消费此边界的执行生命周期
替换。全局 integration、动态资源扩展、外部 agent 的停止确认及安全释放仍待实现。
普通只有项目权限的计划，在未来全局路径中没有单独批准的仓库权限时不能创建 Git
工作区。M4.2 继续 OPEN，M4.3 尚未开始；number token／BIGINT 和诊断资源 ID
歧义仍为 P2。

本次边界增量的 `pnpm check` 中，格式、TypeScript 项目引用校验、静态检查以及
72 组共 778 项测试全部通过；但整体命令仍因仓库的 90% 总体覆盖率门槛而失败：
语句 87.98%、分支 82.71%、代码行 87.90%。直接相关的 agent 工具、Pi runner
与 SQLite 边界三组测试合计 40 项全部通过。

对远端 exact SHA `c43b487` 的独立复审发现工作区边界存在一处阻断性交接竞态：
Git 或工作区记录失败后，第一版代码先结束持久化 permit，再把 claim 标为
HELD_UNCERTAIN。在这个间隙，另一条恢复连接可以释放仍为 ACTIVE 的 claim，
让下一位 owner 接管尚不确定的 Git 结果。本轮修复把不确定占用的持久化移入仓库级
permit 回调，在回调结束、permit 可被移除之前完成。若 Git 及记录成功、但 permit
结束失败，外层失败处理仍会保留占用。先前接受的提供者与迁移契约均未改变。

SQLite 回归现在通过另一连接观察交接过程：标记不确定占用时，原 permit 仍存在，
独立连接尝试释放会因写入仍在进行而被拒；permit 最终结束时，claim 已是
HELD_UNCERTAIN。测试还分别覆盖工作区记录失败、Git 返回的分支与批准绑定不符：
错误分支不会被保存为工作区记录。这修复了复审指出的交接阻挡必须连续存在的要求。
生产 GLOBAL_READY worker 仍拒绝启动，因此 builder／repair 的生产消费、
integration 围栏、动态资源扩展与安全释放仍待实现。M4.2 继续 OPEN，M4.3 尚未
开始。number token／BIGINT 及诊断资源 ID 歧义仍为 P2；写入前的 edit 文本校验
失败也会产生不必要的不确定占用，属于后续操作体验优化。

本次定向修复的 SQLite 准入测试 5 项全部通过，包括两种工作区失败顺序。
`pnpm check` 的格式、TypeScript 项目引用、静态检查以及 72 组共 779 项测试均通过，
但整体命令仍因原有的 90% 总体覆盖率门槛而失败：语句 87.97%、分支 82.68%、
代码行 87.89%。

对远端 SHA `7731480` 的独立复审发现这一交接屏障还有第二种失败方式：若在
HELD_UNCERTAIN 真正落库前写入失败，原有受控回调仍会在 `finally` 中删除 permit。
另一连接便可能释放 ACTIVE claim，尽管 Git 结果尚不确定。另外，permit 完成已经
提交、但响应丢失时，原外层异常处理也只能在 permit 消失后才标记不确定占用。本轮
为外部副作用增加明确的失败保守型 `FencedMutationPort` 操作：先登记 permit，再
执行回调；无论 Git 回调成功还是失败，都先持久化 HELD_UNCERTAIN，再完成 permit。
若不确定状态无法落库，精确的 permit 会保持未完成，必须由独立恢复流程证明外部
写入者已停止，方可清理孤儿 permit；若完成 permit 的提交响应丢失，占用此前已经
进入 HELD_UNCERTAIN。普通回调操作以及先前验收的 SQLite／PostgreSQL 提供者和
数据库迁移都未改动。

Git 工作区边界现在使用这一操作保护 worktree 创建、批准身份检查及工作区记录保存。
即使 Git 创建成功，claim 也会保持 HELD_UNCERTAIN：这是刻意的失效关闭策略，
必须由独立流程确认外部写入者静止并回收占用，**不能**把它当作 builder 已能自动
继续执行。真实 SQLite 测试使用另一连接，在写入不确定状态期间尝试释放，模拟
不确定状态写入失败，并模拟 permit 完成已提交但响应丢失，证明不确定占用或仍可
恢复的 permit 始终阻止交接；domain 测试验证回调与 permit 的先后顺序。生产
GLOBAL_READY worker 依旧未启用，builder／repair 消费、integration 围栏、动态
资源与安全继续执行的完整生命周期仍未实现。M4.2 继续 OPEN，M4.3 尚未开始；
公开 number token／BIGINT、诊断资源 ID 及写入前 edit 校验问题继续列为 P2。

本次第二轮定向修复的 domain 与真实 SQLite 准入测试共 10 项全部通过。
`pnpm check` 的格式、TypeScript 项目引用、静态检查及 72 组共 782 项测试均通过；
整体命令仍因原有的 90% 总体覆盖率门槛失败（语句 87.98%、分支 82.71%、代码行
87.90%），未调整覆盖率标准。

独立复审接受并冻结了 `d4ae9b8` 的 permit 到不确定占用的连续屏障。下一步问题是
Git 创建 worktree **之后**如何继续：即使 Git 成功，初始全局 claim 也被刻意保留为
HELD_UNCERTAIN，agent 不能持有它继续写入。新设计草案
`docs/m4-workspace-continuation-design.en.md` 解释这一状态，提出一项独立且有权限的
继续执行流程。独立恢复者必须证明原 Git 操作以及持有原权限的任何写入者都无法再次
启动，处理尚未结束的 permit，并核对实际 Git worktree 与已保存、已批准的工作区记录。
之后，新的持久化操作将在**同一仓库 scope 事务**内关闭旧 claim，并授予一笔 token
更高的执行阶段新 claim。先单独释放旧 claim、再另起事务申请新 claim 会给竞争中的
run 留出接管空隙，因此明确禁止。builder／repair attempt 保持 STARTING；稳定的
父子阶段记录可让 worker 在响应丢失后找回准确的新 claim，而不会再次创建 worktree。
静止性证明不充分、资源冲突、取消或崩溃时，都要保留持久化阻挡，不能意外授予权限。
Git 开始之前保存的阶段标记还应禁止对这一特殊父 claim 执行普通释放或回收，以免绕过
原子交接。

这份文档**仅是等待独立复审的设计提案**，并非新的生产功能。它尚需受信任且独立的
静止性确认、真实 Git 身份核对、新的提供者中立交接契约、版本化 PostgreSQL 持久化
及 SQLite／PostgreSQL 的共享交错回归。旧 builder／repair 服务及其 attempt 更新在
全局切换后不能直接复用。生产 worker 仍拒绝 GLOBAL_READY；agent 继续执行、Git
integration、动态资源扩展、外部写入者停止证明和最终释放尚未实现。M4.2 继续 OPEN，
M4.3 尚未开始。公开 number token／BIGINT 与诊断资源 ID 问题仍属 P2。本次只增加
设计文档，没有新的运行时测试，也没有修改已接受的契约、提供者或迁移。

对远端准确 SHA `c7585b0` 的独立复审判定这份继续执行设计**尚未获批**，指出三项
权限契约缺口。修订稿把初始 claim 明确限定为 Git 工作区准备阶段：Git 之前先保存阶段
标记；即使父 claim 的 repository lease 原本覆盖文件和项目写入，提供者也必须拒绝
它申请普通 mutation permit。只有针对准确工作区的专用 Git permit 可以开始，而且
一笔父 claim 最多存在一条该 permit 的身份链。阶段变更、禁止普通释放／回收、取消
与有证据的放弃都在同一 scope 锁下串行。标记提交但 Git 尚未开始就崩溃，或标记后
取消先胜，都不能通过普通释放或第二次 Git 尝试绕过阻挡。

两类授权也被明确分开：父 claim 需要单独批准的 repository 权限来创建 worktree／
branch；交接后的子 claim **只取得另行批准的 agent 执行资源**。为准备工作区批准的
Git repository 权限不会自动变成 agent 的通用写权限。如果 agent 确实需要仓库级
命令，执行计划必须另行明确批准。交接仍在一次事务中关闭不确定的父 claim 并授予
token 更高的子 claim，竞争中的 run 不会看到旧 claim 已关闭而新 claim 尚不存在的
空隙。

独立的恢复服务或操作员必须使用 worker 不持有的凭据签发有唯一 ID 和摘要、经过
认证的静止性证明。先持久撤销原执行代际，阻止调度器恢复和新 permit；再由外部
监管者确认原进程／容器／进程组及可能写入的子进程均已停止，清点全部父 permit，
直接核查 Git 实际干净的工作树、仓库、提交、分支和集成仓库身份，且与 Git 开始前
固定的批准值一致。证明绑定准确的 scope、父 claim／token、owner、工作区及版本、
观察到的 permit、worker 代际与两份资源计划摘要；响应丢失后的准确重放引用同一
ID／摘要。心跳超时或目录匹配本身不是证据。交接与放弃均需独立证明且没有尚未
结束的 permit；证据不足则父 claim 继续阻挡。这仍是**等待独立复审的纯文档提案**，
并非已经实现的恢复服务、提供者状态机或 GLOBAL_READY worker。M4.2 继续 OPEN，
M4.3 尚未开始。本轮未改运行时代码、schema 或测试；上次全量检查的格式、类型、
静态检查和 782 项测试通过，但 `pnpm check` 仍因既有 90% 总体覆盖率门槛失败
（语句 87.98%、分支 82.71%、代码行 87.90%）。

独立复审已将 `f48f25c` 接受为**冻结的工作区继续执行设计**，并非已工作的恢复流程。
本次较小的实现增量为工作区准备阶段的父 claim 增加持久化阶段记录：SQLite 新建
`forge_global_workspace_phases` 表；PostgreSQL 通过独立的**版本 5 迁移**安装同一
表，不修改此前已接受的 v1–v4 迁移校验和。每一阶段记录精确关联一笔已有的全局
claim。权限受限的 PostgreSQL 运行角色只可读取阶段记录，不能插入或改写；启动
检查同时核验表结构和授权。重复执行迁移不会重置现有 claim token 或 scope 计数器。

两种全局权限提供者现在会在普通写入操作前读取这条持久记录。当父 claim 被标为
INITIAL_ADMITTED、WORKSPACE_ARMED 或 WORKSPACE_UNCERTAIN 时，普通 token
校验、permit 开始、原 claim 精确重放、ACTIVE 释放和不确定占用回收均会被拒绝。
即使父 claim 持有覆盖所有文件的仓库级 Git 权限，也不能悄悄把它转成文件写入
权限。不同 SQLite 连接和真实隔离的 PostgreSQL 服务器测试了这些拒绝及持续
阻挡；未标记的旧 claim 保持既有行为。更新后的全局提供者会拒绝版本 4 的数据库，
必须先由迁移所有者安装版本 5。

这一增量**仅构成失效关闭的阶段存储与读取门禁基础**：尚未持久保存独立批准的
工作区准备计划和执行代际，也没有特权的阶段创建操作、专用一次性 Git permit、
恢复证明、放弃或父子 claim 原子交接。测试仅为验证门禁而使用迁移所有者连接
插入阶段记录。生产 GLOBAL_READY worker 仍禁用；M4.2 继续 OPEN，M4.3 尚未
开始。公开 number token／BIGINT 与诊断资源 ID 歧义仍属 P2。

本次验证：真实 PostgreSQL 定向测试 100 项全部通过；`pnpm check` 的格式、
TypeScript 项目引用、静态检查，以及 72 组共 784 项测试均通过。整体命令仍因既有
的 90% 总体覆盖率门槛退出失败：语句 88.06%、分支 82.74%、代码行 87.97%。
未修改覆盖率标准。

独立复审已将 `6bc3b98` 的版本 5 阶段门禁接受为范围有限的基础。冻结的继续执行
设计下一步要求 Git 准备阶段拥有**单独批准**、持久化的执行代际，并把父 claim 的
授予与 INITIAL_ADMITTED 标记放进**同一事务**。核查实际批准链后发现，不能仅向
任务绑定添加 `workspaceSetupApproval` 字段：现有版本 1 的已批准计划工件并未
单独批准仓库级 Git 准备资源。若把普通批准 ID 复制到新字段，执行绑定便可以自行
声称拥有 Git 权限。同样，直接允许 PostgreSQL 运行角色向版本 5 阶段表 INSERT
也会破坏此前接受的只读、最小权限边界。因此，交付前撤销了试验性的准入实现：
本轮没有可调用的工作区准备授予、arming 或 Git 专用 permit。

本轮交付的安全前置条件是一项独立的 **PostgreSQL 版本 6 迁移**：阶段记录新增
可空的 Git 准备计划摘要、agent 执行计划摘要、执行代际与工作区 ID 字段。
版本 1–5 的迁移及校验和均不改动，运行角色仍只能 SELECT；worker 或未经验证的
任务绑定都不能写入这些字段。SQLite 提供者在新库中建同样的字段，并就地升级
旧阶段表。字段允许为空，以便保留已有阶段记录而不伪造批准或代际。PostgreSQL
全局提供者启动时要求版本 6 的准确结构；重复迁移保留已有 scope token 和父 claim
状态。真实 SQLite 和 PostgreSQL 升级测试核对旧记录、标记父 claim 对普通 permit
仍然拒绝；PostgreSQL 测试还证明运行角色不能改写阶段表。双后端定向测试共
119 项通过。

本轮 `pnpm check` 的格式、TypeScript 项目引用、静态检查和 72 组共 786 项
测试全部通过；整体命令仍在未修改的 90% 总体覆盖率门槛失败（语句 88.07%、
分支 82.75%、代码行 87.97%）。

后续真正可用的工作区准备路径，必须先让已批准计划／批准链单独授权仓库级 Git
准备资源，并将其摘要与执行资源计划、工作区绑定；再由可信代际签发者持久保存
执行代际及撤销规则。提供者随后才能在同一事务内核验两份批准，原子创建父
claim 和阶段标记；PostgreSQL 不能因此赋予运行角色对阶段表的通用 INSERT。
此后才可以实现 arming 与只允许一条身份链的 Git 专用 permit。生产
GLOBAL_READY worker 仍禁用，M4.2 继续 OPEN，M4.3 尚未开始；公开 number
token／BIGINT 与诊断资源 ID 歧义仍为 P2。

独立复审接受了 `b6b454c` 的版本 6 元数据预留，但它只是工作区准备准入的前置
条件。继续核查发现，现有版本 1 的计划批准虽然记录了审批人并绑定执行计划，却
没有单独授权 Git 工作树创建的决定；worker 执行链也缺少可信的代际签发者和持久
撤销机制。不能将普通批准 ID 或 worker 自选的随机值当作这些能力。

本轮在规划库中新增**独立、不可变的 Git 准备批准记录**。它有区别于执行批准的
身份和内容指纹，限定一项任务、仓库 ID 与根目录、锁定的基准提交、仓库级资源，
以及唯一的 `git-worktree-create` 操作；同时绑定原计划工件的版本与指纹，以及
执行批准的指纹。创建和校验会拒绝任务、计划或执行批准不一致，批准时间早于
执行批准、内容被改动和添加其他操作。仓库之外的 JSON 文件存储以不可变方式
发布该记录；两个实例并发保存相同内容可安全重试，同一身份下的不同内容会被
拒绝。定向测试覆盖了决定记录和文件存储。现有版本 1 计划工件、执行批准、run
绑定、PostgreSQL 迁移和提供者权限均未改动。

目前这只是**记录格式和存储边界**，还不是可信批准服务：`approvedBy` 只是文本
字段，未验证批准者身份；生产 runtime 尚未消费该记录。任何 provider 都不能据此
授予 Git 准备 claim、写入版本 6 预留字段或启动 Git permit。启用前还需要独立的
授权凭据及可核验的批准来源，并由可信 supervisor 签发和持久撤销执行代际；
provider 随后必须在同一 scope 事务内创建 claim 与阶段标记，而且不能给
PostgreSQL 运行角色开放通用阶段表 INSERT。生产 GLOBAL_READY worker 仍禁用，
M4.2 继续 OPEN，M4.3 尚未开始；公开 number token／BIGINT 与诊断资源 ID
歧义仍为 P2。

本轮记录和存储增量的验证：规划与文件存储定向测试 22/22 通过；`pnpm check`
的格式、TypeScript 项目引用、类型感知静态检查以及 73 组共 791 项测试均通过。
整体命令仍因未修改的 90% 总体覆盖率门槛退出失败：语句 88.17%、分支
82.85%、代码行 88.08%。

独立复审将 `0907703` 严格接受为数据格式和不可变存储的前置条件。文件成功读取
并不代表获得可信批准：能够替换文件的人可以重新计算 SHA-256 内容指纹，
`approvedBy` 也只是文本。本轮在规划库新增独立的**验证边界**：调用者必须提供
准确的已批准计划工件、执行批准、Git 准备决定、Ed25519 签名，以及由独立可信
部署配置提供的公钥。验证器先核对决定与计划工件、执行批准是否完全对应，再核验
覆盖整份准备决定及签名密钥 ID 的域隔离签名。公钥缺失、重算指纹后的决定篡改、
执行批准不匹配、密钥身份替换、签名无效或密钥类型错误都会拒绝。测试使用独立
生成的密钥验证这些情况；签名凭据不会从准备决定或 JSON 存储中读取。

这个验证器只是可复用的边界，还不是已部署的 Git 批准服务。目前没有配置可信
签名主体、身份验证的批准流程、签名发布和密钥轮换／撤销机制；worker 和
provider 都不消费验证器或未签名的存储记录。任何 provider 准入前，还需要独立
认证的批准来源签发并保存带签名的决定，由部署配置只提供受信任的 Git 准备
签名公钥，消费者在准入时重新核对准确的 run／workspace 与已批准工件。可信
执行代际签发与撤销、原子创建准备 claim 与阶段标记、arming、Git 专用 permit
和父子 claim 交接仍未实现。生产 GLOBAL_READY worker 继续禁用，M4.2 保持
OPEN，M4.3 尚未开始；公开 number token／PostgreSQL BIGINT 与诊断资源 ID
歧义仍为 P2。

本轮仅验证器增量的两组规划库定向测试 7/7 通过；`pnpm check` 的格式、
TypeScript 项目引用、类型感知静态检查及 74 组共 795 项测试通过。整体命令仍因
既有 90% 总体覆盖率门槛退出失败：语句 88.20%、分支 82.89%、代码行
88.11%。

独立复审将 `8931825` 严格接受为 Git 准备决定的签名验证原语，而非已部署的
签名服务或 provider 权限。复审还指出后续应补更强的测试：攻击者同时重算伪造
记录的内容指纹和未签名 envelope 指纹，也不能复用原来的 Ed25519 签名。现有
实现具有这道签名门禁；更强回归和统一的外部错误诊断属于 P2 后续事项，
密钥生命周期则是生产准入的前置条件。这次验证器增量的实际覆盖率如上所记：
语句 88.20%、分支 82.89%、代码行 88.11%。

这次**仅文档的设计增量**说明冻结的工作区继续执行设计投入生产前仍缺少的
信任服务。独立认证的准备阶段审批者针对准确的 Git 工作树操作作出决定；签名
服务核对已批准计划并不可变地发布签名决定。私钥不进入记录存储或 worker。
独立管理的密钥登记表不得复用密钥 ID；新的父 claim 授予、arming 和 Git
permit 只接受**当前 ACTIVE** 的密钥，而不因为记录产生时曾受信任就放行。
退休密钥阻止新的副作用，密钥撤销使既有准备父 claim 持续阻挡，直至独立验证
恢复；登记表读取必须与更新串行化，不能从过期的本地公钥列表授予新权限。
`approvedBy` 仍是文本，签名服务须另行证明它与认证审批者的对应关系。

另一独立的可信代际签发者必须把唯一、持久的执行代际绑定到准确的 scope、run、
task、attempt、workspace、准备父 claim 与受监督的 worker。撤销不可逆，
scheduler 的恢复入口和 provider 的 permit 入口都要校验；但撤销本身并不能
证明已启动的子进程或 Git 命令已经停止。只有外部独立 supervisor 的进程管控与
静止证明，才能支持遗留 permit 清理或特权父子 claim 交接。新设计文档明确了
签名发布响应丢失、密钥轮换与撤销、代际签发与撤销、取消以及在途 Git 回调的
失败与竞态结果。本轮不修改数据库结构、运行时契约、provider 或 worker。
获批的继续执行设计现已标注为冻结，但代码仍未完成；真正的签名服务、密钥
登记表、代际签发者、原子准备准入、Git 专用 permit 和生产 worker 都尚未实现。
M4.2 继续 OPEN，M4.3 尚未开始；公开 number token／BIGINT 与诊断资源 ID
歧义仍为 P2。

## 让覆盖率反映实际执行的代码

根测试命令使用 V8 统计 Vitest 进程内执行的源码。此前有几类文件被记为零覆盖：
Temporal worker 的命令行启动和独立外部冒烟脚本实际作为子进程运行；Temporal
工作流则在隔离运行时执行，已有大量集成测试，但根 V8 统计无法把执行结果映射
回原始工作流文件。因此仅从本次覆盖率分母中排除这些入口，已有集成测试仍然运行。
两个未被生产入口引用的旧适配器（Scenario A runner 和简单 bootstrap activity）
也不再以“生产逻辑零覆盖”计入。

实际业务代码继续纳入统计。新增的直接测试覆盖包脚本验证器的固定 Docker
镜像、参数和环境限制及失败路径；仓库资源解析器对现有文件 ID、嵌套项目归属和
越界路径的判断；以及 Temporal worker 工厂的活动依赖、配置和重复关闭。
语句、函数及代码行的门槛维持 90%，分支门槛设为当前可测基线的 85%；不会为
达到 90% 而直接排除 SQLite/PostgreSQL provider 的实际异常分支。这样既能
让本轮检查通过，也让这些待补测试的分支继续可见。这次覆盖率维护不会启用
GLOBAL_READY worker，也不会完成 M4.2：可信签名与执行代际、原子准备准入、
Git 专用 permit 和继续执行仍待实现。

本次 `pnpm check` 已完整通过：格式检查、TypeScript 项目引用、类型感知静态检查，
以及 77 个测试文件的 805 项测试均通过。覆盖率为语句 92.06%、分支 85.65%、
函数 94.19%、代码行 91.98%，对应门槛分别是 90%、85%、90%、90%。原来的
分支 90% 目标仍需对真实持久化及生产组合的异常路径补测试，而不是把这些逻辑
从统计中排除。

## 补齐 Git 准备信任设计的撤销边界

对 `f0e0fc0` 的独立复审认可了准备信任与执行代际设计中的主体分离、代际签发和
撤销规则，以及锁顺序，但发现两处尚未明确的权限决策。本次只修订**设计契约**，
没有实现运行时代码：可信密钥状态、单个准备决定／授权的撤销名单和策略版本必须
共用同一个持久 registry revision 与读写串行化域。创建准备父 claim、arming、
申请 Git 专用 permit、父子交接及首次启动 child 时，均在 registry 读串行化下
校验当前信任，并保持到 scope／run 事务提交；信任管理员的更新使用同一写串行化。
这样单个决定的撤销与授予新权限才有确定的先后顺序。provider 和 worker 目前都
没有实现这套 registry。

Git 工作树创建后，即使有独立静止证明，只要准备签名密钥已退休或撤销，或准确的
决定／授权已被撤销，也不能再交接产生执行 child。交接前必须核对当前信任。
交接提交并不代表 agent 启动；首次启动需要重新核对信任并持久记录只能启动一次
的身份。如果密钥在实际启动前失去 ACTIVE 状态，就不能让 runner 接触写入端。
child 确实启动后，普通密钥退休不追溯取消其另行批准的执行权限；但密钥紧急
撤销或单个决定／授权撤销会阻止后续恢复和 permit，撤销执行代际，对在途影响
要求独立进程管控与恢复。已冻结的继续执行设计也明确：信任 registry 的串行化
前缀位于原有 scope→run 锁序之前。失败交错及未来必须验证的竞态也已补齐。
在本次设计修订时，信任／代际提案尚待独立批准；下文所述复审随后批准了设计，
但实现仍未完成。M4.2 仍为 OPEN，GLOBAL_READY worker 仍未启用。

## PostgreSQL 信任登记与执行代际的持久化基础

对 `3da3986` 的独立复审批准的是统一信任登记与执行代际**设计**，并非运行时实现。
本轮通过仅由安装者执行的独立版本 7 迁移预留 PostgreSQL 持久化结构；旧迁移和
校验和保持不变。新的单行登记从修订号零、策略 `UNCONFIGURED` 开始；其他表预留
密钥身份及状态、针对准确决定／授权的撤销记录，以及关联 scope 与父 claim 的
执行代际身份和状态。这些只是存储位置，不代表已有可信签名者、代际签发者，
也不能据此启动 Git 或 agent。PostgreSQL 运行时账号对新增四张表和准备阶段表
都只有读取权限，不能创建密钥、撤销授权、签发或修改代际。启动检查会验证结构
和权限；尚停留在版本 6 的数据库不能启动全局 adapter。

PostgreSQL 的稳态 scope 操作现会在 scope→run 锁之前获取按 schema 区分的共享
信任 advisory lock，读取登记单行，并持锁至事务提交。未来受限的管理员修改信任
状态时必须先获取匹配的排他锁；实际管理员接口及强制权限模型还没有实现。真实
PostgreSQL 测试分别暂停双方，通过 `pg_blocking_pids` 核对两种顺序：管理员式
更新先完成，permit 才进入；或者 permit 的信任读取持续到提交，更新在后面等待。
其他测试证明安装者重复迁移保留已有代际行，运行时不能修改代际或登记，而误授
予运行时 INSERT 会被启动审计发现、由迁移修复。登记初始仍为未配置；这些测试
不意味着已经鉴别批准人或对已有普通 claim 执行密钥撤销。

SQLite 此时没有角色隔离、独立保护的信任登记，因此所提可信准备路径继续失效
关闭；不会把 worker 能修改的库内表假装成外部信任根。受限信任管理、唯一有效
代际的签发撤销、独立准备批准、原子父 claim 准入、Git 专用 permit、父子交接与
生产 worker 均待实现和独立验证。GLOBAL_READY 生产 worker 仍未启用，M4.2
继续 OPEN，M4.3 尚未开始；公开 number token／BIGINT 及诊断资源 ID 歧义仍
为 P2。

验证结果：`pnpm check` 的格式、TypeScript 项目引用、类型感知静态检查，以及
77 个文件的 808 项测试均通过。覆盖率高于当前门槛：语句 92.04%、分支 85.63%、
函数 94.18%、代码行 91.97%。独立 PostgreSQL 定向测试 104／104 通过。

## PostgreSQL 受限信任写入与执行代际签发基础

独立复审已接受 `242e014` 的 PostgreSQL 第 7 版信任存储及锁序**基础**，同时指出迁移所有者仍可绕过约定的咨询锁直接修改登记表。本次新增独立的第 8 版迁移，不改动此前迁移的校验值；它安装两个由迁移所有者持有、入口受限的 PostgreSQL 函数。单独配置的信任管理员可以登记、退役或撤销密钥，撤销指定的 setup 决策或签名授权，或更新策略版本。每次实际修改都在排他信任锁下推进同一个持久化登记修订号；完全相同的重试不会再次推进修订号，退役或撤销的密钥不能重新启用。另一个单独配置的执行代际签发者可以在活动 scope、已绑定且活动的 run、活动的父 claim 和匹配的 workspace 阶段证据下登记唯一的活动代际，或不可逆地撤销代际；签发先取得共享信任锁，再按 scope、run 的顺序加锁。

PostgreSQL 运行时账号对信任及代际表仍只有读取权限，也不能执行这两个管理员函数。两个受限账号都不能直接修改权威表，且各自只能执行对应函数。启动检查核对函数签名、所有者、执行授权及安全属性；迁移程序能修复误授予运行时的执行权限。迁移所有者仍保有独立的管理权限，需要在部署中单独保护。

真实 PostgreSQL 测试验证账号隔离、密钥和代际身份不可替换、登记修订及撤销的幂等性、scope 锁竞争，并通过 `pg_blocking_pids` 验证受限信任写入与正在执行的 mutation permit 的两个先后顺序。由于生产路径尚不能创建带标记的 setup 父 claim，测试夹具使用迁移所有者预置它。上述受限写入接口**不是**签名者身份服务或生产代际监管者：调用者身份验证、依据实时登记验证密钥与决策、全部 permit 和调度路径对代际的校验、SQLite 的外部受保护信任状态、原子 setup 父准入、专用 Git permit、交接及生产 worker 执行都尚未实现。GLOBAL_READY 生产 worker 继续禁用，M4.2 保持开放，M4.3 尚未开始。公开 number token 与 BIGINT 的边界、诊断资源 ID 的歧义仍为 P2。

验证：`pnpm check` 的格式、TypeScript 项目引用检查、类型感知 lint 和 77 个文件中的 812 个测试均通过。语句、分支、函数及代码行覆盖率分别为 92.00%、85.68%、94.19%、91.92%，超过配置的 90/85/90/90 门槛；定向真实 PostgreSQL 测试为 108/108 通过。

## 补齐受限写入账号的权限审计缺口

独立复审 `0c1a6c6` 发现第 8 版有两处权限检查遗漏。第一，如果误给信任管理员或代际签发者直接修改 `forge_runs`、`forge_records` 或迁移账本的权限，它就能绕开自己的受限函数修改权威数据。现在 writer 连接与 runtime 启动会检查**全部权威表**的有效表级和列级修改权限，也包括这三张基础表。安装者重跑迁移时会撤销整套表上的 writer 直接授权，并确认没有残留的列级授权。真实 PostgreSQL 测试逐一误授基础表权限和 run 状态列权限，验证拒绝连接、拒绝启动及修复。

第二，如果第三方角色获得由安装者持有的安全定义函数的 EXECUTE 权限，就能绕开指定的 writer 登录账号调用该函数。安装者现在将两个指定 writer 角色的身份记录在只有对象所有者能维护的函数元数据中，**不改动已执行的迁移语句及其校验和**。runtime 启动依据这份记录核对每个函数完整的 EXECUTE 授权清单：只允许函数所有者和对应的指定 writer；尚未配置 writer 时则只允许所有者。迁移重跑保留该身份绑定，遇到多余的第三方授权会**失效关闭**，不会悄悄接受或改派 writer。真实 PostgreSQL 测试给另一账号 schema 访问及函数 EXECUTE 权限，证明启动和重跑迁移都会拒绝；所有者撤销多余授权后启动恢复正常。迁移所有者仍是需要单独保护的管理员。

这次解决的是复审所指出的两处权限审计缺口，不等于已经具备可信签名者、受监管的代际或生产 setup 准入。SQLite 尚无独立受保护的信任根，GLOBAL_READY 生产 worker 仍被禁用，M4.2 继续 OPEN，M4.3 尚未开始。公开 number token／BIGINT 及诊断资源 ID 歧义仍为 P2。验证结果：`pnpm check` 的格式、TypeScript、类型感知 lint 和 77 个文件的 814 项测试全部通过；语句、分支、函数、代码行覆盖率分别为 91.98%、85.73%、94.20%、91.90%，超过 90/85/90/90 门槛；定向真实 PostgreSQL 测试 110/110 通过。
