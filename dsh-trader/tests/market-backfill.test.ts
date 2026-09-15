import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { backfill } from '../src/market/backfill.js'
import { TokenBucket } from '../src/market/ratelimit.js'
import { MarketSourceError } from '../src/market/types.js'
import { FakeSource, series } from './helpers/market.js'

const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'

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

const at = (hours: number): number => START + hours * HOUR

describe('backfill', () => {
  it('paginates to the exclusive end, stores closed bars, and advances the cursor', async () => {
    const clock = new ReplayClock(at(10))
    const source = new FakeSource({ pages: [series(at(0), 3), series(at(3), 3), []] })

    const result = await backfill(
      { source, archive, clock },
      { symbol: SYMBOL, timeframe: TF, since: at(0), until: at(5) },
    )

    expect(result.stoppedBy).toBe('reached_until')
    expect(result.pages).toBe(2)
    expect(result.written).toBe(5) // 0h..4h，5h 被 until 排除
    expect(archive.count(SYMBOL, TF)).toBe(5)
    expect(source.calls.map((c) => c.since)).toEqual([at(0), at(3)])
    expect(archive.closedBars(SYMBOL, TF).map((c) => c.openTime)).toEqual([
      at(0),
      at(1),
      at(2),
      at(3),
      at(4),
    ])
  })

  it('stops immediately when the source does not advance (no busy loop)', async () => {
    const clock = new ReplayClock(at(200))
    const stuck = series(at(0), 3)
    const source = new FakeSource({ pages: [stuck, stuck, stuck, stuck, stuck] })

    const result = await backfill(
      { source, archive, clock },
      { symbol: SYMBOL, timeframe: TF, since: at(0), until: at(100) },
    )

    expect(result.stoppedBy).toBe('no_progress')
    expect(result.pages).toBe(2)
    expect(archive.count(SYMBOL, TF)).toBe(3)
  })

  it('reports an empty first page', async () => {
    const clock = new ReplayClock(at(10))
    const source = new FakeSource({ pages: [[]] })
    const result = await backfill(
      { source, archive, clock },
      { symbol: SYMBOL, timeframe: TF, since: at(0), until: at(5) },
    )
    expect(result.stoppedBy).toBe('empty')
    expect(result.written).toBe(0)
  })

  it('honours maxPages', async () => {
    const clock = new ReplayClock(at(100))
    const source = new FakeSource({ pages: [series(at(0), 2), series(at(2), 2), series(at(4), 2)] })
    const result = await backfill(
      { source, archive, clock },
      { symbol: SYMBOL, timeframe: TF, since: at(0), until: at(100), maxPages: 2 },
    )
    expect(result.stoppedBy).toBe('max_pages')
    expect(result.pages).toBe(2)
    expect(result.written).toBe(4)
  })

  it('never stores the in-progress bar', async () => {
    const clock = new ReplayClock(at(2)) // 2h 的 bar 要到 3h 才收盘
    const source = new FakeSource({ pages: [series(at(0), 3), []] })
    const result = await backfill(
      { source, archive, clock },
      { symbol: SYMBOL, timeframe: TF, since: at(0), until: at(10) },
    )
    expect(result.written).toBe(2)
    expect(archive.count(SYMBOL, TF)).toBe(2)
  })

  it('waits on the token bucket through the injected sleep', async () => {
    const clock = new ReplayClock(at(100))
    const sleeps: number[] = []
    const limiter = new TokenBucket(clock, { capacity: 1, refillTokens: 1, refillMs: 1_000 })
    const source = new FakeSource({ pages: [series(at(0), 1), series(at(1), 1), []] })

    const result = await backfill(
      {
        source,
        archive,
        clock,
        limiter,
        sleep: async (ms) => {
          sleeps.push(ms)
          clock.advanceTo(clock.now() + ms) // 让虚拟时间真的前进，桶才能补充
        },
      },
      { symbol: SYMBOL, timeframe: TF, since: at(0), until: at(50) },
    )

    expect(sleeps.length).toBeGreaterThan(0)
    expect(sleeps.every((ms) => ms > 0)).toBe(true)
    expect(result.stoppedBy).toBe('empty')
  })

  it('rejects an inverted range', async () => {
    const clock = new ReplayClock(at(10))
    const source = new FakeSource({ pages: [] })
    await expect(
      backfill({ source, archive, clock }, { symbol: SYMBOL, timeframe: TF, since: at(5), until: at(5) }),
    ).rejects.toThrow(MarketSourceError)
  })
})

describe('backfill：until 是开区间（审计修复）', () => {
  it('★ next === until 时必须立即停，且停止原因是 reached_until', async () => {
    const clock = new ReplayClock(at(10))
    const source = new FakeSource({ pages: [series(at(0), 3), series(at(3), 3)] })
    const result = await backfill(
      { source, archive, clock },
      { symbol: SYMBOL, timeframe: TF, since: at(0), until: at(3) },
    )
    expect(source.calls).toHaveLength(1)
    expect(result.stoppedBy).toBe('reached_until')
    // 区间内只有 0/1/2 三根
    expect(result.written).toBe(3)
  })
})
