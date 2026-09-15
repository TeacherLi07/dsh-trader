import { describe, expect, it } from 'vitest'
import {
  adxSeries,
  atrSeries,
  emaSeries,
  realizedVolSeries,
  rsiSeries,
  rsiValue,
  trueRangeAt,
  vwapSeries,
  zscoreOf,
  zscoreSeries,
} from '../src/market/indicators.js'

describe('emaSeries', () => {
  it('seeds with the first value and warms up for period-1 bars', () => {
    const out = emaSeries([1, 2, 3, 4, 5], 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    // k = 2/(3+1) = 0.5；EMA: v0=1 → v1=1.5 → v2=2.25 → v3=3.125 → v4=4.0625
    expect(out[2]).toBeCloseTo(2.25, 10)
    expect(out[3]).toBeCloseTo(3.125, 10)
    expect(out[4]).toBeCloseTo(4.0625, 10)
  })

  it('degenerates to the input for period 1, and handles empty input', () => {
    expect(emaSeries([1, 2, 3], 1)).toEqual([1, 2, 3])
    expect(emaSeries([], 5)).toEqual([])
  })

  it('rejects invalid periods', () => {
    expect(() => emaSeries([1], 0)).toThrow()
    expect(() => emaSeries([1], 1.5)).toThrow()
  })
})

describe('rsiSeries', () => {
  it('is 100 for a monotonic rise, 0 for a fall, and 50 for a flat market', () => {
    expect(rsiValue(1, 0)).toBe(100)
    expect(rsiValue(0, 1)).toBe(0)
    expect(rsiValue(0, 0)).toBe(50)
  })

  it('warms up for exactly `period` changes', () => {
    const rising = rsiSeries([1, 2, 3, 4, 5], 3)
    expect(rising[0]).toBeNull()
    expect(rising[1]).toBeNull()
    expect(rising[2]).toBeNull()
    expect(rising[3]).toBe(100)
    expect(rising[4]).toBe(100)
  })

  it('returns all nulls when there are not enough values', () => {
    expect(rsiSeries([1, 2, 3], 3)).toEqual([null, null, null])
  })
})

describe('atrSeries', () => {
  const flat = [
    { high: 11, low: 9, close: 10, volume: 1 },
    { high: 12, low: 10, close: 11, volume: 1 },
    { high: 13, low: 11, close: 12, volume: 1 },
    { high: 14, low: 12, close: 13, volume: 1 },
  ]

  it('uses high-low at index 0 and the previous close afterwards', () => {
    expect(trueRangeAt(flat, 0)).toBe(2)
    // TR = max(2, |12-10|, |10-10|) = 2
    expect(trueRangeAt(flat, 1)).toBe(2)
  })

  it('warms up at index = period', () => {
    const out = atrSeries(flat, 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).toBe(2)
    expect(out[3]).toBe(2)
  })

  it('returns all nulls when there are not enough candles', () => {
    expect(atrSeries(flat.slice(0, 2), 2)).toEqual([null, null])
  })
})

describe('adxSeries', () => {
  it('uses DI at index=period and ADX at index=2*period', () => {
    const candles = Array.from({ length: 40 }, (_, index) => {
      const close = 100 + index * 2
      return { high: close + 1, low: close - 1, close, volume: 1 }
    })
    const out = adxSeries(candles, 5)
    expect(out[9]).toBeNull()
    expect(out[10]).not.toBeNull()
    expect(out.filter((value): value is number => value !== null).length).toBeGreaterThan(0)
    expect(out[10]).toBe(100)
  })

  it('distinguishes a persistent trend from alternating movement', () => {
    const trend = Array.from({ length: 60 }, (_, index) => {
      const close = 100 + index * 2
      return { high: close + 1, low: close - 1, close, volume: 1 }
    })
    const oscillation = Array.from({ length: 60 }, (_, index) => {
      const close = index % 2 === 0 ? 100 : 101
      return { high: close + 1, low: close - 1, close, volume: 1 }
    })
    const trendAdx = adxSeries(trend, 14).filter((value): value is number => value !== null)
    const oscillationAdx = adxSeries(oscillation, 14).filter((value): value is number => value !== null)
    expect(trendAdx.length).toBeGreaterThan(0)
    expect(oscillationAdx.length).toBeGreaterThan(0)
    expect(trendAdx[trendAdx.length - 1] as number).toBeGreaterThan(25)
    expect(oscillationAdx[oscillationAdx.length - 1] as number).toBeLessThan(25)
  })

  it('returns all nulls before the double-period warm-up', () => {
    const candles = Array.from({ length: 28 }, (_, index) => ({
      high: index + 2,
      low: index,
      close: index + 1,
      volume: 1,
    }))
    expect(adxSeries(candles, 14).every((value) => value === null)).toBe(true)
  })
})

describe('vwapSeries', () => {
  const candles = [
    { high: 2, low: 0, close: 1, volume: 10 }, // tp = 1
    { high: 4, low: 2, close: 3, volume: 30 }, // tp = 3
  ]

  it('weights typical price by volume over the window', () => {
    const out = vwapSeries(candles, 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeCloseTo((1 * 10 + 3 * 30) / 40, 10)
  })

  it('returns null when the window has no volume', () => {
    const noVolume = candles.map((c) => ({ ...c, volume: 0 }))
    expect(vwapSeries(noVolume, 2)[1]).toBeNull()
  })
})

describe('zscore', () => {
  it('computes a population z-score of the last value', () => {
    const value = zscoreOf([1, 2, 3])
    const expected = (3 - 2) / Math.sqrt(2 / 3)
    expect(value).toBeCloseTo(expected, 10)
  })

  it('returns null when the window has zero variance', () => {
    expect(zscoreOf([5, 5, 5])).toBeNull()
    expect(zscoreOf([])).toBeNull()
  })

  it('warms up for period-1 bars', () => {
    const out = zscoreSeries([1, 2, 3], 2)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeCloseTo((2 - 1.5) / Math.sqrt(0.25), 10)
  })
})

describe('realizedVolSeries', () => {
  it('is 0 for constant prices and warms up for `period` returns', () => {
    const flat = realizedVolSeries([10, 10, 10, 10], 2)
    expect(flat[0]).toBeNull()
    expect(flat[1]).toBeNull()
    expect(flat[2]).toBe(0)
    expect(flat[3]).toBe(0)
  })

  it('returns null when a price is not positive', () => {
    expect(realizedVolSeries([10, 0, 10], 2)[2]).toBeNull()
  })
})
