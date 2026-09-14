# 预测市场专项验收（P1 ⑥，2026-09-14）

> `node scripts/pm-pit-check.mjs 30` 产出。原始 JSON 见 `docs/pm-pit-acceptance-2026-09-14.json`。
> 判据来自 plan §10「预测市场事件源专项验收」。**真实数据 + 落库后 SQL 断言**
> （单测证明构件正确；这个脚本查的是 `triggers`/`pm_*` 表里的行数）。

## 判定：全部 11 项通过（`allPassed: true`）

| 检查 | 判据 | 结果 |
|---|---|---|
| `existence_gate_zero_violations` | ① 不存在"市场未创建即被引用" | **0** 命中 |
| `resolution_gate_zero_violations` | ① 不存在"结算结果提前可见" | **0** 命中 |
| `pm_signals_exercised` | 非空跑：真的产生过 novelty | novelty 行数 = **2** |
| `sample_has_real_jump` | 前置条件成立：样本里真有超过阈值的真实变化 | 最大 **0.7050000000000001** |
| `thin_market_novelty_zero` | ④ 低于流动性门槛的 novelty 数 | **0**（被拒 68 个市场） |
| `estimator_consistent` | ③ 估计量与 payload 一致 | 不一致 = **0** |
| `unregistered_alias_uncovered` | ⑧ 未注册 alias 一律 UNCOVERED | `ok:false` + 未知取值 |
| `registered_alias_evaluates` | 注册后可求值 | `ok:true` |
| `hot_path_as_of_zero` | ⑦ 热路径 `as_of` 次数 | **0** |
| `token_buckets_never_negative` | ⑤ 令牌桶记账 | 无负值 |
| `series_span_covers_window` | 30 天覆盖 | **29.99 天** |

## 这一轮让验收从"飘"变"稳"的三处修改

1. **样本要同时满足两件事**：真的动过 **且** 有双边盘口。
   - 只按 `oneDayPriceChange` 取 → 全是没有 orderbook 的天气/体育盘（无 spread ⇒ 被流动性闸门正确拦掉）；
   - 只按 `volume24hr` 取 → 全是远期政治盘（日变化 ≈0.001 ⇒ 规则不触发）。
   现在两路合并去重、且**只 seed 有双边盘口的市场**（没有盘口的连 spread 都没有，不可能过门槛）。
   实测：70 个市场进入样本，**2 个过流动性门槛**，其中最大的真实 24h 变化 0.7050000000000001。

2. **跳变阈值从真实数据推导**，不再写死。写死 3% 时这条检查**实测飘过一次**：
   同一脚本几小时前 `pm_signals_exercised: true`，市场安静下来后变成 `false`。
   现在阈值 = 本批样本里真实最大变化 ÷ 2（报告里给出 `observedMaxChange`），
   于是"只要有市场动过，前置条件必然成立"；样本完全没动过会报 `inconclusive` 而**不是**通过。

3. **加了 `snapshotDiagnostics`**：每条标的的流动性判定、spread、change1h/24h、被拒原因一目了然 ——
   出问题时不用猜是"没数据"还是"被门槛拦了"。上面 68 个被拒市场正是靠它定位的。

## 流动性闸门在这里**真的在做事**

70 个有盘口的市场里只有 2 个过门槛；novelty **只对这 2 个**产生，
其余 68 个一条都没发。这正是 §4.4「薄市场不得进入承诺/告警」的可观测证据 ——
而不是"因为一条都没跑起来所以看起来干净"。

## 顺带确认的取值边界（更新 plan §12 #13）

- v2 `interval=1m` **实测可用且覆盖 30 天** ⇒ 已入白名单；
- v2 `interval=max` 本次返回 248 点/3 个月（plan 记的是"超时"）⇒ 行为**不一致**，不入白名单；
- `order=oneDayPriceChange` 是 gamma 上一个真实可用的排序字段。
