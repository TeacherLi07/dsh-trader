/**
 * 历史回补（plan §4.3 / T0.4）：分页拉取 → 归一化 → 只落已收盘 → upsert。
 *
 * 三条必须守住的边界：
 *   1. **必须前进**：数据源不推进游标时立刻停（`no_progress`），绝不无限循环；
 *   2. **限流**：每页取 token，不足则 sleep（时间来自注入的 Clock）；
 *   3. **不落未收盘**：`closedOnly` 之后才交给归档。
 */

import type { Clock } from '../clock.js'
import type { BarArchive } from './archive.js'
import { closedOnly, normalizeCandles, timeframeMs } from './normalize.js'
import type { TokenBucket } from './ratelimit.js'
import { MarketSourceError, realSleep, type MarketDataSource, type Sleep } from './types.js'

export interface BackfillRequest {
  readonly symbol: string
  readonly timeframe: string
  /** 起点（含），毫秒。 */
  readonly since: number
  /** 终点（不含），毫秒。 */
  readonly until: number
  readonly pageLimit?: number
  readonly maxPages?: number
}

export type BackfillStop = 'reached_until' | 'empty' | 'no_progress' | 'max_pages'

export interface BackfillResult {
  readonly pages: number
  readonly fetched: number
  readonly written: number
  readonly rejectedOpen: number
  readonly dropped: number
  readonly stoppedBy: BackfillStop
  readonly cursor: number
}

export interface PageInfo {
  readonly page: number
  readonly cursor: number
  readonly fetched: number
}

export interface BackfillDeps {
  readonly source: MarketDataSource
  readonly archive: BarArchive
  readonly clock: Clock
  readonly limiter?: TokenBucket
  readonly sleep?: Sleep
  readonly onPage?: (info: PageInfo) => void
}

const MAX_RATE_LIMIT_RETRIES = 64

/** 取 token；不足则按返回的 waitMs 睡。有界重试，避免死等。 */
async function acquireToken(
  limiter: TokenBucket | undefined,
  sleep: Sleep,
  cost = 1,
): Promise<void> {
  if (limiter === undefined) return
  for (let attempt = 0; attempt < MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    const result = limiter.tryAcquire(cost)
    if (result.ok) return
    await sleep(result.waitMs)
  }
  throw new MarketSourceError('rate_limit', '限流等待超过重试上限')
}

export async function backfill(
  deps: BackfillDeps,
  request: BackfillRequest,
): Promise<BackfillResult> {
  const { source, archive, clock } = deps
  const sleep = deps.sleep ?? realSleep
  const tfMs = timeframeMs(request.timeframe)
  const pageLimit = request.pageLimit ?? 500
  const maxPages = request.maxPages ?? 200

  if (!(request.until > request.since)) {
    throw new MarketSourceError('other', `until 必须晚于 since（since=${request.since}, until=${request.until}）`)
  }

  let cursor = request.since
  let pages = 0
  let fetched = 0
  let written = 0
  let rejectedOpen = 0
  let dropped = 0
  let stoppedBy: BackfillStop = 'max_pages'

  for (;;) {
    if (pages >= maxPages) {
      stoppedBy = 'max_pages'
      break
    }

    await acquireToken(deps.limiter, sleep)
    const raw = await source.fetchOHLCV(request.symbol, request.timeframe, cursor, pageLimit)
    pages += 1
    fetched += raw.length
    deps.onPage?.({ page: pages, cursor, fetched: raw.length })

    if (raw.length === 0) {
      stoppedBy = 'empty'
      break
    }

    const now = clock.now()
    const { candles, dropped: invalid } = normalizeCandles(raw, request.symbol, request.timeframe, now)
    dropped += invalid

    const inRange = closedOnly(candles).filter((candle) => candle.openTime < request.until)
    const result = archive.upsertClosed(inRange, { source: source.id, fetchedAt: now })
    written += result.written
    rejectedOpen += result.rejectedOpen

    const last = candles[candles.length - 1]
    if (last === undefined) {
      stoppedBy = 'no_progress'
      break
    }
    const next = last.openTime + tfMs
    // `until` 是**不含**的：next 一旦到达边界，后续页只可能取到区间外的 bar ⇒ 到此为止。
    // 旧实现写 `next > request.until`，`next === until` 时还会多发一次请求，
    // 并把停止原因误记成 'empty'（实测）。
    if (next >= request.until) {
      stoppedBy = 'reached_until'
      break
    }
    if (next <= cursor) {
      // 数据源没有推进（返回了同一批数据）—— 立刻停，绝不空转
      stoppedBy = 'no_progress'
      break
    }
    cursor = next
  }

  return { pages, fetched, written, rejectedOpen, dropped, stoppedBy, cursor }
}
