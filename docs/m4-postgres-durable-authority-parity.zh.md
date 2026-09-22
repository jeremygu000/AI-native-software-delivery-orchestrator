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
