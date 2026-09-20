import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { FeatureArchive } from '../src/market/feature-archive.js'
import { FeatureEngine, type FeatureSnapshot } from '../src/market/features.js'
import { MarketObservationStore } from '../src/market/observations.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { randomSeries } from './helpers/market.js'

const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'

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

function snapshot(count = 25): FeatureSnapshot {
  const bars = normalizeCandles(randomSeries(START, count), SYMBOL, TF, START + count * HOUR).candles
  const engine = new FeatureEngine()
  return bars.map((bar) => engine.onClosedCandle(bar)).at(-1)!
}

describe('FeatureArchive', () => {
  it('round-trips a snapshot exactly', () => {
    const original = snapshot()
    archive.upsert(original)

    const readBack = archive.get(SYMBOL, TF, original.openTime)
    expect(readBack).toEqual(original)
    expect(archive.latest(SYMBOL, TF)).toEqual(original)
    expect(archive.count()).toBe(1)
  })

  it('只在调用方提供可见时刻时写 feature PIT observation', () => {
    const item = snapshot()
    const availableAt = item.closeTime + 500
    archive.upsert(item, availableAt)
    const observation = new MarketObservationStore(db)

    expect(observation.recent('feature', SYMBOL, TF, item.closeTime, 10)).toEqual([])
    const visible = observation.recent<FeatureSnapshot>('feature', SYMBOL, TF, availableAt, 10)
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({ eventTime: item.closeTime, availableAt, value: item })
  })

  it('is idempotent per (symbol, timeframe, open_time)', () => {
    const original = snapshot()
    archive.upsert(original)
    archive.upsert(original)
    expect(archive.count(SYMBOL, TF)).toBe(1)
  })

  it('updates in place when the same bar is recomputed with different values', () => {
    const original = snapshot()
    archive.upsert(original)

    const changed: FeatureSnapshot = {
      ...original,
      values: { ...original.values, rsi14: 12.5 },
      fingerprint: 'sha256:changed',
    }
    archive.upsert(changed)

    expect(archive.count()).toBe(1)
    expect(archive.get(SYMBOL, TF, original.openTime)?.values.rsi14).toBe(12.5)
    expect(archive.get(SYMBOL, TF, original.openTime)?.fingerprint).toBe('sha256:changed')
  })

  it('scopes by symbol/timeframe and reports the latest bar', () => {
    const bars = normalizeCandles(randomSeries(START, 25), SYMBOL, TF, START + 25 * HOUR).candles
    const engine = new FeatureEngine()
    for (const bar of bars) archive.upsert(engine.onClosedCandle(bar))

    const eth = normalizeCandles(randomSeries(START, 25), 'ETH/USDT', TF, START + 25 * HOUR).candles
    const ethEngine = new FeatureEngine()
    for (const bar of eth) archive.upsert(ethEngine.onClosedCandle(bar))

    expect(archive.count(SYMBOL, TF)).toBe(25)
    expect(archive.count('ETH/USDT', TF)).toBe(25)
    expect(archive.count(SYMBOL, '15m')).toBe(0)
    expect(archive.latest(SYMBOL, TF)?.openTime).toBe(bars[24]!.openTime)
    expect(archive.get(SYMBOL, TF, START)).toBeDefined()
    expect(archive.get(SYMBOL, TF, START - HOUR)).toBeUndefined()
  })

  it('reads an inclusive range in ascending open-time order and respects limit', () => {
    const bars = normalizeCandles(randomSeries(START, 8), SYMBOL, TF, START + 8 * HOUR).candles
    const engine = new FeatureEngine()
    const stored: FeatureSnapshot[] = []
    for (const bar of bars) {
      const item = engine.onClosedCandle(bar)
      stored.push(item)
      archive.upsert(item)
    }
    expect(stored.length).toBeGreaterThan(0)

    const ranged = archive.range(SYMBOL, TF, {
      since: stored[2]!.openTime,
      until: stored[5]!.openTime,
    })
    expect(ranged.length).toBeGreaterThan(0)
    expect(ranged).toEqual(stored.slice(2, 6))
    expect(ranged.map((item) => item.openTime)).toEqual(
      [...ranged].map((item) => item.openTime).sort((left, right) => left - right),
    )

    const limited = archive.range(SYMBOL, TF, { limit: 2 })
    expect(limited.length).toBeGreaterThan(0)
    expect(limited).toEqual(stored.slice(0, 2))
    expect(archive.range(SYMBOL, TF, { since: START + 100 * HOUR })).toEqual([])
  })

  it('fails loudly instead of treating malformed snapshot JSON as missing data', () => {
    db.prepare(
      `INSERT INTO features (symbol, timeframe, open_time, snapshot_json, fingerprint)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(SYMBOL, TF, START, '{not-json', 'sha256:bad')

    expect(() => archive.range(SYMBOL, TF)).toThrow()
  })
})
