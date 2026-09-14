/**
 * 指标的**全量参考实现**（plan §4.3 / T0.5）。
 *
 * 这些函数只用于对拍与离线分析；运行期走 `features.ts` 的增量状态。
 * 两者必须**逐点一致** —— 这是 T0.5 的验收标准，所以这里的每一步运算都被刻意写成
 * 与增量实现同一套公式（同样的种子、同样的暖机长度、同样的 Wilder 平滑）。
 *
 * 纯函数：不读时钟、不读状态、不抛随机性。
 */

export type MaybeNumbers = readonly (number | null)[]

export interface Ohlcv {
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
}

function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`周期必须是 >=1 的整数，收到 ${String(period)}`)
  }
}

/**
 * EMA：**用首个值播种**（`ema[0] = values[0]`），因此增量实现只需要保留上一个值。
 * `period-1` 之前返回 `null`（暖机期不给数字，避免把无意义的早期值当信号）。
 */
export function emaSeries(values: readonly number[], period: number): MaybeNumbers {
  assertPeriod(period)
  const k = 2 / (period + 1)
  const out: (number | null)[] = []
  let value = 0
  for (let i = 0; i < values.length; i += 1) {
    const current = values[i] as number
    value = i === 0 ? current : current * k + value * (1 - k)
    out.push(i >= period - 1 ? value : null)
  }
  return out
}

/** RSI（Wilder 平滑）：第一个值出现在 index = period（需要 period 个涨跌幅）。 */
export function rsiSeries(values: readonly number[], period: number): MaybeNumbers {
  assertPeriod(period)
  const out: (number | null)[] = values.map(() => null)
  if (values.length <= period) return out

  let gainSum = 0
  let lossSum = 0
  for (let i = 1; i <= period; i += 1) {
    const delta = (values[i] as number) - (values[i - 1] as number)
    gainSum += Math.max(delta, 0)
    lossSum += Math.max(-delta, 0)
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = rsiValue(avgGain, avgLoss)

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = (values[i] as number) - (values[i - 1] as number)
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period
    out[i] = rsiValue(avgGain, avgLoss)
  }
  return out
}

export function rsiValue(avgGain: number, avgLoss: number): number {
  // 完全无波动时 0/0 无定义；按"中性"处理为 50（而非把除零当成超买 100）
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/** 真实波幅（TR）：index 0 退化为 high-low（没有前收）。 */
export function trueRangeAt(candles: readonly Ohlcv[], index: number): number {
  const candle = candles[index] as Ohlcv
  if (index === 0) return candle.high - candle.low
  const previousClose = (candles[index - 1] as Ohlcv).close
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  )
}

/** ATR（Wilder）：第一个值出现在 index = period（TR[1..period] 的均值）。 */
export function atrSeries(candles: readonly Ohlcv[], period: number): MaybeNumbers {
  assertPeriod(period)
  const out: (number | null)[] = candles.map(() => null)
  if (candles.length <= period) return out

  let sum = 0
  for (let i = 1; i <= period; i += 1) sum += trueRangeAt(candles, i)
  let atr = sum / period
  out[period] = atr

  for (let i = period + 1; i < candles.length; i += 1) {
    atr = (atr * (period - 1) + trueRangeAt(candles, i)) / period
    out[i] = atr
  }
  return out
}

/** VWAP：最近 `period` 根的成交量加权均价（典型价 = (h+l+c)/3）；无成交量时为 null。 */
export function vwapSeries(candles: readonly Ohlcv[], period: number): MaybeNumbers {
  assertPeriod(period)
  const out: (number | null)[] = candles.map(() => null)
  for (let i = period - 1; i < candles.length; i += 1) {
    let priceVolume = 0
    let volume = 0
    for (let j = i - period + 1; j <= i; j += 1) {
      const candle = candles[j] as Ohlcv
      priceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume
      volume += candle.volume
    }
    out[i] = volume > 0 ? priceVolume / volume : null
  }
  return out
}

/** z-score：最近 `period` 个值的（总体）标准差归一化；标准差为 0 时为 null。 */
export function zscoreSeries(values: readonly number[], period: number): MaybeNumbers {
  assertPeriod(period)
  const out: (number | null)[] = values.map(() => null)
  for (let i = period - 1; i < values.length; i += 1) {
    const window = values.slice(i - period + 1, i + 1)
    out[i] = zscoreOf(window)
  }
  return out
}

export function zscoreOf(window: readonly number[]): number | null {
  const n = window.length
  if (n === 0) return null
  const mean = window.reduce((sum, value) => sum + value, 0) / n
  const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n
  const sd = Math.sqrt(variance)
  if (!(sd > 0)) return null
  return ((window[n - 1] as number) - mean) / sd
}

/**
 * 已实现波动率：最近 `period` 个**对数收益**的（总体）标准差。
 * 不做年化 —— 年化因子依赖交易日/自然日的约定，留到需要时显式引入。
 * 出现非正价格时返回 null。
 */
export function realizedVolSeries(values: readonly number[], period: number): MaybeNumbers {
  assertPeriod(period)
  const out: (number | null)[] = values.map(() => null)
  for (let i = period; i < values.length; i += 1) {
    const returns: number[] = []
    let ok = true
    for (let j = i - period + 1; j <= i; j += 1) {
      const previous = values[j - 1] as number
      const current = values[j] as number
      if (!(previous > 0) || !(current > 0)) {
        ok = false
        break
      }
      returns.push(Math.log(current / previous))
    }
    if (!ok) continue
    const mean = returns.reduce((sum, value) => sum + value, 0) / period
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period
    out[i] = Math.sqrt(variance)
  }
  return out
}
