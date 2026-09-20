import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import type {
  AccountSnapshot,
  Broker,
  OrderAck,
  OrderRequest,
  PositionSnapshot,
  ProtectiveRequest,
  UserDataEvent,
} from '../src/exec/broker.js'
import { executeAction } from '../src/exec/execute-action.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { makeCard } from './helpers/plan.js'

const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT:USDT'

class PartialFillBroker implements Broker {
  readonly venue = 'htx' as const
  readonly canceled: string[] = []
  protected = false
  hidePositionSnapshots = false
  protectiveRequests: ProtectiveRequest[] = []
  cancelAllCalls: { readonly includeProtection: boolean }[] = []
  #ack: OrderAck | undefined
  #position: PositionSnapshot | undefined

  async getAccount(): Promise<AccountSnapshot> {
    return {
      venue: 'htx', equityQuote: 10_000, totalExposureUsd: 0, pendingExposureUsd: 0,
      openOrders: 0, leverage: 0, dailyLossUsd: 0, drawdownUsd: 0,
      consecutiveLosses: 0, spreadBps: 1, observedAt: NOW,
    }
  }

  async getPositions(): Promise<readonly PositionSnapshot[]> {
    return this.hidePositionSnapshots || this.#position === undefined ? [] : [this.#position]
  }

  async getOpenOrders(): Promise<readonly OrderAck[]> {
    return this.#ack?.state === 'acked' ? [this.#ack] : []
  }

  async placeOrder(request: OrderRequest): Promise<OrderAck> {
    this.#position = {
      symbol: request.symbol, qty: 0.25, avgPrice: 100, unrealizedPnlUsd: 0,
      observedAt: NOW,
    }
    this.#ack = {
      intentId: request.intentId, clientOrderId: request.clientOrderId,
      exchangeOrderId: 'entry-exchange-id', symbol: request.symbol,
      state: 'acked', filledQty: 0.25, avgPrice: 100, ts: NOW,
    }
    return this.#ack
  }

  async placeProtective(request: ProtectiveRequest): Promise<OrderAck> {
    this.protected = true
    this.protectiveRequests.push(request)
    if (this.#position !== undefined) this.#position = { ...this.#position, protectedStopPrice: request.stopLossPrice }
    return {
      intentId: request.clientOrderId ?? 'protective',
      clientOrderId: request.clientOrderId ?? 'protective',
      exchangeOrderId: 'stop-exchange-id', symbol: request.symbol,
      state: 'acked', ts: NOW,
    }
  }

  async findOrderByExchangeOrderId(exchangeOrderId: string): Promise<OrderAck | undefined> {
    return exchangeOrderId === this.#ack?.exchangeOrderId ? this.#ack : undefined
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    this.canceled.push(exchangeOrderId)
    if (exchangeOrderId === this.#ack?.exchangeOrderId) this.#ack = { ...this.#ack, state: 'canceled' }
  }

  async cancelAll(_symbol?: string, options?: { readonly includeProtection?: boolean }): Promise<void> {
    this.cancelAllCalls.push({ includeProtection: options?.includeProtection === true })
  }
  subscribeUserData(_onEvent: (event: UserDataEvent) => void): () => void { return () => {} }
}

describe('executeAction partial-fill safety', () => {
  it('cancels an unfilled remainder, journals actual partial quantity, and protects the live position', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const journal = new DecisionJournal(db)
    const broker = new PartialFillBroker()
    const clock = new ReplayClock(NOW)
    const plan = makeCard({
      planId: 'partial-plan', symbol: SYMBOL, createdAt: NOW - 1, windowEndsAt: NOW + 1_000_000,
    })
    try {
      const result = await executeAction({
        journal, broker, clock, plan, conditionId: 'open-once',
        action: {
          action: 'open', side: 'long', method: 'market',
          stop: { method: 'structure', level: 90 }, riskPct: 0.001,
        },
        symbol: SYMBOL, timeframe: '1h', barTs: NOW - 3_600_000,
        referencePrice: 100, atr: null, account: await broker.getAccount(), position: undefined,
        riskPct: 0.001, mode: 'live_auto', limits: EXAMPLE_LIMITS,
        reflectionHorizonMs: 14_400_000, alreadyIntended: () => false,
      })

      expect(result.executed).toBe(true)
      expect(broker.canceled).toEqual(['entry-exchange-id'])
      expect(broker.protected).toBe(true)
      expect(journal.fillsForDecision(result.decisionId)).toMatchObject([{ qty: 0.25, price: 100 }])
      expect((await broker.getPositions())[0]).toMatchObject({ qty: 0.25, protectedStopPrice: 90 })
    } finally {
      db.close()
    }
  })

  it('成交量已确认但持仓端点返回空快照时仍用成交量续接保护，不把缺行当 flat', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const journal = new DecisionJournal(db)
    const broker = new PartialFillBroker()
    broker.hidePositionSnapshots = true
    const clock = new ReplayClock(NOW)
    const frozen = new Set<string>()
    try {
      const result = await executeAction({
        journal, broker, clock,
        plan: makeCard({ planId: 'stale-position-plan', symbol: SYMBOL, createdAt: NOW - 1, windowEndsAt: NOW + 1_000_000 }),
        conditionId: 'open-with-stale-position',
        action: {
          action: 'open', side: 'long', method: 'market',
          stop: { method: 'structure', level: 90 }, riskPct: 0.001,
        },
        symbol: SYMBOL, timeframe: '1h', barTs: NOW - 3_600_000,
        referencePrice: 100, atr: null, account: await broker.getAccount(), position: undefined,
        riskPct: 0.001, mode: 'live_auto', limits: EXAMPLE_LIMITS,
        reflectionHorizonMs: 14_400_000, alreadyIntended: () => false,
        freezeSymbol: (symbol) => frozen.add(symbol),
      })

      expect(result.executed).toBe(true)
      expect(broker.protected).toBe(true)
      expect(broker.protectiveRequests[0]?.expectedPositionQty).toBe(0.25)
      expect(broker.cancelAllCalls.some((call) => call.includeProtection)).toBe(false)
      expect(frozen.has(SYMBOL)).toBe(true)
      expect(journal.fillsForDecision(result.decisionId)).toMatchObject([{ qty: 0.25, price: 100 }])
    } finally {
      db.close()
    }
  })
})
