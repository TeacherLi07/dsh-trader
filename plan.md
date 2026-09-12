# dsh-trader 实施计划

> **定位**：本文只写「做什么、怎么做、怎么验收」。
> **为什么这样做、证据、被否决的选项** → `docs/decision.md`（原 `docs/dsh-crypto-trading-agent-plan.md`，全文保留，下称 decision）。
> **标记**：`[定]` 已决定 · `[v0]` 本文给出的最小可用定义，实现中可改（改动记 ADR） · `[开]` 未决，须在标注阶段前关闭（§12）。

---

## 0. 目标 / 非目标

**目标**：7×24 无人值守的 crypto 交易 agent。`non-human in the loop` + 全量可审计；先接 HTX；单进程常驻；崩溃可恢复；止损不依赖 LLM。

**非目标（本计划不做）**：股票/多交易所套利；高频（<1s）；跨语言数值分析（P2+ 再评估）；容器化（P3 评估）；社媒情绪（注入风险，暂不做）。

---

## 1. 七条红线 `[定]`

1. **判断用 LLM，执行用代码**。盘中不唤醒 LLM，只有 W1/W2/W3（§2）。
2. **判断只发生在窗口内、敞口打开之前**，产物是计划卡（§3）。
3. **止损/止盈走交易所侧条件单或插件硬闸**；上下文里的持仓只用于"理解"，不用于"计算"。
4. **权威状态在交易所 + SQLite**，context 是可丢弃的视图；**不可重建的东西一个字都不丢**（§5）。
5. **模型输出不得成为决策的唯一真相来源**：反思只在外部结算后写，且带证据指针（§5.3）。
6. **硬性风控在代码里**（§6.2），模型没有豁免通道。
7. **新增任何 LLM 调用点，必须先回答"为什么不能是条件与逻辑"**；答不上来就不加。

---

## 2. 唤醒规则 `[定]`

agent 默认 idle，**无新信息不唤醒（零 token）**。只有三类唤醒理由：

| # | 触发条件 | 默认上限 | 判定者 | 注入内容 |
|---|---|---|---|---|
| **W1** | 审议窗到点 | 3/天（`00:30Z`、每 4h、`23:30Z`） | 时间 | Event Pack + 状态 + 记忆 |
| **W2** | 条件命中且**计划卡未覆盖** | 3/时、8/天 | 代码 | Event Pack（含 `uncovered_condition`） |
| **W3** | 结构化新颖性信号 | 2/时、6/天、且预算内 | 代码（**模型不能自判**） | Event Pack（明示"计划外，可 `NO_TRADE`"） |

- W3 信号白名单：交易所/预言机状态异常、单 bar > k·ATR、资金费率越极端分位、清算量破历史分位、稳定币脱锚、白名单新闻源高危关键词。
- 超限一律**落库 + 告警**，不唤醒。
- 规则命中后的分流：命中承诺 → 执行（不唤醒）；`invalidation` → 执行降险（不唤醒）；`novelty` → W3；`info` → 只落库；其余 → 仅当 W2 成立才入队。
- agent 忙时不打断，只入队；仅 P0（持仓风险）允许 `steer()`。

**可观测指标（P1 起每日输出）**：计划覆盖率 = `matched / (matched + uncovered)`；W2、W3 频次；每窗口 token 与费用。**W2 频繁 ⇒ 计划写得太粗，先改计划，不是加 LLM。**

---

## 3. 计划卡 v0 `[v0]`

decision 刻意没有锁字段；本节补齐，作为 P0 的实现依据。**要点：模型给"判断与方法"，代码给"数字"。**

### 3.1 形状（存 `plan_cards.card_json`）

```jsonc
{
  "planId": "pc-btcusdt-20250115T0030Z-7f3a",   // 新版本 = 新 id
  "symbol": "BTC/USDT:USDT",
  "createdAt": 1736901000000,
  "windowEndsAt": 1736915400000,                 // 到期即失效，命中走 UNCOVERED
  "thesis": "……",                                // 散文，只供复盘引用，不参与判定
  "confidence": 0.62,
  "keyLevels": [{ "kind": "support", "price": 61200 }],
  "invalidation": [
    { "id": "inv-1", "tf": "15m", "when": "crossBelow(bar.close, 61200)",
      "then": { "action": "reduce", "fraction": 0.5 } }
  ],
  "commitments": [
    { "id": "c-1", "seq": 1, "tf": "15m", "when": "bar.close < 61200 and position.qty > 0",
      "then": { "action": "reduce", "fraction": 0.5, "method": "market" },
      "maxSlippageBps": 15, "cooldownMs": 900000 }
  ],
  "forbidden": ["open"],                          // 本窗口禁则
  "noTrade": false,
  "contentHash": "sha256:…", "author": "model", "authority": "model"
}
```

四条不可协商性质：**可判定**（②③ 必须能被代码求值）· **有期限**（窗口结束即失效）· **幂等根**（`contentHash` + 唯一 id）· **不可事后改写**（冻结；修正产出新 `planId`，旧版留档）。

**同一时刻每个标的恰有一张 active 计划卡**（由 §4.1 的部分唯一索引强制）；旧卡转 `superseded`/`expired` 只读归档。

### 3.2 `when` 表达式 DSL `[v0]`

```
值   := 数字
      | position.qty | position.avgPrice | position.unrealizedPnl | equity.quote
      | price.last | bar.open|high|low|close|volume
      | atr(tf,n) | ema(tf,n) | rsi(tf,n) | adx(tf,n) | vwap(tf) | zscore(tf,n)
      | vol.realized(tf,n) | oi.changePct(n) | liq.notional(windowMs)
      | funding.rate | basis.bps | plan.ageMs | window.sinceMs
运算 := 值 ( + | - | * | / ) 值 | 值 ( < | <= | > | >= | == | != ) 值
      | ( 表达式 ) | not 表达式 | 表达式 ( and | or ) 表达式
函数 := crossAbove(a,b) | crossBelow(a,b) | between(x,a,b) | abs(x) | min(a,b) | max(a,b) | pct(a,b)
```

规则：**取值与运算都是数值/布尔，DSL 没有字符串**；时间框架由承诺自带的 `tf` 字段声明（`tf ∈ {1m,15m,1h,4h,1d}`，在该 tf 的每根已收盘 bar 上求值一次），因此表达式里**不允许**出现 `bar.tf`。`n ≤ 500`；**禁止**赋值/循环/字符串/任意属性访问/网络/时间函数；**只用已收盘 bar**。`crossAbove`/`crossBelow` 需要前一根 bar，由特征层提供。

**求值契约**：`evalWhen(expr, ctx) → {ok:true, value:boolean} | {ok:false, reason}`。返回 `ok:false` 时**记为 UNCOVERED 并告警，绝不静默当作 false**。默认 **edge 触发**（false→true 各触发一次）；需要电平语义的用 `between`/显式条件表达。解析与求值实现为零依赖纯函数，单测覆盖每个算子与每个错误分支（P0 门禁：表达式编译成功率 100%）。

### 3.3 动作词汇表（封闭枚举，`then.action`）

| action | 模型给 | 代码推导 / 校验 |
|---|---|---|
| `noop` | — | — |
| `open` | `side`、`method`(market/limit)、`stop{method:atr\|structure, k?\|level?}`、`target{rMultiple?}`、`riskPct?` | `qty`、`stop_price`、`take_profit`（§3.4）；精度/最小额/敞口校验 |
| `reduce` | `fraction ∈ (0,1)` | `qty = position.qty × fraction` |
| `close` | — | 全平 + `cancelAll(symbol)` |
| `set_stop` / `set_target` | 价格或方法 | 交易所侧条件单，`reduceOnly` |
| `set_trailing` | `percent` | 需 `trailingTriggerPrice`（HTX） |
| `cancel_all` | `scope: symbol\|all` | — |
| `halt` | — | 置 halted，禁止新开仓 |
| `escalate` | `reason` | 记 `REVIEW` + 告警，**不下单** |

模型**不能**给 `qty`、`price`、`stop_price` 的绝对数字（`set_stop/set_target` 的显式价位除外，且仍需过硬闸）。

### 3.4 仓位与保护位由代码推导 `[v0]`

```
stopDistance = |entry - stop|                       # stop 由 stop.method 推导（ATR×k 或结构位）
riskQuote    = equity.quote × riskPct               # riskPct 来自启动参数（§6.5），不在代码里写死
qty          = riskQuote / stopDistance
qty          = floorToStep(qty, market.limits.amount.min, market.precision.amount)
notional     = qty × entry
拒绝条件：notional < market.limits.cost.min | notional > perOrderCapUsd | 止损距离为 0
成本下限：expectedMoveToTarget × qty > fees + expectedFunding + expectedSlippage，否则 deny
```

`entry` 为市价时取执行前重取的盘口中间价（§6.2），限价时取 `limitOffsetBps` 推导。

### 3.5 匹配与优先级（每根 bar 收盘、每个标的）

```
onBarClose(symbol, barTs):
  plan = activePlan(symbol)                          # 唯一索引保证 ≤1
  if plan == null or now > plan.windowEndsAt: markExpired(); return
  # 优先级 1：失效条件 → 直接降险，不唤醒
  for inv in plan.invalidation:
      if hit(inv.when, symbol, barTs): executeRiskDown(inv.then, reason=inv.id); return
  # 优先级 2：承诺 → 直接执行，不唤醒
  for c in plan.commitments order by seq:
      r = evalWhen(c.when, ctx)
      if !r.ok: markUncovered(c.id, r.reason, symbol, barTs); continue
      if r.value and not fired(plan.planId, c.id, barTs):
          markFired(); execute(c.then, reason=c.id); return
  # 优先级 3：规则引擎命中
  for h in ruleHits(symbol, barTs):
      if h.matchedCommitment: execute(...); return
      if h.purpose == 'novelty': enqueueW3(h); return
      if h.purpose == 'info': persist(h); continue
      enqueueW2(h)                                   # 计划未覆盖
```

- `fired` 去重键 = `hash(planId, commitmentId, symbol, barTs)`。
- 硬闸拒绝执行时：记审计事件 + 降级（`halt` 或告警），**不改写计划卡**。

### 3.6 提示注入

外部文本一律作为**数据块**注入并标注来源与"不可信"；工具描述与系统提示词中**禁止出现**"等待用户输入/一次完成任务"这类单流 agent 的暗示（decision §2.3），实现时逐条审阅并改写。

---

## 4. 数据与持久化 `[v0]`

单一 SQLite（`$DSH_HOME/trading/desk.db`，WAL）。全部写入走事务；markdown 只作只读审计产物。

### 4.1 DDL（关键表与约束）

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;

CREATE TABLE bars(                                    -- 只存已收盘 bar
  symbol TEXT, timeframe TEXT, open_time INTEGER, close_time INTEGER,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  source TEXT, fetched_at INTEGER, PRIMARY KEY(symbol,timeframe,open_time)) WITHOUT ROWID;

CREATE TABLE features(                                -- 每根 bar 收盘的特征快照（增量维护）
  symbol TEXT, timeframe TEXT, open_time INTEGER, snapshot_json TEXT, fingerprint TEXT,
  PRIMARY KEY(symbol,timeframe,open_time)) WITHOUT ROWID;

CREATE TABLE plan_cards(
  plan_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN('active','expired','superseded')),
  window_ends_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  card_json TEXT NOT NULL, content_hash TEXT NOT NULL, UNIQUE(plan_id, content_hash));
CREATE UNIQUE INDEX plan_one_active_per_symbol ON plan_cards(symbol) WHERE status='active';

CREATE TABLE decisions(
  decision_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL UNIQUE,   -- 幂等根
  symbol TEXT NOT NULL, plan_id TEXT, decided_at INTEGER NOT NULL,
  context_hash TEXT NOT NULL, data_fingerprint TEXT, model_route TEXT,
  action TEXT NOT NULL CHECK(action IN('open','reduce','close','set_stop','set_target',
        'set_trailing','cancel_all','halt','noop','no_trade','review')),
  size_qty REAL, stop_price REAL, take_profit REAL, confidence REAL,
  rationale TEXT, risk_notes TEXT, authority TEXT NOT NULL DEFAULT 'model',
  executed INTEGER NOT NULL DEFAULT 0, reflection_due_at INTEGER, outcome_id TEXT);

CREATE TABLE order_intents(                           -- 唯一闸门：校验通过才写入
  intent_id TEXT PRIMARY KEY, client_order_id TEXT NOT NULL UNIQUE,  -- 幂等键
  decision_id TEXT REFERENCES decisions(decision_id), venue TEXT NOT NULL, symbol TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('created','acked','rejected','unknown','canceled','filled')),
  type TEXT, side TEXT, qty REAL, price REAL, stop_price REAL, reduce_only INTEGER DEFAULT 0,
  params_json TEXT, created_at INTEGER NOT NULL, acked_at INTEGER, exchange_order_id TEXT);

CREATE TABLE orders(
  order_id TEXT PRIMARY KEY, venue TEXT NOT NULL, exchange_order_id TEXT,
  client_order_id TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL,
  qty REAL, filled_qty REAL DEFAULT 0, avg_price REAL, updated_at INTEGER NOT NULL,
  UNIQUE(venue, exchange_order_id));

CREATE TABLE fills(
  fill_id TEXT PRIMARY KEY, order_id TEXT REFERENCES orders(order_id),
  qty REAL NOT NULL, price REAL NOT NULL, fee REAL, fee_ccy TEXT, ts INTEGER NOT NULL,
  UNIQUE(order_id, ts, qty));                          -- 交易所重复推送兜底

CREATE TABLE lessons(                                  -- 一条决策至多一条反思
  lesson_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL, regime_bucket TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER);

CREATE TABLE triggers(
  trigger_id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, symbol TEXT,
  rule_id TEXT, purpose TEXT NOT NULL, bar_ts INTEGER, payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('queued','claimed','done','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER);

CREATE TABLE audit_events(                             -- append-only；actor 区分模型/人/系统
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN('model','human','system')),
  kind TEXT NOT NULL, payload_json TEXT NOT NULL, prev_hash TEXT, hash TEXT NOT NULL);

CREATE TABLE config_versions(                          -- 启动参数与运行期变更
  version INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, author TEXT NOT NULL,
  waiver INTEGER NOT NULL DEFAULT 0, params_json TEXT NOT NULL);

CREATE TABLE price_table(                              -- 见 §8
  model TEXT, effective_from INTEGER, in_per_mtok REAL, out_per_mtok REAL,
  cached_in_per_mtok REAL, source TEXT, PRIMARY KEY(model,effective_from));

CREATE TABLE budget_ledger(
  day TEXT, scope TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  tokens_cached INTEGER DEFAULT 0, est_usd REAL DEFAULT 0, cost_known INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,scope));

CREATE TABLE heartbeat(id INTEGER PRIMARY KEY CHECK(id=1), beat_at INTEGER NOT NULL,
  halted INTEGER NOT NULL DEFAULT 0);
```

### 4.2 订单状态机 `[v0]`

`created → acked → filled | canceled | expired | rejected`（部分成交 = `acked` 且 `filled_qty > 0`）；超时无 ack → `unknown`，恢复时按 `client_order_id` 向交易所查询后再定状态。
**不变量**：`order_intents` 里每一条都已通过硬闸；`client_order_id` 全局唯一；`audit_events` 只追加。

**启动对账**：本地订单/持仓 vs 交易所 → 孤儿订单撤销；未知持仓**告警并冻结自动交易**（绝不"猜"）；"有持仓但无保护单"列为 P0 不一致（§6.3）。

### 4.3 数据源 `[v0]`

| 数据 | P0/P1 | P2 |
|---|---|---|
| 行情 K 线 | CCXT Pro WS：HTX（主）+ OKX（交叉校验）；回补走 `fetchOHLCV` 分页 | — |
| 资金费率 / OI | CCXT REST/WS（HTX、OKX） | — |
| 清算流 | 启动按 `has`/`features` 探测；**不可用即标记该特征不可用，不伪造** | 换源补齐 |
| 链上 / 宏观 / 情绪 | — | 各选定 1 个供应商并写入 ADR；宏观日历 v0 用人工 YAML；情绪仅 Fear&Greed，**不做社媒** |

硬性规则：只用已收盘 bar（`close_time <= now`，CCXT 最后一根通常是进行中，必须丢弃）；时间戳统一**毫秒整数**；每个数据点存 `observed_at`/`source`/`fetched_at`；落库唯一键 `(symbol,timeframe,open_time)` + **upsert**；`market.precision`/`limits`/合约乘数/**限频**启动时读取校验；启动校准服务器时间并持续监控偏移。
供应商路由：`"primary,fallback"` 显式链 + 行为化错误分类（无数据→记住继续；限流→跳过；未配置→跳过并备忘；其他→告警跳过）；终结返回 `NO_DATA_AVAILABLE: … Do not estimate or fabricate values`；行情（core）全链失败 → **跳过本轮并告警**，可选数据降级为 `DATA_UNAVAILABLE`。

---

## 5. 上下文与记忆

### 5.1 六类上下文 `[定]`（与 DSH `ContextForm` 对齐）

| # | 类别 | 载体 | form | 生命周期 | 压缩 |
|---|---|---|---|---|---|
| C1 | 宪法（纪律/禁则/动作词汇表） | `systemPrompt.section`，逐字 | 系统提示槽位 | 永久 | 不压缩 |
| C2 | 配置（标的池/时间框/限额/基准） | `AGENTS.md` + 插件 Config | `instructions` | 天~周 | 不压缩 |
| C3 | 状态（持仓/权益/挂单/activePlanId） | **每步从交易所+DB 重取** | `snapshot`（取代语义） | 单步 | 不适用 |
| C4 | 承诺（`when`/`then`/失效条件） | DB，序列化注入 | `snapshot` | 窗口期 | **绝不压缩** |
| C5 | 情节（已结算决策/反思/子 agent 报告） | 工具检索 + 固定预算 | `recall` | 单轮 | 可摘要，数值须精确 |
| C6 | 原始（K 线/盘口/新闻全文） | **永不入 context**，落库按需取 | 不进入 | — | 不适用 |

唤醒消息用 `notice`（`summary` ≤ **120 字符**硬上限）；C3/C4 合并为一条 snapshot；`ctxHash = sha256(canonical(组装结果))` 随决策落库。
**遮蔽而非删除**：工具返回体在进入上下文时用带指路的占位符替换（"已省略 15m K 线 200 根，可用 `trade_market` 重取"）；决策与成交记录**不可遮蔽**。
**绝不可丢（逐字/精确）**：`clientOrderId`/`decisionId`/`contentHash`/交易所 `orderId`；金额数量价位；活跃 `when` 与其过期时间；失效条件；未平仓头寸与未成交订单；未解决线程；限额与已用额度；数据指纹；已执行的副作用。

### 5.2 记忆分层 `[定]`

M0 工作记忆（单轮 context）· M1 会话记忆（DSH session JSONL，天~周）· M2 情节记忆（SQLite 交易表，永久）· M3 语义记忆（`playbook.md`/`lessons`/skills，**带版本与字符上限，写入需人审**）。
M3 记忆块：`id/label/value/limit/description`；接近上限**先摘要再写**；每次写入记旧值与 diff；**宪法块与限额块只有代码/人可写**。
检索默认：同标的最近 3 条已结算决策 + 最近 5 条跨标的教训；**分析师与辩论阶段也要注入**相关切片（原文只注入了最终裁决者）；按 regime 相似度分桶检索而非纯时间近邻；同时注入反方教训并要求裁决者显式回应。

### 5.3 反思闭环四条硬闸 `[定]`

1. **外部验证**：只在机械外部评估（成交回报/对账/结算数值/规则违背）之后写；**绝不**因"模型觉得自己没做好"就写（Reflexion 消融：无外部锚定的自反思 0.60 → 0.52）。
2. **证据指针**：每条反思带结算所用事件 ID/订单 ID/行情指纹，可被推翻。
3. **TTL 与上限**：带过期时间与条数上限（仿 Ω=1–3），按 regime 相似度检索。
4. **不可自证**：模型过去的总结**不得**作为新反思的观测输入。

结算：决策落地写 `reflection_due_at = now + horizon`（4h/24h 按策略），基准用 **BTC/ETH**；独立 `SettlementScheduler` 扫描**全部** pending；按**交易级**净额（实际仓位、扣手续费/滑点/资金费）算净收益、alpha、MFE/MAE、是否触发止损。
**复盘瞄准执行而非预测**：主指标是"计划 vs 实际"的偏离（承诺是否被忠实执行、W2 频率、有无窗口外即兴、止损是否守住），预测类结论必须攒够样本；复盘产出**只能提案**，不得自动改策略参数。

---

## 6. 执行、风控与安全

### 6.1 三档模式与 `REVIEW` 语义 `[定]`

| 档位 | 数据 | 下单 | 人工确认 |
|---|---|---|---|
| `paper` | 实时公开行情 | 本地撮合 | 无 |
| `live_confirm` | 实时 | 测试网/小额实盘 | 每单 `ask`（可选过渡档） |
| `live_auto` | 实时 | 实盘 | **无（目标档位）** |

**`REVIEW` 在 `live_auto` 下不得阻塞**：记录决策 + P1 告警 + **不产生任何新动作**（已有保护单保持不动），**不等待人类**；在 `live_confirm` 下转为 `ask`。若 7 天滚动 REVIEW 率 > 30%，视为提示词/工具/计划质量的缺陷，**暂停新开仓**直到处理。`NO_TRADE` = 明确不动，仅 info 级记录。

### 6.2 硬闸 `[定]`

> 提示词里的限额是提示，校验器里的限额才是限额。模型提议 → 确定性系统裁决。

```
validateIntent(intent, portfolio, config):
  mode != paper 而 venue == paper            → deny
  不在交易窗口（宏观事件前后 N 分钟）          → deny
  |newNotional| > perOrderCapUsd             → deny
  |totalExposure| > maxExposureUsd           → deny
  leverage > maxLeverage                     → deny
  dailyLoss > dailyLossLimit | drawdown > ddLimit → deny
  consecutiveLosses >= n | spreadBps > maxSpread  → deny
  duplicateDecision(decisionId)              → deny
  openOrders >= maxOpenOrders                → deny
  return allow
```

- **在模型外部**：没有绕过它的工具，也没有"申请豁免"的通道；阈值全部来自 `config_versions`（§6.5）。
- **只读结构化字段**：理由文本永不参与判定。
- **点两项实现 + 单测**：`tools/pre-execute` 全局监听（deny）+ 每个交易工具内部二次校验。
- **执行前重取状态**：所有交易工具先向交易所重拉账户/持仓/最新价，用实时状态重算，再执行或拒绝；下单前估算滑点与深度，超阈值即拒绝或降级限价。
- `propose` 与 `execute` 分离；降级路径：私有接口连续失败 N 次 → **可平不可开** + 告警。

### 6.3 心跳与死人开关 `[定]`（修正原设计）

进程内 `HeartbeatGuard` 只负责**写心跳**与检测内部卡死；**进程死亡时它自己也死了**，因此真正的撤单动作必须由**进程外**执行：

1. 交易所若原生支持 dead-man/cancel-on-timeout → 优先用。
2. 否则必须有独立 watchdog（独立 systemd unit 或 cron 调 `dsh --profile trade-headless "healthcheck"`），读 `heartbeat` 表，`now - beat_at > 3×interval` → 置 `halted` + `cancelAll()` + 告警。watchdog 用最小独立客户端，不复用主进程代码。
3. 恢复必须人工（`/resume`）。

**HTX 保护单窗口**：不支持原子括号单 ⇒ 入场成交后**立即**挂 `stopLossPrice`/`takeProfitPrice`（`reduceOnly: true`）；挂失败即降级（平仓或冻结）；"有持仓无保护单"是对账 P0 不一致。

### 6.4 权限与密钥 `[定]`

- 工具白名单：分析师只读（`trade_market`/`trade_derivatives`/`trade_news`/`trade_onchain`）；研究与辩论加 `trade_recall`/`trade_regime`；交易员 `trade_portfolio`/`trade_propose_order`/`trade_order_status`；风控 `trade_risk_check`/`trade_stress_test`/`trade_limits`（不能下单）；裁决 `trade_execute_order`/`trade_cancel`/`trade_record_decision`/`trade_workflow_run`；元循环 `trade_review`/`trade_playbook_update`（人审后生效）。
- 用 `agentCtx.tools.restrict({allow, deny})` 按角色收窄；**desk agent 工具目标 ≤ 20**；窗口内**不增删工具**（要收窄用约束，不改工具集）。
- 子 agent 一律剥夺副作用能力（`deny: ['trade_execute_order','trade_cancel', …]`），**能下单的工具只注册给裁决者**。
- 密钥：systemd `EnvironmentFile=%h/.dsh/trading.env`（`0600`，不入仓库），patch 里用 `!!js process.env.*` 引用；插件**不打印密钥**；实盘 key 只开交易权限、**禁用提现**；`paper` 与 `live` 用不同 profile。凭据机制（`dsh-credentials-local`）作为后续收敛方向，`[开]` 见 §12。

---

## 7. 时钟、回放与确定性 `[v0]`

这是 P0 验收"30 天回放零重复下单"的前提，原文档缺失。

- 统一定义 `interface Clock { now(): number; setInterval(fn, ms): Disposer }`；实现 `SystemClock` 与 `ReplayClock`。
- **禁止**在 `src/market/`、`src/trigger/`、`src/exec/gate.ts`、`src/supervisor/settle.ts` 里出现 `Date.now()`/`new Date()`；用一条 CI grep 测试强制。
- **回放只换 Clock 与 Broker**（`PaperBroker`），规则/计划卡匹配/硬闸/落库全部走生产同一份代码。
- 回放输入：从 `bars`/`features` 按 `close_time` 升序推进，`close_time <= clock.now()`；触发路径与实盘一致。
- **确定性判据**：同一区间回放两次 ⇒ `orders`/`fills`/`decisions` 的 id 集合完全相等，`client_order_id` 重复数 = 0。
- 历史回补：`backfill --symbols --timeframes --from --to`，CCXT `fetchOHLCV` 分页 + 限频 + upsert（落 `fetched_at`）。

---

## 8. 成本与预算 `[v0]`

DeepSeek 缓存默认开启、自动命中，**不做缓存调优**。但预算以 USD 计，而本机没有价格表 ⇒ **价目表由我们自己维护**：

- `price_table` 人工种子 + 版本化；模型缺价格行 ⇒ `cost_known = 0`，预算**退化为 token 上限**并告警，**绝不静默计 0**。
- `budget_ledger` 按 `(day, scope)` 聚合；`tokens_cached` 只作可见性，不参与优化。
- 超预算：**停 W2/W3（W1 照常）** + 审计事件 + 告警。
- 成本是一等指标：每次决策记 `context_hash`/`model_route`/token/耗时/触发来源；看板按日、按标的聚合。
- W2/W3 的 `provider/model` 与预算写进插件 Config，可热改。

---

## 9. 工程结构、打包修正与前置动作

### 9.1 目录（根 = `/workspace`）

```
/workspace/
├── plan.md                     # 本文
├── AGENTS.md                   # C2 半固定上下文
├── docs/decision.md            # 决策与证据记录
├── .dsh/skills/{trading-playbook,funding-basis,liq-cascade}/SKILL.md
└── dsh-trader/
    ├── package.json  cordis.patch.yml  README.md
    └── src/
        ├── index.ts  config.ts
        ├── market/{feed,archive,features,rules}.ts
        ├── plan/{schema,dsl,evaluate,match,store}.ts      # ★ 新增：§3 的落点
        ├── trigger/{engine,queue}.ts
        ├── memory/{schema,journal,recall,settle}.ts
        ├── exec/{broker,paper,ccxt,gate,reconcile}.ts
        ├── agents/{prompts/,tools/,roles.ts}
        ├── supervisor/{desk,heartbeat}.ts
        ├── clock.ts  cost.ts                              # ★ 新增：§7/§8
        └── plugins/{db,market,rules,exec,supervisor,tools-desk,tools-research,tools-risk,commands}.ts
```

### 9.2 `package.json` 打包修正（原文档此处会加载失败）

patch 引用的子路径必须在 `exports` 里可达：

```jsonc
{
  "name": "dsh-trader", "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./plugins/*": "./lib/plugins/*.js"        // ★ 覆盖全部 patch 行
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2", "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-tools": "*", "@deepseek-ai/dsh-system-prompt": "*", "@deepseek-ai/dsh-session": "*" },
  "dependencies": { "better-sqlite3": "…", "ws": "…", "ccxt": "…" }
}
```

对应 patch 行的 `name` 写成 `dsh-trader/plugins/market` 等（`insert:` 形式；`config` 整行替换，不深合并）。

### 9.3 前置动作（P-1，必须先做）

| # | 动作 | 命令 / 判据 |
|---|---|---|
| P-1.1 | 装 pnpm（`dsh plugin` 只是 pnpm 转发器） | `corepack enable pnpm` → `pnpm -v`；或 `npm i -g pnpm`。判据：`dsh plugin --profile web --help` 不再 exit 127 |
| P-1.2 | 创建 `trade` profile | `dsh --profile trade --from-default-profile web --dump-config`（创建即退，不阻塞）。★ 本机**没有** `dsh profile` 子命令，只能用 `--from-default-profile`；轻量替代是 `dsh-headless` 包 |
| P-1.3 | 让项目根可判定 | `git init /workspace`（或显式配 `projectRootMarkers`）。★ **实测 `/workspace` 与 `/` 都没有 `.git`**，当前仅靠"cwd 回退"才使 `.dsh/skills` 被发现 |
| P-1.4 | 数据目录与密钥 | `$DSH_HOME/trading/`（在仓库外）；`$DSH_HOME/trading.env`（0600） |
| P-1.5 | 价目表种子 | 写入 `price_table` 当前 DeepSeek 价 |

---

## 10. 路线图与量化验收

原文档的"显著优于 / 曲线平稳 / 连续 N 天"不可自动判定；下面全部改成可计算的判据。

| 阶段 | 目标 | 交付物 | 量化验收（可自动验证） |
|---|---|---|---|
| **P0 骨架**（1–2 周） | 数据 → 特征 → 规则 → **计划卡匹配** → 纸面执行 → 落库 | `market/plan/rules/exec(Paper)/db/clock` + 回放工具 + 探针 + 压测 | ① `--dump-config` exit 0 且列出全部 patch 行；② 30 天回放**跑两遍**：三个表 id 集合完全相等、`client_order_id` 重复数 = 0；③ 每次规则命中都打印 `matched:<id>` 或 `UNCOVERED:<reason>`；④ 表达式编译成功率 100%；⑤ 探针：`resume`→`followup` 产生 `assistant/message`，且 `source.form=notice` 渲染正确；⑥ 压测：24h 合成行情后 RSS 增长 < 10%（首小时为预热）、fd 数波动 ≤ 2 |
| **P1 判断与计划卡**（2–3 周） | 审议窗产出可执行计划卡 + 记忆闭环 | workflow 脚本（含冲突消解）、角色提示词、全部工具、结算/反思、context 组装器、预算账本 | ① 计划卡 schema 通过率 100%；② `when` 求值错误率 = 0（错误一律计 UNCOVERED 并告警）；③ 日输出计划覆盖率、W2/W3 频次、每窗口成本；④ 到期决策结算成功率 ≥ 99%（含重试），**每条决策至多一条反思**（唯一键）；⑤ kill -9 后 `resume` 恢复且无重复决策 |
| **P1.5 通道有效性闸门** | 判定 W2/W3 是否值得保留 | A/B 回放报告（预注册指标） | 回放 ≥ 90 天或 ≥ 200 次触发；指标 = 扣费净 PnL（taker+资金费+滑点模型）+ 执行偏离次数。**保留 W2/W3 的条件**：净 PnL 差值 bootstrap 95% CI 下界 > 0 **且** B 的最大回撤 ≤ A × 1.2。否则关闭 W2/W3，退化为"纯窗口 + 机械执行"（仍是完整可用系统） |
| **P2 测试网实盘**（2–3 周） | 真实接口、幂等、对账、硬闸、熔断 | `CcxtBroker`、对账、外部 watchdog、`/halt` | ① 订单在途时 `kill -9` × 50 次：孤儿订单 = 0、重复成交 = 0；② 同一 `clientOrderId` 提交 10 次 → 仅 1 次成交；③ `SIGSTOP` 主循环 > 3×心跳间隔 → watchdog 撤单，交易所挂单 = 0；④ 停掉模型供应商：已挂保护单仍生效、`StopGuard` 仍执行 |
| **P3 小额实盘**（持续） | `live_confirm` → `live_auto` | 限额、告警、成本看板 | 连续 **14 天**：对账不一致 = 0、硬闸绕过 = 0、日支出 ≤ 预算、W2 ≤ 8/天、W3 ≤ 6/天 |
| **P4 离线整合**（长期） | sleep-time 复盘与提案 | 周级复盘、playbook 提案、regime 检索、M3 版本化 | 每周产出可读复盘；playbook 变更**必须人工批准**；记忆块有版本与 diff，可回答"为什么改掉" |

---

## 11. 任务清单（WBS）

顺序即依赖顺序；每项完成 = 代码 + 单测 + 该行验收。

| ID | 任务 | 依赖 | 完成判据 |
|---|---|---|---|
| P-1.* | §9.3 五项前置 | — | 各条判据通过 |
| T0.1 | 仓库骨架 + `exports` + `cordis.patch.yml` + 插件空实现 | P-1.2 | `--dump-config` exit 0 且 9 行俱在 |
| T0.2 | SQLite schema + 迁移 + `db` 插件 | T0.1 | §4.1 DDL 落地；唯一索引/CHECK 有测试 |
| T0.3 | `clock.ts` + Config 体系 + 参数启动校验 | T0.1 | 缺省参数**拒绝启动**；waiver 路径留痕；grep 测试通过 |
| T0.4 | `market/feed` + `archive` + `backfill` | T0.2 | 30 天回补成功；只落已收盘 bar；断线重连有测试 |
| T0.5 | `features`（纯函数、增量维护） | T0.4 | 与全量重算逐点一致；含边界与缺失数据测试 |
| T0.6 | `plan/dsl` + `evaluate` + `match` + `store` | T0.2, T0.5 | 每算子/每错误分支单测；UNCOVERED 路径可达 |
| T0.7 | `rules` + `trigger`（去重/冷却/限流/分级） | T0.6 | 同一 bar 重复回放零重复触发 |
| T0.8 | `exec/broker` + `paper` + `gate` + `reconcile` 骨架 + 回放工具 | T0.2, T0.6 | §10 P0 验收 ②③ |
| T0.9 | 探针（resume/followup/source）+ R5 压测脚本 | T0.1 | §10 P0 验收 ⑤⑥ |
| T1.1 | `workflow` 脚本（冻结 pack、并行分析师、冲突消解、辩论、裁决） | T0.7 | 同一 `contextHash` 传所有分析师；只回结构化字段 + 工件指针 |
| T1.2 | 角色提示词 + `roles.ts` 白名单 + 模型路由 | T1.1 | 分析师无副作用工具（断言）；desk 工具 ≤ 20 |
| T1.3 | 全部交易工具（propose/execute/portfolio/recall/risk/…） | T0.8, T1.2 | 每个 execute 内二次硬闸；`propose` 不触达交易所 |
| T1.4 | 结算 + 反思 + `lessons`/`journal` + `trade_recall` | T1.3 | 四条反思闸门有测试；结算按交易级净额 |
| T1.5 | context 组装器（C1–C6）+ `ctxHash` + 遮蔽 | T1.3 | 组装可复现；`changedParts` 落库 |
| T1.6 | 预算账本 + 成本看板 | T1.3 | 缺价目表时 `cost_known=0` 并告警；超预算只停 W2/W3 |
| T1.7 | P1.5 A/B 回放 | T1.1–T1.6 | §10 P1.5 判据 |
| T2.* | CcxtBroker / 对账 / watchdog / `/halt` / 故障注入 | T1.* | §10 P2 四条 |
| T3.* | 限额与告警打磨、`live_auto` 切换 | T2.* | §10 P3 |
| T4.* | 周级复盘、playbook 提案、regime 检索、M3 版本化 | T3.* | §10 P4 |

---

## 12. 未决项 `[开]`（须在标注阶段前关闭）

| # | 项 | 关闭时间 | 备注 |
|---|---|---|---|
| 1 | 链上/宏观/情绪供应商选型 | P2 起 | 各选 1 家写 ADR；P0/P1 不阻塞 |
| 2 | `regime` 分桶的精确定义（波动率分位/趋势强度/资金费率状态的桶边界） | P1 中 | 影响检索质量 |
| 3 | `REVIEW` 率阈值（暂定 7 天滚动 30%）与暂停策略 | P1 末 | §6.1 |
| 4 | DSL 扩展政策（谁能加算子、如何回测、何时"转正"为内核指标） | P1 中 | 对应 decision §8.5 |
| 5 | 提示词正文（各角色） | P1 | 语料写入 `src/agents/prompts/` 并版本化 |
| 6 | 凭据机制收敛（`EnvironmentFile` vs `dsh-credentials-local`） | P2 | §6.4 |
| 7 | Python 数值分析接入范围 | P2+ | 只走共享数据存储，不做每 bar 调用 |
| 8 | `headless` bundle 替换 `web` 模板以降低常驻开销 | P3 | §9.3 P-1.2 |
| 9 | 容器化 | P3+ | decision §14.1 #6 |

---

## 13. 纪律 `[定]`

1. 任何策略改动先过**离线回放** → `paper` → 测试网 → 实盘。
2. 每次事故写进 `lessons` 并**加一条回归测试**。
3. 回测/模拟/实盘共用**同一份** `gate.ts` 与 `Broker` 接口。
4. 窗口内不改工具集；状态用 C3 **替换**而非追加。
5. 失败与错误状态**逐字保留**，不"擦掉失败"。
6. 审批状态**永不经过摘要**传递；授权只来自结构化硬闸判定。
7. 审计优先：审议过程、规则命中、意图、订单、成交、对账、参数变更**全量落库**，任意 `decision_id` 可回放当时所见。
