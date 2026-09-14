/**
 * 特征层（plan §4.3 / T0.5）：**增量**维护指标状态，每根已收盘 bar 产出一份快照。
 *
 * 三条纪律：
 *   1. 只接受**已收盘** bar（未收盘一律抛错，不"静默跳过"）；
 *   2. 窗口指标只保留最近 `period` 个值，**不重算全历史** ⇒ 单根成本与历史长度无关；
 *   3. 增量结果必须与 `indicators.ts` 的全量实现**逐点一致**（T0.5 的验收标准）。
 */

import { fingerprint } from '../util/canonical.js'
import { rsiValue, zscoreOf, type Ohlcv } from './indicators.js'
import { MarketSourceError, type Candle } from './types.js'
import type { FeatureArchive } from './feature-archive.js'

/** v0 固定窗口。字段名（`ema20` 等）与之绑定，因此**不做可配置化**，避免名字与语义不符。 */
export const FEATURE_WINDOWS = {
  emaFast: 20,
  emaSlow: 50,
  rsi: 14,
  atr: 14,
  vwap: 20,
  zscore: 20,
  vol: 20,
} as const

/** 重启回灌长度：覆盖最长的指标窗口（EMA50），保证回灌后所有指标立即有值。 */
export const FEATURE_WARMUP_BARS = FEATURE_WINDOWS.emaSlow

export interface FeatureValues {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly ema20: number | null
  readonly ema50: number | null
  readonly rsi14: number | null
  readonly atr14: number | null
  readonly vwap20: number | null
  readonly zscore20: number | null
  readonly volRealized20: number | null
}

export interface FeatureSnapshot {
  readonly symbol: string
  readonly timeframe: string
  readonly openTime: number
  readonly closeTime: number
  readonly values: FeatureValues
  /** 内容指纹：可用它证明"当时用的是什么特征"（plan §5.1）。 */
  readonly fingerprint: string
}

class EmaState {
  #value = 0
  #count = 0

  constructor(private readonly period: number) {}

  push(value: number): number | null {
    this.#count += 1
    if (this.#count === 1) {
      this.#value = value
    } else {
      const k = 2 / (this.period + 1)
      this.#value = value * k + this.#value * (1 - k)
    }
    return this.#count >= this.period ? this.#value : null
  }
}

class RsiState {
  #previousClose: number | undefined
  #changes = 0
  #gainSum = 0
  #lossSum = 0
  #avgGain = 0
  #avgLoss = 0

  constructor(private readonly period: number) {}

  push(close: number): number | null {
    if (this.#previousClose === undefined) {
      this.#previousClose = close
      return null
    }
    const delta = close - this.#previousClose
    this.#previousClose = close
    const gain = Math.max(delta, 0)
    const loss = Math.max(-delta, 0)

    this.#changes += 1
    if (this.#changes <= this.period) {
      this.#gainSum += gain
      this.#lossSum += loss
      if (this.#changes < this.period) return null
      this.#avgGain = this.#gainSum / this.period
      this.#avgLoss = this.#lossSum / this.period
      return rsiValue(this.#avgGain, this.#avgLoss)
    }
    this.#avgGain = (this.#avgGain * (this.period - 1) + gain) / this.period
    this.#avgLoss = (this.#avgLoss * (this.period - 1) + loss) / this.period
    return rsiValue(this.#avgGain, this.#avgLoss)
  }
}

class AtrState {
  #previousClose: number | undefined
  #count = 0
  #sumTr = 0
  #atr = 0

  constructor(private readonly period: number) {}

  push(candle: Ohlcv): number | null {
    const trueRange =
      this.#previousClose === undefined
        ? candle.high - candle.low
        : Math.max(
            candle.high - candle.low,
            Math.abs(candle.high - this.#previousClose),
            Math.abs(candle.low - this.#previousClose),
          )
    this.#previousClose = candle.close
    this.#count += 1

    // TR[0] 不参与首个 ATR（全量实现同样是 TR[1..period] 的均值）
    if (this.#count === 1) return null
    if (this.#count <= this.period + 1) {
      this.#sumTr += trueRange
      if (this.#count < this.period + 1) return null
      this.#atr = this.#sumTr / this.period
      return this.#atr
    }
    this.#atr = (this.#atr * (this.period - 1) + trueRange) / this.period
    return this.#atr
  }
}

class RollingBuffer<T> {
  #items: T[] = []

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.#items.push(item)
    if (this.#items.length > this.capacity) this.#items.shift()
  }

  get size(): number {
    return this.#items.length
  }

  items(): readonly T[] {
    return this.#items
  }
}

const VOL_NEEDS = FEATURE_WINDOWS.vol + 1

export class FeatureEngine {
  #emaFast = new EmaState(FEATURE_WINDOWS.emaFast)
  #emaSlow = new EmaState(FEATURE_WINDOWS.emaSlow)
  #rsi = new RsiState(FEATURE_WINDOWS.rsi)
  #atr = new AtrState(FEATURE_WINDOWS.atr)
  #candles = new RollingBuffer<Ohlcv>(FEATURE_WINDOWS.vwap)
  #closes = new RollingBuffer<number>(Math.max(FEATURE_WINDOWS.zscore, VOL_NEEDS))
  #bars = 0

  get bars(): number {
    return this.#bars
  }

  /** 消费一根**已收盘** bar，返回该 bar 的特征快照。 */
  onClosedCandle(candle: Candle): FeatureSnapshot {
    if (!candle.closed) {
      throw new MarketSourceError(
        'other',
        `特征层只接受已收盘 bar：${candle.symbol} ${candle.timeframe} open=${candle.openTime}`,
      )
    }

    const ohlcv: Ohlcv = {
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }

    this.#bars += 1
    const ema20 = this.#emaFast.push(candle.close)
    const ema50 = this.#emaSlow.push(candle.close)
    const rsi14 = this.#rsi.push(candle.close)
    const atr14 = this.#atr.push(ohlcv)
    this.#candles.push(ohlcv)
    this.#closes.push(candle.close)

    const values: FeatureValues = {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      ema20,
      ema50,
      rsi14,
      atr14,
      vwap20: this.#vwap(),
      zscore20: this.#zscore(),
      volRealized20: this.#realizedVol(),
    }

    return {
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      openTime: candle.openTime,
      closeTime: candle.closeTime,
      values,
      fingerprint: fingerprint({
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        openTime: candle.openTime,
        values,
      }),
    }
  }

  #vwap(): number | null {
    const window = this.#candles.items()
    if (window.length < FEATURE_WINDOWS.vwap) return null
    let priceVolume = 0
    let volume = 0
    for (const candle of window) {
      priceVolume += ((candle.high + candle.low + candle.close) / 3) * candle.volume
      volume += candle.volume
    }
    return volume > 0 ? priceVolume / volume : null
  }

  #zscore(): number | null {
    const window = this.#closes.items()
    if (window.length < FEATURE_WINDOWS.zscore) return null
    return zscoreOf(window.slice(window.length - FEATURE_WINDOWS.zscore))
  }

  #realizedVol(): number | null {
    const window = this.#closes.items()
    if (window.length < VOL_NEEDS) return null
    const recent = window.slice(window.length - VOL_NEEDS)
    const returns: number[] = []
    for (let i = 1; i < recent.length; i += 1) {
      const previous = recent[i - 1] as number
      const current = recent[i] as number
      if (!(previous > 0) || !(current > 0)) return null
      returns.push(Math.log(current / previous))
    }
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length
    return Math.sqrt(variance)
  }
}

/**
 * 特征流水线：按 (symbol, timeframe) 维护各自的增量状态，并把快照写入归档。
 * 直接当作 `MarketFeed` 的 `onClosedCandle` 使用。
 */
export class FeaturePipeline {
  #engines = new Map<string, FeatureEngine>()

  constructor(private readonly archive: FeatureArchive) {}

  onClosedCandle(candle: Candle): FeatureSnapshot {
    const snapshot = this.#engineFor(candle.symbol, candle.timeframe).onClosedCandle(candle)
    this.archive.upsert(snapshot)
    return snapshot
  }

  /**
   * 进程重启后回灌：用归档里的已收盘 bar 重建增量状态。
   * 回灌长度取各窗口的最大需求（50 根足够覆盖全部指标），避免重启后长时间空窗。
   */
  warmUp(candles: readonly Candle[]): void {
    for (const candle of candles) {
      if (!candle.closed) continue
      this.#engineFor(candle.symbol, candle.timeframe).onClosedCandle(candle)
    }
  }

  engineCount(): number {
    return this.#engines.size
  }

  #engineFor(symbol: string, timeframe: string): FeatureEngine {
    const key = `${symbol}|${timeframe}`
    let engine = this.#engines.get(key)
    if (engine === undefined) {
      engine = new FeatureEngine()
      this.#engines.set(key, engine)
    }
    return engine
  }
}
