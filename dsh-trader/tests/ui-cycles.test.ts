import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { readCycleDetail, readCycleList } from '../src/ui/cycles.js'

const NOW = 1_700_000_000_000

describe('Trade Console cycle read model', () => {
  it('joins a decision to context, plan, orders, fills, outcome, lesson and matching audit', () => {
    const db = new Database(':memory:')
    migrate(db)
    const journal = new DecisionJournal(db)
    try {
      journal.recordDecision({
        decisionId: 'cycle-1',
        symbol: 'BTC/USDT:USDT',
        timeframe: '1h',
        planId: 'plan-1',
        decidedAt: NOW,
        contextHash: 'ctx:cycle-1',
        action: 'open',
        sizeQty: 2,
        stopPrice: 99,
        takeProfit: 105,
        rationale: 'breakout with bounded risk',
        modelRoute: 'deepseek-flash',
        executed: true,
        reflectionDueAt: NOW + 3_600_000,
      })
      journal.recordDecision({
        decisionId: 'cycle-2',
        symbol: 'ETH/USDT:USDT',
        timeframe: '1h',
        decidedAt: NOW + 1_000,
        contextHash: 'ctx:cycle-2',
        action: 'no_trade',
        rationale: 'evidence incomplete',
        executed: false,
      })
      db.prepare(
        `INSERT INTO decision_contexts
           (context_id, context_hash, symbol, primary_timeframe, as_of, canonical_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run('ctx-cycle-1', 'ctx:cycle-1', 'BTC/USDT:USDT', '1h', NOW - 100, '{"contextHash":"ctx:cycle-1"}', NOW - 100)
      db.prepare(
        `INSERT INTO plan_cards
           (plan_id, symbol, version, status, window_ends_at, created_at, card_json, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run('plan-1', 'BTC/USDT:USDT', 1, 'expired', NOW + 3_600_000, NOW - 100, '{"thesis":"breakout"}', 'hash:plan-1')
      journal.recordIntent({
        intentId: 'intent-1',
        clientOrderId: 'client-1',
        decisionId: 'cycle-1',
        venue: 'paper',
        symbol: 'BTC/USDT:USDT',
        state: 'filled',
        type: 'market',
        side: 'buy',
        qty: 2,
        reduceOnly: false,
        createdAt: NOW + 10,
        exchangeOrderId: 'exchange-1',
      })
      journal.recordOrder({
        orderId: 'order-1',
        venue: 'paper',
        exchangeOrderId: 'exchange-1',
        clientOrderId: 'client-1',
        symbol: 'BTC/USDT:USDT',
        status: 'filled',
        qty: 2,
        filledQty: 2,
        avgPrice: 100,
        updatedAt: NOW + 20,
      })
      journal.recordFill({
        fillId: 'fill-1',
        orderId: 'order-1',
        qty: 2,
        price: 100,
        fee: 0.1,
        feeCurrency: 'USDT',
        ts: NOW + 20,
      })
      journal.recordOutcome({
        outcomeId: 'outcome-1',
        decisionId: 'cycle-1',
        symbol: 'BTC/USDT:USDT',
        settledAt: NOW + 3_600_000,
        horizonMs: 3_600_000,
        entryPrice: 100,
        exitPrice: 103,
        realizedGrossPct: 3,
        realizedNetPct: 2.8,
        benchmarkPct: 1,
        alphaPct: 1.8,
        mfePct: 4,
        maePct: -0.5,
        stopHit: false,
        feesQuote: 0.1,
        evidenceRefs: ['bar:one'],
      })
      journal.markDecisionOutcome('cycle-1', 'outcome-1')
      journal.recordLesson({
        lessonId: 'lesson-1',
        decisionId: 'cycle-1',
        text: '等待确认后的突破更稳健',
        evidenceRefs: ['outcome-1'],
        regimeBucket: 'trend',
        createdAt: NOW + 3_600_100,
        expiresAt: NOW + 86_400_000,
      })
      journal.appendAudit({
        actor: 'system',
        kind: 'execute.denied',
        payload: { decisionId: 'cycle-1', contextHash: 'ctx:cycle-1', planId: 'plan-1' },
        ts: NOW + 30,
      })

      const list = readCycleList(db, 10)
      expect(list.length).toBeGreaterThan(0)
      expect(list).toHaveLength(2)
      expect(list.find((cycle) => cycle.cycleId === 'cycle-1')).toMatchObject({
        settlement: 'settled',
        executed: true,
        triggerSource: null,
      })
      expect(list.find((cycle) => cycle.cycleId === 'cycle-2')?.settlement).toBe('awaiting')

      const detail = readCycleDetail(db, 'cycle-1')
      expect(detail).toBeDefined()
      if (detail === undefined) return
      expect(detail.context).toMatchObject({ contextHash: 'ctx:cycle-1', symbol: 'BTC/USDT:USDT' })
      expect(detail.plan).toEqual({ thesis: 'breakout' })
      expect(detail.orders).toHaveLength(1)
      expect(detail.orders[0]?.orders).toHaveLength(1)
      expect(detail.fills).toHaveLength(1)
      expect(detail.outcome).toMatchObject({ outcomeId: 'outcome-1', realizedNetPct: 2.8 })
      expect(detail.lesson?.text).toBe('等待确认后的突破更稳健')
      expect(detail.audit.some((event) => event.kind === 'execute.denied')).toBe(true)
      expect(readCycleDetail(db, 'missing-cycle')).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
