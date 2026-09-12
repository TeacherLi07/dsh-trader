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
  outcome_id TEXT
);

CREATE INDEX IF NOT EXISTS decisions_pending_settlement
  ON decisions (reflection_due_at) WHERE outcome_id IS NULL;

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
  in_per_mtok REAL NOT NULL,
  out_per_mtok REAL NOT NULL,
  cached_in_per_mtok REAL,
  source TEXT,
  PRIMARY KEY (model, effective_from)
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  est_usd REAL NOT NULL DEFAULT 0,
  cost_known INTEGER NOT NULL DEFAULT 1 CHECK (cost_known IN (0, 1)),
  PRIMARY KEY (day, scope)
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
