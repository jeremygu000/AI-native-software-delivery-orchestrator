# Runtime V2 Cutover 记录

## 状态

M3.14 Sequence C 已实施，正在等待 independent review。权威的 machine-checkable 记录位于
`runtime-v2-destructive-cutover-manifest.json`；其 architecture regression 位于
`apps/cli/src/runtime-v2-cutover-readiness.spec.ts`。

M3.12 仍为 PASS/CLOSED/FROZEN。已记录的 `deepseek/deepseek-flash` external-effect smoke 仍是 evidence，未在这次
destructive cutover 中删除或重跑。

## Production Route

唯一的 production route 是 compiled `forge run` -> Temporal -> compiled Temporal worker -> Forge runtime
composition。configured SQLite database 继续是 durable authority；`forge status` 与 `forge cancel` 使用同一 authority。
worker 通过 `FORGE_WORKER_REVIEW_PROVIDER` 与 `FORGE_WORKER_REVIEW_MODEL` 的 explicit deployment configuration 接收 review
policy 与 model。CLI 在写入 plan、bind 或 run authority 之前 canonicalize 并解析必填的 `--review-provider` 与
`--review-model`；worker 在开始 polling Temporal 前独立 canonicalize 并解析 deployment identity。缺失、空白、
不可用或 fingerprint 不匹配的 identity 会在产生有用工作前 fail closed；composition 只接收得到的
provider-neutral policy 与 application-owned adapter factory。
composition 还接收 application-owned reviewer 与 coding-runner factory。它既不读取 deployment environment variable，
也不自行创建 Pi adapter 或解析 model；worker 是这些 provider-specific concern 唯一的 production assembly boundary。

## 已删除 Asset

Sequence B 删除了 in-process `OrchestrationRuntime`、`LocalRuntimeStarter`、它们的 `/legacy` export 和测试、
legacy-versus-Temporal differential suite，以及 frozen 的 `temporal-spike`、`restate-spike` 与
`runtime-v2-spike-harness` workspace。package script、TypeScript reference、Vitest coverage exclusion、package
dependency 与 pnpm lockfile 均不再保留这些 asset。

可复用的 `libs/orchestration-runtime` application service 仍位于 production route，包括
`TaskOutputAdmissionCoordinator`、`RepairExecutionCoordinator`、`ForgeRunProgressionService` 与
`ForgeReadModel`。

## 保留 Evidence

Temporal 与 production-composition test 保留精确、不匹配且重复的 blocked-integration wake。一个真实 local Temporal
server 测试在 wake 前以 worker B 替换 worker A；另一个临时 SQLite 测试关闭 composition A 并通过同一数据库重建
composition B，验证错误 wake 不起作用、精确 wake 完成 integration、重复 wake 不重复集成。repair-budget 测试保留
已完成 repair、review 和 verification evidence，且没有 integration claim 或 `workspace-integrated` event。核心
repair-execution 测试保留 post-start `UNKNOWN` authority；此 cutover 不声称已另行验证完整 workflow 的 repair-UNKNOWN
nonterminal 场景。production composition 还测试了 `STALE` blocker repair resume。cutover regression 要求每个
retired path 均不存在。

## Verification

destructive route 已通过 `pnpm build`、`pnpm lint`、`pnpm typecheck`、`pnpm test` 和 machine-checkable cutover
regression 验证。`pnpm check` 当前仅被 `pi-agent-runner.spec.ts`、`task-repair-attempt.ts` 与
`repair-execution-coordinator.spec.ts` 中既有的 formatting 问题阻塞；它们均不属于本次 cutover。
