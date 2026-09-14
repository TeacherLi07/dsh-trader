/**
 * 实时行情 feed（plan §4.3 / T0.4）。
 *
 * 免费 `ccxt` 没有 WebSocket OHLCV（`has.watchOHLCV` 为 undefined，本机实测），
 * 因此 v0 走 **REST 轮询**：只取最近几根 → 只落已收盘 → 只对**新增**已收盘 bar 回调。
 * WS 作为 `capabilities.watchOHLCV` 为真时的增强路径（CCXT Pro，plan §12 #15）。
 *
 * 错误处理：**单个标的失败绝不让循环崩溃**；按行为分类并累计失败次数，
 * 由 `backoffFor()` 给出下一次的退避。
 */

import type { Clock } from '../clock.js'
import type { BarArchive } from './archive.js'
import { closedOnly, normalizeCandles, timeframeMs } from './normalize.js'
import type { TokenBucket } from './ratelimit.js'
import {
  classifyError,
  realSleep,
  type Candle,
  type MarketDataSource,
  type Sleep,
  type SourceErrorKind,
} from './types.js'

export interface BackoffConfig {
  readonly baseMs: number
  readonly maxMs: number
  readonly factor: number
}

export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 1_000, maxMs: 60_000, factor: 2 }

/** 指数退避（纯函数，"断线重连有测试"的落点）。 */
export function computeBackoff(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error(`attempt 必须是非负整数：${String(attempt)}`)
  }
  if (!(config.baseMs > 0) || !(config.maxMs >= config.baseMs) || !(config.factor >= 1)) {
    throw new Error('退避参数非法')
  }
  return Math.min(config.maxMs, Math.floor(config.baseMs * config.factor ** attempt))
}

export interface FeedErrorInfo {
  readonly symbol: string
  readonly timeframe: string
  readonly kind: SourceErrorKind
  readonly attempt: number
}

export interface MarketFeedOptions {
  readonly source: MarketDataSource
  readonly archive: BarArchive
  readonly clock: Clock
  readonly symbols: readonly string[]
  readonly timeframes: readonly string[]
  readonly pollMs: number
  /** 每次轮询抓取的最近 bar 数（含进行中的那根，默认 3）。 */
  readonly recentLimit?: number
  readonly limiter?: TokenBucket
  readonly limiterCost?: number
  readonly sleep?: Sleep
  readonly onClosedCandle?: (candle: Candle) => void | Promise<void>
  readonly onError?: (error: unknown, info: FeedErrorInfo) => void
}

export interface PollResult {
  readonly fetched: number
  readonly written: number
  readonly emitted: number
  readonly failures: number
}

const MAX_RATE_LIMIT_RETRIES = 64

export class MarketFeed {
  #attempts = new Map<string, number>()

  constructor(private readonly options: MarketFeedOptions) {}

  key(symbol: string, timeframe: string): string {
    return `${symbol}|${timeframe}`
  }

  attempts(symbol: string, timeframe: string): number {
    return this.#attempts.get(this.key(symbol, timeframe)) ?? 0
  }

  /**
   * 下一次轮询前的退避毫秒：
   * 连续失败 0 次 → 0（不延迟）；第 1 次失败 → base；第 2 次 → base×factor …
   */
  backoffFor(symbol: string, timeframe: string, config?: BackoffConfig): number {
    const failures = this.attempts(symbol, timeframe)
    return failures === 0 ? 0 : computeBackoff(failures - 1, config)
  }

  /** 跑一轮：每个 symbol×timeframe 独立 try/catch，失败只计数不抛出。 */
  async pollOnce(): Promise<PollResult> {
    const {
      source,
      archive,
      clock,
      symbols,
      timeframes,
      recentLimit = 3,
      limiter,
      limiterCost = 1,
      sleep = realSleep,
      onClosedCandle,
      onError,
    } = this.options

    let fetched = 0
    let written = 0
    let emitted = 0
    let failures = 0

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const key = this.key(symbol, timeframe)
        try {
          // 未知时间框架在这里就失败：不浪费一次请求，也不静默跳过
          timeframeMs(timeframe)

          if (limiter !== undefined) {
            for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt += 1) {
              const result = limiter.tryAcquire(limiterCost)
              if (result.ok) break
              await sleep(result.waitMs)
            }
          }

          const raw = await source.fetchOHLCV(symbol, timeframe, undefined, recentLimit)
          fetched += raw.length

          const now = clock.now()
          const { candles } = normalizeCandles(raw, symbol, timeframe, now)
          const closed = closedOnly(candles)
          const before = archive.lastOpenTime(symbol, timeframe)
          const result = archive.upsertClosed(closed, { source: source.id, fetchedAt: now })
          written += result.written

          if (onClosedCandle !== undefined) {
            for (const candle of closed) {
              if (before !== undefined && candle.openTime <= before) continue
              await onClosedCandle(candle)
              emitted += 1
            }
          }

          this.#attempts.set(key, 0)
        } catch (error) {
          failures += 1
          const attempt = (this.#attempts.get(key) ?? 0) + 1
          this.#attempts.set(key, attempt)
          onError?.(error, { symbol, timeframe, kind: classifyError(error), attempt })
        }
      }
    }

    return { fetched, written, emitted, failures }
  }

  /** 用注入的 Clock 起轮询（回放时同一个 Clock 驱动）。返回取消函数。 */
  start(): () => void {
    return this.options.clock.setInterval(() => {
      void this.pollOnce().catch((error: unknown) => {
        this.options.onError?.(error, {
          symbol: '*',
          timeframe: '*',
          kind: classifyError(error),
          attempt: 0,
        })
      })
    }, this.options.pollMs)
  }
}
