# Runtime V2 Cutover 准备

## 目的

这是非破坏性的 M3.14 准备记录。权威、machine-checkable 的 inventory 与 cutover gate 位于
`runtime-v2-destructive-cutover-manifest.json`，架构 regression 位于
`apps/cli/src/runtime-v2-cutover-readiness.spec.ts`。本文解释这些检查；它不授权删除 fallback、不声明
Runtime V2 migration 已完成，也不关闭整个 M3 programme。

**当前状态：** CUTOVER READY / BLOCKED ON M3.12 REAL SMOKE / NOT CLOSED。manifest 将
`destructiveChangesPermitted` 固定为 `false`，直到 M3.12 记录成功且获授权、使用 `openai/gpt-4.1` 的
external-effect smoke。

## 当前 Production Route

生产 deployment path 是 compiled `forge run` -> Temporal -> compiled Temporal worker -> Forge runtime
composition。durable authority 是显式配置的 SQLite database；`forge status` 从同一 authority database 读取
provider-neutral durable read model。

## Legacy Inventory

manifest 对每个保留路径分类，并记录其 caller 与通过 smoke 后的删除资格：

- `libs/orchestration-runtime/src/lib/orchestration-runtime.ts` 是 legacy in-process runtime，用于已冻结的
  M3.6-M3.9 differential evidence，分类为 differential-only。
- `libs/run-preparation/src/lib/local-runtime-starter.ts` 是 legacy in-process runtime 的
  differential-only caller。
- `apps/temporal-worker/src/legacy-temporal-differential.spec.ts` 并行执行 legacy runtime 和 Temporal path，
  保护 authority parity，分类为 differential-only，并由专门的 legacy test command 调用。
- `libs/temporal-spike/` 和 `libs/restate-spike/` 是 frozen-prototype artifact；它们不会启动 production Forge
  worker。
- `libs/runtime-v2-spike-harness/` 是保留 differential 与 prototype evidence 的 test-only support。
- `libs/orchestration-runtime/src/lib/` 整体不是 deletion candidate。其可复用 application service，包括
  `TaskOutputAdmissionCoordinator`、`RepairExecutionCoordinator`、`ForgeRunProgressionService` 和
  `ForgeReadModel`，继续位于 production route。

可执行的 architecture regression 验证 compiled CLI 不 import `OrchestrationRuntime`、`LocalRuntimeStarter` 或
worker composition；`forge run` 包含 `TemporalRunLauncher` 与 `startForgeRun` route；独立部署的 worker 是唯一使用
`createForgeWorkerComposition` 与 `createTemporalWorker` 组合 activity 的 production process。

## Cutover Assertions

在任何 destructive M3.14 变更前，必须证明：

- M3.12 已记录成功且获授权的真实 external-effect smoke。
- production CLI 只启动 compact Temporal workflow，且只写入一次 launch authority。
- 独立启动的 worker 能从 configured authority database 完成并恢复 durable run。
- `forge status` 和 `forge cancel` 针对该 configured authority database 操作。
- provider-neutral read model 对 CLI operator 以及未来 API/UI boundary 仍然足够。
- 冻结的 legacy-versus-Temporal differential coverage 可在不丢失 authority assertion 的前提下退休或替换。

## Deletion Plan

满足这些断言后，另行 review 的 destructive stage 才可以按顺序移除 production-dead legacy scaffolding：

1. 在不丢失唯一行为的前提下，以 durable contract fixture 取代只用于冻结 differential 的调用方。
2. 移除无引用的 prototype package 及其 build/test script。
3. 只有在没有 production 或 contract test import 后，移除最终 legacy runtime。
4. 更新 architecture 和 progress documentation，说明最终 cutover boundary。

在此之前，本 inventory、manifest 与 regression 有意保持 non-destructive。M3.14 不删除任何列出的路径。
