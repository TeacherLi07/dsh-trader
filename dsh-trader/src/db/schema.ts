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

/**
 * 版本号不是“当前代码能建出的表”的装饰：线上旧库必须先经过同一条、可重复的
 * migration 链，才能继续被 runtime 使用。v5 把完整 DecisionContext 与 decision run
 * 正式纳入版本边界；v6 增加双时间、只追加的行情观测归档；v7 为 W2/W3 触发队列增加
 * 有界重试、退避和重启恢复；v8 让结算成本/基准可显式未知并记录估值类型；v9 为 PM 元数据保存按本机获知时间回放的 append-only 版本；v10 为 PM 盘口补本机可用时刻。
 */
export const SCHEMA_VERSION = 10

export interface SqliteLike {
  exec(sql: string): unknown
  /** 仅增量迁移探测列时用到；测试用的假实现可以不给。 */
  prepare?(sql: string): { all(...params: unknown[]): unknown[] }
}

export const SCHEMA_SQL = `
-- 当前投影会被修订覆盖；判断必须从双时间的不可变观测取数，不能把回补时间冒充历史可见时间。
CREATE TABLE IF NOT EXISTS market_observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('bar', 'feature', 'derivatives', 'spec')),
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  event_time INTEGER NOT NULL CHECK (event_time >= 0),
  available_at INTEGER NOT NULL CHECK (available_at >= event_time),
  source TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (kind, symbol, timeframe, event_time, available_at, fingerprint)
);
CREATE INDEX IF NOT EXISTS market_observations_pit
  ON market_observations (kind, symbol, timeframe, event_time DESC, available_at DESC);
CREATE TRIGGER IF NOT EXISTS market_observations_no_update
  BEFORE UPDATE ON market_observations BEGIN
    SELECT RAISE(ABORT, 'market_observations is append-only');
  END;
CREATE TRIGGER IF NOT EXISTS market_observations_no_delete
  BEFORE DELETE ON market_observations BEGIN
    SELECT RAISE(ABORT, 'market_observations is append-only');
  END;

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

-- bars 已归档不等于已完成特征/规则/机械执行；该游标在回调成功后才推进，
-- 让回调失败、进程重启或执行组合尚未就绪时可以从同一根 bar 幂等重试。
CREATE TABLE IF NOT EXISTS bar_processing (
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time INTEGER NOT NULL,
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (symbol, timeframe, open_time),
  FOREIGN KEY (symbol, timeframe, open_time)
    REFERENCES bars (symbol, timeframe, open_time)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bar_processing_lookup
  ON bar_processing (symbol, timeframe, open_time);

-- 一次判断的事实根：canonical_json 保存模型实际可见的完整上下文；大对象只有在不可变
-- 外部存储已登记时才允许用 content_ref，二者必须恰有一个，避免只存一个无法复算的 hash。
CREATE TABLE IF NOT EXISTS decision_contexts (
  context_id TEXT PRIMARY KEY,
  context_hash TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  primary_timeframe TEXT NOT NULL CHECK (primary_timeframe = '1h'),
  as_of INTEGER NOT NULL,
  canonical_json TEXT,
  content_ref TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((canonical_json IS NULL) <> (content_ref IS NULL)),
  UNIQUE (context_id, context_hash)
);

-- 一轮固定的 Strategist→RiskCritic→Strategist 判断根。中间工件与成本都挂在这里，
-- 不再用一次性 token 把“曾经跑过”与“实际跑了什么”混成两个无法对拍的状态。
CREATE TABLE IF NOT EXISTS decision_runs (
  run_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  symbol TEXT NOT NULL,
  primary_timeframe TEXT NOT NULL CHECK (primary_timeframe = '1h'),
  trigger_source TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'review', 'failed')),
  draft_json TEXT,
  critique_json TEXT,
  final_json TEXT,
  eligibility_json TEXT,
  model_version TEXT,
  prompt_version TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  cost_usd REAL,
  cost_known INTEGER CHECK (cost_known IN (0, 1) OR cost_known IS NULL),
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  FOREIGN KEY (context_id, context_hash)
    REFERENCES decision_contexts (context_id, context_hash)
);
CREATE INDEX IF NOT EXISTS decision_runs_context_lookup
  ON decision_runs (context_hash, symbol, status, created_at);
CREATE TRIGGER IF NOT EXISTS decision_runs_terminal_no_update
  BEFORE UPDATE ON decision_runs
  WHEN OLD.status IN ('completed', 'review', 'failed') BEGIN
    SELECT RAISE(ABORT, 'decision run is terminal');
  END;

CREATE TABLE IF NOT EXISTS plan_cards (
  plan_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES decision_runs (run_id),
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
  run_id TEXT REFERENCES decision_runs (run_id),
  symbol TEXT NOT NULL,
  -- 决策所属时间框：结算要按它取 bar 窗口。没有它就无法在多 tf 下正确结算
  --（旧实现只有一个全局 tf，会把 1h 决策用 4h 的窗口结算）。
  timeframe TEXT,
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

-- 结算结果（plan §7）：未知成本/基准保留 NULL，且不混淆真实成交、视界估值和 paper simulation
CREATE TABLE IF NOT EXISTS outcomes (
  outcome_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL UNIQUE REFERENCES decisions (decision_id),
  symbol TEXT NOT NULL,
  settled_at INTEGER NOT NULL,
  horizon_ms INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  realized_gross_pct REAL NOT NULL,
  realized_net_pct REAL,
  benchmark_pct REAL,
  alpha_pct REAL,
  mfe_pct REAL NOT NULL,
  mae_pct REAL NOT NULL,
  stop_hit INTEGER NOT NULL DEFAULT 0 CHECK (stop_hit IN (0, 1)),
  fees_quote REAL,
  -- 正数为支付、负数为收入；NULL 表示区间资金费未被核验，不能伪装成零
  funding_fee_quote REAL,
  funding_source TEXT,
  settlement_kind TEXT NOT NULL CHECK (settlement_kind IN ('realized', 'horizon_mark', 'paper_simulation', 'legacy_unknown')),
  valuation_basis TEXT NOT NULL CHECK (valuation_basis IN ('actual_exit_fills', 'horizon_mark', 'legacy_unknown')),
  attributed_qty REAL CHECK (attributed_qty IS NULL OR attributed_qty > 0),
  evidence_refs_json TEXT NOT NULL,
  CHECK ((funding_fee_quote IS NULL AND funding_source IS NULL) OR
         (funding_fee_quote IS NOT NULL AND funding_source IS NOT NULL AND length(trim(funding_source)) > 0))
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
  state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done', 'expired', 'failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  last_error TEXT
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

-- 当前 pm_markets 投影会被 upsert 覆盖；历史 PIT 必须读取当时本机已获知的元数据版本。
CREATE TABLE IF NOT EXISTS pm_market_versions (
  version_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_id TEXT NOT NULL,
  available_at INTEGER NOT NULL CHECK (available_at >= 0),
  market_id TEXT,
  slug TEXT NOT NULL,
  question TEXT NOT NULL,
  event_id TEXT,
  event_slug TEXT,
  tags_json TEXT,
  outcomes_json TEXT NOT NULL,
  token_ids_json TEXT NOT NULL,
  neg_risk INTEGER NOT NULL CHECK (neg_risk IN (0, 1)),
  created_at INTEGER NOT NULL,
  start_date INTEGER,
  end_date INTEGER,
  closed INTEGER NOT NULL CHECK (closed IN (0, 1)),
  resolved_at INTEGER,
  winning_outcome TEXT,
  liquidity_num REAL,
  volume24h REAL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  revision_fingerprint TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pm_market_versions_pit
  ON pm_market_versions (condition_id, available_at DESC, version_seq DESC);
CREATE TRIGGER IF NOT EXISTS pm_market_versions_no_update
  BEFORE UPDATE ON pm_market_versions BEGIN
    SELECT RAISE(ABORT, 'pm_market_versions is append-only');
  END;
CREATE TRIGGER IF NOT EXISTS pm_market_versions_no_delete
  BEFORE DELETE ON pm_market_versions BEGIN
    SELECT RAISE(ABORT, 'pm_market_versions is append-only');
  END;

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
  -- 上游 source event time 与本机收到响应的时刻分开；旧行 NULL 代表接收时刻未知，PIT 隐藏。
  available_at INTEGER CHECK (available_at IS NULL OR available_at >= 0),
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

-- W1 窗口的持久游标与待处理 fire。cursor 只在 fire 完成后推进，重启不会漂移 everyMs 锚点。
CREATE TABLE IF NOT EXISTS supervisor_window_cursors (
  window_id TEXT PRIMARY KEY,
  cursor_ts INTEGER NOT NULL,
  anchor_ts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS supervisor_windows (
  window_id TEXT NOT NULL,
  fire_ts INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (window_id, fire_ts)
);
CREATE INDEX IF NOT EXISTS supervisor_windows_pending
  ON supervisor_windows (state, fire_ts, window_id);

CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  beat_at INTEGER NOT NULL,
  halted INTEGER NOT NULL DEFAULT 0 CHECK (halted IN (0, 1))
);
`

/**
 * 建表（幂等）。`PRAGMA journal_mode = WAL` 必须在事务外执行；WAL 让 dsh 崩溃后重启恢复
 * 时的提交与读取保持可恢复，不代表项目有第二个 watchdog 进程。
 */
export function migrate(db: SqliteLike): void {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  const fromVersion = readUserVersion(db)
  if (fromVersion > SCHEMA_VERSION) {
    throw new Error(`数据库 schema 版本 ${fromVersion} 高于当前代码 ${SCHEMA_VERSION}，拒绝降级启动`)
  }
  db.exec(SCHEMA_SQL)
  // user_version 是主路由，但列探测仍保留：旧测试/运维工具可能在 version 已更新后
  // 手工恢复了半旧表形状，启动时仍应 fail-closed 修复而不是等热路径报 no such column。
  if (fromVersion < 4 || needsV4Repair(db)) migrateToV4(db)
  if (fromVersion < 5 || needsV5Repair(db)) migrateToV5(db)
  if (fromVersion < 7 || needsV7Repair(db)) migrateToV7(db)
  if (fromVersion < 8 || needsV8Repair(db)) migrateToV8(db)
  if (fromVersion < 9 || needsV9Repair(db)) migrateToV9(db)
  if (fromVersion < 10 || needsV10Repair(db)) migrateToV10(db)
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
}

/** 只从 SQLite user_version 取版本；没有 prepare 的极简 fake 视作初始库。 */
function readUserVersion(db: SqliteLike): number {
  if (db.prepare === undefined) return 0
  const rows = db.prepare('PRAGMA user_version').all() as { user_version?: unknown }[]
  const value = rows[0]?.user_version
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * v4 历史修复：早期版本只把新增列补到了 decisions，遗漏了已有表的形状变化。
 * 所有重建均在一个 SQLite 事务内完成；旧行先复制到新表，再切换表名，失败即回滚。
 */
function migrateToV4(db: SqliteLike): void {
  if (db.prepare === undefined) return

  // v2/v3 曾只给新库写这些列；老库必须逐列补齐，且每列探测都可重复执行。
  const decisionColumns: readonly [string, string][] = [
    ['timeframe', 'ALTER TABLE decisions ADD COLUMN timeframe TEXT;'],
    ['tokens_in', 'ALTER TABLE decisions ADD COLUMN tokens_in INTEGER;'],
    ['tokens_out', 'ALTER TABLE decisions ADD COLUMN tokens_out INTEGER;'],
    ['tokens_cached', 'ALTER TABLE decisions ADD COLUMN tokens_cached INTEGER;'],
    ['cost_usd', 'ALTER TABLE decisions ADD COLUMN cost_usd REAL;'],
    ['cost_known', 'ALTER TABLE decisions ADD COLUMN cost_known INTEGER;'],
    ['duration_ms', 'ALTER TABLE decisions ADD COLUMN duration_ms INTEGER;'],
    ['trigger_source', 'ALTER TABLE decisions ADD COLUMN trigger_source TEXT;'],
  ]
  for (const [column, sql] of decisionColumns) {
    if (!hasColumn(db, 'decisions', column)) db.exec(sql)
  }

  if (!hasColumn(db, 'triggers', 'disposition')) {
    db.exec(
      "ALTER TABLE triggers ADD COLUMN disposition TEXT NOT NULL DEFAULT 'info' " +
        "CHECK (disposition IN ('info', 'novelty', 'judgment', 'cooldown', 'rate_limited', 'executed'));",
    )
    db.exec(
      `UPDATE triggers
       SET disposition = CASE
         WHEN purpose = 'novelty' THEN 'novelty'
         WHEN purpose IN ('commitment', 'invalidation') THEN 'judgment'
         ELSE 'info'
       END
       WHERE disposition = 'info' AND purpose <> 'info'`,
    )
  }

  if (needsPriceTableRebuild(db)) {
    withMigrationTransaction(db, () => {
      db.exec(`
        CREATE TABLE price_table_v4 (
          model TEXT NOT NULL,
          effective_from INTEGER NOT NULL,
          tier TEXT NOT NULL DEFAULT 'any' CHECK (tier IN ('any', 'peak', 'off_peak')),
          in_per_mtok REAL NOT NULL,
          out_per_mtok REAL NOT NULL,
          cached_in_per_mtok REAL,
          source TEXT,
          PRIMARY KEY (model, effective_from, tier)
        );
        INSERT INTO price_table_v4
          (model, effective_from, tier, in_per_mtok, out_per_mtok, cached_in_per_mtok, source)
        SELECT model, effective_from, 'any', in_per_mtok, out_per_mtok, cached_in_per_mtok, source
        FROM price_table;
        DROP TABLE price_table;
        ALTER TABLE price_table_v4 RENAME TO price_table;
      `)
    })
  }

  if (needsBudgetLedgerRebuild(db)) {
    withMigrationTransaction(db, () => {
      db.exec(`
        CREATE TABLE budget_ledger_v4 (
          day TEXT NOT NULL,
          scope TEXT NOT NULL,
          tokens_in INTEGER NOT NULL DEFAULT 0,
          tokens_out INTEGER NOT NULL DEFAULT 0,
          tokens_cached INTEGER NOT NULL DEFAULT 0,
          est_usd REAL NOT NULL DEFAULT 0,
          cost_known INTEGER NOT NULL DEFAULT 0 CHECK (cost_known IN (0, 1)),
          PRIMARY KEY (day, scope)
        );
        INSERT INTO budget_ledger_v4
          (day, scope, tokens_in, tokens_out, tokens_cached, est_usd, cost_known)
        SELECT day, scope, tokens_in, tokens_out, tokens_cached, est_usd, cost_known
        FROM budget_ledger;
        DROP TABLE budget_ledger;
        ALTER TABLE budget_ledger_v4 RENAME TO budget_ledger;
      `)
    })
  }
}

/**
 * v5 把判断上下文从“只存部件 hash”升级为全文根，并移除一次性 workflow token。
 * 旧表无法还原完整 context，继续保留它反而会让读取方误以为可回放，因此迁移只清理
 * 旧表；历史审计若需保留，应在升级前由运维导出，而不是在新 runtime 中继续读旧协议。
 */
function migrateToV5(db: SqliteLike): void {
  if (db.prepare === undefined) return

  if (!hasColumn(db, 'decisions', 'run_id')) {
    db.exec('ALTER TABLE decisions ADD COLUMN run_id TEXT REFERENCES decision_runs (run_id);')
  }
  if (!hasColumn(db, 'plan_cards', 'run_id')) {
    db.exec('ALTER TABLE plan_cards ADD COLUMN run_id TEXT REFERENCES decision_runs (run_id);')
  }

  // 这两张表只承载已废弃协议的短暂状态，不能出现在 v5 的可运行 schema 中。
  db.exec('DROP TABLE IF EXISTS workflow_contexts;')
  db.exec('DROP TABLE IF EXISTS context_snapshots;')
}

function needsV4Repair(db: SqliteLike): boolean {
  const decisionColumns = [
    'timeframe',
    'tokens_in',
    'tokens_out',
    'tokens_cached',
    'cost_usd',
    'cost_known',
    'duration_ms',
    'trigger_source',
  ]
  return (
    decisionColumns.some((column) => !hasColumn(db, 'decisions', column)) ||
    !hasColumn(db, 'triggers', 'disposition') ||
    needsPriceTableRebuild(db) ||
    needsBudgetLedgerRebuild(db)
  )
}

function needsV5Repair(db: SqliteLike): boolean {
  return !hasColumn(db, 'decisions', 'run_id') || !hasColumn(db, 'plan_cards', 'run_id') || hasTable(db, 'workflow_contexts') || hasTable(db, 'context_snapshots')
}

/** v7 为持久触发队列补上有限重试；旧 claimed 行只能安全地回到 queued。 */
function migrateToV7(db: SqliteLike): void {
  if (db.prepare === undefined) return
  const needsRebuild = needsV7Repair(db)
  if (needsRebuild) {
    const hasDisposition = hasColumn(db, 'triggers', 'disposition')
    const hasAttempts = hasColumn(db, 'triggers', 'attempts')
    const hasNextAttemptAt = hasColumn(db, 'triggers', 'next_attempt_at')
    const hasClaimedAt = hasColumn(db, 'triggers', 'claimed_at')
    const hasLastError = hasColumn(db, 'triggers', 'last_error')
    const disposition = hasDisposition
      ? 'disposition'
      : `CASE WHEN purpose = 'novelty' THEN 'novelty'
             WHEN purpose IN ('commitment', 'invalidation') THEN 'judgment'
             ELSE 'info' END`
    const attempts = hasAttempts ? 'attempts' : '0'
    const nextAttemptAt = hasNextAttemptAt ? 'next_attempt_at' : 'created_at'
    const claimedAt = hasClaimedAt ? 'claimed_at' : 'NULL'
    const lastError = hasLastError ? 'last_error' : 'NULL'

    withMigrationTransaction(db, () => {
      db.exec(`
        CREATE TABLE triggers_v7 (
          trigger_id TEXT PRIMARY KEY,
          dedup_key TEXT NOT NULL UNIQUE,
          symbol TEXT,
          rule_id TEXT,
          purpose TEXT NOT NULL CHECK (purpose IN ('invalidation', 'commitment', 'novelty', 'info')),
          bar_ts INTEGER,
          payload_json TEXT NOT NULL,
          disposition TEXT NOT NULL CHECK (disposition IN ('info', 'novelty', 'judgment', 'cooldown', 'rate_limited', 'executed')),
          state TEXT NOT NULL CHECK (state IN ('queued', 'claimed', 'done', 'expired', 'failed')),
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          claimed_at INTEGER,
          last_error TEXT
        );
        INSERT INTO triggers_v7
          (trigger_id, dedup_key, symbol, rule_id, purpose, bar_ts, payload_json,
           disposition, state, created_at, expires_at, attempts, next_attempt_at, claimed_at, last_error)
        SELECT trigger_id, dedup_key, symbol, rule_id, purpose, bar_ts, payload_json,
          ${disposition},
          CASE WHEN state = 'claimed' THEN 'queued' ELSE state END,
          created_at, expires_at, ${attempts}, ${nextAttemptAt}, NULL, ${lastError}
        FROM triggers;
        DROP TABLE triggers;
        ALTER TABLE triggers_v7 RENAME TO triggers;
      `)
    })
  }
  db.exec(`CREATE INDEX IF NOT EXISTS triggers_claimable
    ON triggers (state, next_attempt_at, created_at, trigger_id);`)
}

/** v8 让结算结果保留成本/基准未知状态，并为历史算法不明的 outcome 标记 legacy_unknown。 */
function migrateToV8(db: SqliteLike): void {
  if (db.prepare === undefined || !needsV8Repair(db)) return

  const has = (column: string): boolean => hasColumn(db, 'outcomes', column)
  const existingOr = (column: string, fallback: string): string => (has(column) ? column : fallback)
  // v7 只保存了 benchmark 的最后一个 bar，且缺数时可能把 0 当结果；无法证明两端
  // 时间窗与标的行情对齐。只有已包含 v8 成本/估值合同的半迁移表才可保留可核验基准。
  const hasV8SettlementContract = has('funding_fee_quote') && has('funding_source') &&
    has('settlement_kind') && has('valuation_basis') && has('evidence_refs_json')
  const benchmark = has('benchmark_pct') && hasV8SettlementContract
    ? `CASE WHEN evidence_refs_json LIKE '%benchmark:unavailable%' OR
         (length(evidence_refs_json) - length(replace(evidence_refs_json, 'bar:benchmark:', ''))) <
           2 * length('bar:benchmark:') THEN NULL ELSE benchmark_pct END`
    : 'NULL'
  // v7 没有资金费字段；即便旧计算给出了 net，也不能把未采集的资金费默认为 0。
  const realizedNet = has('funding_fee_quote') && has('funding_source')
    ? `CASE WHEN funding_fee_quote IS NULL OR funding_source IS NULL THEN NULL ELSE ${existingOr('realized_net_pct', 'NULL')} END`
    : 'NULL'
  const alpha = has('alpha_pct')
    ? `CASE WHEN (${benchmark}) IS NULL OR (${realizedNet}) IS NULL THEN NULL ELSE alpha_pct END`
    : 'NULL'

  withMigrationTransaction(db, () => {
    db.exec(`
      CREATE TABLE outcomes_v8 (
        outcome_id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL UNIQUE REFERENCES decisions (decision_id),
        symbol TEXT NOT NULL,
        settled_at INTEGER NOT NULL,
        horizon_ms INTEGER NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        realized_gross_pct REAL NOT NULL,
        realized_net_pct REAL,
        benchmark_pct REAL,
        alpha_pct REAL,
        mfe_pct REAL NOT NULL,
        mae_pct REAL NOT NULL,
        stop_hit INTEGER NOT NULL DEFAULT 0 CHECK (stop_hit IN (0, 1)),
        fees_quote REAL,
        funding_fee_quote REAL,
        funding_source TEXT,
        settlement_kind TEXT NOT NULL CHECK (settlement_kind IN ('realized', 'horizon_mark', 'paper_simulation', 'legacy_unknown')),
        valuation_basis TEXT NOT NULL CHECK (valuation_basis IN ('actual_exit_fills', 'horizon_mark', 'legacy_unknown')),
        attributed_qty REAL CHECK (attributed_qty IS NULL OR attributed_qty > 0),
        evidence_refs_json TEXT NOT NULL,
        CHECK ((funding_fee_quote IS NULL AND funding_source IS NULL) OR
               (funding_fee_quote IS NOT NULL AND funding_source IS NOT NULL AND length(trim(funding_source)) > 0))
      );
      INSERT INTO outcomes_v8
        (outcome_id, decision_id, symbol, settled_at, horizon_ms, entry_price, exit_price,
         realized_gross_pct, realized_net_pct, benchmark_pct, alpha_pct, mfe_pct, mae_pct,
         stop_hit, fees_quote, funding_fee_quote, funding_source, settlement_kind,
         valuation_basis, attributed_qty, evidence_refs_json)
      SELECT outcome_id, decision_id, symbol, settled_at, horizon_ms, entry_price, exit_price,
         ${existingOr('realized_gross_pct', '0')}, ${realizedNet},
         ${benchmark}, ${alpha}, ${existingOr('mfe_pct', '0')}, ${existingOr('mae_pct', '0')},
         ${existingOr('stop_hit', '0')}, ${existingOr('fees_quote', '0')},
         ${existingOr('funding_fee_quote', 'NULL')}, ${existingOr('funding_source', 'NULL')},
         ${existingOr('settlement_kind', "'legacy_unknown'")},
         ${existingOr('valuation_basis', "'legacy_unknown'")},
         ${existingOr('attributed_qty', 'NULL')}, ${existingOr('evidence_refs_json', "'[]'")}
      FROM outcomes;
      DROP TABLE outcomes;
      ALTER TABLE outcomes_v8 RENAME TO outcomes;
    `)
  })
}

/**
 * v9 为可变的 pm_markets 当前投影补历史版本。旧库只有最后状态可核验，因此只从
 * max(observed_at, first_seen_at) 起暴露该状态；绝不把它回填成更早已知的历史。
 */
function migrateToV9(db: SqliteLike): void {
  if (db.prepare === undefined) return
  withMigrationTransaction(db, () => {
    db.exec(`
      INSERT INTO pm_market_versions (
        condition_id, available_at, market_id, slug, question, event_id, event_slug, tags_json,
        outcomes_json, token_ids_json, neg_risk, created_at, start_date, end_date, closed,
        resolved_at, winning_outcome, liquidity_num, volume24h, first_seen_at, last_seen_at,
        observed_at, revision_fingerprint
      )
      SELECT condition_id,
        CASE WHEN observed_at >= first_seen_at THEN observed_at ELSE first_seen_at END,
        market_id, slug, question, event_id, event_slug, tags_json,
        outcomes_json, token_ids_json, neg_risk, created_at, start_date, end_date, closed,
        resolved_at, winning_outcome, liquidity_num, volume24h, first_seen_at, last_seen_at,
        CASE WHEN observed_at >= first_seen_at THEN observed_at ELSE first_seen_at END,
        'legacy-v8:' || condition_id || ':' || observed_at
      FROM pm_markets
      WHERE NOT EXISTS (
        SELECT 1 FROM pm_market_versions v WHERE v.condition_id = pm_markets.condition_id
      ) AND 1;
    `)
  })
}

function needsV9Repair(db: SqliteLike): boolean {
  const columns = [
    'version_seq', 'condition_id', 'available_at', 'market_id', 'slug', 'question', 'event_id',
    'event_slug', 'tags_json', 'outcomes_json', 'token_ids_json', 'neg_risk', 'created_at',
    'start_date', 'end_date', 'closed', 'resolved_at', 'winning_outcome', 'liquidity_num',
    'volume24h', 'first_seen_at', 'last_seen_at', 'observed_at', 'revision_fingerprint',
  ]
  if (columns.some((column) => !hasColumn(db, 'pm_market_versions', column))) return true
  if (db.prepare === undefined) return false
  return db.prepare(`SELECT 1 FROM pm_markets m
    WHERE NOT EXISTS (
      SELECT 1 FROM pm_market_versions v WHERE v.condition_id = m.condition_id
    ) LIMIT 1`).all().length !== 0
}

/** v10 给 PM quote 增加本机可用时刻；旧行保持 NULL，不能推测历史接收时间。 */
function migrateToV10(db: SqliteLike): void {
  if (db.prepare === undefined) return
  withMigrationTransaction(db, () => {
    if (!hasColumn(db, 'pm_quotes', 'available_at')) {
      db.exec('ALTER TABLE pm_quotes ADD COLUMN available_at INTEGER CHECK (available_at IS NULL OR available_at >= 0);')
    }
    db.exec(`CREATE INDEX IF NOT EXISTS pm_quotes_pit
      ON pm_quotes (token_id, available_at, observed_at DESC);`)
  })
}

function needsV10Repair(db: SqliteLike): boolean {
  if (!hasColumn(db, 'pm_quotes', 'available_at')) return true
  if (db.prepare === undefined) return false
  return db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type = 'index' AND name = 'pm_quotes_pit'`).all().length === 0
}

function needsV8Repair(db: SqliteLike): boolean {
  const rows = tableInfo(db, 'outcomes')
  const nullable = new Set([
    'realized_net_pct', 'benchmark_pct', 'alpha_pct', 'fees_quote',
    'funding_fee_quote', 'funding_source', 'attributed_qty',
  ])
  return (
    ['realized_net_pct', 'benchmark_pct', 'alpha_pct', 'fees_quote', 'funding_fee_quote', 'funding_source',
      'settlement_kind', 'valuation_basis', 'attributed_qty']
      .some((column) => !rows.some((row) => row.name === column)) ||
    rows.some((row) => nullable.has(String(row.name)) && row.notnull === 1)
  )
}

function needsV7Repair(db: SqliteLike): boolean {
  const columns = ['attempts', 'next_attempt_at', 'claimed_at', 'last_error']
  if (columns.some((column) => !hasColumn(db, 'triggers', column))) return true
  const row = db.prepare?.("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'triggers'").all()[0] as
    | { sql?: unknown }
    | undefined
  return typeof row?.sql !== 'string' || !row.sql.includes("'failed'")
}

function tableInfo(db: SqliteLike, table: string): { name?: unknown; pk?: unknown; dflt_value?: unknown; notnull?: unknown }[] {
  if (db.prepare === undefined) return []
  return db.prepare(`PRAGMA table_info(${table})`).all() as {
    name?: unknown
    pk?: unknown
    dflt_value?: unknown
    notnull?: unknown
  }[]
}

function hasColumn(db: SqliteLike, table: string, column: string): boolean {
  return tableInfo(db, table).some((row) => row.name === column)
}

function hasTable(db: SqliteLike, table: string): boolean {
  if (db.prepare === undefined) return false
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").all(table).length > 0
}

function needsPriceTableRebuild(db: SqliteLike): boolean {
  const rows = tableInfo(db, 'price_table')
  const tier = rows.find((row) => row.name === 'tier')
  return tier === undefined || tier.pk !== 3
}

function needsBudgetLedgerRebuild(db: SqliteLike): boolean {
  const row = tableInfo(db, 'budget_ledger').find((item) => item.name === 'cost_known')
  return row?.dflt_value !== '0'
}

function withMigrationTransaction(db: SqliteLike, work: () => void): void {
  db.exec('BEGIN IMMEDIATE;')
  try {
    work()
    db.exec('COMMIT;')
  } catch (error) {
    try {
      db.exec('ROLLBACK;')
    } catch {
      // 保留原始 migration 错误；回滚失败也不能伪装成功。
    }
    throw error
  }
}
