import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { raw } from './helpers/market.js'

const TF = '1h'
const HOUR = 3_600_000
const NOW = 1_700_000_000_000
const META = { source: 'fake', fetchedAt: NOW }

let db: Database.Database
let archive: BarArchive

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  archive = new BarArchive(db)
})

afterEach(() => {
  db.close()
})

const candles = (raws: Parameters<typeof normalizeCandles>[0]) =>
  normalizeCandles(raws, 'BTC/USDT', TF, NOW).candles

describe('BarArchive', () => {
  it('writes closed bars', () => {
    const result = archive.upsertClosed(candles([raw(NOW - 2 * HOUR), raw(NOW - HOUR)]), META)
    expect(result).toEqual({ written: 2, rejectedOpen: 0 })
    expect(archive.count('BTC/USDT', TF)).toBe(2)
  })

  it('refuses in-progress bars — only closed bars are ever stored', () => {
    const result = archive.upsertClosed(candles([raw(NOW - HOUR), raw(NOW)]), META)
    expect(result).toEqual({ written: 1, rejectedOpen: 1 })
    expect(archive.count()).toBe(1)
    expect(archive.lastOpenTime('BTC/USDT', TF)).toBe(NOW - HOUR)
  })

  it('is idempotent: re-writing the same page does not duplicate rows', () => {
    const batch = candles([raw(NOW - 3 * HOUR), raw(NOW - 2 * HOUR), raw(NOW - HOUR)])
    archive.upsertClosed(batch, META)
    const again = archive.upsertClosed(batch, META)
    expect(again.written).toBe(3)
    expect(archive.count()).toBe(3)
  })

  it('applies exchange corrections for the same open_time (upsert, not append)', () => {
    archive.upsertClosed(candles([raw(NOW - HOUR, 100)]), META)
    archive.upsertClosed(candles([raw(NOW - HOUR, 123)]), META)
    const stored = archive.closedBars('BTC/USDT', TF)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.close).toBe(123)
  })

  it('returns closed bars ascending within [since, until) and honours the limit', () => {
    archive.upsertClosed(
      candles([raw(NOW - 5 * HOUR), raw(NOW - 4 * HOUR), raw(NOW - 3 * HOUR), raw(NOW - 2 * HOUR)]),
      META,
    )
    const range = archive.closedBars('BTC/USDT', TF, {
      since: NOW - 4 * HOUR,
      until: NOW - 2 * HOUR,
    })
    expect(range.map((c) => c.openTime)).toEqual([NOW - 4 * HOUR, NOW - 3 * HOUR])
    expect(archive.closedBars('BTC/USDT', TF, { limit: 2 })).toHaveLength(2)
  })

  it('scopes queries per symbol and timeframe', () => {
    archive.upsertClosed(candles([raw(NOW - HOUR)]), META)
    const other = normalizeCandles([raw(NOW - HOUR)], 'ETH/USDT', TF, NOW).candles
    archive.upsertClosed(other, META)
    expect(archive.count('BTC/USDT')).toBe(1)
    expect(archive.count('ETH/USDT')).toBe(1)
    expect(archive.count()).toBe(2)
    expect(archive.closedBars('ETH/USDT', '15m')).toHaveLength(0)
  })
})
