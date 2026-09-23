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
