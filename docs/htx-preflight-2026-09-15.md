# HTX 只读预检实测（plan §12.2 A 第①步，2026-09-15）

> 命令（凭据放在 `$DSH_HOME/.env`，0600；用 Node 自带的 env-file 解析器加载，与 DSH 同源）：
>
> ```bash
> cd dsh-trader && pnpm build
> node --env-file="$HOME/.dsh/.env" scripts/htx-preflight.mjs htx BTC/USDT:USDT /tmp/htx-preflight.json
> ```
>
> 原始 JSON（含账户权益）留在 `/tmp/htx-preflight.json`，**未入库** —— 避免把账户数据写进 git。

## 结果：exit 0，第①步通过

| 项 | 值 |
|---|---|
| 私有端点认证 | ✅ 成功（`fetchBalance`/`fetchPositions`/`fetchOpenOrders` 均返回） |
| 账户权益 | ✅ 读到（余额不足 1 USDT，远低于 `perOrderCapUsd=200`） |
| 交易所持仓 / 挂单 | 0 / 0 |
| 本地挂单 / 持仓 | 0 / 0 |
| `consistent` | true（**平凡一致**，见下） |
| `freezeTrading` | false |
| `executedActions` | `[]`（只读保证成立：脚本不调用 place/cancel） |

## ⚠️ 诚实说明：这次"对账一致"是**平凡**的

交易所与本地**两边都是 0**，所以 `consistent: true` 并不构成"对账逻辑正确"的证据 ——
它只说明没有不一致可报。这一步**非空验证到的是"认证与私有读链路可用"**（余额确实来自 HTX），
不是对账判定本身。等账户有持仓/挂单（第②/③步产生）之后再跑，`consistent` 才有非平凡含义。

这与项目一贯的反空跑纪律一致：分母为 0 时不下"通过"的结论。

## 对下一步的影响

- 第①步（只读）✅，可以进入第②步（`paper` 全链路，用真实公开行情，不需要入金）。
- 第③步（`live_confirm`）之前需要**入金**：当前余额连一笔最小名义额都撑不起
  （`qty = equity × riskPct ÷ 止损距离`，且 `perOrderCapUsd=200`）。不入金只会得到一堆
  sizing/硬闸拒绝，属于"看起来在跑"的坏状态。
- `live_auto`（§12.2 E）还要 `plan.md` §10 P3 连续 14 天的判据。
