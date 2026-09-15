/**
 * 预测市场（Polymarket）事件源的 **PIT 三道闸门**（plan.md §4.4）。
 *
 * 这三条修掉了 decision.md §3.2 指出的缺口：TradingAgents 的 Polymarket 数据
 * "只有实时没有 as-of"。纯函数、无 IO、不读时钟 —— 时间由调用方传入，
 * 因此回放时可以逐点断言"当时能看到什么"。
 *
 * 单位陷阱：Polymarket 的 **REST** 端点返回**秒**级时间戳（本机实测 v1 `{t}` 与
 * v2 `{timestamp}` 都是秒），而官方 **SDK** 归一为毫秒。落库前必须过
 * `normalizeSourceSeconds()`，它会把"疑似毫秒被当作秒"直接判错，而不是静默算错。
 */

export class PmTimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PmTimeError'
  }
}

export interface PmMarketRecord {
  readonly conditionId: string
  /** 源时间：市场创建时刻（毫秒）。 */
  readonly createdAt: number
  readonly closed: boolean
  /** 结算时刻（毫秒）；缺失表示尚未结算或未知。 */
  readonly resolvedAt?: number
  readonly winningOutcome?: string
}

export type MarketView =
  | { readonly visible: false; readonly reason: 'not_created_yet' }
  | {
      readonly visible: true
      readonly resolved: boolean
      /** **只在 `resolved === true` 时非 undefined** —— 结算门控。 */
      readonly winningOutcome: string | undefined
    }

/** 存在门控 + 结算门控：`now` 时刻该市场能看到什么。 */
export function marketAsOf(market: PmMarketRecord, now: number): MarketView {
  if (!Number.isFinite(now)) throw new PmTimeError(`now 非法：${now}`)
  // 缺失/非法的创建时刻**不能**当成"远古就在" —— 那会让存在门控在任意过去时点放行。
  // 源数据缺字段时 `normalizeGammaMarket` 退化到 0，这里把它当作"尚不可见"（fail-closed）。
  if (!Number.isFinite(market.createdAt) || market.createdAt <= 0) {
    return { visible: false, reason: 'not_created_yet' }
  }
  if (market.createdAt > now) return { visible: false, reason: 'not_created_yet' }
  const resolved =
    market.closed && market.resolvedAt !== undefined && market.resolvedAt <= now
  return { visible: true, resolved, winningOutcome: resolved ? market.winningOutcome : undefined }
}

export interface PmSeriesPoint {
  readonly ts: number
  readonly price: number
}

/** 序列门控：只保留 `ts <= now` 的点。顺序保持不变，便于确定性回放。 */
export function seriesAsOf<T extends PmSeriesPoint>(points: readonly T[], now: number): readonly T[] {
  if (!Number.isFinite(now)) throw new PmTimeError(`now 非法：${now}`)
  return points.filter((point) => point.ts <= now)
}

/** 疑似毫秒的下界：1e11 秒 ≈ 5138 年，1e11 毫秒 ≈ 1973 年 —— 超过即认为是误传的毫秒。 */
/**
 * 秒/毫秒的分界（约 1973-03-03）：
 *   · 秒级时间戳不可能达到 1e11；
 *   · 毫秒级时间戳（现代时间约 1.7e12）必然 ≥ 1e11。
 * 正好用同一个常数做两个方向的判错，避免两处阈值漂移。
 */
const UNIT_BOUNDARY = 1e11

/** 把源的**秒**级时间戳归一为**毫秒整数**；误传毫秒会被判错而不是静默放大 1000 倍。 */
export function normalizeSourceSeconds(seconds: number): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new PmTimeError(`源时间戳必须是有限正数，收到 ${String(seconds)}`)
  }
  if (seconds >= UNIT_BOUNDARY) {
    throw new PmTimeError(`疑似毫秒时间戳被当作秒传入：${seconds}`)
  }
  const ms = seconds * 1000
  if (!Number.isSafeInteger(ms)) throw new PmTimeError(`秒级时间戳溢出：${seconds}`)
  return ms
}

/**
 * 把源的**毫秒**级时间戳原样透传。
 *
 * 为什么必须单独一个函数：**同一个源里不同端点的时间单位不同** ——
 * 实测 `clob.polymarket.com/book` 的 `timestamp` 是**毫秒**（如 `1789399859695`），
 * 而 `prices-history` 的 `t`/`timestamp` 是**秒**。
 * 用 `normalizeSourceSeconds` 处理 book 会直接抛错（这是好事），但更危险的是
 * "把秒当毫秒" —— 那会让时间静默回到 1970 年，PIT 门控就彻底失效。
 */
export function normalizeSourceMillis(ms: number): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new PmTimeError(`源时间戳必须是有限正数，收到 ${String(ms)}`)
  }
  if (ms < UNIT_BOUNDARY) {
    throw new PmTimeError(`疑似秒级时间戳被当作毫秒传入：${ms}`)
  }
  if (!Number.isSafeInteger(ms)) throw new PmTimeError(`毫秒级时间戳溢出：${ms}`)
  return ms
}

export interface PmQuoteLike {
  readonly mid?: number
  readonly lastTradePrice?: number
}

export type ProbabilityEstimate =
  | { readonly ok: true; readonly value: number; readonly estimator: 'mid' | 'last_trade_price' }
  | { readonly ok: false; readonly reason: string }

/**
 * 概率估计量必须**唯一且可复现**：优先中间价（`mid`），缺失时退化到 `last_trade_price`。
 * 返回所用估计量并写进快照/告警 payload —— 否则"概率变了"可能只是换了口径。
 */
export function estimateProbability(quote: PmQuoteLike): ProbabilityEstimate {
  const usable = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

  if (usable(quote.mid)) return { ok: true, value: quote.mid, estimator: 'mid' }
  if (usable(quote.lastTradePrice)) {
    return { ok: true, value: quote.lastTradePrice, estimator: 'last_trade_price' }
  }
  return { ok: false, reason: '既无有效 mid 也无有效 last_trade_price（需在 [0,1] 内）' }
}

export interface LiquidityGateConfig {
  readonly liquidityFloorQuote: number
  readonly spreadCeilBps: number
}

export interface PmQuoteForGate {
  readonly liquidity?: number
  readonly spread?: number
}

export type LiquidityVerdict =
  | { readonly pass: true }
  | { readonly pass: false; readonly reason: string }

/**
 * 流动性门槛（硬性）：薄市场/宽价差的数据**不得**产生 novelty 告警，也不得进入承诺。
 * `spread` 是概率单位（0..1），×10000 换算为 bps。
 */
export function liquidityGate(quote: PmQuoteForGate, config: LiquidityGateConfig): LiquidityVerdict {
  if (typeof quote.liquidity !== 'number' || !Number.isFinite(quote.liquidity)) {
    return { pass: false, reason: '缺少流动性数据' }
  }
  if (quote.liquidity < config.liquidityFloorQuote) {
    return {
      pass: false,
      reason: `流动性 ${quote.liquidity} 低于门槛 ${config.liquidityFloorQuote}`,
    }
  }
  if (typeof quote.spread !== 'number' || !Number.isFinite(quote.spread)) {
    return { pass: false, reason: '缺少价差数据' }
  }
  const spreadBps = quote.spread * 10_000
  if (spreadBps > config.spreadCeilBps) {
    return { pass: false, reason: `点差 ${spreadBps.toFixed(1)}bps 超过上限 ${config.spreadCeilBps}bps` }
  }
  return { pass: true }
}

/** watch 命中的去重键：同一 (watch, token, 时间桶) 只触发一次。 */
export function watchDedupKey(watchId: string, tokenId: string, ts: number, bucketMs: number): string {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new PmTimeError(`时间桶必须是有限正数，收到 ${String(bucketMs)}`)
  }
  if (!Number.isFinite(ts)) throw new PmTimeError(`ts 非法：${ts}`)
  return `pm:${watchId}:${tokenId}:${Math.floor(ts / bucketMs)}`
}
