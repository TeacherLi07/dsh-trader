import { describe, expect, it } from 'vitest'
import { MarketSourceError } from '../src/market/types.js'
import { closedOnly, closeTimeOf, normalizeCandles, timeframeMs } from '../src/market/normalize.js'
import { raw } from './helpers/market.js'

const TF = '1h'
const TF_MS = 3_600_000
const NOW = 1_700_000_000_000

describe('timeframes', () => {
  it('maps supported timeframes to milliseconds', () => {
    expect(timeframeMs('1m')).toBe(60_000)
    expect(timeframeMs('1h')).toBe(TF_MS)
    expect(timeframeMs('1d')).toBe(86_400_000)
    expect(closeTimeOf(1_000, '1h')).toBe(1_000 + TF_MS)
  })

  it('rejects unknown timeframes instead of guessing', () => {
    expect(() => timeframeMs('3m')).toThrow(MarketSourceError)
    expect(() => timeframeMs('')).toThrow(MarketSourceError)
  })
})

describe('normalizeCandles', () => {
  it('marks a bar closed exactly when openTime + timeframe <= now', () => {
    const open = NOW - TF_MS
    const { candles } = normalizeCandles([raw(open), raw(open + TF_MS)], 'BTC/USDT', TF, NOW)
    expect(candles.map((c) => c.closed)).toEqual([true, false])
    expect(candles[0]?.closeTime).toBe(open + TF_MS)
  })

  it('drops the in-progress last bar when only closed bars are requested', () => {
    const open = NOW - 2 * TF_MS
    const { candles } = normalizeCandles([raw(open), raw(open + TF_MS), raw(open + 2 * TF_MS)], 'BTC/USDT', TF, NOW)
    expect(closedOnly(candles)).toHaveLength(2)
  })

  it('sorts ascending and dedupes by openTime keeping the later value', () => {
    const { candles } = normalizeCandles(
      [raw(NOW - TF_MS, 100), raw(NOW - 3 * TF_MS, 90), raw(NOW - TF_MS, 111)],
      'BTC/USDT',
      TF,
      NOW,
    )
    expect(candles.map((c) => c.openTime)).toEqual([NOW - 3 * TF_MS, NOW - TF_MS])
    expect(candles[1]?.close).toBe(111)
  })

  it('counts and drops malformed or self-contradictory candles', () => {
    const { candles, dropped } = normalizeCandles(
      [
        raw(NOW - TF_MS), // ok
        raw(NOW - 2 * TF_MS, 100, { open: Number.NaN }), // NaN
        raw(NOW - 3 * TF_MS, 100, { volume: -1 }), // 负成交量
        raw(NOW - 4 * TF_MS, 100, { high: 50, low: 90 }), // high < low
        raw(NOW - 5 * TF_MS, 100, { high: 99 }), // high < close
        raw(NOW - 6 * TF_MS, 100, { low: 101 }), // low > open/close
        { ...raw(NOW - 7 * TF_MS), openTime: 1.5 }, // 非整数时间
      ],
      'BTC/USDT',
      TF,
      NOW,
    )
    expect(candles).toHaveLength(1)
    expect(dropped).toBe(6)
  })

  it('rejects a non-finite now', () => {
    expect(() => normalizeCandles([], 'BTC/USDT', TF, Number.NaN)).toThrow(MarketSourceError)
  })
})
