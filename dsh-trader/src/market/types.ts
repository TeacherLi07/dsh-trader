/**
 * 市场数据层的契约（plan.md §4.3）。
 *
 * 所有数据源都实现 `MarketDataSource`：生产环境用 CCXT 适配器（`ccxt-source.ts`），
 * 测试用 fake。**这样"交易所不可达"不会阻塞逻辑开发与验收** —— 本机实测
 * HTX/OKX 端点均不可达（plan §12 #14），因此数据源必须可注入。
 */

export interface RawCandle {
  /** 开盘时间，毫秒整数。 */
  readonly openTime: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

export interface Candle extends RawCandle {
  readonly symbol: string
  readonly timeframe: string
  /** `openTime + timeframe`；bar 覆盖半开区间 `[openTime, closeTime)`。 */
  readonly closeTime: number
  /**
   * 只有 `closeTime <= now` 的 bar 才算已收盘。
   * **未收盘 bar 绝不进入特征、规则、回测**（plan §4.3 硬性规则）。
   */
  readonly closed: boolean
}

/** 按**行为**分类的错误（不是按供应商）—— 决定"记住并继续 / 跳过 / 告警"（plan §4.3）。 */
export type SourceErrorKind = 'no_data' | 'rate_limit' | 'not_configured' | 'other'

export class MarketSourceError extends Error {
  readonly kind: SourceErrorKind

  constructor(kind: SourceErrorKind, message: string) {
    super(message)
    this.name = 'MarketSourceError'
    this.kind = kind
  }
}

export function classifyError(error: unknown): SourceErrorKind {
  const name = (error as { name?: string } | undefined)?.name ?? ''
  const message = String((error as { message?: string } | undefined)?.message ?? error).toLowerCase()

  if (
    name === 'RateLimitExceeded' ||
    name === 'DDoSProtection' ||
    message.includes('rate limit') ||
    message.includes('too many request') ||
    message.includes('429')
  ) {
    return 'rate_limit'
  }
  if (
    name === 'BadSymbol' ||
    message.includes('does not have market symbol') ||
    message.includes('no data')
  ) {
    return 'no_data'
  }
  if (
    name === 'AuthenticationError' ||
    name === 'PermissionDenied' ||
    message.includes('api key') ||
    message.includes('not configured')
  ) {
    return 'not_configured'
  }
  return 'other'
}

export interface MarketDataSourceCapabilities {
  /**
   * 免费 `ccxt` 的 `has.watchOHLCV` 为 `undefined`（本机实测）⇒ 只有 REST；
   * 真正的 WebSocket 流需要 CCXT Pro（独立付费包）。见 plan §12 #15。
   */
  readonly watchOHLCV: boolean
}

export interface MarketDataSource {
  readonly id: string
  readonly capabilities: MarketDataSourceCapabilities
  /** 原始 K 线；顺序不限，由 `normalizeCandles` 归一。`since` 为毫秒。 */
  fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<readonly RawCandle[]>
  close?(): Promise<void>
}

export type Sleep = (ms: number) => Promise<void>

/** 真实 sleep。不读墙钟，因此可用于 `src/market/`（时钟纪律，plan §7）。 */
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
