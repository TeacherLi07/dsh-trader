import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { ImmutablePlanError, PlanStore, PlanStoreError } from '../src/plan/store.js'
import type { PlanCard } from '../src/plan/schema.js'
import { makeCard } from './helpers/plan.js'

const NOW = 50_000

let db: Database.Database
let store: PlanStore

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  store = new PlanStore(db)
})

afterEach(() => {
  db.close()
})

function statusOf(planId: string): string {
  const row = db.prepare('SELECT status FROM plan_cards WHERE plan_id = ?').get(planId) as {
    status: string
  }
  return row.status
}

describe('PlanStore', () => {
  it('inserts a valid card and exposes it as active', () => {
    const card = makeCard()
    const result = store.save(card, NOW)

    expect(result).toEqual({ status: 'inserted', planId: 'pc-btc-1', version: 1 })
    expect(store.active('BTC/USDT')).toEqual(card)
    expect(store.get('pc-btc-1')).toEqual(card)
  })

  it('is idempotent for identical content', () => {
    store.save(makeCard(), NOW)
    const again = store.save(makeCard(), NOW)

    expect(again.status).toBe('unchanged')
    expect(store.count()).toBe(1)
  })

  it('supersedes the previous active card on new content and bumps the version', () => {
    store.save(makeCard({ planId: 'pc-a' }), NOW)
    const result = store.save(makeCard({ planId: 'pc-b', confidence: 0.9 }), NOW)

    expect(result).toEqual({ status: 'inserted', planId: 'pc-b', version: 2, replaced: 'pc-a' })
    expect(statusOf('pc-a')).toBe('superseded')
    expect(store.active('BTC/USDT')?.planId).toBe('pc-b')
    expect(store.count()).toBe(2)
  })

  it('refuses to rewrite an existing planId — a correction must be a new id', () => {
    store.save(makeCard({ planId: 'pc-a' }), NOW)
    const changed = makeCard({ planId: 'pc-a', confidence: 0.95 })

    expect(() => store.save(changed, NOW)).toThrow(ImmutablePlanError)
    expect(store.active('BTC/USDT')?.confidence).toBe(0.5)
  })

  it('rejects a contentHash that does not match the content (the idempotency root must be real)', () => {
    const tampered: PlanCard = { ...makeCard(), contentHash: 'sha256:bogus' }
    expect(() => store.save(tampered, NOW)).toThrow(PlanStoreError)
    expect(store.count()).toBe(0)
  })

  it('rejects a structurally invalid card', () => {
    const invalid = makeCard({ invalidation: [] })
    expect(() => store.save(invalid, NOW)).toThrow(PlanStoreError)
  })

  it('expires overdue active cards and frees the symbol', () => {
    store.save(makeCard({ windowEndsAt: NOW - 1 }), NOW)
    expect(store.active('BTC/USDT')).toBeDefined()

    expect(store.expire(NOW)).toBe(1)
    expect(store.active('BTC/USDT')).toBeUndefined()
    expect(statusOf('pc-btc-1')).toBe('expired')
  })

  it('marks an already-expired predecessor as expired rather than superseded', () => {
    store.save(makeCard({ planId: 'pc-a', windowEndsAt: NOW - 1 }), NOW)
    const result = store.save(makeCard({ planId: 'pc-b', confidence: 0.8 }), NOW)

    expect(result.replaced).toBe('pc-a')
    expect(statusOf('pc-a')).toBe('expired')
    expect(store.active('BTC/USDT')?.planId).toBe('pc-b')
  })

  it('keeps the full version history for audit, newest first', () => {
    store.save(makeCard({ planId: 'pc-a' }), NOW)
    store.save(makeCard({ planId: 'pc-b', confidence: 0.8 }), NOW)
    store.save(makeCard({ planId: 'pc-c', confidence: 0.85 }), NOW)

    const history = store.history('BTC/USDT')
    expect(history.map((card) => card.planId)).toEqual(['pc-c', 'pc-b', 'pc-a'])
    expect(history.map((card) => card.confidence)).toEqual([0.85, 0.8, 0.5])
    expect(store.history('BTC/USDT', 2)).toHaveLength(2)
  })

  it('keeps at most one active card per symbol', () => {
    store.save(makeCard({ planId: 'pc-a', symbol: 'BTC/USDT' }), NOW)
    store.save(makeCard({ planId: 'pc-b', symbol: 'BTC/USDT', confidence: 0.8 }), NOW)
    store.save(makeCard({ planId: 'pc-eth', symbol: 'ETH/USDT' }), NOW)

    const activeCount = db
      .prepare("SELECT COUNT(*) AS n FROM plan_cards WHERE status = 'active'")
      .get() as { n: number }
    expect(activeCount.n).toBe(2)
    expect(store.active('ETH/USDT')?.planId).toBe('pc-eth')
  })
})
