/**
 * 行情运行时（T0.4）：把 exchange → source → 限流 → feed 串起来。
 *
 * `createExchange` 是**注入**的：生产环境传 CCXT 构造器，测试传 fake。
 * 本机无法访问交易所端点（plan §12 #14），所以这条路径必须能在没有网络时被测试。
 */

import type { Clock } from '../clock.js'
import type { BarArchive } from './archive.js'
import { applyProxyAwareFetch, createCcxtSource, type CcxtExchangeLike } from './ccxt-source.js'
import { MarketFeed, type FeedErrorInfo } from './feed.js'
import { TokenBucket } from './ratelimit.js'
import type { Candle, MarketDataSource } from './types.js'

export interface MarketRuntimeOptions {
  readonly venue: string
  readonly symbols: readonly string[]
  readonly timeframes: readonly string[]
  readonly pollMs: number
  readonly archive: BarArchive
  readonly clock: Clock
  readonly recentLimit?: number
  /** 依赖注入：返回 exchange-like（生产 = `new ccxt[venue]({ enableRateLimit: true })`）。 */
  readonly createExchange: (venue: string) => Promise<CcxtExchangeLike> | CcxtExchangeLike
  /**
   * 覆盖注入给 ccxt 的 fetch。默认 = Node 全局 fetch（读代理环境变量）；
   * 传 `null` 表示不注入（仅用于测试/直连场景）。
   */
  readonly fetchImplementation?: unknown
  readonly onClosedCandle?: (candle: Candle) => void | Promise<void>
  readonly onError?: (error: unknown, info: FeedErrorInfo) => void
}

export interface MarketRuntime {
  readonly source: MarketDataSource
  readonly limiter: TokenBucket
  readonly feed: MarketFeed
  start(): void
  stop(): void
  close(): Promise<void>
}

const DEFAULT_RATE_LIMIT_MS = 1_000

export async function createMarketRuntime(options: MarketRuntimeOptions): Promise<MarketRuntime> {
  const exchange = await options.createExchange(options.venue)
  // 默认注入 Node 全局 fetch：ccxt 自带 fetch 不读代理环境变量（见 applyProxyAwareFetch）
  if (options.fetchImplementation !== null) {
    applyProxyAwareFetch(exchange, options.fetchImplementation ?? globalThis.fetch)
  }
  const source = createCcxtSource(exchange)

  // 免费 ccxt 的 `rateLimit` 是"两次请求之间的最小毫秒数"，因此桶按 1 token / rateLimitMs 补充，
  // 容量给小一点（3）以允许开头的突发。
  const rateLimitMs =
    typeof exchange.rateLimit === 'number' && exchange.rateLimit > 0
      ? exchange.rateLimit
      : DEFAULT_RATE_LIMIT_MS
  const limiter = new TokenBucket(options.clock, {
    capacity: 3,
    refillTokens: 1,
    refillMs: rateLimitMs,
  })

  const feed = new MarketFeed({
    source,
    archive: options.archive,
    clock: options.clock,
    symbols: options.symbols,
    timeframes: options.timeframes,
    pollMs: options.pollMs,
    recentLimit: options.recentLimit,
    limiter,
    onClosedCandle: options.onClosedCandle,
    onError: options.onError,
  })

  let stopFn: (() => void) | undefined

  return {
    source,
    limiter,
    feed,
    start() {
      stopFn ??= feed.start()
    },
    stop() {
      stopFn?.()
      stopFn = undefined
    },
    async close() {
      stopFn?.()
      stopFn = undefined
      await source.close?.()
    },
  }
}
