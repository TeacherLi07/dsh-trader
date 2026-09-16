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

- W3 信号白名单：交易所/预言机状态异常、单 bar > k·ATR、资金费率越极端分位、清算量破历史分位、稳定币脱锚、白名单新闻源高危关键词、**预测市场概率跳变 / 新市场 / 结算**（§4.4，且必须先过流动性门槛）。
- 超限一律**落库 + 告警**，不唤醒。
- 规则命中后的分流：命中承诺 → 执行（不唤醒）；`invalidation` → 执行降险（不唤醒）；`novelty` → W3；`info` → 只落库；其余 → 仅当 W2 成立才入队。
- agent 忙时不打断，只入队；仅 P0（持仓风险）允许 `steer()`。
- **★ attach 时机（实测，见 §4.6 R1）**：**不能在插件 `apply` 期间调用 `ctx.agents.create/resume`** —— agent factory 由 `agent-loop` 注册，而它的 apply 晚于插件 include 条目。在 `apply` 里调用会抛 `no agent factory registered`；若 `await` 等待 factory 出现，会**死锁 plugin loader**（loader 正在等 `apply` 返回）。正确做法：挂 `agent/created` 事件后**即发即忘**地 attach，或在进程启动完成后再驱动（supervisor 的 T1.x 实现必须遵守）。

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
      | ema20 | ema50 | rsi14 | atr14 | vwap20 | zscore20 | volRealized20
      | plan.ageMs | window.sinceMs
      | pm.<alias>.prob | pm.<alias>.mid | pm.<alias>.spread | pm.<alias>.volume24h
      | pm.<alias>.change1h | pm.<alias>.change24h | pm.<alias>.ageMs
运算 := 值 ( + | - | * | / ) 值 | 值 ( < | <= | > | >= | == | != ) 值
      | ( 表达式 ) | not 表达式 | 表达式 ( and | or ) 表达式
函数 := crossAbove(a,b) | crossBelow(a,b) | between(x,a,b) | abs(x) | min(a,b) | max(a,b) | pct(a,b)
```

规则：**取值与运算都是数值/布尔，DSL 没有字符串**；时间框架由承诺自带的 `tf` 字段声明（`tf ∈ {1m,15m,1h,4h,1d}`，在该 tf 的每根已收盘 bar 上求值一次），因此表达式里**不允许**出现 `bar.tf`。`pm.<alias>.*` 只在 alias 已由 `trade_prediction_watch` 注册后合法（§4.4）——DSL 没有字符串，所以预测市场**只能通过别名**进入表达式；未注册的 alias 视为未知取值 → `ok:false` → UNCOVERED，**不静默 false**。`n ≤ 500`；**禁止**赋值/循环/字符串/任意属性访问/网络/时间函数；**只用已收盘 bar**。`crossAbove`/`crossBelow` 需要前一根 bar，由特征层提供。

**内核指标层的当前覆盖（T0.5 交付，T2.4 补齐）**：已实现 `ema20`/`ema50`/`atr14`/`rsi14`/`vwap20`/`zscore20`/`volRealized20`，全部为**增量维护**且与全量重算**逐点严格相等**（`indicators.ts` 是对拍参考实现）。**T2.4 已补齐**：`adx14`（Wilder 三重平滑，增量=全量逐点相等），以及依赖衍生品/清算数据源的 `oi.changePct`、`liq.notional`、`funding.rate`、`basis.bps`（`derivatives.ts`；单位口径：`funding.rate` 为**小数比例**、`basis.bps` 为 **bps**、`liq.notional` 为窗口 `trade_turnover` **累加**、`oi.changePct` 为相对上一观测的**百分比**，各有单位测试）。指标以**扁平取值**暴露（求值本身已绑定到某个 `tf` 的那根 bar），因此**不使用 `atr(tf,n)` 这类函数形式** —— DSL 词法器没有 `tf` 记号，那种写法根本无法解析。衍生品数据未注入时相应路径**缺失** ⇒ `ok:false` → **UNCOVERED（fail-closed）**，不会静默当成 false，也不会在回测里假装有值（见 §12 #16）。

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

> **⚠️ 两套动作词汇必须分开**（实现时踩到过）：上面这张表是**计划卡**的 `then.action`；
> **决策日志**（`decisions.action`）是另一套，多出 `no_trade`（看过、不动）与 `review`（拿不准、升级），
> 而卡片上的 `escalate` 落到日志时记作 `review`（`toDecisionAction()`）。
> 两者混用会让类型与数据库 CHECK 约束不一致 —— 现在 `ACTION_KINDS` 与 `DECISION_ACTIONS` 是两个独立常量，并有单测锁定。

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
  executed INTEGER NOT NULL DEFAULT 0, reflection_due_at INTEGER, outcome_id TEXT,
  -- 成本是一等指标（§8）：每次决策记 token/耗时/触发来源；缺价目时 cost_known=0
  tokens_in INTEGER, tokens_out INTEGER, tokens_cached INTEGER,
  cost_usd REAL, cost_known INTEGER, duration_ms INTEGER, trigger_source TEXT);

CREATE TABLE outcomes(                                -- 结算结果：**交易级**净额（§7.9）
  outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(decision_id),  -- 一条决策至多一次结算
  symbol TEXT NOT NULL, settled_at INTEGER NOT NULL, horizon_ms INTEGER NOT NULL,
  entry_price REAL NOT NULL, exit_price REAL NOT NULL,
  realized_gross_pct REAL NOT NULL, realized_net_pct REAL NOT NULL,
  benchmark_pct REAL NOT NULL, alpha_pct REAL NOT NULL,
  mfe_pct REAL NOT NULL, mae_pct REAL NOT NULL,
  stop_hit INTEGER NOT NULL DEFAULT 0, fees_quote REAL NOT NULL DEFAULT 0,
  evidence_refs_json TEXT NOT NULL);

CREATE TABLE context_snapshots(                     -- 上下文组装快照（§5.1）：ctxHash 可复现、changedParts 可审计
  ctx_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, symbol TEXT,
  part_hashes_json TEXT NOT NULL,                   -- {C1: "sha256:..", ...}；C6 永不入 context
  changed_parts_json TEXT NOT NULL, char_counts_json TEXT NOT NULL,
  overflow_json TEXT NOT NULL DEFAULT '[]');

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
  -- 最终去向。只有 novelty/judgment 消耗唤醒预算；被冷却/限流压掉的仍然落库但不算预算
  disposition TEXT NOT NULL CHECK(disposition IN('info','novelty','judgment','cooldown','rate_limited','executed')),
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

-- ── 预测市场（Polymarket）事件源：只读，永不交易（§4.4）──────────────────────
CREATE TABLE pm_markets(
  condition_id TEXT PRIMARY KEY, market_id TEXT, slug TEXT NOT NULL, question TEXT NOT NULL,
  event_id TEXT, event_slug TEXT, tags_json TEXT,
  outcomes_json TEXT NOT NULL, token_ids_json TEXT NOT NULL, neg_risk INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,                 -- 源时间：市场创建时刻（存在门控用）
  start_date INTEGER, end_date INTEGER, closed INTEGER NOT NULL DEFAULT 0,
  resolved_at INTEGER, winning_outcome TEXT,   -- 仅在结算之后可见（结算门控）
  liquidity_num REAL, volume24h REAL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, observed_at INTEGER NOT NULL);
CREATE INDEX pm_markets_slug ON pm_markets(slug);
CREATE INDEX pm_markets_open ON pm_markets(closed, end_date);

CREATE TABLE pm_series(                        -- 概率序列：PIT 回放的唯一合法来源
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,                         -- 源观测时间，**毫秒整数**（源为秒 ⇒ ×1000）
  price REAL NOT NULL, resolution_seconds INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY(token_id, ts, resolution_seconds)) WITHOUT ROWID;

CREATE TABLE pm_quotes(                        -- 盘口/流动性快照：告警必须带流动性门槛
  token_id TEXT NOT NULL, observed_at INTEGER NOT NULL,
  best_bid REAL, best_ask REAL, mid REAL, spread REAL,
  last_trade_price REAL, volume24h REAL, liquidity REAL,
  PRIMARY KEY(token_id, observed_at)) WITHOUT ROWID;

CREATE TABLE pm_watches(                       -- LLM 设定的"关心事件/提醒"：结构化、有期限、有上限
  watch_id TEXT PRIMARY KEY, alias TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL UNIQUE,           -- 重复登记同一规格 = 幂等 no-op
  kind TEXT NOT NULL CHECK(kind IN('threshold','topic','resolution','liquidity')),
  expr TEXT,                                   -- threshold 必填；v0 DSL，布尔
  token_ids_json TEXT NOT NULL DEFAULT '[]', tags_json TEXT NOT NULL DEFAULT '[]', query TEXT,
  purpose TEXT NOT NULL CHECK(purpose IN('novelty','info','commitment')), plan_id TEXT,
  cooldown_ms INTEGER NOT NULL DEFAULT 900000, max_triggers INTEGER NOT NULL DEFAULT 10,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,                 -- 必填：不允许无期限关注
  state TEXT NOT NULL CHECK(state IN('active','expired','disabled')),
  created_by TEXT NOT NULL CHECK(created_by IN('model','human')),
  created_at INTEGER NOT NULL, last_fired_at INTEGER);

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
| 行情 K 线 | **v0 = CCXT REST 轮询**（免费 `ccxt` 没有 WS OHLCV，见 §12 #15）+ `fetchOHLCV` 分页回补；**必须注入代理感知的 fetch**（§12 #14） | CCXT Pro WS（主）+ OKX 交叉校验 |
| 资金费率 / OI | CCXT REST/WS（HTX、OKX） | — |
| 清算流 | 启动按 `has`/`features` 探测；**不可用即标记该特征不可用，不伪造** | 换源补齐 |
| **事件概率（预测市场）** | **Polymarket 只读**：Gamma（发现/元数据）+ CLOB（盘口/价格）+ Data API v2（历史序列）；默认 60s 轮询，WSS 作为可用时的增强 | 鲸鱼集中度/持仓（Data API v2）、结算链上事件 |
| 链上 / 宏观 / 情绪 | — | 各选定 1 个供应商并写入 ADR；宏观日历 v0 用人工 YAML；情绪仅 Fear&Greed，**不做社媒** |

硬性规则：只用已收盘 bar（`close_time <= now`，CCXT 最后一根通常是进行中，必须丢弃）；时间戳统一**毫秒整数**；每个数据点存 `observed_at`/`source`/`fetched_at`；落库唯一键 `(symbol,timeframe,open_time)` + **upsert**；`market.precision`/`limits`/合约乘数/**限频**启动时读取校验；启动校准服务器时间并持续监控偏移。
供应商路由：`"primary,fallback"` 显式链 + 行为化错误分类（无数据→记住继续；限流→跳过；未配置→跳过并备忘；其他→告警跳过）；终结返回 `NO_DATA_AVAILABLE: … Do not estimate or fabricate values`；行情（core）全链失败 → **跳过本轮并告警**，可选数据降级为 `DATA_UNAVAILABLE`。

---

### 4.4 事件来源：Polymarket 预测市场（只读）`[v0]`

**定位**：预测市场给出的是**市场隐含的事件概率**，与新闻（发生了什么）、链上（钱在干什么）互补：新闻回答"世界怎么了"，预测市场回答"市场认为会怎样"。它**不是基准真值** —— 价格里含手续费、价差、噪声与操纵成本，**薄市场可以被很便宜地推动**。

**三条红线**：
1. **只读，永不交易**。不接 Polymarket 下单：资产错配（我们是 USDT 永续，它是 Polygon 上的条件代币），且下单受地域限制（官方 geoblock 只拦"下单"，公开行情数据不受影响）。代码里**不注册任何 pm 下单工具**。
2. **不作执行触发**。pm 数值可以进计划卡的 `when`，但**不得**成为开仓的唯一理由；W3 唤醒后仍走正常审议与硬闸。
3. **市场文本是不可信输入**。`question`/`description`/结算规则**由市场创建者书写** ⇒ 攻击者可控文本，一律按数据块注入并标注来源，**绝不参与工具授权**（§3.6）。

**本机实测依据（2026-09-12 实测，非推测）**：

| 能力 | 端点 | 实测结果 |
|---|---|---|
| 发现 / 元数据 | [`gamma-api.polymarket.com/markets`](https://docs.polymarket.com/market-data/discover-markets)、`/events/keyset`、`/public-search?q=` | 200。字段：`conditionId`/`clobTokenIds`/`outcomes`/`outcomePrices`/`bestBid`/`bestAsk`/`spread`/`volume24hr`/`liquidity`/`createdAt`/`endDate`/`closed`；`/markets?order=startDate&ascending=false` 取最新市场；`/markets/keyset` 支持 `after_cursor` 翻页 |
| 盘口 / 价格 | [`clob.polymarket.com/book`](https://docs.polymarket.com/market-data/prices-order-books)、`/price` | 200。`book` 返回 `bids/asks/tick_size/min_order_size/neg_risk/timestamp/hash` |
| 历史序列 | `clob.polymarket.com/prices-history?market=&interval=&fidelity=`；`data-api.polymarket.com/v2/prices-history?token_id=&interval=&bucket_seconds=` | 200。v1 → `{history:[{t,p}]}`（`t` 为**秒**，`fidelity` 单位是**分钟**，实测 60 ⇒ 每小时一个点）；v2 → `{data:[{timestamp,price,resolution_seconds}],pagination}`（`timestamp` 也是**秒**，`resolution_seconds=0` 表示精确 tick） |
| 点时刻 | v2 `...&as_of=<ts>` | 200，但**耗时约 20s**（全量扫描）⇒ **禁止进热路径**，只用于审计重建 |
| 实时流 | [`wss://ws-subscriptions-clob.polymarket.com/ws/market`](https://docs.polymarket.com/market-data/realtime-data)，订阅 `{"assets_ids":[...],"type":"market"}`，需每 10s 发文本 `PING` | ⚠️ **本机握手超时**（HTTPS 正常，疑似出站 WSS 被拦）⇒ 默认走轮询，WSS 作为可用时的增强 |
| 官方速率（IP 级，Cloudflare **排队**而非拒绝） | [`api-reference/rate-limits`](https://docs.polymarket.com/api-reference/rate-limits) | Gamma `/markets` 300/10s、`/events` 500/10s、`/public-search` 350/10s；CLOB `/prices-history` 1000/10s、`/book` 1500/10s；Data API `/trades` 200/10s、v2 `/prices-history` 200/10s。我们用量远低于限额，但仍须**令牌桶 + 退避**，取限额 ≤20% |

**已实测的取值边界**：v2 `interval=1d`/`1w` 可用；**`1h` 返回 0 行**；**`max` 超时** ⇒ `interval` 走**白名单**，禁止未验证取值；所有请求带超时与重试上限。

**⚠️ 2026-09-14 复测修正（详见 `docs/pm-client-live-2026-09-14.md`）**：
1. `book.timestamp` 是**毫秒**（非秒）⇒ 用 `normalizeSourceMillis()` 解析，与 history 的秒分开；
2. **尚无盘口的新市场 `/book` 返回 404** ⇒ 这是正常数据状态（`book()` 返回 `null`），
   **不计入降级计数**，否则新市场会把客户端打到降级；
3. v1 `prices-history?market=` 必须是 **CLOB token id**；传 `conditionId` 会返回
   **200 + 空序列**（静默骗人）⇒ 客户端用 `assertTokenId()` 直接拒。

**PIT 三道闸门**（decision.md §3.2 指出 TradingAgents 对 Polymarket "只有实时没有 as-of"，这里修掉）：

| 闸门 | 规则 |
|---|---|
| **存在门控** | 只用 `pm_markets.created_at <= now` 的市场；回放**不得**引用"当时还不存在"的市场 |
| **结算门控** | `closed`/`winning_outcome` 只在 `resolved_at <= now` 之后可见；**绝不**让结算结果提前进入历史回放 |
| **序列门控** | 历史点按 `ts <= now` 过滤（`ts` 归一为**毫秒整数**；源为秒 ⇒ 边界 `×1000`） |

每次取数写 `observed_at` 与 `source`；决策落库时把用到的 pm 数据指纹并入 `context_hash`（§5.1 C6）。

**别名机制（让受限 DSL 能引用预测市场）**：DSH 的 `when` DSL 只有数值/布尔、**没有字符串**，所以预测市场**以别名进入词汇表**：`trade_prediction_watch` 注册 `alias`（如 `fed_sep_cut`）→ 存 alias↔token 映射 → 轮询刷新 → 特征快照暴露 `pm.<alias>.prob|mid|spread|volume24h|change1h|change24h|ageMs` → 计划卡写 `when: "pm.fed_sep_cut.prob < 0.30"`。未注册 alias = 未知取值 → UNCOVERED。
**估计量必须一致**：`prob` 定义为**中间价**（`mid`，缺失时退化 `last_trade_price`），所用估计量写入快照与告警 payload —— 否则"概率变了"可能只是换了口径。

**预测市场规则族（纯函数，`purpose` 见 §2）**：

| 规则 | purpose | 触发条件（v0） | 治理 |
|---|---|---|---|
| `pm_level_cross` | `commitment` | 计划卡写明的 `pm.<alias>.prob` 穿越 | 命中承诺即执行，不唤醒 |
| `pm_prob_jump` | `novelty` | `\|Δprob\|` 超窗口阈值，或超概率序列已实现波动的 k 倍 | 必须过流动性门槛；冷却 ≥15min |
| `pm_new_market` | `novelty` | 关注的 tag/关键词下出现新市场 | 每小时 ≤N；仅白名单 tag |
| `pm_resolution` | `info` | 关注市场结算 | 只落库 + 通知；作为复盘证据 |
| `pm_volume_spike` | `info` | `volume24h` z-score 超阈值 | 只落库 + 通知 |
| `pm_spread_blowout` | `info` | `spread` 超阈值 | 同时下调该 alias 置信度并在 Event Pack 标注 |

**流动性门槛（硬性）**：`liquidity < liquidityFloorQuote` 或 `spread > spreadCeilBps` 的市场**不产生任何 novelty 告警**，其 `prob` **不得**进入计划卡承诺。薄市场的"跳变"是噪声或操纵，不是信息。

**工具与权限**（§6.4）：
- `trade_predictions`（**只读**；分析师、研究与辩论）：`search`（query/tag）、`market`（conditionId/slug/tokenId）、`series`（tokenId + 区间）、`event`。返回结构化摘要 + `observedAt` + `dataFingerprint` + **所用估计量**；只返回已观测点。
- `trade_prediction_watch`（**有副作用** ⇒ 只给 desk 的裁决者）：`create`/`list`/`cancel`。create 必须给 `expires_at`；`expr` 走与计划卡相同的编译 + 词汇表校验（未知 alias/字段即拒绝）；受**上限**（默认 30 个 active）与**去重**（`content_hash` 唯一，重复登记 = 幂等 no-op）约束；每次变更写 `audit_events`。

**治理形态**（与 §2/§6.3 一致）：watch 命中 → 去重（`hash(watchId, tokenId, bucketTs)`）→ 冷却 → 限流（novelty 走 W3 上限）→ 分级（P1 机会 / P2 信息）→ 入 `triggers` 表，复用既有队列与 W1/W2/W3 分流；**无新信息不唤醒**。

**工程落点**：`src/predictions/{client,store,poller,watch,rules,pit}.ts` + `plugins/predictions.ts`（id `trade-predictions`，默认 `enabled: true`、`mode: read-only`）。轮询器读**注入的 `Clock`**（§7），因此回放确定性与实盘共用同一份代码。

---

## 5. 上下文与记忆

### 5.1 六类上下文 `[定]`（与 DSH `ContextForm` 对齐）

| # | 类别 | 载体 | form | 生命周期 | 压缩 |
|---|---|---|---|---|---|
| C1 | 宪法（纪律/禁则/动作词汇表） | `systemPrompt.section`，逐字 | 系统提示槽位 | 永久 | 不压缩 |
| C2 | 配置（标的池/时间框/限额/基准） | 插件 Config（`cordis.patch.yml`）+ `config_versions` 表 | `instructions` | 天~周 | 不压缩 |
| C3 | 状态（持仓/权益/挂单/activePlanId） | **每步从交易所+DB 重取** | `snapshot`（取代语义） | 单步 | 不适用 |
| C4 | 承诺（`when`/`then`/失效条件） | DB，序列化注入 | `snapshot` | 窗口期 | **绝不压缩** |
| C5 | 情节（已结算决策/反思/子 agent 报告） | 工具检索 + 固定预算 | `recall` | 单轮 | 可摘要，数值须精确 |
| C6 | 原始（K 线/盘口/新闻全文） | **永不入 context**，落库按需取 | 不进入 | — | 不适用 |

唤醒消息用 `notice`（`summary` ≤ **120 字符**硬上限）；C3/C4 合并为一条 snapshot；`ctxHash = sha256(canonical(组装结果))` 随决策落库。
> **C2 不含 `AGENTS.md`**：仓库根的 `AGENTS.md` 面向**编码 agent**（构建/测试/约定，遵循 [agents.md](https://agents.md/)），
> 里面有构建命令与"坑表"，对交易模型纯属噪声。交易配置只从插件 Config 与 `config_versions` 来，这样它才是**可审计、可热改**的（§6.5）。
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

- 工具白名单：分析师只读（`trade_market`/`trade_derivatives`/`trade_news`/`trade_onchain`/`trade_predictions`）；研究与辩论加 `trade_recall`/`trade_regime`；交易员 `trade_portfolio`/`trade_propose_order`/`trade_order_status`；风控 `trade_risk_check`/`trade_stress_test`/`trade_limits`（不能下单）；裁决 `trade_execute_order`/`trade_cancel`/`trade_record_decision`/`trade_workflow_run`/`trade_prediction_watch`；元循环 `trade_review`/`trade_playbook_update`（人审后生效）。
- **预测市场只有只读工具 + 关注登记工具**：`trade_predictions` 只读（分析师可用），`trade_prediction_watch` 有副作用（登记/取消关注）⇒ 只给裁决者；**没有任何 pm 下单工具**（§4.4 红线 1）。
- 用 `agentCtx.tools.restrict({allow, deny})` 按角色收窄；**desk agent 工具目标 ≤ 20**；窗口内**不增删工具**（要收窄用约束，不改工具集）。
- 子 agent 一律剥夺副作用能力（`deny: ['trade_execute_order','trade_cancel', …]`），**能下单的工具只注册给裁决者**。
- 密钥：systemd `EnvironmentFile=%h/.dsh/trading.env`（`0600`，不入仓库），patch 里用 `!!js process.env.*` 引用；插件**不打印密钥**；实盘 key 只开交易权限、**禁用提现**；`paper` 与 `live` 用不同 profile。凭据机制（`dsh-credentials-local`）作为后续收敛方向，`[开]` 见 §12。

---

### 6.5 启动参数与风控参数 `[定]`

风控参数是**运行时输入**，不是代码常量，也不是配置默认值（decision §14.3）。规则：

- **缺省即拒绝启动**：`mode` / `riskPct` / `limits` / `symbols` / `benchmark` 缺一即抛 `StartupParamsError`。系统**不替用户猜一个"安全的数"** —— 那会制造虚假的安全感。
- **可显式放弃（风险自负）**：`waiver: true` 是**一等公民路径**。放弃后 `limits === null`，但**安全机制不随之放弃**：幂等、对账、心跳熔断照常生效（§6.3）；硬闸保留"永远生效"的三条检查（§6.2）。
- **放弃必须留痕且持续可见**：写入 `config_versions`（含 `waiver` 标记）与 `audit_events`，启动摘要显式回显"当前无风控"；允许随时补上参数，补上即刻生效。
- **参数进 prompt，但只作提示**：真正的强制在硬闸（§6.2）—— 二者都要，不能只做前者。
- **参数必须自洽**：`riskPct`、止损距离与单笔名义上限要相互自洽 —— `notional ≈ equity × riskPct ÷ (stopDistance / price)`。BTC 的 2×ATR 止损只有价格的 ~0.5%，所以 `riskPct = 1%` 会推出约 **2× 权益**的名义金额，必然被单笔上限拒绝。**不自洽时启动就该拒绝**，而不是让每一单都在硬闸处被打回（见 §12 #17）。
- **运行期变更**：只允许人工命令修改，且改配置本身是一条审计事件（§13 纪律 7「审计优先」）。

---

## 7. 时钟、回放与确定性 `[v0]`

这是 P0 验收"30 天回放零重复下单"的前提，原文档缺失。

- 统一定义 `interface Clock { now(): number; setInterval(fn, ms): Disposer }`；实现 `SystemClock` 与 `ReplayClock`。
- **禁止**在 `src/market/`、`src/predictions/`、`src/trigger/`、`src/exec/gate.ts`、`src/supervisor/` 里出现 `Date.now()`/`new Date()`；用一条 CI grep 测试强制（`tests/clock-discipline.test.ts`，按目录整目录扫描）。
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

### 8.1 价目表与峰谷 `[定]`

**官方价目分峰谷**，同一模型峰时/谷时单价差 **2×**。只存一行"平均价"会让谷时预算高估一倍、
峰时低估一倍 —— 所以 `price_table` 带 `tier ∈ {peak, off_peak, any}`，主键 `(model, effective_from, tier)`，
取价时先选生效版本、再按**注入的时间戳**判档（`priceTier(at)`，不读系统时钟）：

- 峰时 = **UTC 周一至周五** 01:00–04:00 与 06:00–10:00；其余（含整个周末）谷时；
- 谷时价 = 峰时价 ÷ 2（官方明示）；实现里**显式写两档**，让价目表成为唯一事实来源；
- 缺行 ⇒ `cost_known = 0` + 告警，退化为 token 上限，**绝不静默计 0**。

种子（抓取于 **2026-09-14**，单位 USD / 1M tokens，源见 `PRICING_SOURCE`）：

| 模型 | 档 | 缓存命中 | 缓存未命中(输入) | 输出 |
|---|---|---|---|---|
| `deepseek-flash` | peak | 0.006 | 0.30 | 1.20 |
| `deepseek-flash` | off_peak | 0.003 | 0.15 | 0.60 |
| `deepseek-v4-pro` | peak | 0.044 | 1.32 | 3.96 |
| `deepseek-v4-pro` | off_peak | 0.022 | 0.66 | 1.98 |

价目会变（官方明示"保留调价权利"）⇒ 表里有 `source` 与 `effectiveFrom`，改价只改表、不动代码。

---

## 9. 工程结构、打包修正与前置动作

### 9.1 目录（根 = `/workspace`）

```
/workspace/
├── plan.md                     # 本文
├── AGENTS.md                   # 面向**编码 agent**的仓库说明（遵循 agents.md；不进交易上下文，见 §5.1）
├── docs/decision.md            # 决策与证据记录
├── .dsh/skills/{trading-playbook,funding-basis,liq-cascade}/SKILL.md
└── dsh-trader/
    ├── package.json  cordis.patch.yml  README.md
    └── src/
        ├── index.ts  config.ts  clock.ts  cost.ts  cost-ledger.ts
        ├── db/{schema,statements}.ts
        ├── util/canonical.ts                             # ★ 规范化 JSON + 指纹（幂等根）
        ├── market/{types,normalize,ratelimit,archive,backfill,feed,ccxt-source,runtime,indicators,features,feature-archive,context,derivatives,regime}.ts
        ├── plan/{schema,dsl,evaluate,match,store}.ts      # ★ 新增：§3 的落点
        ├── predictions/{pit,client,store,poller,rules,wiring,runtime}.ts   # ★ §4.4 事件源（只读）
        ├── trigger/{queue,engine,runtime}.ts
        ├── memory/{recall,settle}.ts                      # ★ 教训检索（TTL 执行）+ 交易级结算
        ├── exec/{broker,paper,gate,sizing,journal,reconcile,replay,recovery,ccxt-broker,sim-exchange}.ts
        ├── agents/{types,pack,prompts,workflow,roles,tools}.ts
        ├── supervisor/{metrics,desk,heartbeat,watchdog}.ts  # desk 属 P4；heartbeat/外部 watchdog 见 T2.2
        └── plugins/{db,market,predictions,rules,exec,supervisor,tools-desk,tools-research,tools-risk,commands,probe}.ts
```

> T1.1–T1.11 均已落地，目录与上表一致（`journal` 落在 `exec/`，因为它是执行链的账本）。
> T2.1–T2.6 新增 `exec/ccxt-broker.ts`（注入 exchange 的真实 Broker）、`exec/sim-exchange.ts`
> （**仅为验收/单测**的跨进程持久化模拟 venue，不是生产 venue）、`market/derivatives.ts`、
> `market/regime.ts`、`supervisor/{heartbeat,watchdog}.ts`。
> `predictions/watch.ts` 未单独成文件：watch 治理落在 `store.ts`（写入侧强制），
> pm 规则族落在 `rules.ts`，接线落在 `wiring.ts` —— 三处都比"一个 watch.ts"更靠近各自的职责。

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
| P-1.5 | 价目表种子 | 写入 `price_table` 当前 DeepSeek 价（**已做**：§8.1，2026-09-14 抓取，含峰谷两档） |

---

## 10. 路线图与量化验收

原文档的"显著优于 / 曲线平稳 / 连续 N 天"不可自动判定；下面全部改成可计算的判据。
**状态截至 2026-09-15：P0 ✅、P1 ✅、P1.5 闸门 ✅（可运行判定已产出，判定为"关闭 W2/W3"）、P2 ✅（T2.1–T2.6 代码落地，§10 P2 ①–④ 由持久化模拟 venue 验证；真实 HTX 只读对账待 §12.2 A 的凭据）。**

| 阶段 | 状态 | 量化验收（可自动验证） |
|---|---|---|
| **P0 骨架** | ✅ `tag: phase-p0` | ① `--dump-config` exit 0 且列出全部 patch 行；② 30 天回放**跑两遍**：三表 id 集合完全相等、`client_order_id` 重复数 = 0；③ 每次命中都打印 `matched:`/`UNCOVERED:`；④ 表达式编译成功率 100%；⑤ 探针 `resume`→`followup` 产生 `assistant/message` 且 `source.form=notice` 正确落盘；⑥ 压测稳态增长 +2.73%、fd 波动 0、WAL 有界 |
| **P1 判断与计划卡** | ✅ `tag: phase-p1` | ① 计划卡 schema 100%；② `when` 求值错误率 = 0（错误一律 UNCOVERED）；③ 覆盖率 / W2-W3 频次 / 每窗口成本；④ 结算成功率 ≥ 99%（含重试）+ 每条决策至多一条反思；⑤ `kill -9` 后 resume 且无重复决策；⑥ 预测市场专项 ①–⑧ 全通过 |
| **P1.5 通道有效性闸门** | ✅ 可运行 | 保留条件：净 PnL 差值 bootstrap 95% CI 下界 > 0 **且** B 回撤 ≤ A × 1.2；否则关闭 W2/W3，退化为"纯窗口 + 机械执行"（仍是完整可用系统）。**首轮判定：关闭**（`docs/p1.5-gate-run-2026-09-14.md`） |
| **P2 真实接口与故障注入** | ✅ 可运行判定 | ① 订单在途时 `kill -9` × 50：孤儿订单 = 0、重复成交 = 0（`docs/p2-fault-injection-2026-09-15.md`）；② 同一 `clientOrderId` 提交 10 次 → 仅 1 次成交；③ `SIGSTOP` > 3× 心跳 → watchdog 撤单、交易所挂单 = 0（`docs/p2-watchdog-2026-09-15.md`）；④ 停掉模型供应商：已挂保护单仍生效。**真 HTX 端点**的只读核对待 §12.2 A |
| **P3 小额实盘** | 待做 | 连续 **14 天**：对账不一致 = 0、硬闸绕过 = 0、日支出 ≤ 预算、W2 ≤ 8/天、W3 ≤ 6/天 |
| **P4 离线整合** | 待做 | 周级复盘可读；playbook 变更**必须人工批准**；记忆块有版本与 diff |

**⑥ 压测口径**（保留，因为它防止误判）：进程启动时 V8 堆 / malloc arena / SQLite 页缓存都在爬坡，而 RSS **不随 GC 归还** ⇒ 硬指标取**稳态斜率**（25% 处采样为基线比末次），启动爬坡如实报告但不作闸门。该判据抓到过真实泄漏：`db.prepare()` 每次调用累积 Statement（5 万次 **+139.5MB**），缓存复用后 +0.3MB；由 `tests/db-discipline.test.ts` 守住"热路径不得直接 `prepare()`"。

### 10.1 可运行判定（全部一条命令可复现）

| 判据 | 命令 | 结果 |
|---|---|---|
| P0 ②③ 回放确定性 | `node scripts/replay-check.mjs htx BTC/USDT 1h 30` | 8/8，PnL `117.5327914103922` |
| P0 ⑤ 探针 | `node scripts/probe-check.mjs probe /tmp/trade-probe-result.json` | 通过 |
| P0 ⑥ 压测 | `node --expose-gc scripts/soak.mjs 24 60` | 稳态 +2.73% |
| P1 ①–④ | `node scripts/p1-acceptance.mjs 30` | 全通过（`docs/p1-acceptance-2026-09-14.md`） |
| P1 ⑤ 崩溃恢复 | `node scripts/crash-recovery-check.mjs` | 10/10 真实 SIGKILL（`docs/crash-recovery-2026-09-14.md`） |
| P1 ⑥ 预测市场 | `node scripts/pm-pit-check.mjs 30` | 11/11（`docs/pm-pit-acceptance-2026-09-14.md`） |
| P1.5 通道闸门 | `node scripts/ab-gate.mjs htx BTC/USDT 1h 92` | 判定：关闭 W2/W3（`docs/p1.5-gate-run-2026-09-14.md`） |
| P2 ①②④ 故障注入 | `node scripts/fault-injection.mjs /tmp/p2-fault.json` | 50 轮中 38 次真 SIGKILL；孤儿挂单 0 / 重复成交 0；同一 `clientOrderId` 提交 10 次→成交 1；保护单在"模型停摆"下仍触发（`docs/p2-fault-injection-2026-09-15.md`） |
| P2 ③ 外部 watchdog | `node scripts/watchdog-check.mjs /tmp/p2-watchdog.json` | 8/8：真实 `SIGSTOP` → stale → 撤单 → 挂单清空 → halted 落库 → 幂等（`docs/p2-watchdog-2026-09-15.md`） |
| §12.2 A 第①步 HTX 只读预检 | `node --env-file=$DSH_HOME/.env scripts/htx-preflight.mjs htx BTC/USDT:USDT` | exit 0：认证成功、读到**永续账户**余额 24.914 USDT、空仓空挂单；`executedActions=[]`。**对账为平凡一致**（两边都 0）。实测坑：现货/永续账户分离，见 `docs/htx-preflight-2026-09-15.md` |

**非空跑纪律**（这三条是被真实踩坑逼出来的，永久保留）：① 结算成功率必须报**分母**（机械执行路径曾不登记 `reflection_due_at` ⇒ "100%" 是在 **0 个样本**上通过的）；② 预测市场 novelty 检查必须有 `pm_signals_exercised`（样本曾全是日变化 ≈0.001 的远期政治盘 ⇒ 规则不触发却"通过"）；③ 验收阈值**从真实数据推导**，不写死（写死 3% 时同一脚本会随行情飘）。

**预测市场专项验收 ①–⑧**：① 不存在"市场未创建即被引用"/"结算结果提前可见"（SQL 命中 = 0）；② `pm_series.ts` 毫秒整数且与源秒可逆；③ 同一 alias 的 `prob` 在工具返回与告警 payload 中估计量一致；④ 低于流动性门槛的市场 novelty 数 = 0（实测 70 个有盘口市场仅 2 个过门槛，novelty 只对这 2 个产生）；⑤ 任意 10s 窗口请求数 ≤ 官方限额 20%；⑥ 轮询连续失败 ⇒ 降级为 `info` 且主循环不受影响；⑦ 热路径 `as_of` 次数 = 0；⑧ 未注册 alias 一律 UNCOVERED、零静默 false。

---

## 11. 任务清单（WBS）

顺序即依赖顺序；每项完成 = 代码 + 单测 + 该行验收。**P-1 / T0.* / T1.* 全部 ✅**（P0/P1 阶段标签已打）。

| ID | 状态 | 任务 | 完成判据 |
|---|---|---|---|
| P-1.* | ✅ | §9.3 五项前置 | 各条判据通过 |
| T0.1 | ✅ | 仓库骨架 + `exports` + `cordis.patch.yml` + 插件空实现 | `--dump-config` exit 0 且 11 patch 行俱在 |
| T0.2 | ✅ | SQLite schema + 迁移 + `db` 插件 | §4.1 DDL 落地；唯一索引/CHECK/append-only 有测试 |
| T0.3 | ✅ | `clock.ts` + Config 体系 + 参数启动校验 | 缺省参数**拒绝启动**；waiver 留痕；grep 测试通过 |
| T0.4 | ✅ | `market/feed` + `archive` + `backfill` | 30 天回补成功；只落已收盘 bar；断线重连有测试 |
| T0.5 | ✅ | `features`（纯函数、增量维护） | 增量与全量重算**逐点严格相等** |
| T0.6 | ✅ | `plan/dsl` + `evaluate` + `match` + `store` | 每算子/每错误分支单测；UNCOVERED 可达 |
| T0.7 | ✅ | `rules` + `trigger`（去重/冷却/限流/分级） | 同一 bar 重复回放零重复触发 |
| T0.8a | ✅ | `exec/paper` + `reconcile`，与 `gate` 共用 `Broker` 接口 | 滑点/手续费、`clientOrderId` 幂等、保护单是挂单 |
| T0.8b | ✅ | 确定性回放：features → match → rules → gate → paper | P0 ②③：两遍 id 集合相等、重复数 = 0 |
| T0.9 | ✅ | 探针（resume/followup/source）+ R5 压测 | P0 ⑤⑥ |
| T1.1 | ✅ | `workflow` 脚本（冻结 pack、并行分析师、冲突消解、辩论、裁决） | 同一 `contextHash` 传所有分析师；只回结构化字段 + 工件指针 |
| T1.2 | ✅ | 角色提示词 + `roles.ts` 白名单 + 模型路由 | 分析师无副作用工具（断言）；desk 工具 ≤ 20 |
| T1.3 | ✅ | 全部交易工具（propose/execute/portfolio/recall/risk/…） | 每个 execute 内二次硬闸；`propose` 不触达交易所 |
| T1.4 | ✅ | 结算 + 反思 + `lessons`/`journal` + `trade_recall` | 四条反思闸门有测试；**TTL 在读取侧真的执行**；缺数据**推迟**而非编造 |
| T1.4b | ✅ | 每日运营指标（覆盖率 / W2-W3 频次 / 每窗口成本） | P1 ③ 可自动判定；覆盖率绑定 `asOf` 时点 |
| T1.4c | ✅ | 崩溃恢复（在途意图分类、未知即冻结、恢复幂等） | P1 ⑤ 真实 SIGKILL 10/10 |
| T1.5 | ✅ | context 组装器（C1–C6）+ `ctxHash` + 遮蔽 | 组装可复现；`changedParts` 落库；`context_hash` 只由代码写入 |
| T1.6 | ✅ | 预算账本 + 成本看板 | 缺价目 `cost_known=0` 并告警；超预算只停 W2/W3；价目按峰谷两档取 |
| T1.7 | ✅ | P1.5 A/B 回放 | `scripts/ab-gate.mjs` 可运行；LLM 判断臂待 §12.2 |
| T1.8 | ✅ | `predictions/client` 三家 API + 令牌桶/退避 + PIT 三闸门 | §10 专项 ①②⑤⑥⑦；实测修正 plan 原文三处单位/语义错误 |
| T1.9 | ✅ | `predictions/store` + `poller` + `trade_predictions` + alias↔token 映射 | §10 专项 ②③⑧ |
| T1.10 | ✅ | `trade_prediction_watch` + watch 治理 + pm 规则族 + W3 接线 | §10 专项 ④；novelty 与行情共享同一份预算 |
| T1.11 | ✅ | `plugins/predictions.ts` + patch 行 + Config | `--dump-config` 列出该行（11 行、exit 0） |
| T2.1 | ✅ | `CcxtBroker`（**HTX 优先**，venue-agnostic）+ 真实 `getOpenOrders`/`findOrderByClientOrderId` | 同一 `gate.ts` 不变；`sandbox` 开关走 OKX（§12 #6）；传输失败必须 throw（意图留在 `created` 交恢复处理）；密钥只进不出。**真 HTX 只读对账待 §12.2 A** |
| T2.2 | ✅ | 对账 + 外部 watchdog + `/halt` / `/resume` | §10 P2 ③ 8/8（`docs/p2-watchdog-2026-09-15.md`）；撤单成功才置 halted；`inject=['commands']` |
| T2.3 | ✅ | 故障注入：`kill -9` × 50、重复提交 × 10 | §10 P2 ①②④ 全部通过（`docs/p2-fault-injection-2026-09-15.md`）；持久化 `sim-exchange` 仅为验收/单测，不是生产 venue |
| T2.4 | ✅ | 内核指标补全：`adx14` + `funding.rate` + `oi.changePct` + `liq.notional` + `basis.bps`（§12 #16） | 增量=全量逐点相等（ADX 对拍 92 个有效样本）；单位口径各有测试；5 路径移入 `V0_ALLOWED_PATHS` |
| T2.5 | ✅ | `regime` 分桶（§12 #2）+ `trade_regime` 工具 | 分位定义可复现（边界 0.33/0.67 归 mid）；样本 < 30 一律 `ok:false` |
| T2.6 | ✅ | **§12 已决策待实现的小项**：`SUGGESTED_LIMITS`→`EXAMPLE_LIMITS` + 启动自洽校验（#17）；negRisk 偏差校验（#12）；`PriceTableStore.ageDays` + 90 天告警（#19）；结算视界按 tf 推导 + `Reflector` 绑 quick tier（#18）；`PROMPT_VERSION` 并入 C1 哈希（#5） | 每项一个单测；#17 有"不自洽即拒启动"的断言 |
| T3.* | ⏳ | 限额与告警打磨、`live_confirm` → `live_auto` | §10 P3 |
| T4.* | ⏳ | 周级复盘、playbook 提案、regime 检索、M3 版本化 | §10 P4 |

---

## 12. 决策记录 `[定]`

原「未决项」已逐条决断。原则：**能决的当场决，并写下依据与推翻条件**；只有真正需要外部输入的才留在 §12.2。

### 12.1 已决

| # | 议题 | 决策 | 依据 / 推翻条件 |
|---|---|---|---|
| 1 | 链上/宏观/情绪供应商选型 | **不接**。`trade_news`/`trade_onchain` 保持未实现并如实报告 | 我方红线是"计划卡 + 机械执行"，这三个源在 P4 之前的边际价值不明；为凑工具数接噪声源是负收益。推翻条件：写出 ADR 说明某个源能改变**已注册计划卡**的触发质量 |
| 2 | `regime` 分桶定义 | **分位数而非拍阈值**，组合桶 `trend\|vol` 共 9 桶：`vol` = `volRealized20` 在同标的同 tf 近 90 天滚动分位（<33% 低 / 33–67% 中 / >67% 高）；`trend` = `abs(ema20−ema50)/atr14` 分位（<0.5 震荡 / 0.5–1.5 趋势 / >1.5 强趋势） | 分位数天然适配不同标的的量纲，阈值必须从数据来。实现落 `src/market/regime.ts`（纯函数 + 需历史窗口，T2.5）。暂不含资金费率维度（等 #16 落地后再议） |
| 3 | `REVIEW` 率阈值 | 保留 **7 天滚动 30%**，但补两条：分母 = 该窗口全部决策数；**窗口内决策 < 20 时不触发暂停**（避免冷启动误停）。触发后**只禁 open**，允许 reduce/close | 冷启动期 2 个决策里 1 个 review 就是 50%，按比例停机会误伤。`review` 不阻塞、不等待人类（§6.1） |
| 4 | DSL 扩展政策 | **两阶段**：① *表达式层*加算子/路径 —— 纯函数 + 单测 + 回放对比即可，无需人审；`§3.2` 红线（禁赋值/循环/字符串/网络/时间）永不动。② *内核指标转正*（组合式 → `features` 一等指标）—— 必须 (a) 增量=全量逐点一致、(b) 90 天回放净 PnL 不降 > 10%、(c) 写入 `decision.md`，**且必须人审** | ②会改变所有计划卡的语义，属于"改宪法"级别。①不改变语义，只需证据 |
| 5 | 提示词正文 | **主体已完成**（`src/agents/prompts.ts` 覆盖 analyst/reconcile/bull/bear/risk/judge）。补一条：提示词带显式 `PROMPT_VERSION`，并入 C1 宪法哈希 | 版本化必须能回答"这条决策用的是哪版提示词"；C1 的 `partHashes` 已在 `context_snapshots` 里。`trade_review`/`trade_playbook_update` 的提示词随 P4 |
| 6 | 凭据机制与 venue | **定案**：`EnvironmentFile`（`$DSH_HOME/trading.env`，0600），不做 `dsh-credentials-local`（多一层间接、权限模型更复杂、收益不明）。**HTX = 生产 venue**（用户提供 key；行情/回补已实测）；**OKX = 只读交叉校验 + P2 故障注入的 sandbox venue** | 实测（ccxt 4.5.78）：HTX 的 `createOrder/cancelOrder/fetchOrder/fetchOpenOrders/fetchPositions/fetchBalance/fetchMyTrades` 全 `true`，但 **HTX 在 ccxt 里没有 sandbox 端点**，而 OKX 有（`urls.sandbox`）。P2 的"孤儿订单 = 0"必须在**不亏钱**的环境里做 ⇒ 双 venue。`CcxtBroker` 保持 venue-agnostic（§13 纪律 3）。**权限最小化**：key 只开交易、**禁用提现**、绑 IP；`paper`/`live` 用不同 profile；插件只报"已注入/未注入"布尔，永不打印密钥 |
| 7 | Python 数值分析 | **不引入 Python 运行时**。只允许**离线批量**通道：Node 导出 → Python 算 → 结果写回静态表；**绝不进热路径、绝不每 bar 调用** | 跨语言会引入第二套时序语义，直接冲突 §7 的确定性要求（回测/实盘同一份代码）。v0 的指标需求 Node 侧已覆盖 |
| 8 | `headless` bundle | **已落地**：`probe` 与 `trade` profile 均用 `--from-default-profile headless` 创建 | P-1.2 已用该路径创建 probe profile 并跑通探针，无需再议 |
| 9 | 容器化 | **非目标**。交易进程跑 systemd unit | 我们依赖 `HTTP(S)_PROXY` + `host.docker.internal`，容器会新增网络故障面；§6.3 要求 watchdog 是**进程外独立 unit**，systemd 更直接。例外：一次性回测容器允许，不影响交易进程 |
| 10 | Polymarket WSS | **永久走轮询**（60s 周期）。不引入 `https-proxy-agent` | 实测 WSS 握手超时（HTTPS 正常）；轮询已满足 W3 需求，且 30 天 PIT 回补与验收全通过。收益（延迟）对本系统无意义：动作来自计划卡，是分钟级 |
| 11 | pm 能否作为 `commitment` 触发 | **永久禁止**。`allowPmCommitment` 默认 `false`，且要打开必须**同时**满足 §10 P1.5 判据 | decision.md 明确警示"市场情绪当信号"；而 A/B 闸门在触发密度解决前（§12.2 #21）给不出有意义证据。保留开关只为将来留门，不是待办 |
| 12 | negRisk 概率归一化 | **只校验、绝不改写**：同一 negRisk 事件下 token `mid` 之和与 1 的偏差 > 3% ⇒ (a) 该 alias 置信度按 `confidencePenalty` 打折、(b) 发 `info` 告警、(c) 在 Event Pack 标注 | 归一化会掩盖真实的摩擦/套利空间，而那本身是信息。我们要的是"知道这组数不自洽"，不是替市场"修正"数据。实现落 `store.ts` 按 event 分组（T2.x） |
| 13 | 历史深度（v2 interval） | **已关闭**：`1m` 实测覆盖 30 天（1441 点）⇒ 入白名单；`max` 行为不一致 ⇒ 不入白名单 | 见 `docs/pm-client-live-2026-09-14.md` |
| 14 | ccxt 不读代理环境变量 | **已关闭**：`applyProxyAwareFetch()` 已实现并在 `createMarketRuntime` 默认启用 | 实测 HTX 30 天 1h 回补 720 取回 / 719 落库全为已收盘 bar |
| 15 | WebSocket 行情需 CCXT Pro | **不买 Pro**。v0/v1 只用 REST | 实测免费版 `has.watchOHLCV === undefined`；REST 满足 60s 级需求，且我们的动作是分钟级。推翻条件：出现**必须在秒级**反应的规则 |
| 16 | 内核指标未覆盖（`UNIMPLEMENTED_PATHS` 共 5 项） | **5 项全部可实现，一个都不移除**：`adx14` 纯计算（Wilder 三重平滑）；`funding.rate` / `oi.changePct` / `liq.notional` / `basis.bps` 走 ccxt/HTX。**T2.4 已全部落地并移入 `V0_ALLOWED_PATHS`**（ADX 增量=全量逐点相等；四个衍生品路径各有单位测试；未注入衍生品数据时仍然 UNCOVERED） | 实测 HTX 公开端点（**无需 key**）全部真实可用：`fetchFundingRate` → `funding_rate=-0.0000788`；`fetchOpenInterest` → `openInterestValue=2249677981.5`；`fetchLiquidations` → 5 条真实强平（含 `volume`/`trade_turnover`）；`basis.bps` → 同一 ccxt 实例取现货+永续 ticker，实测 `spot=78430.4 / swap=78400 ⇒ **−3.88 bps**`。★ **单位口径**：`funding.rate` 是**小数比例**（非 bp、非百分比）；`basis.bps` 单位是 **bps**（`(swap−spot)/spot×10000`）；`liq.notional` 用 `trade_turnover` 累加窗口值；`oi.changePct` 是相对上一观测的**百分比**。口径写进 §3.2 词汇表且各有单位测试 |
| 17 | 建议风控参数不自洽 | 删掉 `SUGGESTED_LIMITS` 的"建议"身份，改名 `EXAMPLE_LIMITS` 并标注"示例，非建议"；新增**启动期自洽校验**：`maxNotionalAtMinStop = equity × riskPct ÷ minStopDistancePct`，若 `perOrderCapUsd < 该值` ⇒ **拒绝启动**，并给出两个可选修法（调低 `riskPct` 或调高上限） | 实测 riskPct=1% 时 180 次命中**全部被拒**（名义 ≈ 2× 权益），0.2% 才成交。`minStopDistancePct` 默认取 BTC 1h 2×ATR 的实测中位距离，可配置。让每单都在硬闸处被打回是"看起来在跑"的坏状态 |
| 18 | 结算视界 / 调度位 / Reflector 绑定 | ① 视界**按计划卡 tf 推导**：`horizon = clamp(4 根 bar, 4h, 24h)`（1h→4h、4h→16h、1d→24h）；② 调度挂到 supervisor heartbeat（T2.2）；③ `Reflector` 绑 **quick tier**（`deepseek-flash`）+ 独立预算 | 结算是"这笔交易的结果"，应与持仓周期同尺度，全局 4h 常量对 1d 卡明显过短。反思已由 §5.3 闸门限制为"短、可检索"（≤600 字），用 quick tier 足够 |
| 19 | 价目表年龄 | `PriceTableStore` 增加 `ageDays(at)`；heartbeat 检查 > **90 天** ⇒ 发 P2 告警（不阻塞），看板显示 `stale` 标记 | 官方保留调价权利；缺行只降级为 token 上限（不会静默免费），所以告警级别 P2 足够 |
| 20 | 结算与反思的观测口径 | 结算结果必须同时报 `settled` / `deferred` / `deferredIds`；缺数据**推迟**并在下一轮重试，绝不写 `entry_price = 0` | 我们实际踩过：缺数据时写 0 会把"数据缺口"伪装成"零收益交易"，直接污染 alpha 与 lessons |
| 21 | 机械执行与判断通道的记录一致性 | 机械执行路径**必须**登记 `reflection_due_at`（`{open, reduce, close}` 成交后）；`isTradeTrigger` 对 pm 信号写死 `false` | 实际踩过：机械路径不登记 ⇒ 反思闭环在回测里根本不跑，而"结算成功率 100%"是在 0 个样本上通过的 |

### 12.2 待外部输入（不阻塞 P2 开工）

| # | 事项 | 需要什么 | 现状与替代路径 |
|---|---|---|---|
| A | HTX API key | 用户提供（只开**交易**权限、**禁用提现**、绑 IP 白名单） | **已确认可提供**（2026-09-14）。落地顺序固定为三步，每步都可独立停下：① **只读**——`CcxtBroker` 先接 `fetchBalance`/`fetchPositions`/`fetchOpenOrders`，与本地 `paper` 对账（不需要下任何单）；② **`paper` 模式**跑通全链路（行情仍用真实公开数据）；③ 进 **`live_confirm`**（每单人工 `ask`），稳住后再评估 `live_auto`。**代码状态（2026-09-15）**：T2.1 `CcxtBroker` 已实现（venue-agnostic、注入 exchange、`sandbox` 开关走 OKX），缺凭据时安全降级 `paper`（`resolveExecBroker`）；**第①步已实测通过（2026-09-15）**：`node --env-file=$DSH_HOME/.env scripts/htx-preflight.mjs` → exit 0，私有端点认证成功、`executedActions=[]`（只读保证成立）。★ 实测坑：**HTX 现货与 USDT 永续是两个账户**，不指定 `accountType` 会读到现货的 0（"以为没钱"，会让 sizing 推出 qty=0）——修为 `accountType=swap` 后读到真实永续余额 **24.914 USDT**（无持仓无挂单）。该次"对账一致"是**平凡**的（两边都是 0），非空验证到的是只读链路可用。手册见 `docs/htx-credentials.md`，实测记录见 `docs/htx-preflight-2026-09-15.md`。**第②③步待做**。★ 2026-09-15 实盘前实测：账户 24.914 USDT 在 **1×** 下开不了 BTC/ETH 永续的最小张（1 张名义：BTC≈76.4、ETH≈24.2 USDT），故测试标的池改为**高流动性小额合约** `ADA/USDT:USDT`（≈1.95 USDT/张）与 `DOGE/USDT:USDT`（≈8.0）。另修掉一个只有实盘才会暴露的单位 bug：ccxt 永续 `createOrder` 的 `amount` 与 `fetchPositions` 的 `contracts` 都是**张数**，必须按 `contractSize` 换算（BTC 差 1000×、ADA 差 10×），见 `docs/htx-preflight-2026-09-15.md` 与 commit `e4df59a` |
| B | 测试网（P2 故障注入用） | **OKX demo key**（HTX 在 ccxt 里无 sandbox 端点，OKX 有） | 若用户愿意额外提供 OKX demo key ⇒ 用它承担 §10 P2 的破坏性验收（`kill -9`×50、重复提交、`SIGSTOP`）。**若不愿提供**，替代路径（无需新凭据）：`paper` 模式做全部破坏性测试（幂等/孤儿/恢复已可在本地库验证，见 `scripts/crash-recovery-check.mjs`），HTX 侧只做**只读**验收 + 最小额 `live_confirm` 单笔核对。**不以"没有测试网"为由跳过验收**，只降低破坏性测试的爆炸半径 |
| C | 模型凭据（P1.5 的 LLM 判断臂） | `provider/model` 可用 | 闸门已可运行，B 臂现为**确定性替身** `standInJudge`。换上真通道即可复用同一套闸门，其余不动；首轮判定只说明"闸门可运行且默认降级"，**不是对 W2/W3 的最终判决** |
| D | A/B 触发密度 | 一套真的会成交的计划卡/规则族（或更长窗口） | 实测 92 天仅 16 次触发、1 笔配对成交 ⇒ 即使换上 LLM 通道也算不出有意义的 CI。方案：`ab-gate.mjs` 增加 `--preset high-freq`（多标的、多 tf、更宽入场条件），目标 ≥ 200 次触发 |
| E | `live_auto` 授权 | 人工决定 + 额度 | **2026-09-15 用户明确授权**，以最小仓位（1×、单笔 ≤12 USDT、日亏 ≤1.25）arm；回滚 = 把 `trade-exec.mode` 改回 `paper` |
| F | **desk agent 回合驱动**（阻塞首单） | DSH `ctx.agents.create/resume` 后的 `followup` 必须真的跑出一个回合 | 实测：arm 后 W1 已触发（`audit: w1_wake`）、desk 会话已创建，但会话日志**只有 header**（无 `user/message`/`assistant/message`/工具调用）⇒ 没有计划卡 ⇒ 零下单。`plugins/probe.ts` 的 P0 ⑤ 验收其实是由 **app 自带 root agent** 驱动的，`followup` 对程序内 `create/resume` 的 agent 未必启动回合。修法方向：用 `dsh-agent-loop` 的声明式 `agents` 配置让 loop 接管该会话，或找到正确的驱动入口；**修好前不要重启 live 进程** |
| G | 首轮监督实测抓到的真 bug | 记入本表与 commit | ① `/halt` 读未声明的 `ctx.tradePorts` ⇒ cordis 抛错、plugin tree 加载失败；② **W1 永不触发**：supervisor 每轮把扫描边界跟到 `now`，而 `everyMs` 从边界起算 ⇒ 游标必须在**触发后**推进到 `fireTs`；③ 永续 `amount`/`contracts` 是**张数**，必须按 `contractSize` 换算（BTC 差 1000×）；④ 行情失败被 `void error` 静默吞掉 |

---

## 13. 纪律 `[定]`

1. 任何策略改动先过**离线回放** → `paper` → 测试网 → 实盘。
2. 每次事故写进 `lessons` 并**加一条回归测试**。
3. 回测/模拟/实盘共用**同一份** `gate.ts` 与 `Broker` 接口。
4. 窗口内不改工具集；状态用 C3 **替换**而非追加。
5. 失败与错误状态**逐字保留**，不"擦掉失败"。
6. 审批状态**永不经过摘要**传递；授权只来自结构化硬闸判定。
7. 审计优先：审议过程、规则命中、意图、订单、成交、对账、参数变更**全量落库**，任意 `decision_id` 可回放当时所见。
8. **预测市场是特征，不是真理**：薄市场/宽价差的数据不得进入承诺；pm 永不作为开仓的唯一理由，也永不下单（§4.4 红线）。
