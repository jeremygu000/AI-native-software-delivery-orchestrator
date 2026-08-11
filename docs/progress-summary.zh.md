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

完整质量门现在有 250 个测试通过。覆盖率为语句 96.78%、分支 91.83%、函数 99.14%、行 96.75%。
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

完整质量门现在有 250 个测试通过。覆盖率为语句 96.78%、分支 91.83%、函数 99.14%、行 96.75%。

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

完整质量门现在有 250 个测试通过。覆盖率为语句 96.78%、分支 91.83%、函数 99.14%、行 96.75%。
`pnpm check`、`pnpm build` 和 `git diff --check` 都通过。

## 目前整体状态(截止到本文写作时)

- 架构规划的 11 个里程碑已全部实现。这不代表完整产品 100% 完成：real agent execution、真实 write
  enforcement、concurrent dispatch、provider integration 和 CLI runtime command 仍是当前 milestone 计划外的重要能力。
- `pnpm check` 会完成格式、lint、TypeScript 7 类型检查和测试。当前 250 个测试全部通过。
- 覆盖率为:语句 96.78%、分支 91.83%、函数 99.14%、行 96.75%;四项都达到至少 90% 的门槛。
- `pnpm build` 通过。`forge analyze` 已在 968 个文件的真实仓库验证;`forge plan` 仍然刻意
  保持不可用。
- Milestone 6 第二次正确性加固和 Milestone 7 实现都已经通过独立 Review 与 follow-up Review,没有
  Critical、High 或 Medium。Scheduler 中记录的 review finding 已修复，并在提交前独立重新验证。
- Milestone 8 Runtime Guard 已完成接受的 process-local in-memory scope，并已通过独立 Review。
- Milestone 9 Persistence 已完成接受的 local SQLite scope，并已通过独立 Review。
- Milestone 10 Workspace/Git 已完成接受的 local single-repository scope，并已通过独立 Review。Review 还
  重新验证 Date-aware lease idempotency 和 clean-target task-branch collision handling。
- Milestone 11 Orchestration Runtime 已完成接受的 local serial fake-agent scope，正在等待独立 Review 后才能提交。
- Pi 有意尚未集成。下一 backend stage 只能把它作为 `AgentRunner` adapter，置于 orchestrator-controlled tool
  和 durable attempt/session evidence 之后。

## 还没有实现的部分

- 真正调用/监控 coding agent 或 verification command。
- Dispatch 多个 concurrent agent、recovery unknown in-flight agent 或协调多个 process。

简单说:**编排器现在能为真实 TypeScript pnpm 仓库建立确定的结构地图,预测任务影响、比较冲突,
在事件发生后确定地决定哪些任务可以启动，在一个 process 内保护 exclusive write，从 SQLite 恢复
经过验证的 local orchestration evidence，用 Git integrate 一个 local task worktree，并用 serial fake-agent
runtime 运行这些 port。它仍不会观察真实 write、协调多个 process 或运行 real coding agent。**
