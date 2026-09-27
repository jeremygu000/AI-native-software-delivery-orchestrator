# M4.1A：Durable Persistence 契约与 Parity 盘点

## 基线与范围

M4 从冻结的 M3 closure commit `e58564010593d65d58f749c4dd74125368f31092` 开始，工作分支是
`m4/postgres-durable-authority`。SQLite 是当前 Forge 单个 run 的 authority 语义参照，**不是**要求 PostgreSQL
复制 SQLite 实现。M4.1A 盘点差距并提取可执行行为契约，不修改 M3 authority 语义，也不将生产 worker 切换到
PostgreSQL。跨 run 的 repository fencing、全局分布式 write lease 和多 run 并发留给 M4.2/M4.3。

## Adapter 现状

| 能力                        | SQLite (`DrizzleSqliteOrchestrationPersistence`)      | PostgreSQL (`postgres-persistence`)                                                                                                                          |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Forge run authority adapter | 实现 `OrchestrationPersistence` 与活动/控制面存储接口 | **缺失**：`PostgresEvidenceStore` 只是未来 adapter 的 TypeScript 交叉类型；没有实现和 factory。                                                              |
| 连接                        | 可打开同一文件的两个独立 SQLite 连接                  | `connectPostgresEvidenceStore()` 仅检查连接串前缀、schema 标识符、非空 role，建立 `postgres` client 并提供有界 `close()`；未验证连接，也未落实 schema/role。 |
| 持久化 schema               | adapter 内含 SQLite 表、约束与打开时迁移              | 没有 Forge 表、迁移、行锁、索引或 search-path/role 隔离。                                                                                                    |
| 测试数据库                  | 临时 SQLite 文件可由两个连接共用                      | 没有 provisioned PostgreSQL 服务、schema 生命周期或测试 role。                                                                                               |
| 生产路由                    | CLI/worker 使用显式配置的 SQLite authority            | 尚未接入 PostgreSQL。                                                                                                                                        |

现有 PostgreSQL 测试只覆盖配置元数据与候选连接关闭，**不**证明任何 Forge durable authority parity。
候选 `PostgresEvidenceStore` 类型本身也不完整：目前未包含 `ActiveMutationClaimPersistence`、
`CancellationPersistence`、`CancellationSettlementPersistence`、
`IntegrationMutationClaimPersistence`、`TaskRepairWorkItemAdmissionStore` 和
`TaskRepairResumeStore`。后续 adapter 必须实现完整的 worker authority 接口。

## 共享可执行契约

`libs/persistence/src/lib/durable-authority.contract.test.ts` 是基于 domain persistence 接口的统一行为
suite。SQLite 在 `durable-authority-parity.spec.ts` 中通过**同一临时文件上的两个独立连接**执行。PostgreSQL 的
`libs/postgres-persistence/src/lib/durable-authority-parity.spec.ts` 导入**同一套测试**，但在真实 adapter 与
PostgreSQL fixture 存在之前明确跳过：skip 表示**尚未验证**，不是 PASS，不使用 SQLite 或假的 PostgreSQL
adapter 代跑。SQLite 既有细粒度测试继续保留；共享 suite 是后续 M4.1 实现的共同 parity 基线。

| 行为契约                                                                | SQLite 参照                                                                             | PostgreSQL 差距                                                                                                                                 |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 精确 run authority 建立、重复 ID 拒绝、task binding 恢复                | 共享测试验证建立/恢复，并拒绝不同 authority 覆写                                        | 缺少 run/binding 表与事务性建立。                                                                                                               |
| sequence-one `run-started` initial dispatch，attempt 已推进后的精确重试 | 要求 `ensureInitialDispatch`、唯一 event/decision、不变 attempt authority，拒绝不同证据 | 缺少 initial-dispatch 事务与证据一致性验证。                                                                                                    |
| builder PREPARING -> STARTING revision CAS                              | 两个连接竞争同一 attempt，只有一个成功                                                  | 应使用条件更新（如 `UPDATE ... WHERE state='PREPARING' AND revision=? RETURNING ...`）并事务性处理 lease；不能以不安全的 read-then-write 模拟。 |
| repair admission、不可变 work item、预算边界                            | 两连接对同一 review 返回同一 attempt、一个 work item；下一 review 超出预算              | 缺少按 task 的事务性预算与精确 review 幂等性。                                                                                                  |
| BLOCKED repair resume revision CAS、lease release、唯一 dispatch        | 两连接竞争，一次 resume、一次 version conflict、唯一 revision-three dispatch            | 应在同一事务中条件更新并约束 `(run,repair,revision)` 唯一。                                                                                     |
| review 与 verification evidence                                         | 精确重试仅恢复一个记录；不同 subject 或 evidence 拒绝                                   | 缺少精确 subject/fingerprint 验证与不可变 evidence 表。                                                                                         |
| workspace 与 impact 恢复                                                | 另一连接恢复 blocked workspace 和结构化 `Set` impact                                    | 缺少持久化编码、解码与损坏证据校验。                                                                                                            |
| integration claim 与 cancellation settlement                            | claim identity 不变；取消可见、错误 settlement 被拒、精确 settlement 清除 claim         | 缺少 claim CAS、身份校验及 settlement 事务。                                                                                                    |
| cancellation 与普通 terminal state                                      | ACTIVE -> CANCEL_REQUESTED -> CANCELLED、ACTIVE -> COMPLETED；terminal 不可覆盖         | 缺少状态迁移 CAS 与终态模型。                                                                                                                   |
| `ForgeReadModel` 恢复前提                                               | SQLite 提供 `recoverRun`、review、repair、verification、lease 等数据                    | 没有兼容的恢复 API 或重建集合。                                                                                                                 |

共享 suite 还新增两项**同一 run 的 authority** 行为契约：

- `claimRepairStart` 将已准入的 repair 从 PREPARING revision N 推进到 STARTING revision N+1。
  两个独立连接竞争同一 claim，仅一个成功，失败方不产生额外 attempt 或 work item。PostgreSQL
  必须在同一事务中条件检查 repair revision 与 run 的 ACTIVE 状态。
- `requestCancellation()` 一旦持久化 CANCEL_REQUESTED，随后 `claimBuilderStart`、
  `claimRepairStart`、`claimIntegrationStart` 均须拒绝，且不留下新的 mutation evidence。
  builder claim 携带非空 lease plan；拒绝后 builder 仍为 PREPARING、候选 lease 不存在，run 仍为
  CANCEL_REQUESTED。PostgreSQL 必须让这三种 ACTIVE-run mutation claim 与 cancellation **原子串行化**；
  先读取 ACTIVE、待另一个事务取消后再无条件写入 claim，会违反冻结的 M3 authority。

共享 suite 只是完整 SQLite 行为的首批可执行子集，不能取代原有细粒度测试。后续 PostgreSQL parity
仍须覆盖 partial initial evidence、builder/repair UNKNOWN settlement、lease version regression、
reevaluation replay 与 runtime-conflict sequence、verification fingerprint integrity 与 corruption、
integration claim release 与 settlement 区别、跨连接的 repair history。当前 SQLite
`finalizeCancellation()` 即使存在 active integration claim，也会将 `CANCEL_REQUESTED` 转为 `CANCELLED`；
调用方另行查询和处理 claim。M4.1 应记录并保持这个已观察到的行为，不能暗中改写 SQL 语义。
SQLite 的两个连接能验证外部可观察的单赢家/失败方及取消优先行为，但其同步事务意味着这里的
`Promise.all` **不能**证明两个数据库事务真正重叠。PostgreSQL parity 必须人为控制独立事务在
claim-versus-claim 和 cancellation-versus-claim 窗口重叠，并证明唯一持久化赢家与确定的失败方。
这是同一 run 的 authority parity，不属于 M4.2 的跨 run repository fencing。

## PostgreSQL parity 退出条件

1. 建立完整实现 domain 所需存储接口的 PostgreSQL adapter；parity 完成之前不接入 CLI/worker。
2. 为测试提供隔离的真实 PostgreSQL 数据库/schema/role，验证 search-path、role 隔离、迁移、唯一性及损坏记录处理。
3. 以两个独立 PostgreSQL 连接运行**同一套**共享契约，替换目前明确的 PostgreSQL skip；mock 或内存实现不算 parity。
4. 扩充共同契约以覆盖剩余差距，使用 PostgreSQL 约束、条件更新、`RETURNING` 和必要的锁保证事务/CAS；
   增加可控重叠事务测试，让 builder、repair、integration claim 与 cancellation 竞争：取消先赢时，
   后续 claim 不得留下任何持久化 mutation authority。
5. 保持冻结的 M3 SQLite 语义；跨 run repository fencing 和多 run acceptance 分别留待 M4.2 与 M4.3。

独立复审 `348f823` 后，M4.1A 状态为 **PASS / CLOSED**。SQLite 参照 adapter 的 10 项共享
authority 契约全部通过。PostgreSQL 仍是 10 项显式跳过、1 项 fixture 待实现：authority adapter
**尚未实现 / 尚未验证**，parity 仍受阻于 M4.1B。关闭的仅是审计，不是 PostgreSQL parity 或整个 M4.1。

## M4.1B：真实 PostgreSQL authority adapter 与 fixture（待独立复审）

`PostgresOrchestrationPersistence` 实现 Forge run、dispatch、attempt、repair、review、verification、
workspace、integration 和 cancellation 存储接口，原有候选 `connectPostgresEvidenceStore()` API 未被
替换。连接时检查配置 role 与 `current_user` 一致、schema 存在，然后建立 run 和带唯一键的 evidence 表。
同一 run 的写操作在事务里先用 `SELECT ... FOR UPDATE` 锁定 run 行，因此状态判断、revision 判断和
写入共用串行化边界。初始 dispatch 精确重试会验证已经推进的 attempt 的不可变 authority。
`recoverRun` 使用一致的 `REPEATABLE READ READ ONLY` 快照重建并校验 authority 证据。

PostgreSQL fixture 以 `initdb`、`pg_ctl` 启动隔离的本机真实服务，每个用例使用新 schema 和两个
独立连接，执行与 SQLite **同一套 10 项共享契约**，不跳过、不回退。另有五项 PostgreSQL 专属
测试覆盖错误 role、缺失 schema、损坏 run、残缺初始 authority、重开连接后的 replay/恢复；同时证明
两个真正阻塞的 builder claim 只有一个成功，以及取消先提交时三种被阻塞的 mutation claim 不留下副作用。
`pg_blocking_pids` 用来确认事务真实重叠。

这只是**单 run adapter 证据**，并非生产切换：CLI/worker 仍使用 SQLite；M4.2 跨 run repository
fencing 与 M4.3 多 run 并发属于后续阶段。上方 M4.1A 差距表是历史审计快照。选择 PostgreSQL
生产路由前，还需审查 schema 归属/迁移、role 权限，以及扩充 UNKNOWN settlement、其他证据损坏、
conflict sequence/replay、ForgeReadModel 恢复等共同契约。M4.1B 当前为
**IMPLEMENTED / AWAITING INDEPENDENT REVIEW**。

### 复审补正：证据校验与新连接上的恢复

同一套 backend-neutral 契约现在对每种 backend 执行 **16 项用例**，通过仅用于测试的 binding、
verification 记录直接损坏，证明恢复必须 fail closed。新增用例拒绝格式错误的 scheduler event、
snapshot、task decision，effective sequence 错误的 runtime conflict；run 或 task 身份不符的
impact、conflict、workspace；缺失或行键不符的 binding；以及结构合法但自指纹错误的 verification
证据。PostgreSQL adapter 在写入前校验证据，恢复时要求 binding 同时符合行键和 run 的完整 task 集合。

共享契约还分别验证 UNKNOWN builder 和 repair attempt 的取消结算：请求取消前不得结算，错误
revision 不能修改 lease；精确 revision 将对应 attempt 标为 CANCELLED，释放匹配的 active lease，
但保留无关 lease 的 ACTIVE 状态。PostgreSQL 专属用例在相同持久化 schema 上打开一个新的独立
adapter/connection，再使用 `ForgeReadModel` 投影已恢复的 run，检查 builder/repair 血缘、
review/verification 引用、lease、
阻塞原因、时间线和关联标识。与原有五项 PostgreSQL 专属用例合计，定向测试 **38 项通过**
（每种 backend 各 16 项共享契约，另有六项 PostgreSQL 专属用例）。SQLite 生产路由和冻结的 M3
语义均未变。

这些证据**不授权 PostgreSQL 生产切换**。目前 adapter 仍在连接时创建两张表，没有版本化、
由 migration owner 管理的 schema，也没有启动时的版本兼容检查。启用生产路由前，必须引入
可复审的迁移与记录在库中的 schema 版本，拒绝不兼容版本；把 migration-owner role 和仅具
必要数据权限、启动时不能执行 DDL 的最小权限 runtime role 分离；并在真实数据库验证建表、
权限与升级。PostgreSQL `recoverRun` 的事务只保证**单次调用**的一致快照，不代表
`ForgeReadModel` 四次独立恢复调用共享原子快照。独立复审 `a6c1884` 未发现 P0/P1，
**M4.1B 现为 PASS / CLOSED**。CLI/worker 继续使用 SQLite；PostgreSQL 生产路由
**NOT READY / NOT ENABLED**，整个 M4.1 **NOT CLOSED**。版本化迁移、schema 兼容性闸门、
migration-owner/runtime-role 分离、最小权限授权和真实升级验收仍是后续 M4.1C operational-schema
阶段的前置条件。M4.2/M4.3 不在本阶段范围内。

## M4.1C：可运维的 schema 与受限 runtime（待独立复审）

现在只有独立的迁移所有者操作 `migratePostgresAuthoritySchema()` 才能安装 schema：带校验和的
版本账本记录 v1 的 run/evidence 表及 v2 的查询索引。安装、升级在事务和 schema 专属 advisory
lock 中完成；已完成版本可重复运行而不改写数据，降级、未来版本或被篡改的账本、未纳入管理的
既有表、错误的 schema 所有者均拒绝。迁移者向不同的 runtime role 授予 schema 使用权、账本只读
权限及数据表所需的读写权限，不授予 schema 所有权或 DDL 权限。

`PostgresOrchestrationPersistence.connect()` 不再创建表或修复 schema。它以只读启动检查核对
当前数据库身份、schema/表所有者、列类型与非空约束、主键与外键、必需索引的实际定义、准确
的版本与校验和，以及 runtime 的实际权限。
runtime 不得为超级用户、迁移所有者成员、数据库或 schema 的创建者，也不得创建临时表。
缺失的对象、未来或被篡改的账本、缺失索引或缺少数据表权限都使启动失败，且不执行 DDL；
authority adapter 不使用迁移所有者凭据。

真实 PostgreSQL fixture 为每项用例建立全新 schema，分别使用迁移所有者和受限 runtime
身份，并开启两个独立 runtime 连接。同一套 **16 项后端中立 authority 契约**及已有的
PostgreSQL 恢复与受控事务重叠测试均在受限身份下运行。额外的真实数据库测试覆盖 v1 安装
后升级到 v2 且保留 run 数据、重复安装与拒绝降级、账本缺失／未来版本／校验和损坏、DDL 和
账本写入被拒、撤销 UPDATE 权限、删除必需索引、修改列的非空约束、删除主键以及同名索引
改指错误列。PostgreSQL 专项 suite 当前 **29 项通过**，
其中包括 16 项共享契约；SQLite 对同一共享 suite 的实例仍可执行。M3 的 authority 语义与
生产路由均未改变：CLI 和 worker 继续使用 SQLite。M4.1C 为**已实现／待独立复审**，整个
M4.1 仍**进行中**。应用的显式 PostgreSQL 路由属于 M4.1D；跨 run fencing 与多 run 并发
分别属于 M4.2/M4.3。

### M4.1C 复审加固（待独立复审）

迁移入口现在在连接或创建 schema 之前拒绝不支持的运行时目标版本，包括零、未来版本及非数字
输入。迁移重复执行时，先撤销 `PUBLIC` 和 runtime role 的全部表权限，再只授予：账本
`SELECT`、run 表 `SELECT/INSERT/UPDATE`、evidence 表
`SELECT/INSERT/UPDATE/DELETE`。启动检查拒绝多余的 `DELETE`、`TRUNCATE`、
`REFERENCES`、`TRIGGER` 权限，也拒绝缺少必要权限。真实 PostgreSQL 测试先授予多余权限，
确认启动失败，再重跑迁移并确认多余授权消失、启动成功。

迁移校验和普通启动都要求 authority 表是永久普通表、禁用 RLS 与 FORCE RLS、账本时间戳
保留 `now()` 默认值，并且 authority 表无用户自定义 trigger 或 rewrite rule。真实数据库测试
逐项篡改这些属性，证明两个入口均拒绝且不自动修复。PostgreSQL 专项 suite 现有 **39 项
通过**；共享的后端中立契约未修改。M4.1C 仍为**已实现／待独立复审**；CLI 和 worker 继续
使用 SQLite。

### M4.1C 有效权限复审加固（待独立复审）

runtime 启动闸门现在检查凭据的**实际有效权限**，不再只看表级 GRANT：拒绝只读账本上的列级
`INSERT`／`UPDATE`／`REFERENCES`、两张数据表上的列级 `REFERENCES`、所有允许的表操作
及 schema `USAGE` 的 `WITH GRANT OPTION`，以及任何其他角色成员关系（包括不自动继承但
可通过 `SET ROLE` 激活的角色）。迁移重跑仍可归一化直接授予 runtime／PUBLIC 的权限；
runtime 的角色成员关系需要另行移除。

明确只支持 **PostgreSQL 14–16**：迁移与 adapter 启动均拒绝范围外的主版本；如需支持
PostgreSQL 17 或更新版本，须先将新增 `MAINTAIN` 权限纳入有效权限闸门。真实 PG14 回归证明
账本的列级 `UPDATE(checksum)` 即使表级 UPDATE 为 false 也能修改账本，启动会拒绝此权限，
迁移重跑后多余授权消失。用例还覆盖其他列级越权、表／列授权转授权、schema 转授权及角色
成员关系。PostgreSQL 专项 suite 现为 **50 项通过**（16 项共享契约、34 项 PG 专项）；
M4.1C 仍为**已实现／待独立复审**，CLI／worker 仍使用 SQLite，M4.1D 路由未启用。

### M4.1C 会话身份复审修正（待独立复审）

PostgreSQL 将通常代表初始会话身份的 `session_user` 与当前权限身份 `current_user` 分开：高权限登录角色可以
通过 `SET ROLE` 暂时成为受限 runtime，再用 `SET ROLE NONE` 恢复登录角色的权限。只读的
runtime 启动闸门现在要求**两种身份都等于**所配置的 runtime 角色，然后才检查权限；不支持由
其他登录角色代为登录并切换为 runtime 角色的部署模式。

真实 PostgreSQL 14 fixture 使用带 `CREATEDB` 权限的独立 LOGIN 角色切换成 runtime，验证
会话身份与当前身份不同、登录权限能够恢复，且启动闸门和 adapter 连接均拒绝这种会话。
成员关系测试还将 `NOINHERIT` 正确设置在作为成员的 runtime 角色上，证明
`USAGE=false`、`MEMBER=true`，且仍可通过 `SET ROLE` 激活成员角色，随后启动被拒绝。
PostgreSQL 专项 suite 现有 **51 项通过**（16 项共享契约、35 项 PG 专项）。M4.1C 仍为
**已实现／待独立复审**，CLI／worker 仍使用 SQLite，M4.1D 路由尚未开始。

### M4.1C 真实连接凭据复审修正（待独立复审）

`session_user` 也不是不可变的：超级用户可以执行 `SET SESSION AUTHORIZATION`，让两个 SQL
身份同时显示为受限 runtime，再通过 `RESET SESSION AUTHORIZATION` 恢复原始高权限身份。
因此 runtime adapter 现在在**建立连接池之前**校验连接 URL：用户名必须明确是配置的 runtime
角色，且 URL 不得带任何查询参数，包括可切换角色的 PostgreSQL 连接启动参数。只读 schema
启动闸门也独立执行相同的 URL 校验、检查 PostgreSQL 客户端连接池实际选用的登录用户，并保留
两个 SQL 身份的检查；这里明确不支持代理登录或连接启动覆写。

真实 PostgreSQL 14 回归证明超级用户登录后能使两个 SQL 身份都表现为 runtime，随后仍可
恢复超级用户身份；schema 闸门拒绝此代理凭据，adapter 入口拒绝同类 URL 启动参数。省略
runtime 用户名或携带任何 URL 启动参数也会被拒绝。PostgreSQL 专项 suite 现有 **53 项通过**
（16 项共享契约、37 项 PG 专项）。M4.1C 仍为**已实现／待独立复审**，CLI／worker 仍使用
SQLite，M4.1D 生产路由尚未开始。

### M4.1C 独立复审结论

对受限 runtime 连接凭据修正的独立复审未发现 P0 或 P1 问题。M4.1C 现为
**PASS / CLOSED / FROZEN**。M4.1 整体仍为**进行中**：M4.1D 尚未开始，生产 CLI 和
worker 继续使用 SQLite，PostgreSQL 生产路由尚未启用。未来如需 TLS 或连接安全配置，
应使用明确的强类型 adapter 配置，不应放宽 runtime 登录闸门以允许 URL 查询参数。

## M4.1D：生产 authority 显式路由（待独立复审）

CLI 与独立启动的 Temporal worker 现在通过 `libs/persistence` 中相同的
`resolveAuthorityConfiguration`／`openAuthorityPersistence` 边界选择持久化存储。
`FORGE_AUTHORITY_BACKEND=sqlite` 使用绝对路径 `FORGE_WORKER_DATABASE_PATH`；未设置 backend
时，现有 SQLite 部署及按 run 存储的运维命令仍保持 SQLite 兼容行为。仅设置 PostgreSQL
参数却未显式选择 `FORGE_AUTHORITY_BACKEND=postgres` 会被拒绝，不会默默回退 SQLite。
选择 PostgreSQL 时，两个进程均需提供 `FORGE_POSTGRES_CONNECTION_STRING`、
`FORGE_POSTGRES_SCHEMA`、`FORGE_POSTGRES_ROLE` 和 `FORGE_AUTHORITY_ID`；不得同时提供
SQLite 数据库路径。`FORGE_AUTHORITY_ID` 是 `authorityConfigurationFingerprint` 对 backend、
数据库主机／端口／名称、schema、角色计算的 `sha256:` 指纹，不包含凭据。两个进程必须使用
相同指纹；修改数据库、schema、角色或 backend 却未更新指纹会在工作开始前失败。这防止意外
配置错位，不能抵御有意伪造一致配置的行为。

迁移仍由独立的 owner 显式执行：进程启动之前使用 `migratePostgresAuthoritySchema` 安装
版本化 schema。工厂仅通过 `PostgresOrchestrationPersistence.connect` 打开 PostgreSQL；
缺失迁移、错误角色、多余权限或异常结构均直接拒绝，不在启动时建表。`forge run` 在绑定计划
或创建 checkout 之前预检连接。启动、`forge status`、`forge cancel`、UNKNOWN attempt
取消结算及 integration 取消结算均使用所配置的 authority；worker 将同一 backend 的
存储注入 provider-neutral composition。CLI 不创建 worker，Temporal 工作流只传紧凑 run ID。

编译产物进程验收启动本地 Temporal 服务、由 owner 迁移且 runtime 角色受限的真实
PostgreSQL 14 fixture、独立 CLI 与独立 worker。第三个数据库连接验证持久化完成及唯一
初始 run-started 事件。CLI status 读取该 PostgreSQL run；终态 cancel 拒绝取消已完成
run。另一个独立启动的 PostgreSQL run 在 CLI 启动进程退出后由 CLI 发起取消：status 与
独立连接可见 `CANCEL_REQUESTED`，另一 worker 随后将其完成为 `CANCELLED`。错误 schema
的 CLI 和错误 backend 的 worker 均被部署身份闸门拒绝。
原有编译产物 SQLite 进程测试现在也以相同身份机制显式选用 SQLite；未指定 backend
的 SQLite 兼容行为由工厂测试保留。

M4.1D 当前为**已实现／待独立复审**，尚未关闭；M4.1A–C 和 M3 的语义保持冻结。
本阶段不增加跨 run repository fencing 或多 run 并发控制；未来 TLS 与连接安全配置
应使用明确的强类型 adapter 配置，不能通过绕过登录闸门的 URL 查询参数实现。

验证结果：工厂／CLI／composition 定向测试 50 项通过；编译产物 Temporal worker 阶段的
composition 15 项、进程验收 5 项、smoke 配置 3 项均通过。Lint、typecheck、build 通过。
非 worker 全套阶段有 668 项通过，但未改动的 Restate 容器测试无法找到可用的容器运行时，
因此未能完成整套测试。仓库级 `pnpm check` 在三个未改动文件的格式检查处停止：
`libs/agent-runtime/src/lib/pi-agent-runner.spec.ts`、
`libs/domain/src/lib/task-repair-attempt.ts`、
`libs/orchestration-runtime/src/lib/repair-execution-coordinator.spec.ts`。

### M4.1D 显式 SQLite 部署身份复审修正

独立复审指出新加入的显式 SQLite 路由仍可缺少 `FORGE_AUTHORITY_ID`。现在**两个显式选择的
backend** 都必须提供该身份；只有历史上**未设置 backend** 的 SQLite 兼容路径允许省略。
若提供身份，即使走兼容路径也必须通过校验。工厂回归分别覆盖这两种情况，并拒绝使用 CLI
数据库 A 的预期身份却指向 SQLite 数据库 B 的 worker。编译产物 SQLite 进程验收也验证这种
错误路径的 worker 在连接 Temporal 前退出。PostgreSQL 路由及 M4.1C 启动闸门没有变化。
M4.1D 仍为**已实现／待独立复审**，M4.1 整体仍为**进行中**。
