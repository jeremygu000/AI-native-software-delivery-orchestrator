# Runtime V2 Cutover 准备

## 目的

这是非破坏性的 M3.14 准备记录。它盘点 legacy migration evidence，并定义删除前必须满足的断言；它不授权删除
fallback、不声明 Runtime V2 migration 已完成，也不关闭整个 M3 programme。

## 当前 Production Route

生产 deployment path 是 compiled `forge run` -> Temporal -> compiled Temporal worker -> Forge runtime
composition。durable authority 是显式配置的 SQLite database；`forge status` 从同一 authority database 读取
provider-neutral durable read model。

## Legacy Inventory

以下路径保留为 migration evidence，而不是 production routing：

- `libs/orchestration-runtime/src/lib/orchestration-runtime.ts` 是 legacy in-process runtime，用于已冻结的
  M3.6-M3.9 differential evidence。
- `apps/temporal-worker/src/legacy-temporal-differential.spec.ts` 并行执行 legacy runtime 和 Temporal path，
  保护 authority parity。
- `libs/temporal-spike/` 和 `libs/restate-spike/` 是冻结的 decision/prototype artifact；它们不会启动 production
  Forge worker。

compiled CLI 不得实例化 legacy runtime 或 Forge worker composition。compiled worker 是唯一负责 composition
activity 的 production process。

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

在此之前，本 inventory 有意仅为 documentation。
