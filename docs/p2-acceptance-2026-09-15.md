# P2 阶段验收汇总（真实接口与故障注入，历史归档，2026-09-15）

> 当前部署已改为 Docker 单进程；外部 watchdog 已禁用。下表第③项保留为历史实测，
> 不再作为当前运行模型或发布前置条件。

> 逐条判据的可运行命令与原始 JSON：
> - ① ② ④ → `docs/p2-fault-injection-2026-09-15.md` / `.json`（`node scripts/fault-injection.mjs`）
> - ③ → `docs/p2-watchdog-2026-09-15.md` / `.json`（历史命令 `node scripts/watchdog-check.mjs`；当前调用会返回 disabled）
>
> 提交前门禁：`pnpm verify` = **50 文件 / 560 测试全绿**。

## 判定：§10 P2 ①–④ 全部通过；真 HTX 端点核对待凭据

| # | 判据（plan §10） | 结果 | 边 |
|---|---|---|---|
| ① | 订单在途时 `kill -9` × 50：孤儿订单 = 0、重复成交 = 0 | ✅ 50 轮、38 次真 SIGKILL；孤儿挂单 **0**、重复成交 **0**、恢复幂等 50/50 | 持久化 `sim-exchange`（同 `Broker` 契约） |
| ② | 同一 `clientOrderId` 提交 10 次 → 仅 1 次成交 | ✅ 成交 **1** / 意图 **1** / 成交记录 **1** | 同上 |
| ③ | `SIGSTOP` > 3× 心跳 → watchdog 撤单、交易所挂单 = 0 | ✅ 8/8（历史）：真实 `SIGSTOP` → stale → 撤单 → 挂单清空 → halted 落库 → 幂等 | **已退役**；当前改由 Docker restart + 启动 CrashRecovery/reconcile |
| ④ | 停掉模型供应商：已挂保护单仍生效 | ✅ 停摆后保护单触发 1 次、持仓归零 | 交易所侧条件单 |

## 本阶段交付的代码（T2.1–T2.6）

| 任务 | 交付 | 关键取舍 |
|---|---|---|
| T2.1 | `exec/ccxt-broker.ts`（venue-agnostic、注入 exchange、OKX sandbox 开关）、`plugins/exec.ts` 的 `resolveExecBroker` | `placeOrder` 传输失败**必须 throw**，让已落库的 `created` 意图交给恢复处理；`getAccount` 缺盘口时 `spreadBps = Infinity`（fail-closed）；密钥经 `#safeError` 脱敏 |
| T2.2 | `supervisor/{heartbeat,watchdog}.ts`、`Reconciler`、`/halt` `/resume`、`scripts/watchdog-check.mjs` | 历史 watchdog 逻辑曾验证撤单成功才置 halted；**当前不启用**，生产路径改为 Docker restart + CrashRecovery/reconcile；`inject = ['commands']` |
| T2.3 | `exec/sim-exchange.ts`、`scripts/fault-injection.mjs` | 模拟 venue 只在测试/验收使用，**不接生产**（`src/plugins/*` 无引用） |
| T2.4 | `market/{indicators,features,context,ccxt-source,derivatives}.ts`、`plan/evaluate.ts` | ADX Wilder 三重平滑且增量=全量逐点相等；四路径单位口径各有测试；未注入数据仍 UNCOVERED |
| T2.5 | `market/regime.ts`、`FeatureArchive.range()`、`trade_regime` | 分位而非拍阈值；样本 < 30 一律 `ok:false` |
| T2.6 | `config.ts`(#17)、`agents/{prompts,context}.ts`(#5)、`predictions/store.ts`(#12)、`cost-ledger.ts`(#19)、`memory/settle.ts`(#18) | 每项一个单测；#17 不自洽即抛 `StartupParamsError`；#12 只校验**绝不改写** mid |

## 明确未完成 / 阻塞项（不假装完成）

1. **真 HTX 只读对账**（§12.2 A）：`CcxtBroker` 代码与单测就绪，但缺 API key，无法验证
   `fetchBalance`/`fetchPositions`/`fetchOpenOrders` 与本地 `paper` 的真实一致性。这是进入 P3 的第一步。
2. **OKX demo key**（§12.2 B）：破坏性验收目前跑在持久化模拟 venue 上（验证的是**我方状态机**，
   不是交易所自身的幂等行为），两者不可互相替代。
3. **P1 ⑥ 预测市场专项复跑为 inconclusive**：2026-09-15 的真实样本是一批流动性 < 门槛的温度盘，
   `observedMaxChange = 0`，因此 `pm_signals_exercised` / `sample_has_real_jump` 两个**反空跑守卫**
   报 inconclusive（9/11 通过：PIT 三道闸门、薄市场 novelty=0、估计量一致、未注册 alias UNCOVERED、
   热路径 `as_of`=0 等全过）。这是行情样本问题，不是代码回归；P1 ⑥ 的历史结论由
   `docs/pm-pit-acceptance-2026-09-14.md`（11/11）保留。
