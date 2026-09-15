import { describe, expect, it } from 'vitest'
import {
  percentileRank,
  regimeOf,
  trendBucket,
  trendRatio,
  volBucket,
} from '../src/market/regime.js'

describe('regime pure functions', () => {
  it('defines percentileRank as the <= sample proportion and never invents an empty rank', () => {
    const history = [3, 1, 2, 2]
    expect(history.length).toBeGreaterThan(0)
    expect(percentileRank(2, history)).toBe(0.75)
    expect(percentileRank(2, [...history].sort((left, right) => left - right))).toBe(0.75)
    expect(percentileRank(2, [2, 2, 2])).toBe(1)
    expect(percentileRank(0, history)).toBe(0)
    expect(percentileRank(2, [])).toBeNull()
  })

  it('locks low/mid/high volatility boundaries at exactly 0.33 and 0.67', () => {
    const history = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(history.length).toBeGreaterThan(0)
    expect(volBucket(32, history)).toBe('low')
    expect(volBucket(33, history)).toBe('mid')
    expect(volBucket(67, history)).toBe('mid')
    expect(volBucket(68, history)).toBe('high')
    expect(volBucket(null, history)).toBeNull()
    expect(volBucket(50, [])).toBeNull()
  })

  it('uses the auditable ATR-normalized trend thresholds', () => {
    expect(trendRatio({ ema20: 100, ema50: 100.4, atr14: 1 })).toBeCloseTo(0.4)
    expect(trendBucket({ ema20: 100, ema50: 100.4, atr14: 1 })).toBe('range')
    expect(trendBucket({ ema20: 100, ema50: 99.5, atr14: 1 })).toBe('trend')
    expect(trendBucket({ ema20: 100, ema50: 98.5, atr14: 1 })).toBe('trend')
    expect(trendBucket({ ema20: 100, ema50: 98.4, atr14: 1 })).toBe('strong_trend')
    expect(trendBucket({ ema20: 100, ema50: 101, atr14: 0 })).toBeNull()
    expect(trendBucket({ ema20: null, ema50: 101, atr14: 1 })).toBeNull()
  })

  it('fails closed for insufficient history and warmed-up inputs', () => {
    const tooShort = regimeOf({
      symbol: 'BTC/USDT',
      timeframe: '1h',
      ema20: 101,
      ema50: 100,
      atr14: 1,
      volRealized20: 0.2,
      volHistory: [0.1, 0.2],
    })
    expect(tooShort.ok).toBe(false)
    if (tooShort.ok) throw new Error('样本不足不应产生 regime 桶')
    expect(tooShort.reason).toContain('样本不足')

    const missing = regimeOf({
      symbol: 'BTC/USDT',
      timeframe: '1h',
      ema20: null,
      ema50: 100,
      atr14: 1,
      volRealized20: 0.2,
      volHistory: Array.from({ length: 30 }, () => 0.2),
    })
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('暖机中的趋势指标不应产生 regime 桶')
    expect(missing.reason).toContain('暖机')
  })

  it('classifies the same synthetic 90-day input reproducibly', () => {
    const volHistory = Array.from({ length: 90 }, (_, index) => (index + 1) / 100)
    expect(volHistory.length).toBe(90)

    const input = {
      symbol: 'BTC/USDT',
      timeframe: '1h',
      ema20: 104,
      ema50: 100,
      atr14: 2,
      volRealized20: 0.9,
      volHistory,
    }
    const first = regimeOf(input)
    const second = regimeOf(input)

    expect(first).toEqual(second)
    expect(first).toEqual({
      ok: true,
      bucket: 'strong_trend|high',
      trend: 'strong_trend',
      vol: 'high',
      trendRatio: 2,
      volRank: 1,
      samples: 90,
    })
  })
})
