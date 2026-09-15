import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { featureValues } from '../src/market/context.js'
import { FeatureArchive } from '../src/market/feature-archive.js'
import {
  FEATURE_WARMUP_BARS,
  FEATURE_WINDOWS,
  FeatureEngine,
  FeaturePipeline,
} from '../src/market/features.js'
import {
  adxSeries,
  atrSeries,
  emaSeries,
  realizedVolSeries,
  rsiSeries,
  vwapSeries,
  zscoreSeries,
} from '../src/market/indicators.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { MarketSourceError, type Candle } from '../src/market/types.js'
import { randomSeries } from './helpers/market.js'

const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'

function candles(count: number): readonly Candle[] {
  return normalizeCandles(randomSeries(START, count), SYMBOL, TF, START + count * HOUR).candles
}

describe('FeatureEngine vs full recomputation', () => {
  it('matches the reference indicator series at every single bar', () => {
    const bars = candles(120)
    const closes = bars.map((bar) => bar.close)
    const ohlcvs = bars.map((bar) => ({
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }))

    const expected = {
      ema20: emaSeries(closes, FEATURE_WINDOWS.emaFast),
      ema50: emaSeries(closes, FEATURE_WINDOWS.emaSlow),
      rsi14: rsiSeries(closes, FEATURE_WINDOWS.rsi),
      atr14: atrSeries(ohlcvs, FEATURE_WINDOWS.atr),
      adx14: adxSeries(ohlcvs, FEATURE_WINDOWS.adx),
      vwap20: vwapSeries(ohlcvs, FEATURE_WINDOWS.vwap),
      zscore20: zscoreSeries(closes, FEATURE_WINDOWS.zscore),
      volRealized20: realizedVolSeries(closes, FEATURE_WINDOWS.vol),
    }
    const adxSamples = expected.adx14.filter((value): value is number => value !== null)
    expect(adxSamples.length).toBeGreaterThan(0)

    const engine = new FeatureEngine()
    bars.forEach((bar, index) => {
      const { values } = engine.onClosedCandle(bar)
      // 严格相等：两套实现用同一公式与同一运算顺序，不允许漂移
      expect(values.ema20).toBe(expected.ema20[index])
      expect(values.ema50).toBe(expected.ema50[index])
      expect(values.rsi14).toBe(expected.rsi14[index])
      expect(values.atr14).toBe(expected.atr14[index])
      expect(values.adx14).toBe(expected.adx14[index])
      expect(values.vwap20).toBe(expected.vwap20[index])
      expect(values.zscore20).toBe(expected.zscore20[index])
      expect(values.volRealized20).toBe(expected.volRealized20[index])
    })
  })

  it('warms up exactly where the reference implementation does', () => {
    const bars = candles(60)
    const engine = new FeatureEngine()
    const values = bars.map((bar) => engine.onClosedCandle(bar).values)

    expect(values[18]!.ema20).toBeNull()
    expect(values[19]!.ema20).not.toBeNull()
    expect(values[48]!.ema50).toBeNull()
    expect(values[49]!.ema50).not.toBeNull()
    expect(values[13]!.rsi14).toBeNull()
    expect(values[14]!.rsi14).not.toBeNull()
    expect(values[13]!.atr14).toBeNull()
    expect(values[14]!.atr14).not.toBeNull()
    expect(values[27]!.adx14).toBeNull()
    expect(values[28]!.adx14).not.toBeNull()
    expect(values[18]!.vwap20).toBeNull()
    expect(values[19]!.vwap20).not.toBeNull()
    expect(values[18]!.zscore20).toBeNull()
    expect(values[19]!.zscore20).not.toBeNull()
    expect(values[19]!.volRealized20).toBeNull()
    expect(values[20]!.volRealized20).not.toBeNull()
  })

  it('refuses an in-progress candle instead of silently skipping it', () => {
    const [closed, open] = candles(2)
    const engine = new FeatureEngine()
    expect(() => engine.onClosedCandle(closed!)).not.toThrow()
    expect(() => engine.onClosedCandle({ ...open!, closed: false })).toThrow(MarketSourceError)
  })

  it('is deterministic: same bars, fresh engine, same fingerprints', () => {
    const bars = candles(30)
    const run = (): string[] => {
      const engine = new FeatureEngine()
      return bars.map((bar) => engine.onClosedCandle(bar).fingerprint)
    }
    expect(run()).toEqual(run())
  })

  it('produces one distinct sha256 fingerprint per bar', () => {
    const bars = candles(25)
    const engine = new FeatureEngine()
    const fingerprints = bars.map((bar) => engine.onClosedCandle(bar).fingerprint)
    expect(new Set(fingerprints).size).toBe(fingerprints.length)
    expect(fingerprints[0]).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('exposes completed derivative fields to the DSL context and omits missing ones', () => {
    const [bar] = candles(1)
    const engine = new FeatureEngine()
    const snapshot = engine.onClosedCandle(bar!, {
      fundingRate: 0.0001,
      oiChangePct: 2.5,
      liqNotional: 125,
      basisBps: -3,
    })
    const table = featureValues(snapshot.values)
    expect(table['funding.rate']).toBe(0.0001)
    expect(table['oi.changePct']).toBe(2.5)
    expect(table['liq.notional']).toBe(125)
    expect(table['basis.bps']).toBe(-3)

    const missing = featureValues(new FeatureEngine().onClosedCandle(bar!).values)
    expect(missing['funding.rate']).toBeUndefined()
    expect(missing['adx14']).toBeUndefined()
  })
})

describe('FeaturePipeline', () => {
  let db: Database.Database
  let archive: FeatureArchive

  beforeEach(() => {
    db = new Database(':memory:')
    migrate(db)
    archive = new FeatureArchive(db)
  })

  afterEach(() => {
    db.close()
  })

  it('persists every snapshot and matches an engine fed from scratch after warm-up', () => {
    const bars = candles(80)
    const reference = new FeatureEngine()
    const expected = bars.map((bar) => reference.onClosedCandle(bar).values)

    const pipeline = new FeaturePipeline(archive)
    pipeline.warmUp(bars.slice(0, FEATURE_WARMUP_BARS))
    const produced = bars.slice(FEATURE_WARMUP_BARS).map((bar) => pipeline.onClosedCandle(bar).values)

    expect(produced).toEqual(expected.slice(FEATURE_WARMUP_BARS))
    expect(archive.count(SYMBOL, TF)).toBe(bars.length - FEATURE_WARMUP_BARS)
    expect(pipeline.engineCount()).toBe(1)
  })

  it('keeps independent state per symbol and timeframe', () => {
    const pipeline = new FeaturePipeline(archive)
    for (const candle of candles(3)) pipeline.onClosedCandle(candle)
    const eth = normalizeCandles(randomSeries(START, 3), 'ETH/USDT', TF, START + 3 * HOUR).candles
    for (const candle of eth) pipeline.onClosedCandle(candle)

    expect(pipeline.engineCount()).toBe(2)
    expect(archive.count()).toBe(6)
  })

  it('ignores in-progress bars during warm-up', () => {
    const bars = candles(10)
    const pipeline = new FeaturePipeline(archive)
    pipeline.warmUp([...bars, { ...bars[9]!, openTime: bars[9]!.openTime + HOUR, closed: false }])
    expect(pipeline.engineCount()).toBe(1)
    expect(archive.count()).toBe(0) // warmUp 只重建状态，不写归档
  })
})
