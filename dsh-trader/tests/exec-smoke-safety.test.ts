import { describe, expect, it } from 'vitest'
import type { Broker, OrderAck, PositionSnapshot } from '../src/exec/broker.js'
import { assertSmokeAccountFlat, cleanupSmokePosition, evaluateSmokeLossEnvelope } from '../src/exec/smoke-safety.js'

const SYMBOL = 'ADA/USDT:USDT'
const stop: OrderAck = {
  intentId: 'stop-intent', clientOrderId: 'stop-client', exchangeOrderId: 'stop-exchange',
  symbol: SYMBOL, state: 'acked', ts: 1,
}

describe('真实冒烟保护单纪律', () => {
  it('按真实权益拒绝超过 2% 额度的最小合约，并拒绝未知数值', () => {
    const base = { equityQuote: 25, maxDrawdownPct: 0.02, oneContractBase: 10, referencePrice: 0.256 }
    expect(evaluateSmokeLossEnvelope(base)).toMatchObject({ maxLossUsd: 0.5, fits: false })
    expect(evaluateSmokeLossEnvelope({ ...base, referencePrice: 0.01 }).fits).toBe(true)
    expect(() => evaluateSmokeLossEnvelope({ ...base, referencePrice: Number.NaN })).toThrow(/无效/)
    expect(() => evaluateSmokeLossEnvelope({ ...base, maxDrawdownPct: 0 })).toThrow(/无效/)
  })

  it('拒绝账户中任意标的的已有持仓或挂单', () => {
    const position: PositionSnapshot = { symbol: 'DOGE/USDT:USDT', qty: 100, avgPrice: 1, unrealizedPnlUsd: 0 }
    expect(() => assertSmokeAccountFlat([position], [])).toThrow(/非空仓/)
    expect(() => assertSmokeAccountFlat([], [stop])).toThrow(/挂单/)
    expect(() => assertSmokeAccountFlat([], [])).not.toThrow()
  })

  it('持仓期间保留保护单，确认平仓后才撤', async () => {
    let qty = 10
    let protection = true
    const events: string[] = []
    const broker: Pick<Broker, 'cancelAll' | 'getPositions' | 'getOpenOrders'> = {
      cancelAll: async (_symbol, options) => {
        events.push(options?.includeProtection === true ? 'cancel-protection' : 'cancel-entries')
        if (options?.includeProtection === true) {
          expect(qty).toBe(0)
          protection = false
        }
      },
      getPositions: async () => [{ symbol: SYMBOL, qty, avgPrice: 1, unrealizedPnlUsd: 0 }],
      getOpenOrders: async () => protection ? [stop] : [],
    }

    const result = await cleanupSmokePosition(broker, SYMBOL, async (openQty) => {
      events.push('reduce-only-close')
      expect(openQty).toBe(10)
      expect(protection).toBe(true)
      qty = 0
    })

    expect(events).toEqual(['cancel-entries', 'reduce-only-close', 'cancel-protection'])
    expect(result).toEqual({ cancelAll: true, flattened: true, note: null })
  })

  it('平仓失败时不撤保护单', async () => {
    const optionsSeen: unknown[] = []
    const broker: Pick<Broker, 'cancelAll' | 'getPositions' | 'getOpenOrders'> = {
      cancelAll: async (_symbol, options) => { optionsSeen.push(options) },
      getPositions: async () => [{ symbol: SYMBOL, qty: 10, avgPrice: 1, unrealizedPnlUsd: 0 }],
      getOpenOrders: async () => [stop],
    }
    const result = await cleanupSmokePosition(broker, SYMBOL, async () => { throw new Error('close unavailable') })
    expect(optionsSeen).toEqual([undefined])
    expect(result).toMatchObject({ cancelAll: false, flattened: false })
  })
})
