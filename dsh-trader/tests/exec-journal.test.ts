import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { DecisionJournal, type DecisionRecord } from '../src/exec/journal.js'

const NOW = 1_700_000_000_000

let db: Database.Database
let journal: DecisionJournal

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  journal = new DecisionJournal(db)
})

afterEach(() => {
  db.close()
})

const decision = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decisionId: 'd1',
  symbol: 'BTC/USDT',
  planId: 'pc-1',
  decidedAt: NOW,
  contextHash: 'sha256:ctx',
  action: 'open',
  sizeQty: 1,
  executed: true,
  ...over,
})

describe('DecisionJournal', () => {
  it('records a decision and reports it once', () => {
    expect(journal.recordDecision(decision())).toBe(true)
    expect(journal.recordDecision(decision())).toBe(false)
    expect(journal.decisionIds()).toEqual(['d1'])
  })

  it('pendingSettlements 按 tf 过滤；缺 tf 的决策不会被任何 scheduler 误领（plan §5.3）', () => {
    journal.recordDecision(decision({ decisionId: 'd-1h', timeframe: '1h', reflectionDueAt: NOW }))
    journal.recordDecision(decision({ decisionId: 'd-4h', timeframe: '4h', reflectionDueAt: NOW }))
    journal.recordDecision(decision({ decisionId: 'd-null', reflectionDueAt: NOW }))

    expect(journal.pendingSettlements(NOW, 10, '1h').map((row) => row.decisionId)).toEqual(['d-1h'])
    expect(journal.pendingSettlements(NOW, 10, '4h').map((row) => row.decisionId)).toEqual(['d-4h'])
    // 不传 tf = 不过滤（旧调用方/运维排查用）
    expect(
      journal
        .pendingSettlements(NOW, 10)
        .map((row) => row.decisionId)
        .sort(),
    ).toEqual(['d-1h', 'd-4h', 'd-null'])
    // 缺 tf 的决策不会被"猜"成某个 tf：宁可不结算，也不用错的 bar 窗口结算
    expect(journal.pendingSettlements(NOW, 10, '1h').some((row) => row.decisionId === 'd-null')).toBe(false)
  })

  it('dedupes identical content and refuses to rewrite the same decision id', () => {
    expect(journal.recordDecision(decision())).toBe(true)
    expect(journal.recordDecision(decision())).toBe(false)
    // `executed` 是结果而非内容，不进入幂等根
    expect(journal.recordDecision({ ...decision(), executed: false })).toBe(false)
    expect(journal.decisionIds()).toEqual(['d1'])
    // 同一 decisionId 改内容 = 事后改写 → 主键冲突，必须报错而不是悄悄写第三条
    expect(() => journal.recordDecision({ ...decision(), sizeQty: 999 })).toThrow()
    expect(journal.recordDecision(decision({ decisionId: 'd2', action: 'close' }))).toBe(true)
    expect(journal.decisionIds()).toEqual(['d1', 'd2'])
  })

  it('rejects an action outside the closed vocabulary instead of silently dropping it', () => {
    expect(() => journal.recordDecision(decision({ action: 'teleport' as never }))).toThrow()
  })

  it('is idempotent per client_order_id and never duplicates an order', () => {
    journal.recordDecision(decision()) // order_intents.decision_id 有外键
    const intent = {
      intentId: 'i1',
      clientOrderId: 'co-1',
      decisionId: 'd1',
      venue: 'paper',
      symbol: 'BTC/USDT',
      state: 'filled' as const,
      type: 'market',
      side: 'buy',
      qty: 1,
      notionalUsd: 100,
      reduceOnly: false,
      createdAt: NOW,
    }
    expect(journal.recordIntent(intent)).toBe(true)
    expect(journal.recordIntent({ ...intent, intentId: 'i2' })).toBe(false)
    expect(journal.intentIds()).toEqual(['i1'])
    expect(journal.duplicateClientOrderIds()).toBe(0)
    expect(journal.hasClientOrderId('co-1')).toBe(true)
    expect(journal.hasClientOrderId('co-2')).toBe(false)
  })

  it('records orders and fills idempotently', () => {
    journal.recordDecision(decision())
    journal.recordIntent({
      intentId: 'i1',
      clientOrderId: 'co-1',
      decisionId: 'd1',
      venue: 'paper',
      symbol: 'BTC/USDT',
      state: 'filled',
      type: 'market',
      side: 'buy',
      qty: 1,
      reduceOnly: false,
      createdAt: NOW,
    })
    const order = {
      orderId: 'o1',
      venue: 'paper',
      exchangeOrderId: 'o1',
      clientOrderId: 'co-1',
      symbol: 'BTC/USDT',
      status: 'filled',
      qty: 1,
      filledQty: 1,
      avgPrice: 100,
      updatedAt: NOW,
    }
    const fill = { fillId: 'f1', orderId: 'o1', qty: 1, price: 100, fee: 0.05, feeCurrency: 'USDT', ts: NOW }

    expect(journal.recordOrder(order)).toBe(true)
    expect(journal.recordOrder(order)).toBe(false)
    expect(journal.recordFill(fill)).toBe(true)
    expect(journal.recordFill(fill)).toBe(false)
    expect(journal.fillIds()).toEqual(['f1'])
  })

  it('refuses a fill for an order that was never recorded (FK enforced)', () => {
    expect(() =>
      journal.recordFill({
        fillId: 'f9',
        orderId: 'missing',
        qty: 1,
        price: 1,
        fee: 0,
        feeCurrency: 'USDT',
        ts: NOW,
      }),
    ).toThrow()
  })
})
