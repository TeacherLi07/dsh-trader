# 实盘运行手册

本手册只描述已落地的 systemd、heartbeat 和只读/撤单路径。进入实盘前仍须按
`plan.md` §12.2 A 的顺序完成 HTX 只读预检、`paper` 全链路和人工确认档；不要因为
unit 能启动就把 `live_auto` 当成已获授权。

## 0. 部署前检查

先在项目目录构建，脚本会从 `lib/` 导入：

```bash
cd /workspace/dsh-trader
pnpm install --frozen-lockfile
pnpm build
```

复制环境文件到仓库外，填写真实值后收紧权限：

```bash
install -d -m 700 ~/.dsh
install -m 600 deploy/systemd/dsh-trader.env.example ~/.dsh/trading.env
$EDITOR ~/.dsh/trading.env
chmod 600 ~/.dsh/trading.env
```

HTX key 只开交易权限、禁用提现并绑定 IP；`TRADER_ACCOUNT_TYPE=swap` 不要删除，除非
已经明确要读另一种账户。环境文件、命令行和日志中都不要出现 key/secret。

### 运行模式在**启动时**决定（不在仓库里写死）

`cordis.patch.yml` 里 `trade-exec.mode` 读的是启动环境变量 `TRADER_MODE`，**未设即 `paper`**：

```bash
# 纸面（默认；不触网下单）
cd /workspace/dsh-trader && pnpm build
TRADER_MODE=paper dsh --profile trade

# 无人值守实盘（会下真单；需已按 plan §12.2 A/E 完成授权）
TRADER_MODE=live_auto dsh --profile trade
```

生产走 systemd 时写在 `~/.dsh/trading.env`（`EnvironmentFile`）里的 `TRADER_MODE`，改完
`systemctl restart dsh-trader` 生效。非法模式值会被插件 Config 的 union 校验**拒绝启动**
（不会静默退回 paper，避免"以为在实盘、其实在纸面"）。

先执行 §12.2 A 的只读步骤，确认私有端点、永续账户和本地状态都能读到；该命令不下单、
不撤单：

```bash
cd /workspace/dsh-trader
node --env-file="$HOME/.dsh/trading.env" scripts/htx-preflight.mjs \
  htx BTC/USDT:USDT /tmp/htx-preflight.json --require-consistent
```

判定看退出码和 JSON：退出码 0、`report.readOnly=true`、`report.executedActions=[]`；
若是首次接入且本地/远端不一致，停在这里人工核对，不要用 `--require-consistent` 失败
当作“可以忽略”。

安装 unit 前检查两个 unit 中的 `User`、`WorkingDirectory`、Node 路径、`dsh` 路径和
数据库路径；当前示例默认用户为 `ubuntu`，并使用 `/workspace/dsh-trader`。

```bash
sudo install -m 644 deploy/systemd/dsh-trader.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/dsh-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## 1. 启动、停止、查看

启动时先启动交易进程，再启动 watchdog；watchdog 的 `After=` 只规定启动顺序，未绑定
交易进程生命周期：

```bash
sudo systemctl enable --now dsh-trader.service
sudo systemctl enable --now dsh-watchdog.service
systemctl status dsh-trader.service --no-pager
systemctl status dsh-watchdog.service --no-pager
```

查看最近日志或实时跟踪：

```bash
journalctl -u dsh-trader.service -n 100 --no-pager
journalctl -u dsh-watchdog.service -n 100 --no-pager
journalctl -fu dsh-watchdog.service
```

计划内停机时不要先停 watchdog。先停交易进程，等 watchdog 报告撤单成功且挂单计数为
0，再停 watchdog：

```bash
sudo systemctl stop dsh-trader.service
journalctl -fu dsh-watchdog.service
# 看到 cancelSucceeded=true、halted=true、openOrders=0 后执行：
sudo systemctl stop dsh-watchdog.service
```

恢复服务时，先确认交易所账户，再启动 trader/watchdog；旧的 `halted` 不会被心跳自动
清除，必须人工执行 `/resume`。

## 2. 心跳与 watchdog 判据

完整语义以 `plan.md` §6.3 为准，这里只列运行时判定。主进程每个 heartbeat 周期写入
同一 SQLite 的 `heartbeat(id=1).beat_at`；watchdog 使用 `now - beat_at > multiple ×
interval`，默认是 `3 × 5000ms = 15000ms`，严格大于阈值才算 stale。

watchdog 每轮至少输出如下字段：

```json
{"action":"none","reason":"healthy","openOrders":0,"halted":false}
```

超时或缺少心跳时，预期为 `action="halt_cancel"`，随后撤单成功的结果必须包含
`cancelAttempted=true`、`cancelSucceeded=true`、`halted=true`；成功后再次读到
`openOrders=0` 才能把“交易所挂单为 0”作为本轮的可计算证据。`reason` 应为
`stale_heartbeat` 或 `missing_beat`。

撤单失败时预期为 `cancelSucceeded=false`、`halted=false`，同时有告警/审计；不要手工
把它解释成安全完成，常驻进程会在下一轮重试。watchdog 只输出
`keyInjected`/`secretInjected` 布尔值，不输出凭据。

本地检查心跳行（需要 sqlite3 命令行工具）：

```bash
sqlite3 ~/.dsh/trading/desk.db \
  'SELECT id, beat_at, halted FROM heartbeat WHERE id = 1;'
```

`halted=1` 是熔断状态；心跳继续刷新也不会自动清除它。缺少 heartbeat 行不是健康，
而是 `missing_beat` 输入，应等待 watchdog 完成撤单并落库。

## 3. 人工 `/halt` 与 `/resume`

在 DSH 的命令入口发送：

```text
/halt
/resume
```

`/halt` 是人工停机动作：暂停自动交易并尝试撤销全部挂单；撤单失败时保持告警并由
外部 watchdog 兜底。`/resume` 只解除持久化熔断并刷新心跳，不会自动撤单，也不会
自动开仓。执行 `/resume` 前必须由人工确认：交易所挂单、持仓、保护单和本地对账均已
一致。恢复责任永远在人，不由 watchdog 或心跳自动恢复。

## 4. 确认“交易所挂单 = 0”

至少做两次独立确认：

1. 查 watchdog 最近一条 JSON：`openOrders=0` 且撤单结果为成功；
2. 登录 HTX 对应的 USDT 永续账户，逐标的检查 Open Orders 页面/API 为 0；不要只看
   本地 `order_intents`，也不要把缺少 `clientOrderId` 的远端单当成不存在。

如需重新执行一次检查，先确保环境文件已加载；这会触碰真实交易所的只读挂单查询，
并在 stale 时执行撤单：

```bash
set -a; . ~/.dsh/trading.env; set +a
cd /workspace/dsh-trader
node scripts/watchdog-daemon.mjs --once --db="$HOME/.dsh/trading/desk.db"
```

退出码 `0` 表示本次检查完成且撤单（如有）成功；`2` 表示凭据缺失；`1` 表示参数、
网络、审计、撤单或核验失败。退出码为 0 仍要看 JSON 的 `halted`、`cancelSucceeded`
和 `openOrders`，不能只看 systemd 的绿色状态。

## 5. 每日运营检查

每天按 UTC 日检查指标，至少保留当天的覆盖率、W2/W3 频次、成本和对账不一致数：

- 覆盖率：计划池中仍有 active 计划卡的标的数 / 计划池大小；分母必须大于 0，另记
  `asOf` 时刻。
- W2/W3：分别看 `judgment` / `novelty` 的实际消耗数，同时看被 cooldown、rate-limited
  的数量；确认没有悄悄超出日上限。
- 成本：看 `budget_ledger` 各 scope 的 USD、token 和 `costKnown`；成本未知不是零成本，
  需要补价目表并告警。
- 对账：看启动/周期对账的孤儿挂单、未知持仓、数量不一致、无保护单数量；期望值是
  **不一致数 = 0**。未知持仓或有仓无保护单属于冻结级问题。

项目已提供 `MetricsStore`，可在构建后用一段只读 Node 命令输出当天完整 JSON（命令在
项目根执行；标的池要替换成配置中的真实值）：

```bash
cd /workspace/dsh-trader
node --input-type=module -e '
import Database from "better-sqlite3";
import { dailyMetricsAt, MetricsStore } from "./lib/supervisor/metrics.js";
const db = new Database(process.env.DSH_TRADER_DB ?? process.env.HOME + "/.dsh/trading/desk.db", { readonly: true });
const at = Date.now();
console.log(JSON.stringify(dailyMetricsAt(new MetricsStore(db), at, { symbols: ["BTC/USDT:USDT"] })));
db.close();
'
```

同时在审计/对账查询中统计当天 `inconsistency` 事件，不能用“没有记录”代替查询成功；
网络或字段缺失要作为未知并人工处理。

对账动作统一落在 `reconcile_action` 审计事件，可用下面的只读查询得到当天不一致动作数；
期望命中行数为 0（`reconcile_failed` 另行视为故障）：

```bash
sqlite3 ~/.dsh/trading/desk.db \
  "SELECT kind, COUNT(*) FROM audit_events
   WHERE kind IN ('reconcile_action', 'reconcile_failed')
     AND ts >= CAST(strftime('%s','now','start of day') AS INTEGER) * 1000
   GROUP BY kind ORDER BY kind;"
```

## 6. 出事时的降级路径

1. 先 `/halt`，并确认 watchdog 仍在运行；交易所侧直接撤单时保留截图/API 回执。
2. 私有接口连续失败时进入“可平不可开”：禁止所有增加敞口的 open/非 reduceOnly 请求，
   只允许 reduceOnly 的减仓、平仓和保护单维护；不要为了恢复开仓而绕过硬闸。
3. 出现未知持仓、数量不一致、有持仓无保护单或无法证明挂单为 0 时，保持 halted，
   人工对账；必要时使用交易所原生 reduce-only 平仓入口。
4. 若主进程异常，保持 `dsh-watchdog.service` 活着；不要先停 watchdog，也不要删除
   SQLite/WAL 文件。检查 key 权限、代理、HTX 永续账户类型和网络后再重试。

降级期间仍要记录失败原文、时间、交易所回执和 audit 序号。任何“恢复交易”都必须由
人工确认；系统不会因为心跳恢复、服务重启或取消一次成功而自动执行 `/resume`。
