/**
 * 市场 regime 分桶（plan §12 #2 / T2.5）。
 *
 * 本文件只保留纯函数：不读时钟、不读数据库，也不依赖运行时状态，方便回放和审计复算。
 */

export type RegimeVol = 'low' | 'mid' | 'high'
export type RegimeTrend = 'range' | 'trend' | 'strong_trend'
export type RegimeBucket = `${RegimeTrend}|${RegimeVol}`

export interface TrendInputs {
  readonly ema20: number | null | undefined
  readonly ema50: number | null | undefined
  readonly atr14: number | null | undefined
}

export interface RegimeInputs extends TrendInputs {
  readonly symbol: string
  readonly timeframe: string
  readonly volRealized20: number | null | undefined
  readonly volHistory: readonly (number | null | undefined)[]
  readonly minSamples?: number
}

export type RegimeResult =
  | {
      readonly ok: true
      readonly bucket: RegimeBucket
      readonly trend: RegimeTrend
      readonly vol: RegimeVol
      readonly trendRatio: number
      readonly volRank: number
      readonly samples: number
    }
  | { readonly ok: false; readonly reason: string }

const DEFAULT_MIN_SAMPLES = 30
const LOW_VOL_CUTOFF = 0.33
const HIGH_VOL_CUTOFF = 0.67

function isFiniteNumber(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value)
}

/**
 * 小于等于 value 的样本占比，返回范围为 (0, 1]；空历史或非法输入返回 null。
 * 复制后排序，故调用者传入已排序或未排序的历史都得到同一结果，且不会改写原数组。
 */
export function percentileRank(value: number, sortedOrUnsorted: readonly number[]): number | null {
  if (!Number.isFinite(value) || sortedOrUnsorted.length === 0) return null
  if (sortedOrUnsorted.some((sample) => !Number.isFinite(sample))) return null

  const sorted = [...sortedOrUnsorted].sort((left, right) => left - right)
  const lessThanOrEqual = sorted.reduce((count, sample) => count + (sample <= value ? 1 : 0), 0)
  return lessThanOrEqual / sorted.length
}

/** 以固定的 33% / 67% 边界分桶；正好落在边界时归入中档。 */
export function volBucket(
  volRealized20: number | null | undefined,
  history: readonly number[],
): RegimeVol | null {
  const rank = isFiniteNumber(volRealized20) ? percentileRank(volRealized20, history) : null
  if (rank === null) return null
  if (rank < LOW_VOL_CUTOFF) return 'low'
  if (rank <= HIGH_VOL_CUTOFF) return 'mid'
  return 'high'
}

/** §12 #2 的趋势归一化比值；ATR 非正或任一指标仍在暖机时不猜桶。 */
export function trendRatio(input: TrendInputs): number | null {
  if (
    !isFiniteNumber(input.ema20) ||
    !isFiniteNumber(input.ema50) ||
    !isFiniteNumber(input.atr14) ||
    !(input.atr14 > 0)
  ) {
    return null
  }
  return Math.abs(input.ema20 - input.ema50) / input.atr14
}

export function trendBucket(input: TrendInputs): RegimeTrend | null {
  const ratio = trendRatio(input)
  if (ratio === null) return null
  if (ratio < 0.5) return 'range'
  if (ratio <= 1.5) return 'trend'
  return 'strong_trend'
}

/**
 * 组合趋势与波动率得到 9 个可审计桶。
 * 分位数为什么优于拍阈值：不同标的的波动量纲不同，历史分位能自适应其自身分布；
 * 但 §12 #2 同时给了趋势比值阈值，这里两者都保留以便审计，不能用一个维度替代另一个。
 */
export function regimeOf(input: RegimeInputs): RegimeResult {
  const minSamples = input.minSamples ?? DEFAULT_MIN_SAMPLES
  if (!Number.isInteger(minSamples) || minSamples < 1) {
    return { ok: false, reason: `minSamples 必须是 >=1 的整数，收到 ${String(minSamples)}` }
  }

  const ratio = trendRatio(input)
  if (ratio === null || !isFiniteNumber(input.volRealized20)) {
    return { ok: false, reason: 'regime 输入缺失或仍处于指标暖机期' }
  }

  // 暖机/坏值不算样本；若有效历史不够，宁可拒绝也不把未知状态猜成某个桶。
  const history = input.volHistory.filter(isFiniteNumber)
  if (history.length < minSamples) {
    return {
      ok: false,
      reason: `波动率历史样本不足：${history.length} < ${minSamples}`,
    }
  }

  const rank = percentileRank(input.volRealized20, history)
  const trend = trendBucket(input)
  const vol = volBucket(input.volRealized20, history)
  if (rank === null || trend === null || vol === null) {
    return { ok: false, reason: 'regime 输入无法形成有效分位或桶' }
  }

  return {
    ok: true,
    bucket: `${trend}|${vol}`,
    trend,
    vol,
    trendRatio: ratio,
    volRank: rank,
    samples: history.length,
  }
}
