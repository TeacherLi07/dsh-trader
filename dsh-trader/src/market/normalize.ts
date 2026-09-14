/**
 * K 线归一化：校验、去重、排序、计算 `closeTime`/`closed`（plan §4.3）。
 *
 * 纯函数、不读时钟 —— `now` 由调用方传入，因此回放与实盘走同一份逻辑。
 * 这是"只落已收盘 bar"与"禁用未收盘 K 线"两条硬性规则的唯一落点。
 */

import { MarketSourceError, type Candle, type RawCandle } from './types.js'

export const TIMEFRAME_MS = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
} as const

export type MarketTimeframe = keyof typeof TIMEFRAME_MS

export function timeframeMs(timeframe: string): number {
  const ms = (TIMEFRAME_MS as Record<string, number>)[timeframe]
  if (ms === undefined) {
    throw new MarketSourceError('not_configured', `不支持的时间框架：${timeframe}`)
  }
  return ms
}

export function closeTimeOf(openTime: number, timeframe: string): number {
  return openTime + timeframeMs(timeframe)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export interface NormalizeResult {
  readonly candles: readonly Candle[]
  /** 因非法/自相矛盾而被丢弃的原始条目数（数据质量校验，plan §4.5 #8）。 */
  readonly dropped: number
}

/**
 * 归一化：`(symbol, timeframe, now)` → 升序、去重（同一 `openTime` 后者覆盖）、带 `closed` 标记。
 * 丢弃：非整数/非正开盘时间、非有限数值、volume<0、`high < low`、`high` 低于 open/close、`low` 高于 open/close。
 */
export function normalizeCandles(
  raw: readonly RawCandle[],
  symbol: string,
  timeframe: string,
  now: number,
): NormalizeResult {
  const tfMs = timeframeMs(timeframe)
  if (!isFiniteNumber(now)) throw new MarketSourceError('other', `now 非法：${String(now)}`)

  const byOpen = new Map<number, Candle>()
  let dropped = 0

  for (const candle of raw) {
    if (!isFiniteNumber(candle.openTime) || !Number.isInteger(candle.openTime) || candle.openTime <= 0) {
      dropped += 1
      continue
    }
    const { open, high, low, close, volume } = candle
    if (![open, high, low, close, volume].every(isFiniteNumber)) {
      dropped += 1
      continue
    }
    if (volume < 0 || high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      dropped += 1
      continue
    }
    // 同一 openTime 出现多次时，后出现的覆盖先出现的（交易所会回补/修正）
    byOpen.set(candle.openTime, {
      symbol,
      timeframe,
      openTime: candle.openTime,
      closeTime: candle.openTime + tfMs,
      open,
      high,
      low,
      close,
      volume,
      closed: candle.openTime + tfMs <= now,
    })
  }

  const candles = [...byOpen.values()].sort((a, b) => a.openTime - b.openTime)
  return { candles, dropped }
}

/**
 * 只保留已收盘 bar。
 * 这是唯一允许把 bar 送进特征/规则/落库的入口 —— CCXT 的最后一根通常是进行中的 bar。
 */
export function closedOnly(candles: readonly Candle[]): readonly Candle[] {
  return candles.filter((candle) => candle.closed)
}
