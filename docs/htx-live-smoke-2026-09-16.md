# HTX 真实首单 + 交易功能全链路冒烟（2026-09-16）

> `node --env-file=$HOME/.dsh/.env scripts/htx-live-smoke.mjs --execute ADA/USDT:USDT`
> 原始 JSON：`docs/htx-live-smoke-2026-09-16.json`。
>
> 这是**受监督的真实资金**验证（plan §12.2 A 第③步的 live_confirm 语义），标的 ADA/USDT:USDT 永续，
> **最小 1 张 = 10 ADA ≈ 1.94 USDT 名义**，账户权益约 24.9 USDT。脚本带 `finally` 强制清理
> （撤单 + 平仓），失败也会把账户拉回空仓。

## 判定：18/18 步全通过（`allPassed: true`，exit 0）

| 步骤 | 结果 |
|---|---|
| `getAccount` / `getPositions` / `getOpenOrders` 只读预检 | ✅ 权益 24.9055、空仓、0 挂单 |
| 空仓守卫（非空仓拒绝继续，不干扰既有仓位） | ✅ |
| **开仓**：市价买 1 张 | ✅ `filled`，avgPrice=0.194456，fee=0.0011667 |
| `findOrderByClientOrderId`（按交易所订单号） | ✅ 查到 `filled` |
| `getPositions` 反映出持仓 | ✅ qty=10 ADA |
| **挂保护单（止损 sl）** | ✅ exchangeOrderId=1549862278635917312 |
| **挂保护单（止盈 tp）** | ✅ exchangeOrderId=1549862337208471552 |
| **撤单 `cancelOrder`（算法单）** | ✅ 撤后挂单 0 |
| **`cancelAll`** | ✅ 挂单 0 |
| **平仓**：reduceOnly 市价 | ✅ `filled`，持仓归 0 |
| 终态：持仓 0 / 挂单 0 | ✅ |
| 强制清理（finally） | ✅ `cancelAll:true, flattened:true` |

交易所侧复核：权益 **24.9044 USDT**、0 持仓、0 挂单。5 轮往返（含此前失败轮）合计成本约
**0.0056 USDT**（手续费+滑点），与"最小仓位"预期一致。

## ★ 这次冒烟抓到并修掉的 4 个实盘缺陷（单测测不出）

1. **市价单成交不回填**：HTX `createOrder` 的响应是 open/new，`CcxtBroker.placeOrder` 直接返回
   `state:'acked'`。后果不是显示问题：`execute-action` 只在 `filled` 时记 fill/登记结算/挂保护单，
   于是一笔真实成交被当成"没成交"。→ 新增**有界轮询** `#awaitFill`（默认 6×700ms，可配）。
2. **算法保护单缺 `position_side`**：HTX 直接拒（code 1067 `position_side field is invalid`），
   保护单**永远挂不上** —— 而"有持仓无保护单"是 P0 不一致。→ `CcxtBrokerOptions.positionSide`
   （默认 `both`），贯通 runtime/插件/`cordis.patch.yml`。
3. **算法单撤不掉**：`cancelOrder` 走普通端点报 `not.found`。→ 按 `{stopLossTakeProfit}` /
   `{trigger}` / `{trailing}` 逐个尝试，全 miss 才报错。
4. **算法挂单看不见**：`getOpenOrders` 只查普通挂单，HTX 的 sl/tp 在 `/v5/algo/*`。→
   `#fetchOpenOrdersMerged()` 合并普通 + 算法挂单（仅 HTX）。

## ★ 两条**平台限制**（不是我们的 bug，但影响设计，必须记住）

1. **HTX 不采用我们传的 `clientOrderId`**：ccxt 用 `safeIntegerN` 解析（证明是数字字段），实测交易所
   把 `client_order_id` **生成为订单号本身**，算法单甚至不回填。⇒ **"按自己的 clientOrderId 查回来"
   在 HTX 上不可用**；崩溃恢复对"未 ack 的在途意图"只能判 unknown + 冻结（fail-closed，安全）。
   本地幂等不受影响（`order_intents.client_order_id` 唯一键仍在）。
2. **`ccxt` 的 HTX `fetchOpenOrders` 不返回算法单**：所以 `getPositions().protectedStopPrice`
   在 HTX 上**看不到**交易所侧保护单。⇒ 对账的"有持仓无保护单"在 HTX 上会**误报**；当前靠本地
   journal 里的保护单意图兜底，接线属后续工作（已在 plan §12.2 记为待办）。

## 复现

```bash
cd dsh-trader && pnpm build
node --env-file="$HOME/.dsh/.env" scripts/htx-live-smoke.mjs --execute ADA/USDT:USDT /tmp/smoke.json
# 不加 --execute 时只做只读预检，不下任何单
```
