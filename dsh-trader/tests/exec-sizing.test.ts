import { describe, expect, it } from 'vitest'
import { computeSize, stopPriceFor, takeProfitFor } from '../src/exec/sizing.js'

describe('computeSize (plan §3.4)', () => {
  it('sizes from equity risk and stop distance', () => {
    const result = computeSize({ equityQuote: 10_000, riskPct: 0.01, entryPrice: 100, stopPrice: 95 })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.stopDistance).toBe(5)
      expect(result.riskQuote).toBe(100)
      expect(result.qty).toBe(20)
      expect(result.notionalUsd).toBe(2_000)
    }
  })

  it('floors to the venue quantity step', () => {
    const result = computeSize({
      equityQuote: 10_000,
      riskPct: 0.01,
      entryPrice: 100,
      stopPrice: 97,
      qtyStep: 0.5,
    })
    // 100/3 = 33.33 → 步进 0.5 → 33.0
    expect(result.ok && result.qty).toBe(33)
  })

  it('refuses a zero stop distance instead of dividing by zero', () => {
    expect(computeSize({ equityQuote: 10_000, riskPct: 0.01, entryPrice: 100, stopPrice: 100 })).toEqual({
      ok: false,
      reason: '止损距离为 0 —— 无法据此定仓',
    })
  })

  it('rejects out-of-range risk, non-positive equity, and tiny sizes', () => {
    expect(computeSize({ equityQuote: 10_000, riskPct: 0, entryPrice: 100, stopPrice: 95 }).ok).toBe(false)
    expect(computeSize({ equityQuote: 10_000, riskPct: 0.2, entryPrice: 100, stopPrice: 95 }).ok).toBe(false)
    expect(computeSize({ equityQuote: 0, riskPct: 0.01, entryPrice: 100, stopPrice: 95 }).ok).toBe(false)
    expect(
      computeSize({ equityQuote: 1, riskPct: 0.001, entryPrice: 100, stopPrice: 50, minQty: 1 }).ok,
    ).toBe(false)
  })

  it('enforces the per-order notional cap', () => {
    const result = computeSize({
      equityQuote: 1_000_000,
      riskPct: 0.01,
      entryPrice: 100,
      stopPrice: 99,
      maxNotionalUsd: 500,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('超过单笔上限')
  })
})

describe('stopPriceFor', () => {
  it('uses the structure level when the method is structure', () => {
    expect(stopPriceFor(100, 'long', { method: 'structure', level: 92 }, null)).toBe(92)
  })

  it('derives an ATR stop on the correct side of the entry', () => {
    expect(stopPriceFor(100, 'long', { method: 'atr', k: 2 }, 3)).toBe(94)
    expect(stopPriceFor(100, 'short', { method: 'atr', k: 2 }, 3)).toBe(106)
  })

  it('refuses to guess when ATR is unavailable (warm-up)', () => {
    expect(stopPriceFor(100, 'long', { method: 'atr', k: 2 }, null)).toBeUndefined()
    expect(stopPriceFor(100, 'long', { method: 'atr', k: 2 }, 0)).toBeUndefined()
    expect(stopPriceFor(100, 'long', { method: 'atr', k: 2 }, Number.NaN)).toBeUndefined()
  })
})

describe('takeProfitFor', () => {
  it('projects the R multiple from the stop distance', () => {
    expect(takeProfitFor(100, 'long', 95, 2)).toBe(110)
    expect(takeProfitFor(100, 'short', 105, 2)).toBe(90)
  })

  it('returns undefined when no target is declared', () => {
    expect(takeProfitFor(100, 'long', 95, undefined)).toBeUndefined()
    expect(takeProfitFor(100, 'long', 95, 0)).toBeUndefined()
  })
})
