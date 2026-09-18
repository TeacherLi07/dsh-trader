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
  MarketSourceError,
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
  /** 每轮最多补处理多少根已归档但尚未成功回调的 bar。 */
  readonly processingBatchLimit?: number
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
  #nextAllowedAt = new Map<string, number>()
  /**
   * 周期回调可能在上一轮 REST 请求尚未返回时再次到期；保留正在运行的 promise，
   * 让所有入口共享同一轮，避免慢源导致并发请求和乱序写入。
   */
  #pollInFlight: Promise<PollResult> | undefined

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
  pollOnce(): Promise<PollResult> {
    return this.#beginPoll(false)
  }

  #beginPoll(respectBackoff: boolean): Promise<PollResult> {
    const inFlight = this.#pollInFlight
    if (inFlight !== undefined) return inFlight

    const poll = this.#pollOnce(respectBackoff)
    this.#pollInFlight = poll
    // 两个分支都消费清理 promise；若内部出现未预期 reject，也不能制造新的 unhandled rejection。
    void poll.then(
      () => {
        if (this.#pollInFlight === poll) this.#pollInFlight = undefined
      },
      () => {
        if (this.#pollInFlight === poll) this.#pollInFlight = undefined
      },
    )
    return poll
  }

  async #pollOnce(respectBackoff: boolean): Promise<PollResult> {
    const {
      source,
      archive,
      clock,
      symbols,
      timeframes,
      recentLimit = 3,
      processingBatchLimit = 1_000,
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

          // 退避不靠生产调用方“记得调用 backoffFor”：start() 走这一道闸。
          // 尚未到 due 时只跳过本 key，不阻塞其它标的/时间框；手工 pollOnce 保留
          // 立即重试语义，便于回补/故障注入显式控制时间。
          const nextAllowedAt = this.#nextAllowedAt.get(key)
          if (respectBackoff && nextAllowedAt !== undefined && clock.now() < nextAllowedAt) continue

          if (limiter !== undefined) {
            let acquired = false
            for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt += 1) {
              const result = limiter.tryAcquire(limiterCost)
              if (result.ok) {
                acquired = true
                break
              }
              await sleep(result.waitMs)
            }
            // 旧实现在重试耗尽后**照样发请求**（fail-open ⇒ 撞限额）。这里必须 fail-closed，
            // 与 backfill 的 `acquireToken` 行为一致：抛 rate_limit，由 onError 计数/退避。
            if (!acquired) {
              throw new MarketSourceError('rate_limit', '限流等待超过重试上限')
            }
          }

          const raw = await source.fetchOHLCV(symbol, timeframe, undefined, recentLimit)
          fetched += raw.length

          const now = clock.now()
          const { candles } = normalizeCandles(raw, symbol, timeframe, now)
          const closed = closedOnly(candles)
          const result = archive.upsertClosed(closed, { source: source.id, fetchedAt: now })
          written += result.written

          if (onClosedCandle !== undefined) {
            // 归档游标与处理游标分离：整批 upsert 成功不代表下游成功。
            // 处理队列包含之前回调失败的 bar，因此回调抛错后不会把批内后续 bar 永久吞掉。
            const pending = archive.unprocessedClosedBars(symbol, timeframe, processingBatchLimit)
            for (const candle of pending) {
              await onClosedCandle(candle)
              archive.markProcessed(candle, clock.now())
              emitted += 1
            }
          }

          this.#attempts.set(key, 0)
          this.#nextAllowedAt.delete(key)
        } catch (error) {
          failures += 1
          const attempt = (this.#attempts.get(key) ?? 0) + 1
          this.#attempts.set(key, attempt)
          this.#nextAllowedAt.set(key, clock.now() + computeBackoff(attempt - 1))
          onError?.(error, { symbol, timeframe, kind: classifyError(error), attempt })
        }
      }
    }

    return { fetched, written, emitted, failures }
  }

  /** 用注入的 Clock 起轮询（回放时同一个 Clock 驱动）。返回取消函数。 */
  start(): () => void {
    return this.options.clock.setInterval(() => {
      void this.#beginPoll(true).catch((error: unknown) => {
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
