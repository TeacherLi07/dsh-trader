import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import {
  DEFAULT_BACKOFF,
  MarketFeed,
  computeBackoff,
  type FeedErrorInfo,
  type MarketFeedOptions,
} from '../src/market/feed.js'
import { MarketSourceError, type MarketDataSource } from '../src/market/types.js'
import { TokenBucket } from '../src/market/ratelimit.js'
import { FakeSource, series } from './helpers/market.js'

const TF = '1h'
const HOUR = 3_600_000
const NOW = 1_700_000_000_000
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

function makeFeed(
  source: MarketDataSource,
  clock: ReplayClock,
  over: Partial<MarketFeedOptions> = {},
): MarketFeed {
  return new MarketFeed({
    source,
    archive,
    clock,
    symbols: [SYMBOL],
    timeframes: [TF],
    pollMs: 60_000,
    ...over,
  })
}

describe('computeBackoff', () => {
  it('grows exponentially and caps at maxMs', () => {
    expect(computeBackoff(0)).toBe(1_000)
    expect(computeBackoff(1)).toBe(2_000)
    expect(computeBackoff(2)).toBe(4_000)
    expect(computeBackoff(6)).toBe(60_000)
    expect(computeBackoff(50)).toBe(60_000)
    expect(DEFAULT_BACKOFF.maxMs).toBe(60_000)
  })

  it('rejects invalid attempts and configurations', () => {
    expect(() => computeBackoff(-1)).toThrow()
    expect(() => computeBackoff(1.5)).toThrow()
    expect(() => computeBackoff(0, { baseMs: 0, maxMs: 10, factor: 2 })).toThrow()
    expect(() => computeBackoff(0, { baseMs: 10, maxMs: 5, factor: 2 })).toThrow()
  })
})

describe('MarketFeed', () => {
  it('stores and emits only newly closed candles', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [series(NOW - 3 * HOUR, 3), series(NOW - 3 * HOUR, 4)] })
    const emitted: number[] = []
    const feed = makeFeed(source, clock, {
      onClosedCandle: (candle) => {
        emitted.push(candle.openTime)
      },
    })

    const first = await feed.pollOnce()
    expect(first).toEqual({ fetched: 3, written: 3, emitted: 3, failures: 0 })

    // 第 4 根（openTime = NOW）此刻才收盘
    clock.advanceTo(NOW + HOUR)
    const second = await feed.pollOnce()
    expect(second.written).toBe(4)
    expect(second.emitted).toBe(1)

    expect(emitted).toEqual([NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR, NOW])
    expect(archive.count(SYMBOL, TF)).toBe(4)
    expect(feed.attempts(SYMBOL, TF)).toBe(0)
  })

  it('never lets a failing source break the loop; it counts and backs off', async () => {
    const clock = new ReplayClock(NOW)
    const error = Object.assign(new Error('rate limit exceeded'), { name: 'RateLimitExceeded' })
    const source = new FakeSource({ error })
    const seen: FeedErrorInfo[] = []
    const feed = makeFeed(source, clock, {
      onError: (_error, info) => {
        seen.push(info)
      },
    })

    await expect(feed.pollOnce()).resolves.toEqual({
      fetched: 0,
      written: 0,
      emitted: 0,
      failures: 1,
    })
    expect(seen[0]).toMatchObject({ symbol: SYMBOL, timeframe: TF, kind: 'rate_limit', attempt: 1 })
    expect(feed.attempts(SYMBOL, TF)).toBe(1)
    expect(feed.backoffFor(SYMBOL, TF)).toBe(1_000)

    await feed.pollOnce()
    expect(feed.attempts(SYMBOL, TF)).toBe(2)
    expect(feed.backoffFor(SYMBOL, TF)).toBe(2_000)
  })

  it('resets the failure counter after a successful poll', async () => {
    const clock = new ReplayClock(NOW)
    let calls = 0
    const flaky: MarketDataSource = {
      id: 'flaky',
      capabilities: { watchOHLCV: false },
      async fetchOHLCV() {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('socket hang up'), { name: 'NetworkError' })
        return series(NOW - HOUR, 1)
      },
    }
    const feed = makeFeed(flaky, clock)

    await feed.pollOnce()
    expect(feed.attempts(SYMBOL, TF)).toBe(1)
    await feed.pollOnce()
    expect(feed.attempts(SYMBOL, TF)).toBe(0)
  })

  it('refuses to store an in-progress bar even if the source returns one', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [series(NOW, 2)] }) // closeTime 分别为 NOW+1h、NOW+2h
    const feed = makeFeed(source, clock)

    const result = await feed.pollOnce()
    expect(result.written).toBe(0)
    expect(result.emitted).toBe(0)
    expect(archive.count()).toBe(0)
  })

  it('start() registers a clock-driven timer, and the disposer removes it', () => {
    const clock = new ReplayClock(NOW)
    const feed = makeFeed(new FakeSource({ pages: [] }), clock)

    const stop = feed.start()
    expect(clock.pendingTimers()).toBe(1)
    stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('reports an unsupported timeframe instead of silently skipping', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [] })
    const feed = makeFeed(source, clock, { timeframes: ['3m'] })

    const result = await feed.pollOnce()
    expect(result.failures).toBe(1)
    expect(source.calls).toHaveLength(0) // 归一化先失败，根本不打数据源
  })
})

describe('MarketSourceError', () => {
  it('carries a behavioural kind', () => {
    const error = new MarketSourceError('no_data', 'nothing here')
    expect(error.kind).toBe('no_data')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('限流耗尽必须 fail-closed（审计修复）', () => {
  it('★ 令牌耗尽且 sleep 不推进时钟时，不得"照样发请求"', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [series(NOW - HOUR, 1)] })
    const limiter = new TokenBucket(clock, { capacity: 1, refillTokens: 1, refillMs: 1e12 })
    const seen: FeedErrorInfo[] = []
    const feed = makeFeed(source, clock, {
      limiter,
      sleep: () => Promise.resolve(),
      onError: (_error, info) => {
        seen.push(info)
      },
    })

    const first = await feed.pollOnce()
    expect(first.failures).toBe(0)
    expect(source.calls).toHaveLength(1)

    const second = await feed.pollOnce()
    expect(second.failures).toBe(1)
    // 关键：没有第二次请求打出去（旧实现会 fail-open 继续请求）
    expect(source.calls).toHaveLength(1)
    expect(seen.at(-1)?.kind).toBe('rate_limit')
  })
})
