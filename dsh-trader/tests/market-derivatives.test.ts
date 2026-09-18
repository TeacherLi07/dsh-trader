import { describe, expect, it } from 'vitest'
import {
  basisBps,
  createCcxtDerivativesSource,
  DerivativesTracker,
  derivativesValues,
  normalizeFundingRate,
  normalizeLiquidations,
  normalizeOpenInterest,
  type DerivativesObservation,
} from '../src/market/derivatives.js'
import type { CcxtExchangeLike } from '../src/market/ccxt-source.js'

describe('derivatives units and normalization', () => {
  it('keeps funding.rate as a decimal ratio and rejects unparseable values', () => {
    expect(normalizeFundingRate('0.0001')).toBe(0.0001)
    expect(normalizeFundingRate(-0.0000788)).toBe(-0.0000788)
    expect(normalizeFundingRate('not-a-number')).toBeNull()
    expect(normalizeFundingRate('')).toBeNull()
  })

  it('normalizes open interest and reports skipped liquidation rows', () => {
    expect(normalizeOpenInterest('2249677981.5')).toBe(2249677981.5)
    expect(normalizeOpenInterest('missing')).toBeNull()
    expect(
      normalizeLiquidations([
        { trade_turnover: '100' },
        { volume: 25 },
        { trade_turnover: 'bad', volume: '5' },
        { volume: 'bad' },
      ]),
    ).toEqual({ notional: 130, skipped: 1 })
  })

  it('uses bps for basis and rejects non-positive prices', () => {
    expect(basisBps(100, 101)).toBe(100)
    expect(basisBps(78430.4, 78400)).toBeCloseTo(-3.8758, 3)
    expect(basisBps(0, 101)).toBeNull()
    expect(basisBps(100, -1)).toBeNull()
  })
})

describe('DerivativesTracker', () => {
  const series: readonly DerivativesObservation[] = [
    {
      timestamp: 0,
      fundingRate: '0.0001',
      openInterest: 1_000,
      liquidations: [{ volume: 10 }],
      spotPrice: 100,
      swapPrice: 101,
    },
    {
      timestamp: 500,
      fundingRate: '0.0002',
      openInterest: 1_100,
      liquidations: [{ trade_turnover: '5' }],
      spotPrice: 100,
      swapPrice: 99,
    },
    {
      timestamp: 1_501,
      fundingRate: undefined,
      openInterest: 0,
      liquidations: [{ volume: 2 }],
      spotPrice: 100,
      swapPrice: 100,
    },
  ]

  it('matches the full reference point by point and has non-empty samples', () => {
    const expected = derivativesValues(series, 1_000)
    const tracker = new DerivativesTracker(1_000)
    const actual = series.map((observation) => tracker.push(observation))
    const samples = actual.filter((value) => value.oiChangePct !== null && value.liqNotional !== null)

    expect(samples.length).toBeGreaterThan(0)
    expect(actual).toEqual(expected)
    expect(actual[0]).toEqual({ fundingRate: 0.0001, oiChangePct: null, liqNotional: 10, basisBps: 100 })
    expect(actual[1]?.oiChangePct).toBe(10)
    // prev=1100 时 curr=0 仍是 -100%，下一次 prev=0 才会因分母无效返回 null。
    expect(actual[2]?.oiChangePct).toBe(-100)
    expect(actual[2]?.liqNotional).toBe(2)
  })

  it('returns null for missing previous OI instead of manufacturing a percentage', () => {
    const tracker = new DerivativesTracker(60_000)
    expect(tracker.push({ timestamp: 1, openInterest: 0 }).oiChangePct).toBeNull()
    expect(tracker.push({ timestamp: 2, openInterest: 100 }).oiChangePct).toBeNull()
    expect(tracker.push({ timestamp: 3, openInterest: 110 }).oiChangePct).toBe(10)
  })

  it('deduplicates overlapping liquidation windows when rows have stable ids', () => {
    const observations: readonly DerivativesObservation[] = [
      { timestamp: 1_000, liquidations: [{ id: 'l1', trade_turnover: 10 }] },
      { timestamp: 2_000, liquidations: [{ id: 'l1', trade_turnover: 10 }, { id: 'l2', trade_turnover: 5 }] },
    ]
    const expected = derivativesValues(observations, 60_000)
    const tracker = new DerivativesTracker(60_000)
    const actual = observations.map((observation) => tracker.push(observation))
    expect(actual).toEqual(expected)
    expect(actual[1]?.liqNotional).toBe(15)
  })
})

class FakeDerivativesExchange implements CcxtExchangeLike {
  readonly id = 'htx'
  readonly has: Record<string, unknown> = {}

  async loadMarkets(): Promise<unknown> {
    return {}
  }

  async fetchOHLCV(): Promise<readonly unknown[]> {
    return []
  }

  async fetchFundingRate(): Promise<unknown> {
    return { funding_rate: '-0.0000788' }
  }

  async fetchOpenInterest(): Promise<unknown> {
    return { openInterestValue: '2249677981.5' }
  }

  async fetchLiquidations(): Promise<readonly unknown[]> {
    return [{ volume: '4' }, { trade_turnover: '6' }]
  }

  async fetchTicker(symbol: string): Promise<unknown> {
    return { last: symbol === 'BTC/USDT:USDT' ? '78400' : '78430.4' }
  }
}

describe('createCcxtDerivativesSource', () => {
  it('maps HTX-style fields and separate spot/swap tickers without network', async () => {
    const source = createCcxtDerivativesSource(new FakeDerivativesExchange())
    const observation = await source.fetch('BTC/USDT:USDT', 1_700_000_000_000, 'BTC/USDT')

    expect(observation).toEqual({
      timestamp: 1_700_000_000_000,
      fundingRate: -0.0000788,
      openInterest: 2249677981.5,
      liquidations: [{ volume: '4' }, { trade_turnover: '6' }],
      spotPrice: 78430.4,
      swapPrice: 78400,
    })
    expect(new DerivativesTracker(60_000).push(observation)).toMatchObject({
      fundingRate: -0.0000788,
      liqNotional: 10,
      basisBps: expect.closeTo(-3.8758, 3),
    })
  })
})
