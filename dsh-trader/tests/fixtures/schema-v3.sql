-- Historical pre-v4 shape: these tables existed in deployed v1-v3 databases.
PRAGMA user_version = 3;

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  plan_id TEXT,
  decided_at INTEGER NOT NULL,
  context_hash TEXT NOT NULL,
  data_fingerprint TEXT,
  model_route TEXT,
  action TEXT NOT NULL,
  size_qty REAL,
  stop_price REAL,
  take_profit REAL,
  confidence REAL,
  rationale TEXT,
  risk_notes TEXT,
  authority TEXT NOT NULL DEFAULT 'model',
  executed INTEGER NOT NULL DEFAULT 0,
  reflection_due_at INTEGER,
  outcome_id TEXT
);

CREATE TABLE triggers (
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

CREATE TABLE price_table (
  model TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  in_per_mtok REAL NOT NULL,
  out_per_mtok REAL NOT NULL,
  cached_in_per_mtok REAL,
  source TEXT,
  PRIMARY KEY (model, effective_from)
);

CREATE TABLE budget_ledger (
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cached INTEGER NOT NULL DEFAULT 0,
  est_usd REAL NOT NULL DEFAULT 0,
  cost_known INTEGER NOT NULL DEFAULT 1 CHECK (cost_known IN (0, 1)),
  PRIMARY KEY (day, scope)
);

INSERT INTO triggers
  (trigger_id, dedup_key, symbol, rule_id, purpose, bar_ts, payload_json, state, created_at)
VALUES ('old-trigger', 'old-key', 'BTC/USDT:USDT', 'old-rule', 'novelty', 100, '{}', 'queued', 100);
INSERT INTO price_table
  (model, effective_from, in_per_mtok, out_per_mtok, cached_in_per_mtok, source)
VALUES ('old-model', 100, 1, 2, 0.5, 'historical');
INSERT INTO budget_ledger
  (day, scope, tokens_in, tokens_out, tokens_cached, est_usd, cost_known)
VALUES ('2026-01-01', 'global', 1, 2, 0, 3, 1);
