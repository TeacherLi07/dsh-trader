# HTX 凭据提供与只读预检（plan §12.2 A 第①步）

> 本文只讲**怎么做**；为什么这样设计见 `plan.md` §6.4 / §12.2 A。密钥**永不**进仓库、数据库或 prompt。

## 1. 把密钥放进 DSH 的环境层（推荐）

DSH 启动时按 **继承的 `process.env` > `$PWD/.env` > `$DSH_HOME/.env`** 三层加载，并把值物化进
`process.env`；`cordis.patch.yml` 里的 `apiKey: !!js process.env.TRADER_API_KEY` 随后读到它。

```bash
install -m 600 /dev/null ~/.dsh/.env      # 建空文件并直接给 0600
# 然后用编辑器写入两行（不要 echo，避免进 shell history）：
#   TRADER_API_KEY=<key>
#   TRADER_API_SECRET=<secret>
chmod 600 ~/.dsh/.env
```

- 变量名固定为 `TRADER_API_KEY` / `TRADER_API_SECRET`；HTX 不需要 passphrase。
- **不要**放 `/workspace/.env`：项目层随 clone 走。
- 7×24 无人值守走 systemd：`EnvironmentFile=%h/.dsh/trading.env`（同样 `chmod 600`）。
- HTX key 权限最小化：**只开交易、禁用提现、绑 IP 白名单**；`paper` 与 `live` 用不同 key。

## 2. 确认"已注入"（不泄露值）

`dsh --profile trade --dump-config` 打印的是 `!!js process.env.TRADER_API_KEY` **原文**，
不会解析、也不会显示值（已用哑值实测），因此它只能证明 patch 行在，不能证明注入。

真正证明注入的是插件的启动日志（`plugins/exec.ts`，只输出布尔）：

```
凭据状态：keyInjected=true secretInjected=true liveCapable=false route=paper（mode=paper）
```

`liveCapable=false` 是**预期的**：`mode` 仍是 `paper`，缺省不会走真实下单路由。

## 3. 第①步：只读预检（一条命令）

```bash
cd dsh-trader && pnpm build
node scripts/htx-preflight.mjs htx BTC/USDT:USDT /tmp/htx-preflight.json
```

它读 `getPositions` / `getOpenOrders` / `readOnlyBalance`，与本地库对账并输出 JSON；
**不调用** `placeOrder`/`placeProtective`/`cancelOrder`/`cancelAll`（报告里 `executedActions` 恒为空）。
退出码：`0` 读取成功、`1` 读取失败、`2` 凭据缺失。加 `--require-consistent` 可在"账户与本地不一致"时返回 1。

也可以让组合根在启动时自动跑（默认关闭）：把 `cordis.patch.yml` 的 `trade-exec.preflightEnabled`
改为 `true`，之后每次启动都会只读对账一次，并写一条 `htx_readonly_preflight` 审计事件。

**为什么第①步天然安全**：`mode` 保持 `paper`，而 `gate.ts` 对 `mode==='paper' && venue!=='paper'`
一律 `deny`（连 `reduceOnly` 也不例外，因为模式一致性属于"永远生效"的检查）。因此即使真实 broker
已接上，硬闸也会**结构性**拒绝一切下单；预检本身也只报告、不执行撤销。

首次跑通常会报"本地库没有持仓、交易所却有 N 个"——这是预期结果，**未知持仓绝不自动处理**，
需人工核对后再决定是否进入第②步。

## 4. 实测踩到的两个真 bug（已修，防止再踩）

| 现象 | 根因 | 修法 |
|---|---|---|
| `htx requires "apiKey" credential` | `CcxtBroker` 只把凭据存在自己字段里，**没有挂到 ccxt exchange 实例**上 | 构造时回填 `exchange.apiKey` |
| `htx requires "secret" credential` | ccxt 的规范字段是 **`secret`**，不是 `apiSecret`（`requiredCredentials` 里写的就是 `secret`） | 回填 `exchange.secret` |

两个 bug 单测（假 exchange）都测不出来——假 exchange 不看凭据；是**用哑值真打一次 HTX** 才暴露的。
哑值最终返回 `api-signature-not-valid / Incorrect Access key`，恰好证明"凭据确实送到了交易所并被校验"。
回归测试见 `tests/exec-ccxt-broker.test.ts`（断言 `exchange.apiKey`/`exchange.secret` 被写入、错误消息脱敏）。

## 5. 之后（不在本文范围，plan §12.2 A）

- 第②步：`paper` 模式跑通全链路（行情仍用真实公开数据）；
- 第③步：`live_confirm`（每单人工 `ask`），稳住后再评估 `live_auto`（需 §12.2 E 授权）。
