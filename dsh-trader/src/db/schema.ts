/**
 * 权威状态的 DDL（plan.md §4.1）。
 *
 * 不变量（可断言）：
 *   · `order_intents.client_order_id` 唯一 —— 幂等根，重复提交不会重复成交；
 *   · `decisions.content_hash` 唯一 —— 结算后重跑不会追加第二条"教训"；
 *   · `plan_cards` 对每个标的至多一条 active（部分唯一索引）；
 *   · `lessons.decision_id` 唯一 —— 一条决策至多一条反思；
 *   · `audit_events` 只追加（由触发器强制）。
 *
 * markdown 只作只读审计产物；权威数据只在这里。
 */

export const SCHEMA_VERSION = 1

export interface SqliteLike {
  exec(sql: string): unknown
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS bars (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  close_time INTEGER NOT NULL,
  open REAL, high REAL, low REAL, close REAL, volume REAL,
  -- closed = 1 表示已收盘；未收盘 bar 绝不允许进入特征/规则路径（plan §4.3）
  closed INTEGER NOT NULL DEFAULT 1 CHECK (closed IN (0, 1)),
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS features (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS plan_cards (
  plan_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'superseded')),
  window_ends_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE (plan_id, content_hash)
);

-- 同一时刻每个标的恰有一张 active 计划卡（plan §3.1）
CREATE UNIQUE INDEX IF NOT EXISTS plan_one_active_per_symbol
  ON plan_cards (symbol) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  plan_id TEXT,
  decided_at INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  data_fingerprint TEXT,
  model_route TEXT,
  action TEXT NOT NULL CHECK (action IN (
    'open', 'reduce', 'close', 'set_stop', 'set_target', 'set_trailing',
    'cancel_all', 'halt', 'noop', 'no_trade', 'review')),
  size_qty REAL, stop_price REAL, take_profit REAL, confidence REAL,
  rationale TEXT, risk_notes TEXT,
  authority TEXT NOT NULL DEFAULT 'model' CHECK (authority IN ('model', 'store', 'external')),
  executed INTEGER NOT NULL DEFAULT 0 CHECK (executed IN (0, 1)),
  reflection_due_at INTEGER,
  outcome_id TEXT,
  -- 成本是一等指标（plan §8）：每次决策记 token/耗时/触发来源；缺价目时 cost_known=0
  tokens_in INTEGER, tokens_out INTEGER, tokens_cached INTEGER,
  cost_usd REAL, cost_known INTEGER CHECK (cost_known IN (0, 1) OR cost_known IS NULL),
  duration_ms INTEGER, trigger_source TEXT
);

CREATE INDEX IF NOT EXISTS decisions_pending_settlement
  ON decisions (reflection_due_at) WHERE outcome_id IS NULL;

-- 结算结果（plan §7.9）：**交易级**净额，一条决策至多一次结算
CREATE TABLE IF NOT EXISTS outcomes (
  outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions (decision_id),
  symbol TEXT NOT NULL,
  settled_at INTEGER NOT NULL,
  horizon_ms INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  realized_gross_pct REAL NOT NULL,
  realized_net_pct REAL NOT NULL,
  benchmark_pct REAL NOT NULL,
  alpha_pct REAL NOT NULL,
  mfe_pct REAL NOT NULL,
  mae_pct REAL NOT NULL,
  stop_hit INTEGER NOT NULL DEFAULT 0 CHECK (stop_hit IN (0, 1)),
  fees_quote REAL NOT NULL DEFAULT 0,
  evidence_refs_json TEXT NOT NULL
);

-- 上下文组装快照（plan §5.1 / T1.5）：让 ctxHash 可复现、changedParts 可审计
CREATE TABLE IF NOT EXISTS context_snapshots (
  ctx_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  symbol TEXT,
  -- {C1: "sha256:..", C2: ...}；C6 永不入 context，因此不出现
  part_hashes_json TEXT NOT NULL,
  changed_parts_json TEXT NOT NULL,
  char_counts_json TEXT NOT NULL,
  overflow_json TEXT NOT NULL DEFAULT '[]'
);

-- 唯一闸门：只有通过硬闸的意图才会写入这里
CREATE TABLE IF NOT EXISTS order_intents (
  intent_id TEXT PRIMARY KEY,
  client_order_id TEXT NOT NULL UNIQUE,
  decision_id TEXT REFERENCES decisions (decision_id),
  venue TEXT NOT NULL,
  symbol TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('created', 'acked', 'rejected', 'unknown', 'canceled', 'filled')),
  type TEXT, side TEXT, qty REAL, price REAL, stop_price REAL,
  notional_usd REAL,
  reduce_only INTEGER NOT NULL DEFAULT 0 CHECK (reduce_only IN (0, 1)),
  params_json TEXT,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  exchange_order_id TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  exchange_order_id TEXT,
  client_order_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL,
  qty REAL, filled_qty REAL NOT NULL DEFAULT 0, avg_price REAL,
  updated_at INTEGER NOT NULL,
  UNIQUE (venue, exchange_order_id)
);

CREATE TABLE IF NOT EXISTS fills (
  fill_id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders (order_id),
  qty REAL NOT NULL, price REAL NOT NULL,
  fee REAL, fee_ccy TEXT,
  ts INTEGER NOT NULL,
  UNIQUE (order_id, ts, qty)          -- 交易所重复推送的兜底
);

CREATE TABLE IF NOT EXISTS lessons (
  lesson_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE,   -- 一条决策至多一条反思
  text TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,   -- 证据指针：可被推翻
  regime_bucket TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS triggers (
  trigger_id TEXT PRIMARY KEY,
  dedup_key TEXT NOT NULL UNIQUE,
  symbol TEXT,
  rule_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('invalidation', 'commitment', 'novelty', 'info')),
  bar_ts INTEGER,
  payload_json TEXT NOT NULL,
  -- 最终去向：只有 novelty/judgment 消耗唤醒预算（被冷却/限流压掉的不算，但仍落库可审计）
  disposition TEXT NOT NULL CHECK (disposition IN ('info', 'novelty', 'judgment', 'cooldown', 'rate_limited', 'executed')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('model', 'human', 'system')),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
  BEFORE UPDATE ON audit_events BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
  END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
  BEFORE DELETE ON audit_events BEGIN
    SELECT RAISE(ABORT, 'audit_events is append-only');
  END;

CREATE TABLE IF NOT EXISTS config_versions (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  author TEXT NOT NULL,               -- 'human' | 'system'
  waiver INTEGER NOT NULL DEFAULT 0 CHECK (waiver IN (0, 1)),
  params_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_table (
  model TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  -- 峰谷档位：官方价目分峰/谷（谷时=峰时÷2），any 为不分峰谷的兜底行
  tier TEXT NOT NULL DEFAULT 'any' CHECK (tier IN ('any', 'peak', 'off_peak')),
  in_per_mtok REAL NOT NULL,
  out_per_mtok REAL NOT NULL,
  cached_in_per_mtok REAL,
  source TEXT,
  PRIMARY KEY (model, effective_from, tier)
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  est_usd REAL NOT NULL DEFAULT 0,
  -- 默认 0（未知）而非 1：与 plan §4.1 的 DDL 一致，且"缺价目"必须 fail-closed
  cost_known INTEGER NOT NULL DEFAULT 0 CHECK (cost_known IN (0, 1)),
  PRIMARY KEY (day, scope)
);

-- ── 预测市场（Polymarket）事件源：只读，永不交易（plan §4.4）──────────────────
CREATE TABLE IF NOT EXISTS pm_markets (
  condition_id TEXT PRIMARY KEY,
  market_id TEXT,
  slug TEXT NOT NULL,
  question TEXT NOT NULL,
  event_id TEXT,
  event_slug TEXT,
  tags_json TEXT,
  outcomes_json TEXT NOT NULL,
  token_ids_json TEXT NOT NULL,
  neg_risk INTEGER NOT NULL DEFAULT 0 CHECK (neg_risk IN (0, 1)),
  -- 源时间：市场创建时刻（存在门控用；回放不得引用当时不存在的市场）
  created_at INTEGER NOT NULL,
  start_date INTEGER,
  end_date INTEGER,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed IN (0, 1)),
  -- 结算门控：winning_outcome 只在 resolved_at <= now 之后才允许被读出
  resolved_at INTEGER,
  winning_outcome TEXT,
  liquidity_num REAL,
  volume24h REAL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pm_markets_slug ON pm_markets (slug);
CREATE INDEX IF NOT EXISTS pm_markets_open ON pm_markets (closed, end_date);

-- 概率序列：PIT 回放的唯一合法来源（ts 为毫秒整数；源为秒，边界 ×1000）
CREATE TABLE IF NOT EXISTS pm_series (
  token_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price REAL NOT NULL,
  resolution_seconds INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, ts, resolution_seconds)
) WITHOUT ROWID;

-- 盘口/流动性快照：novelty 告警必须先过流动性门槛
CREATE TABLE IF NOT EXISTS pm_quotes (
  token_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  best_bid REAL, best_ask REAL, mid REAL, spread REAL,
  last_trade_price REAL, volume24h REAL, liquidity REAL,
  PRIMARY KEY (token_id, observed_at)
) WITHOUT ROWID;

-- LLM 设定的"关心事件/提醒"：结构化、有期限、有上限
CREATE TABLE IF NOT EXISTS pm_watches (
  watch_id TEXT PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,                 -- 供 when DSL 引用：pm.<alias>.*
  content_hash TEXT NOT NULL UNIQUE,          -- 重复登记同一规格 = 幂等 no-op
  kind TEXT NOT NULL CHECK (kind IN ('threshold', 'topic', 'resolution', 'liquidity')),
  expr TEXT,                                  -- threshold 必填；v0 DSL，布尔
  token_ids_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  query TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('novelty', 'info', 'commitment')),
  plan_id TEXT,
  cooldown_ms INTEGER NOT NULL DEFAULT 900000,
  max_triggers INTEGER NOT NULL DEFAULT 10,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,                -- 必填：不允许无期限关注
  state TEXT NOT NULL CHECK (state IN ('active', 'expired', 'disabled')),
  created_by TEXT NOT NULL CHECK (created_by IN ('model', 'human')),
  created_at INTEGER NOT NULL,
  last_fired_at INTEGER
);

CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  beat_at INTEGER NOT NULL,
  halted INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0, 1))
);
`

/**
 * 建表（幂等）。`PRAGMA journal_mode = WAL` 必须在事务外执行，
 * 且多进程（主进程 + 外部 watchdog）读写依赖 WAL。
 */
export function migrate(db: SqliteLike): void {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
}
