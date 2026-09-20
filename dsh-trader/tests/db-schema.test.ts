import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, migrate } from '../src/db/schema.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

afterEach(() => {
  db.close()
})

function names(type: string): string[] {
  return (db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all(type) as { name: string }[]).map(
    (row) => row.name,
  )
}

function insertPlan(planId: string, symbol: string, status = 'active'): void {
  db.prepare(
    `INSERT INTO plan_cards (plan_id, symbol, version, status, window_ends_at, created_at, card_json, content_hash)
     VALUES (?, ?, 1, ?, 2000, 1000, '{}', ?)`,
  ).run(planId, symbol, status, `hash-${planId}`)
}

function insertDecision(decisionId: string, contentHash: string, action = 'no_trade'): void {
  db.prepare(
    `INSERT INTO decisions (decision_id, content_hash, symbol, decided_at, context_hash, action)
     VALUES (?, ?, 'BTC/USDT:USDT', 1, 'ctx', ?)`,
  ).run(decisionId, contentHash, action)
}

describe('schema (plan §4.1 invariants)', () => {
  it('creates every authoritative table', () => {
    const tables = names('table')
    for (const table of [
      'market_observations',
      'bars',
      'bar_processing',
      'features',
      'decision_contexts',
      'decision_runs',
      'plan_cards',
      'decisions',
      'outcomes',
      'order_intents',
      'orders',
      'fills',
      'lessons',
      'triggers',
      'audit_events',
      'config_versions',
      'price_table',
      'budget_ledger',
      'heartbeat',
      'supervisor_window_cursors',
      'supervisor_windows',
      'pm_markets',
      'pm_series',
      'pm_quotes',
      'pm_watches',
    ]) {
      expect(tables).toContain(table)
    }
  })

  it('is idempotent and records the schema version', () => {
    expect(() => migrate(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('把 v5 库升级到 v6 时补齐双时间 observation 表与 append-only 触发器', () => {
    db.exec(`DROP TRIGGER market_observations_no_update;
      DROP TRIGGER market_observations_no_delete;
      DROP TABLE market_observations;
      PRAGMA user_version = 5;`)

    migrate(db)

    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(names('table')).toContain('market_observations')
    expect(names('trigger')).toContain('market_observations_no_update')
    expect(names('trigger')).toContain('market_observations_no_delete')
  })

  it('给已有库补 decisions.timeframe（增量迁移），且可重复执行', () => {
    const columns = (): string[] =>
      (db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]).map((row) => row.name)
    // 模拟"旧库"：建表时还没有 timeframe 列
    db.exec('ALTER TABLE decisions DROP COLUMN timeframe')
    expect(columns()).not.toContain('timeframe')

    migrate(db)
    expect(columns()).toContain('timeframe')
    // 迁移必须幂等：再跑一次不能因为列已存在而抛错
    expect(() => migrate(db)).not.toThrow()
  })

  it('给旧库补齐成本与触发来源列，避免周期/成本读取整条失败', () => {
    const columns = (): string[] =>
      (db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]).map((row) => row.name)
    for (const column of ['tokens_in', 'tokens_out', 'tokens_cached', 'cost_usd', 'cost_known', 'duration_ms', 'trigger_source']) {
      db.exec(`ALTER TABLE decisions DROP COLUMN ${column}`)
    }
    expect(columns()).not.toContain('trigger_source')

    migrate(db)
    expect(columns()).toEqual(expect.arrayContaining([
      'tokens_in',
      'tokens_out',
      'tokens_cached',
      'cost_usd',
      'cost_known',
      'duration_ms',
      'trigger_source',
    ]))
    expect(() => migrate(db)).not.toThrow()
  })

  it('allows at most one active plan card per symbol, across symbols independently', () => {
    insertPlan('p1', 'BTC/USDT:USDT')
    expect(() => insertPlan('p2', 'BTC/USDT:USDT')).toThrow()
    expect(() => insertPlan('p3', 'ETH/USDT:USDT')).not.toThrow()
    // 非 active 的历史版本可以并存（冻结归档，修正产出新 planId）
    expect(() => insertPlan('p4', 'BTC/USDT:USDT', 'superseded')).not.toThrow()
  })

  it('makes decision content_hash the idempotency root', () => {
    insertDecision('d1', 'same-hash')
    expect(() => insertDecision('d2', 'same-hash')).toThrow()
    expect(() => insertDecision('d3', 'other-hash')).not.toThrow()
  })

  it('makes client_order_id globally unique (no double fills on retry)', () => {
    const insert = (intentId: string, clientOrderId: string): void => {
      db.prepare(
        `INSERT INTO order_intents (intent_id, client_order_id, venue, symbol, state, created_at)
         VALUES (?, ?, 'paper', 'BTC/USDT:USDT', 'created', 1)`,
      ).run(intentId, clientOrderId)
    }
    insert('i1', 'co-1')
    expect(() => insert('i2', 'co-1')).toThrow()
    expect(() => insert('i3', 'co-2')).not.toThrow()
  })

  it('allows at most one reflection per decision', () => {
    insertDecision('d1', 'h1')
    const insertLesson = (lessonId: string, decisionId: string): void => {
      db.prepare(
        `INSERT INTO lessons (lesson_id, decision_id, text, evidence_refs_json, created_at)
         VALUES (?, ?, 'x', '[]', 1)`,
      ).run(lessonId, decisionId)
    }
    insertLesson('l1', 'd1')
    expect(() => insertLesson('l2', 'd1')).toThrow()
  })

  it('keeps audit_events append-only', () => {
    db.prepare(
      "INSERT INTO audit_events (ts, actor, kind, payload_json, hash) VALUES (1, 'system', 'boot', '{}', 'h')",
    ).run()
    expect(() => db.prepare("UPDATE audit_events SET kind = 'tampered' WHERE seq = 1").run()).toThrow()
    expect(() => db.prepare('DELETE FROM audit_events WHERE seq = 1').run()).toThrow()
  })

  it('restricts decisions.action to the closed vocabulary', () => {
    expect(() => insertDecision('d1', 'h1', 'teleport')).toThrow()
    expect(() => insertDecision('d2', 'h2', 'no_trade')).not.toThrow()
    expect(() => insertDecision('d3', 'h3', 'review')).not.toThrow()
  })

  it('enforces the order_intents state machine domain', () => {
    const insert = (state: string): void => {
      db.prepare(
        `INSERT INTO order_intents (intent_id, client_order_id, venue, symbol, state, created_at)
         VALUES (?, ?, 'paper', 'BTC/USDT:USDT', ?, 1)`,
      ).run(`i-${state}`, `co-${state}`, state)
    }
    expect(() => insert('created')).not.toThrow()
    expect(() => insert('acked')).not.toThrow()
    expect(() => insert('flying')).toThrow()
  })

  it('keeps one row per (token_id, ts, resolution_seconds) in pm_series', () => {
    const insert = (ts: number, resolution: number): void => {
      db.prepare(
        `INSERT INTO pm_series (token_id, ts, price, resolution_seconds, source, observed_at)
         VALUES ('tok', ?, 0.5, ?, 'data-api:v2', 1)`,
      ).run(ts, resolution)
    }
    insert(1_700_000_000_000, 0)
    // 同一时刻的"桶观测"与"精确 tick"可以并存（resolution_seconds=0 表示精确 tick）
    insert(1_700_000_000_000, 3600)
    expect(() => insert(1_700_000_000_000, 0)).toThrow()
  })

  it('v5 binds decisions to a decision run when a run is supplied', () => {
    db.prepare(
      `INSERT INTO decision_contexts
         (context_id, context_hash, symbol, primary_timeframe, as_of, canonical_json, created_at)
       VALUES ('ctx-1', 'sha256:ctx-1', 'BTC/USDT:USDT', '1h', 1, '{}', 1)`,
    ).run()
    db.prepare(
      `INSERT INTO decision_runs
         (run_id, context_id, context_hash, symbol, primary_timeframe, trigger_source, status, created_at, updated_at)
       VALUES ('run-1', 'ctx-1', 'sha256:ctx-1', 'BTC/USDT:USDT', '1h', 'W1', 'running', 1, 1)`,
    ).run()
    db.prepare(
      `INSERT INTO decisions (decision_id, content_hash, run_id, symbol, decided_at, context_hash, action)
       VALUES ('d-run', 'h-run', 'run-1', 'BTC/USDT:USDT', 1, 'sha256:ctx-1', 'no_trade')`,
    ).run()
    expect(() => db.prepare(
      `INSERT INTO decisions (decision_id, content_hash, run_id, symbol, decided_at, context_hash, action)
       VALUES ('d-bad-run', 'h-bad-run', 'missing-run', 'BTC/USDT:USDT', 1, 'sha256:ctx-1', 'no_trade')`,
    ).run()).toThrow()
  })

  it('removes obsolete context snapshot/token tables during v5 migration', () => {
    db.exec(`
      CREATE TABLE context_snapshots (ctx_hash TEXT PRIMARY KEY);
      CREATE TABLE workflow_contexts (token_hash TEXT PRIMARY KEY);
      PRAGMA user_version = 4;
    `)
    migrate(db)
    expect(names('table')).not.toContain('context_snapshots')
    expect(names('table')).not.toContain('workflow_contexts')
    expect(names('table')).toEqual(expect.arrayContaining(['decision_contexts', 'decision_runs']))
  })

  it('constrains pm_watches: unique alias, idempotent content hash, mandatory expiry, closed enums', () => {
    const insert = (watchId: string, alias: string, hash: string): void => {
      db.prepare(
        `INSERT INTO pm_watches (watch_id, alias, content_hash, kind, purpose, expires_at, state, created_by, created_at)
         VALUES (?, ?, ?, 'threshold', 'novelty', 9999999999999, 'active', 'model', 1)`,
      ).run(watchId, alias, hash)
    }
    insert('w1', 'fed_sep_cut', 'h1')
    expect(() => insert('w2', 'fed_sep_cut', 'h2')).toThrow() // alias 唯一
    expect(() => insert('w3', 'other_alias', 'h1')).toThrow() // content_hash 幂等

    // expires_at 必填：不允许无期限关注
    expect(() =>
      db
        .prepare(
          `INSERT INTO pm_watches (watch_id, alias, content_hash, kind, purpose, state, created_by, created_at)
           VALUES ('w4', 'no_ttl', 'h4', 'threshold', 'novelty', 'active', 'model', 1)`,
        )
        .run(),
    ).toThrow()

    // kind / purpose 是封闭枚举
    expect(() =>
      db
        .prepare(
          `INSERT INTO pm_watches (watch_id, alias, content_hash, kind, purpose, expires_at, state, created_by, created_at)
           VALUES ('w5', 'bad_kind', 'h5', 'teleport', 'novelty', 1, 'active', 'model', 1)`,
        )
        .run(),
    ).toThrow()
  })
})

describe('schema 与 plan §4.1 同步（审计修复）', () => {
  it('★ budget_ledger.cost_known 默认 0（缺价目 fail-closed，不是"可信"）', () => {
    db.prepare(`INSERT INTO budget_ledger (day, scope) VALUES ('2026-01-01', 'global')`).run()
    const row = db.prepare(`SELECT cost_known FROM budget_ledger`).get() as { cost_known: number }
    expect(row.cost_known).toBe(0)
  })

  it('从历史 v3 fixture 迁移到当前版本：保留数据、补齐列/主键形状且可重复执行', () => {
    const historical = readFileSync(new URL('./fixtures/schema-v3.sql', import.meta.url), 'utf8')
    const old = new Database(':memory:')
    old.exec(historical)

    migrate(old)
    expect(old.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(old.prepare('SELECT disposition FROM triggers WHERE trigger_id = ?').get('old-trigger')).toMatchObject({
      disposition: 'novelty',
    })
    expect(old.prepare('SELECT tier FROM price_table WHERE model = ?').get('old-model')).toMatchObject({ tier: 'any' })
    expect(old.prepare('SELECT cost_known FROM budget_ledger WHERE day = ?').get('2026-01-01')).toMatchObject({
      cost_known: 1,
    })

    const priceInfo = old.prepare('PRAGMA table_info(price_table)').all() as { name: string; pk: number }[]
    expect(priceInfo.find((column) => column.name === 'tier')?.pk).toBe(3)
    expect(old.prepare('PRAGMA table_info(bar_processing)').all()).toHaveLength(4)
    expect(() => migrate(old)).not.toThrow()
    old.close()
  })
})
