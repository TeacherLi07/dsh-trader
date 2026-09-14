/**
 * CCXT 适配器（plan §4.3）：把 `ccxt` 的 `[ts, o, h, l, c, v]` 数组转成 `RawCandle`。
 *
 * 通过"传入已构造的 exchange"做依赖注入：本模块**不 import ccxt**，
 * 因此可以在没有网络、没有 ccxt 的环境里单测；也需要时由插件动态 import。
 */

import { MarketSourceError, classifyError, type MarketDataSource, type RawCandle } from './types.js'

/** `ccxt.Exchange` 的结构子集，避免把整包类型拖进来。 */
export interface CcxtExchangeLike {
  readonly id: string
  readonly has: Record<string, unknown>
  /** 两次请求之间的最小毫秒数（ccxt 的 `rateLimit`）。 */
  readonly rateLimit?: number
  /** ccxt 允许用户覆盖 fetch 实现（`Exchange.fetchImplementation`）。 */
  fetchImplementation?: unknown
  loadMarkets(): Promise<unknown>
  fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<readonly unknown[]>
  close?(): Promise<void>
}

/**
 * 把 **Node 的全局 fetch** 注入给 ccxt。
 *
 * 为什么必须做：ccxt 内部的 fetch **不读** `HTTP_PROXY`/`HTTPS_PROXY`，而 Node ≥24 的全局 fetch
 * 会读（需要 `NODE_USE_ENV_PROXY=1`）。本机实测（2026-09-14）：不注入 ⇒
 * `connect ECONNREFUSED 67.230.169.182:443`；注入后 HTX `loadMarkets()` 得到 2526 个市场且
 * `fetchOHLCV` 正常返回。这是"本机访问不了交易所"的真正原因，不是网络封锁。
 */
export function applyProxyAwareFetch(
  exchange: CcxtExchangeLike,
  fetchImplementation: unknown = globalThis.fetch,
): void {
  if (typeof fetchImplementation !== 'function') {
    throw new MarketSourceError('not_configured', '全局 fetch 不可用，无法注入代理感知的 fetch')
  }
  exchange.fetchImplementation = fetchImplementation
}

/** `[openTime, open, high, low, close, volume, ...]` → `RawCandle`；脏数据返回 undefined。 */
export function toRawCandle(row: unknown): RawCandle | undefined {
  if (!Array.isArray(row) || row.length < 6) return undefined
  const numbers = row.slice(0, 6).map((value) => {
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '') return Number(value)
    return Number.NaN
  })
  if (!numbers.every((value) => Number.isFinite(value))) return undefined
  const [openTime, open, high, low, close, volume] = numbers as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return { openTime, open, high, low, close, volume }
}

export function createCcxtSource(exchange: CcxtExchangeLike): MarketDataSource {
  let marketsLoaded = false

  return {
    id: exchange.id,
    capabilities: {
      // 免费 ccxt 的 has.watchOHLCV 为 undefined；只有真为 true 才认为有流式能力
      watchOHLCV: exchange.has['watchOHLCV'] === true,
    },
    async fetchOHLCV(symbol, timeframe, since, limit) {
      if (!marketsLoaded) {
        await exchange.loadMarkets()
        marketsLoaded = true
      }
      try {
        const rows = await exchange.fetchOHLCV(symbol, timeframe, since, limit)
        return rows
          .map(toRawCandle)
          .filter((candle): candle is RawCandle => candle !== undefined)
      } catch (error) {
        const message = String((error as { message?: string } | undefined)?.message ?? error)
        throw new MarketSourceError(
          classifyError(error),
          `${exchange.id} fetchOHLCV(${symbol}, ${timeframe}) 失败：${message}`,
        )
      }
    },
    async close() {
      await exchange.close?.()
    },
  }
}
