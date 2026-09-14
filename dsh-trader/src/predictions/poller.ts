/**
 * 预测市场轮询器（plan §4.4 / T1.9）。
 *
 * 三条纪律：
 *   1. **时钟注入**：所有"现在"都来自 `Clock`，因此回放与实盘共用同一份代码，
 *      且轮询行为可确定性单测（不需要真的 sleep）。
 *   2. **降级不上抛**：任何取数失败都收敛成 `degraded: true` 的结果对象 + 告警条目，
 *      **绝不**把异常抛进交易主循环（§10 专项 ⑥）。
 *   3. **落库即 PIT 素材**：写进去的是"观测时刻 + 源时刻"，读的时候由 `PmStore` 的三道闸门过滤。

 * WSS（`wss://ws-subscriptions-clob.polymarket.com/ws/market`）实测本机握手超时
 * （plan §12 #10），所以 v0 只有轮询。轮询满足 60s 级需求。
 */

import type { Clock, Disposer } from '../clock.js'
import type { PmAliasSnapshot, PmStore, WatchRow } from './store.js'

/** 轮询器需要的最小客户端面（便于注入假客户端做故障注入）。 */
export interface PmPollerClients {
  readonly gamma: {
    readonly markets: (options: {
      readonly limit?: number
      readonly newestFirst?: boolean
      readonly closed?: boolean
    }) => Promise<{ readonly items: readonly unknown[] }>
  }
  readonly clob: {
    readonly book: (tokenId: string) => Promise<{
      readonly bids: readonly { readonly price: number; readonly size: number }[]
      readonly asks: readonly { readonly price: number; readonly size: number }[]
      readonly tickSize: number | null
      readonly minOrderSize: number | null
      readonly negRisk: boolean
      readonly observedAt: number
      readonly hash: string | null
    } | null>
  }
  readonly dataApi: {
    readonly pricesHistory: (options: {
      readonly tokenId: string
      readonly interval?: '1d' | '1w'
      readonly bucketSeconds?: number
    }) => Promise<readonly { readonly ts: number; readonly price: number }[]>
  }
  readonly degraded: boolean
  readonly stats: () => unknown
}

export interface PmPollerOptions {
  readonly clients: PmPollerClients
  readonly store: PmStore
  readonly clock: Clock
  /** 轮询周期；默认 60s（plan §4.4：轮询满足 60s 级需求）。 */
  readonly intervalMs?: number
  /** 每个 token 回补多少历史（`1d` 实测可用）。 */
  readonly historyInterval?: '1d' | '1w'
  /** 元数据刷新：每次轮询取多少最新市场。 */
  readonly marketPageSize?: number
}

export interface PmPollerAlert {
  readonly level: 'info' | 'warning'
  readonly code: string
  readonly message: string
}

export interface PmPollResult {
  readonly asOf: number
  readonly degraded: boolean
  readonly marketsSeen: number
  readonly tokensRefreshed: number
  readonly seriesWritten: number
  readonly quotesWritten: number
  readonly expiredWatches: number
  readonly snapshots: readonly PmAliasSnapshot[]
  readonly alerts: readonly PmPollerAlert[]
  readonly errors: readonly string[]
}

export class PmPoller {
  #timer: Disposer | undefined

  constructor(private readonly options: PmPollerOptions) {}

  /**
   * 跑一轮：刷新关注市场的元数据 + 关注 token 的盘口与序列。
   *
   * 任何一步失败都**只**记进 `alerts`/`errors`；返回对象永远可用。
   */
  async runOnce(now = this.options.clock.now()): Promise<PmPollResult> {
    const { store, clients } = this.options
    const alerts: PmPollerAlert[] = []
    const errors: string[] = []
    let marketsSeen = 0
    let tokensRefreshed = 0
    let seriesWritten = 0
    let quotesWritten = 0

    const expiredWatches = store.expireWatches(now)
    const watches = store.activeWatches(now)
    /** token → 元数据里的流动性与 24h 成交额（盘口端不提供这两项）。 */
    const perToken: Record<string, { liquidity: number | null; volume24h: number | null }> = {}

    // ① 元数据：取最新市场（存在门控由 store 读取侧把关）
    try {
      const page = await clients.gamma.markets({
        limit: this.options.marketPageSize ?? 50,
        newestFirst: true,
      })
      for (const item of page.items) {
        const asMarket = item as Parameters<PmStore['upsertMarket']>[0]
        store.upsertMarket(asMarket, now)
        marketsSeen += 1
        for (const tokenId of asMarket.clobTokenIds) {
          perToken[tokenId] = { liquidity: asMarket.liquidity, volume24h: asMarket.volume24hr }
        }
      }
    } catch (error) {
      errors.push(`market metadata: ${String(error)}`)
      alerts.push({
        level: 'warning',
        code: 'pm_metadata_failed',
        message: `预测市场元数据刷新失败（已降级，主循环不受影响）：${String(error)}`,
      })
    }

    // ② 关注 token：盘口 + 序列
    const tokens = [...new Set(watches.flatMap((watch) => watch.tokenIds))]
    for (const tokenId of tokens) {
      try {
        const book = await clients.clob.book(tokenId)
        if (book === null) {
          // 尚无盘口：正常状态，不告警、不降级
          continue
        }
        const bestBid = book.bids.length > 0 ? maxPrice(book.bids) : undefined
        const bestAsk = book.asks.length > 0 ? minPrice(book.asks) : undefined
        const mid =
          bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined
        const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined
        // 流动性与 24h 成交额来自 Gamma 元数据（盘口端点不返回）——
        // 不写它们则 `liquidityGate` 永远因"缺少流动性数据"拒绝，
        // novelty 告警会**因为错的理由**一条都不发（专项 ④ 会假通过）。
        const meta = perToken[tokenId]
        const wrote = store.recordQuote({
          tokenId,
          observedAt: book.observedAt > 0 ? book.observedAt : now,
          ...(bestBid === undefined ? {} : { bestBid }),
          ...(bestAsk === undefined ? {} : { bestAsk }),
          ...(mid === undefined ? {} : { mid }),
          ...(spread === undefined ? {} : { spread }),
          ...(meta?.liquidity === null || meta?.liquidity === undefined
            ? {}
            : { liquidity: meta.liquidity }),
          ...(meta?.volume24h === null || meta?.volume24h === undefined
            ? {}
            : { volume24h: meta.volume24h }),
        })
        if (wrote) quotesWritten += 1
        tokensRefreshed += 1
      } catch (error) {
        errors.push(`book ${tokenId}: ${String(error)}`)
      }

      try {
        const points = await clients.dataApi.pricesHistory({
          tokenId,
          interval: this.options.historyInterval ?? '1d',
        })
        if (points.length > 0) {
          seriesWritten += store.recordSeries(tokenId, points, {
            source: 'data-api.v2',
            observedAt: now,
          })
        }
      } catch (error) {
        errors.push(`history ${tokenId}: ${String(error)}`)
      }
    }

    const degraded = clients.degraded
    if (degraded) {
      alerts.push({
        level: 'info',
        code: 'pm_degraded',
        message: '预测市场客户端处于降级状态：只发 info 通知，交易主循环不受影响',
      })
    }

    return {
      asOf: now,
      degraded,
      marketsSeen,
      tokensRefreshed,
      seriesWritten,
      quotesWritten,
      expiredWatches,
      snapshots: store.snapshotAt(now),
      alerts,
      errors,
    }
  }

  /**
   * 按注入时钟起周期轮询。回调拿到的是 `PmPollResult`，异常已在 `runOnce` 内收敛，
   * 但这里仍然再兜一层 —— 定时器里抛出的异常会污染整个事件循环。
   */
  start(onResult?: (result: PmPollResult) => void): Disposer {
    const intervalMs = this.options.intervalMs ?? 60_000
    this.#timer = this.options.clock.setInterval(() => {
      void this.runOnce()
        .then((result) => onResult?.(result))
        .catch((error: unknown) => {
          onResult?.({
            asOf: this.options.clock.now(),
            degraded: true,
            marketsSeen: 0,
            tokensRefreshed: 0,
            seriesWritten: 0,
            quotesWritten: 0,
            expiredWatches: 0,
            snapshots: [],
            alerts: [
              {
                level: 'info',
                code: 'pm_poll_threw',
                message: `轮询回调异常（已吞掉，主循环不受影响）：${String(error)}`,
              },
            ],
            errors: [String(error)],
          })
        })
    }, intervalMs)
    return this.stop.bind(this)
  }

  stop(): void {
    this.#timer?.()
    this.#timer = undefined
  }
}

function maxPrice(levels: readonly { readonly price: number }[]): number {
  return levels.reduce((best, level) => Math.max(best, level.price), Number.NEGATIVE_INFINITY)
}

function minPrice(levels: readonly { readonly price: number }[]): number {
  return levels.reduce((best, level) => Math.min(best, level.price), Number.POSITIVE_INFINITY)
}

/** 关注市场的 `conditionId` 集合（供元数据轮询限定范围用）。 */
export function watchedConditionIds(watches: readonly WatchRow[]): readonly string[] {
  return [...new Set(watches.map((watch) => watch.planId ?? '').filter((id) => id !== ''))]
}
