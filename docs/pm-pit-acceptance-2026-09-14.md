# 预测市场专项验收（P1 ⑥，2026-09-14）

> `node scripts/pm-pit-check.mjs 30` 产出。原始 JSON 见 `docs/pm-pit-acceptance-2026-09-14.json`。
> 判据来自 plan §10「预测市场事件源专项验收」。**真实数据 + 落库后 SQL 断言**
> （单测证明构件正确；这个脚本查的是 `triggers`/`pm_*` 表里的行数）。

## 判定

**全部 10 项检查通过（`allPassed: true`）。**

| 检查 | 判据 | 结果 |
|---|---|---|
| `existence_gate_zero_violations` | ① 不存在"市场未创建即被引用" | **0** 命中 |
| `resolution_gate_zero_violations` | ① 不存在"结算结果提前可见" | **0** 命中 |
| `pm_signals_exercised` | 非空跑：样本里真的产生过 novelty | novelty 行数 = **1** |
| `thin_market_novelty_zero` | ④ 低于流动性门槛的 novelty 数 | **0** |
| `estimator_consistent` | ③ 估计量与 payload 一致 | 不一致 = **0** |
| `unregistered_alias_uncovered` | ⑧ 未注册 alias 一律 UNCOVERED | `ok:false` + 未知取值 |
| `registered_alias_evaluates` | 注册后可求值 | `ok:true, value:true` |
| `hot_path_as_of_zero` | ⑦ 热路径 `as_of` 次数 | **0**（`asOfCalls`） |
| `token_buckets_never_negative` | ⑤ 令牌桶记账 | 无负值 |
| `series_span_covers_window` | 30 天覆盖 | **29.99 天** |

真实样本：120 个概率点 / 29.99 天 / 盘口 22 bids × 0 asks；
81 次请求、0 次重试、未降级。

## 过程中修掉的三个"会让验收假通过"的问题

1. **空跑**：第一版脚本用 `order=volume24hr` 取样本，取到的全是远期政治盘
   （日变化 ≈0.001）⇒ 规则永远不触发 ⇒ 判据 ③④ 在 **0 行** 上"通过"。
   现在脚本按 `oneDayPriceChange` 倒序挑**真的动过**的市场，并加了
   `pm_signals_exercised` 专门拦这种假通过（本次真的抓到并修掉）。
2. **没有盘口就没有概率**：轮询器原先只从 book 端点写 `mid`，于是无 orderbook 的市场
   完全没有概率；而 Gamma 元数据里本来就有 `lastTradePrice`（`estimateProbability` 的合法退化路径）。
   现在元数据里的最新成交价会一起落库。
3. **跳变窗口含糊**：plan §4.4 表写的是"超**窗口**阈值"却没规定窗口长度。
   现在显式可配（`jumpLookback: '1h' \| '24h'`），本次验收用 24h 窗口 + 3% 阈值真的触发了一次
   （实测变化 0.7215，估计量 `mid`）；实际使用的参数原样写进报告，避免"用哪套参数验的"含糊。

## 顺带确认的取值边界（更新 plan §12 #13）

- v2 `interval=1m` **实测可用且覆盖 30 天**（1441 点）⇒ 已加入白名单；
- v2 `interval=max` 本次返回 248 点/3 个月（plan 记的是"超时"）⇒ 行为**不一致**，不入白名单；
- `order=oneDayPriceChange` 是 gamma 上一个真实可用的排序字段（用它挑"动过的"样本）。
