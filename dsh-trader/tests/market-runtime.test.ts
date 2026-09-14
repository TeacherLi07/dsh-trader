import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import type { CcxtExchangeLike } from '../src/market/ccxt-source.js'
import { createMarketRuntime } from '../src/market/runtime.js'

const HOUR = 3_600_000
const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'
const TF = '1h'

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

class FakeExchange implements CcxtExchangeLike {
  readonly id = 'htx'
  readonly has: Record<string, unknown> = { fetchOHLCV: true }
  readonly rateLimit = 250
  fetchImplementation?: unknown
  closed = false
  /** ccxt 风格的行：`[openTime, open, high, low, close, volume]`。 */
  rows: readonly unknown[] = [[NOW - HOUR, 99, 101, 98, 100, 10]]

  async loadMarkets(): Promise<unknown> {
    return {}
  }

  async fetchOHLCV(): Promise<readonly unknown[]> {
    return this.rows
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

describe('createMarketRuntime', () => {
  it('wires exchange -> source -> limiter -> feed and starts only when asked', async () => {
    const clock = new ReplayClock(NOW)
    const exchange = new FakeExchange()
    const runtime = await createMarketRuntime({
      venue: 'htx',
      symbols: [SYMBOL],
      timeframes: [TF],
      pollMs: 60_000,
      archive,
      clock,
      createExchange: () => exchange,
    })

    expect(runtime.source.id).toBe('htx')
    expect(runtime.source.capabilities.watchOHLCV).toBe(false)
    expect(clock.pendingTimers()).toBe(0) // 未 start 不起定时器

    runtime.start()
    expect(clock.pendingTimers()).toBe(1)
    runtime.start() // 幂等
    expect(clock.pendingTimers()).toBe(1)

    runtime.stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('derives the rate limiter from the exchange rateLimit', async () => {
    const runtime = await createMarketRuntime({
      venue: 'htx',
      symbols: [SYMBOL],
      timeframes: [TF],
      pollMs: 1_000,
      archive,
      clock: new ReplayClock(NOW),
      createExchange: () => new FakeExchange(),
    })
    // capacity 3 起步，够一次轮询
    expect(runtime.limiter.tokens()).toBe(3)
  })

  it('injects a proxy-aware fetch into the exchange (ccxt needs it to honour HTTP_PROXY)', async () => {
    const injected = (() => Promise.reject(new Error('unused'))) as unknown as typeof fetch
    const exchange = new FakeExchange()
    await createMarketRuntime({
      venue: 'htx',
      symbols: [SYMBOL],
      timeframes: [TF],
      pollMs: 1_000,
      archive,
      clock: new ReplayClock(NOW),
      createExchange: () => exchange,
      fetchImplementation: injected,
    })
    expect(exchange.fetchImplementation).toBe(injected)
  })

  it('defaults to the Node global fetch, and can be opted out with null', async () => {
    const withDefault = new FakeExchange()
    await createMarketRuntime({
      venue: 'htx',
      symbols: [SYMBOL],
      timeframes: [TF],
      pollMs: 1_000,
      archive,
      clock: new ReplayClock(NOW),
      createExchange: () => withDefault,
    })
    expect(withDefault.fetchImplementation).toBe(globalThis.fetch)

    const optedOut = new FakeExchange()
    await createMarketRuntime({
      venue: 'htx',
      symbols: [SYMBOL],
      timeframes: [TF],
      pollMs: 1_000,
      archive,
      clock: new ReplayClock(NOW),
      createExchange: () => optedOut,
      fetchImplementation: null,
    })
    expect(optedOut.fetchImplementation).toBeUndefined()
  })

  it('polls into the archive through the runtime and closes the source', async () => {    const clock = new ReplayClock(NOW)
    const exchange = new FakeExchange()
    const runtime = await createMarketRuntime({
      venue: 'htx',
      symbols: [SYMBOL],
      timeframes: [TF],
      pollMs: 1_000,
      archive,
      clock,
      createExchange: () => exchange,
    })

    const result = await runtime.feed.pollOnce()
    expect(result.written).toBe(1)
    expect(archive.count(SYMBOL, TF)).toBe(1)

    await runtime.close()
    expect(exchange.closed).toBe(true)
  })
})
