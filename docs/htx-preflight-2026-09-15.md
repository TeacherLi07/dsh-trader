# HTX 只读预检实测（plan §12.2 A 第①步，2026-09-15）

> 命令（凭据在 `$DSH_HOME/.env`，0600；用 Node 自带 env-file 解析器，与 DSH 同源）：
>
> ```bash
> cd dsh-trader && pnpm build
> node --env-file="$HOME/.dsh/.env" scripts/htx-preflight.mjs htx BTC/USDT:USDT /tmp/htx-preflight.json
> ```
>
> 原始 JSON（含账户余额）留在 `/tmp`，**未入库** —— 不把账户数据写进 git。

## 三轮实测：①错误子账户 → ②正确子账户但读到现货 0 → ③修正后读到永续余额

| 轮 | 现象 | 结论 |
|---|---|---|
| ① 错误子账户 | 认证成功，equity ≈ 0.68 USDT | key 不是要用的子账户 |
| ② 正确子账户 | 认证成功，`EquityQuote = 0` | ★ **误报**：默认读到的是**现货账户** |
| ③ 修正 `accountType=swap` | 认证成功，**equity = 24.914 USDT**（`free`，无持仓无挂单） | 真实可用余额在 **USDT 永续账户** |

### ★ 抓到的真 bug（已修）：HTX 现货与永续是两个账户

`fetchBalance()` 不指定 `type` 时读到的是现货账户；策略跑 `BTC/USDT:USDT` 永续，现货通常是 0。
后果不是"显示错误"而是**决策错误**：`equity=0` 会让 sizing 推出 `qty=0`、`projectedLeverage` 失去意义，
系统会**以为没钱**（或反过来在别的口径上失真）。

修法（commit 见下）：

- `CcxtBrokerOptions.accountType`（如 `'swap'`），`getAccount()`/`readOnlyBalance()` 都带上 `fetchBalance({type})`；
- 组合根/脚本构造 exchange 时同时设 `defaultType`，让行情与持仓解析也落在永续账户；
- `cordis.patch.yml` 增 `accountType: swap`；脚本可用 `TRADER_ACCOUNT_TYPE` 覆盖；
- 回归测试断言 `fetchBalance` 收到 `{type:'swap'}`（未配置时收到 `{}`，不猜）。

实测旁证：同一把 key，`fetchBalance({type:'swap'})` 与 `{type:'future'}` 均返回 24.914，
默认/`spot` 为 0。

## 判定

- 第①步（只读）✅：私有端点认证成功、读到真实永续余额、`executedActions=[]`。
- ⚠️ 该次 `consistent=true` 仍是**平凡一致**（交易所与本地两侧都是 0 持仓/0 挂单），
  非空验证到的是"把永续账户读对了、只读链路可用"，不是对账判定本身。
- 余额 24.914 USDT 是后续所有风险限额的**唯一事实来源**（见 `plan.md` §6.5：参数不写死）。
