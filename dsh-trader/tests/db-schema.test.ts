import Database from 'better-sqlite3'
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
      'bars',
      'features',
      'plan_cards',
      'decisions',
      'outcomes',
      'context_snapshots',
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
