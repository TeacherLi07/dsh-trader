# Docker 实盘运行手册

本项目采用 Docker 单进程部署：dsh 是容器主进程，容器 restart policy 负责进程存活；
**不启动、不安装、不依赖外部 watchdog**。dsh 退出后，Docker 重启同一个容器，交易状态
由启动时 `CrashRecovery → reconcile` 收敛。进入实盘前仍须按 `plan.md` §12.2 A 的顺序
完成 HTX 只读预检、`paper` 全链路和结构化确认通道检查；不要把历史 systemd/watchdog
证据当成当前运行能力。

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

将该文件作为 Docker secret/env-file 注入容器。HTX key 只开交易权限、禁用提现并绑定 IP；
`TRADER_ACCOUNT_TYPE=swap` 不要删除，除非
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

生产容器通过 secret/env 注入 `TRADER_MODE`；修改后重启唯一交易容器生效。非法模式值会被插件 Config 的 union 校验**拒绝启动**
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

容器必须满足以下部署契约：

- dsh 是 PID 1 或由等价的前台 init 承担唯一主进程；
- 配置 `restart: always`（或等价 restart policy）；
- `$DSH_HOME/trading/` 使用持久卷，不能把 SQLite/WAL 放在容器临时层；
- 不挂载、启用或 sidecar 化 `deploy/systemd/dsh-watchdog.service`；该 unit 已硬禁用。

## 1. 启动、停止、查看

启动唯一交易容器；不要再启动第二个交易/撤单进程：

```bash
docker compose up -d trade
docker compose ps trade
docker compose logs --tail=100 -f trade
```

计划内停机：

```bash
docker compose stop trade
```

恢复服务时，先看容器启动日志中的 `crash_recovery` 与 `reconcile_report`，确认交易所
账户/持仓/挂单/保护单和本地状态一致；旧的 `halted` 不会被心跳自动清除，必须人工执行
`/resume`。

## 2. 心跳与 Docker 重启恢复

主进程每个 heartbeat 周期写入 `heartbeat(id=1).beat_at`。它只用于状态面、审计和持久化
`halted` 熔断，不做 stale 超时撤单；外部 watchdog 已禁用。

容器重启后必须观察以下启动恢复顺序：

1. SQLite 打开/迁移成功；
2. 交易所账户、持仓、普通挂单和算法保护单只读重取成功；
3. `CrashRecovery` 先处理 `created` 且无 ack 的在途意图：可确认则推进，未知则标记
   `unknown` 并冻结标的；
4. `reconcile` 再处理孤儿单、未知持仓、数量不一致和无保护单；
5. 恢复/对账完成后才恢复周期任务。任何失败都要落审计并保持 fail-closed。

本地检查心跳行（需要 sqlite3 命令行工具）：

```bash
sqlite3 ~/.dsh/trading/desk.db \
  'SELECT id, beat_at, halted FROM heartbeat WHERE id = 1;'
```

`halted=1` 是熔断状态；心跳继续刷新也不会自动清除它。缺少 heartbeat 行表示尚未完成
初始化，应等待 dsh 启动恢复并查看原始错误，不能把缺失当成健康。

## 3. 人工 `/halt` 与 `/resume`

在 DSH 的命令入口发送：

```text
/halt
/resume
```

`/halt` 是人工停机动作：先持久化暂停状态，再尝试撤销全部挂单；撤单失败时保持
`halted`、落审计，必须人工在交易所核对并处理。`/resume` 只解除持久化熔断并刷新心跳，
不会自动撤单，也不会自动开仓。执行 `/resume` 前必须由人工确认：交易所挂单、持仓、
保护单和本地对账均已一致。

## 4. 确认“交易所挂单 = 0”

至少做两次独立确认：

1. 查看 dsh 重启后的 `reconcile_report`，确认普通单与算法保护单的 merged 视图一致；
2. 登录 HTX 对应的 USDT 永续账户，逐标的检查 Open Orders 页面/API；不要只看
   本地 `order_intents`，也不要把缺少 `clientOrderId` 的远端单当成不存在。

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

1. 先 `/halt`；交易所侧直接撤单时保留截图/API 回执。
2. 私有接口连续失败时进入“可平不可开”：禁止所有增加敞口的 open/非 reduceOnly 请求，
   只允许 reduceOnly 的减仓、平仓和保护单维护；不要为了恢复开仓而绕过硬闸。
3. 出现未知持仓、数量不一致、有持仓无保护单或无法证明挂单为 0 时，保持 halted，
   人工对账；必要时使用交易所原生 reduce-only 平仓入口。
4. 若主进程异常，不启动任何旁路 watchdog，也不要删除 SQLite/WAL 文件。让 Docker 按
   restart policy 重启 dsh；检查容器启动日志中的恢复/对账审计，以及 key 权限、代理、
   HTX 永续账户类型和网络后再决定是否 `/resume`。

降级期间仍要记录失败原文、时间、交易所回执和 audit 序号。任何“恢复交易”都必须由
人工确认；系统不会因为心跳恢复、服务重启或取消一次成功而自动执行 `/resume`。
