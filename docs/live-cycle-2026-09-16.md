# 首轮实盘（live_auto）监督观测（2026-09-16）

> 用户明确授权（plan §12.2 E）后以最小仓位 arm `live_auto`。本文记录首轮真实运行的可观测证据。
> 账户：HTX **USDT 永续**子账户，权益 **24.914 USDT**（只读预检读数），标的 ADA/DOGE 1h，**1× 杠杆**。

## 运行组件（均实测在跑）

| 组件 | 证据 |
|---|---|
| 交易进程 `dsh --profile trade` | 常驻（端口 3099）；`heartbeat` 每 15s 刷新，`age≈13s`、`halted=0` |
| 启动 + 周期对账 | `audit_events.kind=reconcile_report` ×16 |
| 行情 → 特征 | `bars` / `features` 有 ADA、DOGE 的 1h 已收盘 bar |
| W1 窗口调度 | `audit_events.kind=w1_wake` ×11（监督期用短窗口观察） |
| desk agent 回合 | 会话事件：`user/message → assistant/message×3–4 → tool/call×10–14 → tool/result → turn/end`，`idleMs≈10–13s` |
| 进程外 watchdog | 每 15s 一次健康检查，`action:none / reason:healthy / openOrders:0`，凭据布尔正常 |

## 首轮产出：4 条 `no_trade` 决策，**零下单**

desk agent 在窗口内对 ADA、DOGE 各判断两次，全部选择 `no_trade`（合法且常见）：

```
w1-dbg-20260916T0353Z-ada   no_trade  ADA/USDT:USDT
w1-dbg-20260916T0353Z-doge  no_trade  DOGE/USDT:USDT
w1-dbg-20260916T0354Z-ada   no_trade  ADA/USDT:USDT
w1-dbg-20260916T0354Z-doge  no_trade  DOGE/USDT:USDT
```

`plan_cards = 0`、`order_intents = 0`、`orders = 0`、`fills = 0`；交易所侧 0 持仓、0 挂单。
**结论：回路端到端跑通到"判断并落决策"，但没有产生任何真实成交。** 首单取决于模型在后续
W1 窗口是否调用 `trade_plan_card` 判出机会，以及承诺是否在下一根 1h 收盘命中。

## 监督期结束后

- W1 排期已恢复真实值（`00:30Z` / 每 4h / `23:30Z`），下一个窗口 ≤4h；
- `mode` 保持 `live_auto`；回滚只需把 `trade-exec.mode` 改回 `paper`；
- 限额（由 24.914 USDT 推导）：单笔 ≤12、总敞口 ≤24、**1×**、日亏 ≤1.25、回撤 ≤2.5、连亏 3、点差 ≤10bps、≤2 挂单。

## 会话结束后的状态（2026-09-16）

本会话定位是**开发与测试**，因此首轮观测结束后已停止常驻进程并把配置回退到开发默认：

- 交易进程与 watchdog **已停止**（端口 3099 释放，进程表无残留）；
- `trade-exec.mode` 已回退为 **`paper`**；重新 arm 只需改回 `live_auto` 一行；
- `heartbeat.halted` 复位为 0（本次从未真正下单，无需人工 `/resume`）；
- 本地库 `plan_cards`/`order_intents`/`orders`/`fills` 均为 **0**；交易所侧 0 持仓、0 挂单、权益 24.914 USDT。

## 已知的非阻塞项

- 价目表在该库为空 ⇒ `price_table_stale` 告警反复出现，成本核算退化为 token 上限（不会静默计 0）。
  停机后跑 `node scripts/seed-prices.mjs "$HOME/.dsh/trading/desk.db"` 即可补种。
- 后台进程是本会话的 job，不是 7×24 持久方式；持久运行按 `deploy/systemd/*.service` + `docs/live-runbook.md`。
