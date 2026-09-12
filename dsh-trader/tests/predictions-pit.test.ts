import { describe, expect, it } from 'vitest'
import {
  PmTimeError,
  estimateProbability,
  liquidityGate,
  marketAsOf,
  normalizeSourceSeconds,
  seriesAsOf,
  watchDedupKey,
} from '../src/predictions/pit.js'

const market = {
  conditionId: '0xabc',
  createdAt: 1_700_000_000_000,
  closed: false,
}

describe('PIT gates (plan §4.4)', () => {
  it('existence gate: a market that did not exist yet is invisible', () => {
    expect(marketAsOf(market, market.createdAt - 1)).toEqual({
      visible: false,
      reason: 'not_created_yet',
    })
    expect(marketAsOf(market, market.createdAt)).toMatchObject({ visible: true })
  })

  it('resolution gate: the outcome is hidden until resolved_at has passed', () => {
    const closed = { ...market, closed: true, resolvedAt: 1_800_000_000_000, winningOutcome: 'Yes' }

    const before = marketAsOf(closed, 1_799_999_999_999)
    expect(before).toEqual({ visible: true, resolved: false, winningOutcome: undefined })

    const after = marketAsOf(closed, 1_800_000_000_000)
    expect(after).toEqual({ visible: true, resolved: true, winningOutcome: 'Yes' })
  })

  it('resolution gate: closed without a resolved_at still hides the outcome', () => {
    const view = marketAsOf({ ...market, closed: true, winningOutcome: 'Yes' }, 1_900_000_000_000)
    expect(view).toEqual({ visible: true, resolved: false, winningOutcome: undefined })
  })

  it('series gate: only points at or before now survive, order preserved', () => {
    const points = [
      { ts: 100, price: 0.1 },
      { ts: 200, price: 0.2 },
      { ts: 300, price: 0.3 },
    ]
    expect(seriesAsOf(points, 200)).toEqual([
      { ts: 100, price: 0.1 },
      { ts: 200, price: 0.2 },
    ])
    expect(seriesAsOf(points, 0)).toEqual([])
  })

  it('normalizes source seconds to integer milliseconds', () => {
    expect(normalizeSourceSeconds(1_789_138_800)).toBe(1_789_138_800_000)
    expect(Number.isInteger(normalizeSourceSeconds(1_789_138_800))).toBe(true)
  })

  it('rejects a millisecond value passed as seconds instead of silently scaling it', () => {
    expect(() => normalizeSourceSeconds(1_789_138_800_000)).toThrow(PmTimeError)
    expect(() => normalizeSourceSeconds(0)).toThrow(PmTimeError)
    expect(() => normalizeSourceSeconds(Number.NaN)).toThrow(PmTimeError)
  })

  it('picks one estimator and reports which one it used', () => {
    expect(estimateProbability({ mid: 0.42, lastTradePrice: 0.4 })).toEqual({
      ok: true,
      value: 0.42,
      estimator: 'mid',
    })
    expect(estimateProbability({ lastTradePrice: 0.4 })).toEqual({
      ok: true,
      value: 0.4,
      estimator: 'last_trade_price',
    })
    expect(estimateProbability({ mid: 1.2 })).toMatchObject({ ok: false })
    expect(estimateProbability({})).toMatchObject({ ok: false })
  })

  it('liquidity gate blocks thin or wide markets', () => {
    const config = { liquidityFloorQuote: 50_000, spreadCeilBps: 200 }
    expect(liquidityGate({ liquidity: 80_000, spread: 0.01 }, config)).toEqual({ pass: true })
    expect(liquidityGate({ liquidity: 1_000, spread: 0.01 }, config)).toMatchObject({ pass: false })
    expect(liquidityGate({ liquidity: 80_000, spread: 0.05 }, config)).toMatchObject({ pass: false })
    expect(liquidityGate({ spread: 0.01 }, config)).toMatchObject({ pass: false })
  })

  it('dedups watch hits per (watch, token, time bucket)', () => {
    // 900s 桶：[0,900k)=0，[900k,1.8M)=1，[1.8M,2.7M)=2
    const a = watchDedupKey('w1', 'tok', 1_000_000, 900_000)
    expect(a).toBe('pm:w1:tok:1')
    expect(a).toBe(watchDedupKey('w1', 'tok', 1_799_999, 900_000)) // 同一桶
    expect(a).not.toBe(watchDedupKey('w1', 'tok', 1_800_000, 900_000)) // 跨桶
    expect(a).not.toBe(watchDedupKey('w2', 'tok', 1_000_000, 900_000)) // 不同 watch
    expect(() => watchDedupKey('w1', 'tok', 1_000_000, 0)).toThrow(PmTimeError)
  })
})
