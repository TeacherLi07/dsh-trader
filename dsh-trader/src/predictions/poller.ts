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
import type { PmInterval } from './client.js'
import type { PmAliasSnapshot, PmStore, WatchRow } from './store.js'

/** 轮询器需要的最小客户端面（便于注入假客户端做故障注入）。 */
export interface PmPollerClients {
  readonly gamma: {
    readonly markets: (options: {
      readonly limit?: number
      readonly newestFirst?: boolean
      readonly order?: 'startDate' | 'volume24hr' | 'oneDayPriceChange' | 'liquidity'
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
      readonly interval?: PmInterval
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
  readonly historyInterval?: PmInterval
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
  /**
   * 正在进行的这一轮。**single-flight**：慢轮询不得与下一次 interval 并发。
   * 并发会让 watch 过期与读写交错、`onResult` 结果逆序，并在降级时互相覆盖；
   * plan §4.4 的限流前提正是"同一时刻只有一轮在打 API"。
   */
  #running: Promise<void> | undefined

  constructor(private readonly options: PmPollerOptions) {}

  /**
   * 跑一轮：刷新关注市场的元数据 + 关注 token 的盘口与序列。
   *
   * 任何一步失败都**只**记进 `alerts`/`errors`；返回对象永远可用。
   */
  async runOnce(now = this.options.clock.now()): Promise<PmPollResult> {
    const { store, clients } = this.options
    let resultAsOf = Math.max(now, this.options.clock.now())
    const alerts: PmPollerAlert[] = []
    const errors: string[] = []
    let marketsSeen = 0
    let tokensRefreshed = 0
    let seriesWritten = 0
    let quotesWritten = 0

    const expiredWatches = store.expireWatches(now)
    const watches = store.activeWatches(now)
    /**
     * token → 元数据里的流动性 / 24h 成交额 / 最新成交价。
     * 盘口端只给 bid/ask；**没有成交价的兜底，没有 orderbook 的市场就完全没有概率** ——
     * 而 Gamma 元数据里本来就有 `lastTradePrice`，那是 `estimateProbability` 的合法退化路径。
     */
    const perToken: Record<
      string,
      { liquidity: number | null; volume24h: number | null; lastTradePrice: number | null }
    > = {}

    // ① 元数据：取最新市场（存在门控由 store 读取侧把关）
    try {
      const page = await clients.gamma.markets({
        limit: this.options.marketPageSize ?? 50,
        newestFirst: true,
      })
      for (const item of page.items) {
        const asMarket = item as Parameters<PmStore['upsertMarket']>[0]
        const availableAt = this.options.clock.now()
        resultAsOf = Math.max(resultAsOf, availableAt)
        store.upsertMarket(asMarket, availableAt)
        marketsSeen += 1
        for (const tokenId of asMarket.clobTokenIds) {
          perToken[tokenId] = {
            liquidity: asMarket.liquidity,
            volume24h: asMarket.volume24hr,
            lastTradePrice: asMarket.lastTradePrice,
          }
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
        const availableAt = this.options.clock.now()
        resultAsOf = Math.max(resultAsOf, availableAt)
        if (!Number.isFinite(book.observedAt) || book.observedAt <= 0) {
          // 缺少可信 source event time 时不拿请求开始时间冒充；没有可核验时间的盘口不可入 PIT。
          errors.push(`book ${tokenId}: invalid source timestamp`)
        } else {
          const bestBid = book.bids.length > 0 ? maxPrice(book.bids) : undefined
          const bestAsk = book.asks.length > 0 ? minPrice(book.asks) : undefined
          const mid =
            bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined
          const spread = bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : undefined
          // 流动性与 24h 成交额来自 Gamma 元数据（盘口端点不返回）。它们最多与本次
          // quote 同时可见，不能借 source timestamp 倒灌到本机收到 book 之前。
          const meta = perToken[tokenId]
          const wrote = store.recordQuote({
            tokenId,
            observedAt: book.observedAt,
            availableAt,
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
            // 概率的退化路径：没有盘口中间价时用元数据里的最新成交价
            ...(meta?.lastTradePrice === null || meta?.lastTradePrice === undefined
              ? {}
              : { lastTradePrice: meta.lastTradePrice }),
          })
          if (wrote) quotesWritten += 1
          tokensRefreshed += 1
        }
      } catch (error) {
        errors.push(`book ${tokenId}: ${String(error)}`)
      }

      try {
        const points = await clients.dataApi.pricesHistory({
          tokenId,
          interval: this.options.historyInterval ?? '1d',
        })
        if (points.length > 0) {
          const availableAt = this.options.clock.now()
          resultAsOf = Math.max(resultAsOf, availableAt)
          seriesWritten += store.recordSeries(tokenId, points, {
            source: 'data-api.v2',
            observedAt: availableAt,
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

    resultAsOf = Math.max(resultAsOf, this.options.clock.now())
    return {
      asOf: resultAsOf,
      degraded,
      marketsSeen,
      tokensRefreshed,
      seriesWritten,
      quotesWritten,
      expiredWatches,
      snapshots: store.snapshotAt(resultAsOf),
      alerts,
      errors,
    }
  }

  /**
   * 按注入时钟起周期轮询。回调拿到的是 `PmPollResult`，异常已在 `runOnce` 内收敛，
   * 但这里仍然再兜一层 —— 定时器里抛出的异常会污染整个事件循环。
   */
  start(onResult?: (result: PmPollResult) => void): Disposer {
    // 重入保护：先停掉旧 timer。否则旧 disposer 的闭包只认 this.#timer，
    // start 第二次之后调用旧 disposer 会把"新" timer 一起停掉。
    this.stop()
    const intervalMs = this.options.intervalMs ?? 60_000
    const timer = this.options.clock.setInterval(() => {
      if (this.#running !== undefined) {
        // 上一轮还没结束：本轮**跳过**而不是并发。这是正常的信息，但仍要可见 ——
        // 静默跳过会让人误以为轮询频率正常。degraded 保守置 true：我们并不知道上一轮结论。
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
              code: 'pm_poll_skipped',
              message: '上一轮预测市场轮询尚未结束，本轮跳过（single-flight，避免并发打 API 与乱序写库）',
            },
          ],
          errors: [],
        })
        return
      }
      let operation: Promise<void>
      operation = this.runOnce()
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
        .finally(() => {
          if (this.#running === operation) this.#running = undefined
        })
      this.#running = operation
    }, intervalMs)
    this.#timer = timer
    return () => {
      // 只停"自己那一次"的 timer：start 重入后，旧 disposer 不得停掉新 timer。
      if (this.#timer === timer) this.stop()
      else timer()
    }
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
