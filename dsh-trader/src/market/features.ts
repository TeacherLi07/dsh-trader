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
import {
  EMPTY_DERIVATIVES_VALUES,
  DerivativesTracker,
  type DerivativesObservation,
  type DerivativesValues,
} from './derivatives.js'
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
  adx: 14,
} as const

/**
 * 重启回灌长度覆盖 EMA50 与 ADX 的双窗口暖机；ADX 首值在 index=2*period，
 * 因而需要 2*period+1 根 bar 才能重建该状态。
 */
export const FEATURE_WARMUP_BARS = Math.max(FEATURE_WINDOWS.emaSlow, FEATURE_WINDOWS.adx * 2 + 1)

export const DEFAULT_DERIVATIVES_WINDOW_MS = 60 * 60 * 1000

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
  readonly adx14: number | null
  readonly vwap20: number | null
  readonly zscore20: number | null
  readonly volRealized20: number | null
  readonly fundingRate: number | null
  readonly oiChangePct: number | null
  readonly liqNotional: number | null
  readonly basisBps: number | null
}

/** 特征层只接收已归一化的快照字段或原始 observation；时间戳仍由调用方注入。 */
export type FeatureDerivatives =
  | DerivativesValues
  | (Omit<DerivativesObservation, 'timestamp'> & { readonly timestamp?: number })

export interface FeatureSnapshot {
  readonly symbol: string
  readonly timeframe: string
  readonly openTime: number
  readonly closeTime: number
  readonly values: FeatureValues
  /** 重启时恢复 OI/清算窗口的原始观测；不参与 DSL 词汇表。 */
  readonly derivatives?: DerivativesObservation
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

class AdxState {
  #previousHigh: number | undefined
  #previousLow: number | undefined
  #previousClose: number | undefined
  #count = 0
  #sumTr = 0
  #sumPlus = 0
  #sumMinus = 0
  #averageTr = 0
  #averagePlus = 0
  #averageMinus = 0
  #dxSum = 0
  #dxCount = 0
  #adx: number | null = null

  constructor(private readonly period: number) {}

  push(candle: Ohlcv): number | null {
    const previousHigh = this.#previousHigh
    const previousLow = this.#previousLow
    const previousClose = this.#previousClose
    this.#previousHigh = candle.high
    this.#previousLow = candle.low
    this.#previousClose = candle.close
    this.#count += 1

    if (previousHigh === undefined || previousLow === undefined || previousClose === undefined) return null

    const trueRange = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    )
    const upMove = candle.high - previousHigh
    const downMove = previousLow - candle.low
    const plus = upMove > downMove && upMove > 0 ? upMove : 0
    const minus = downMove > upMove && downMove > 0 ? downMove : 0

    if (this.#count <= this.period + 1) {
      this.#sumTr += trueRange
      this.#sumPlus += plus
      this.#sumMinus += minus
      if (this.#count < this.period + 1) return null
      this.#averageTr = this.#sumTr / this.period
      this.#averagePlus = this.#sumPlus / this.period
      this.#averageMinus = this.#sumMinus / this.period
    } else {
      this.#averageTr = (this.#averageTr * (this.period - 1) + trueRange) / this.period
      this.#averagePlus = (this.#averagePlus * (this.period - 1) + plus) / this.period
      this.#averageMinus = (this.#averageMinus * (this.period - 1) + minus) / this.period
    }

    if (!(this.#averageTr > 0)) return null
    const plusDi = (100 * this.#averagePlus) / this.#averageTr
    const minusDi = (100 * this.#averageMinus) / this.#averageTr
    const denominator = plusDi + minusDi
    const dx = denominator > 0 ? (100 * Math.abs(plusDi - minusDi)) / denominator : 0

    // 种子 DI 不进入首组 ADX 均值；因此普通数据的首个 ADX 固定在 index=2*period。
    if (this.#count === this.period + 1) return null
    if (this.#adx === null) {
      this.#dxSum += dx
      this.#dxCount += 1
      if (this.#dxCount < this.period) return null
      this.#adx = this.#dxSum / this.period
      return this.#adx
    }
    if (this.#adx === null) return null
    this.#adx = (this.#adx * (this.period - 1) + dx) / this.period
    return this.#adx
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
  #adx = new AdxState(FEATURE_WINDOWS.adx)
  #candles = new RollingBuffer<Ohlcv>(FEATURE_WINDOWS.vwap)
  #closes = new RollingBuffer<number>(Math.max(FEATURE_WINDOWS.zscore, VOL_NEEDS))
  #derivatives: DerivativesTracker
  #bars = 0
  #lastCandle: Candle | undefined
  #lastSnapshot: FeatureSnapshot | undefined

  constructor(derivativesWindowMs = DEFAULT_DERIVATIVES_WINDOW_MS) {
    this.#derivatives = new DerivativesTracker(derivativesWindowMs)
  }

  get bars(): number {
    return this.#bars
  }

  /** 消费一根**已收盘** bar，返回该 bar 的特征快照。 */
  onClosedCandle(candle: Candle, derivatives?: FeatureDerivatives): FeatureSnapshot {
    if (!candle.closed) {
      throw new MarketSourceError(
        'other',
        `特征层只接受已收盘 bar：${candle.symbol} ${candle.timeframe} open=${candle.openTime}`,
      )
    }

    // 增量状态不能接受乱序或历史修正：继续计算会把一根旧 bar 当成新 bar，
    // 之后所有 EMA/RSI/ADX/衍生品窗口都被静默污染。相同 bar 的重复投递则返回
    // 上次快照，供 feed 回调失败后的幂等重试使用。
    if (this.#lastCandle !== undefined) {
      if (candle.openTime < this.#lastCandle.openTime) {
        throw new MarketSourceError(
          'other',
          `特征层收到乱序 bar：${candle.symbol} ${candle.timeframe} ${candle.openTime} < ${this.#lastCandle.openTime}`,
        )
      }
      if (candle.openTime === this.#lastCandle.openTime) {
        const same =
          candle.symbol === this.#lastCandle.symbol &&
          candle.timeframe === this.#lastCandle.timeframe &&
          candle.closeTime === this.#lastCandle.closeTime &&
          candle.open === this.#lastCandle.open &&
          candle.high === this.#lastCandle.high &&
          candle.low === this.#lastCandle.low &&
          candle.close === this.#lastCandle.close &&
          candle.volume === this.#lastCandle.volume
        if (same && this.#lastSnapshot !== undefined) return this.#lastSnapshot
        throw new MarketSourceError(
          'other',
          `特征层拒绝修正已消费 bar：${candle.symbol} ${candle.timeframe} ${candle.openTime}`,
        )
      }
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
    const adx14 = this.#adx.push(ohlcv)
    this.#candles.push(ohlcv)
    this.#closes.push(candle.close)
    const derivativeValues = this.#derivativeValues(derivatives, candle.closeTime)
    const rawDerivatives =
      derivatives !== undefined && !('oiChangePct' in derivatives)
        ? { ...derivatives, timestamp: derivatives.timestamp ?? candle.closeTime }
        : undefined

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
      adx14,
      vwap20: this.#vwap(),
      zscore20: this.#zscore(),
      volRealized20: this.#realizedVol(),
      fundingRate: derivativeValues.fundingRate,
      oiChangePct: derivativeValues.oiChangePct,
      liqNotional: derivativeValues.liqNotional,
      basisBps: derivativeValues.basisBps,
    }

    const snapshot: FeatureSnapshot = {
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
        ...(rawDerivatives === undefined ? {} : { derivatives: rawDerivatives }),
      }),
      ...(rawDerivatives === undefined ? {} : { derivatives: rawDerivatives }),
    }
    this.#lastCandle = candle
    this.#lastSnapshot = snapshot
    return snapshot
  }

  #derivativeValues(
    derivatives: FeatureDerivatives | undefined,
    fallbackTimestamp: number,
  ): DerivativesValues {
    if (derivatives === undefined) return EMPTY_DERIVATIVES_VALUES
    if ('oiChangePct' in derivatives) return derivatives
    return this.#derivatives.push({
      ...derivatives,
      timestamp: derivatives.timestamp ?? fallbackTimestamp,
    })
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
  #lastOpenTimes = new Map<string, number>()
  #blocked = new Set<string>()

  constructor(
    private readonly archive: FeatureArchive,
    private readonly derivativesWindowMs = DEFAULT_DERIVATIVES_WINDOW_MS,
  ) {}

  onClosedCandle(candle: Candle, derivatives?: FeatureDerivatives, availableAt?: number): FeatureSnapshot {
    const key = `${candle.symbol}|${candle.timeframe}`
    if (this.#blocked.has(key)) {
      throw new MarketSourceError(
        'other',
        `特征流水线因历史修订 fail-closed：${candle.symbol} ${candle.timeframe}；需运维完成 feature-only 重建并显式确认处理游标`,
      )
    }

    const lastOpenTime = this.#lastOpenTimes.get(key)
    let snapshot: FeatureSnapshot
    try {
      snapshot = this.#engineFor(candle.symbol, candle.timeframe).onClosedCandle(candle, derivatives)
    } catch (error) {
      if (candle.closed && lastOpenTime !== undefined && candle.openTime <= lastOpenTime) {
        this.#blocked.add(key)
        try {
          this.archive.invalidateFrom(
            candle.symbol,
            candle.timeframe,
            candle.openTime,
            availableAt,
            candle.closeTime,
          )
        } catch (invalidationError) {
          throw new MarketSourceError(
            'other',
            `历史修订已阻断特征流水线，但失效投影失败：${String(invalidationError)}`,
          )
        }
      }
      throw error
    }

    this.#lastOpenTimes.set(key, candle.openTime)
    this.archive.upsert(snapshot, availableAt)
    return snapshot
  }

  /**
   * 进程重启后回灌：用归档里的已收盘 bar 重建增量状态。
   * 回灌长度取 FEATURE_WARMUP_BARS，覆盖 EMA50 和 ADX 双窗口，避免重启后长时间空窗。
   */
  warmUp(candles: readonly Candle[], snapshots: readonly FeatureSnapshot[] = []): void {
    const byOpen = new Map<string, FeatureSnapshot>()
    for (const snapshot of snapshots) {
      byOpen.set(`${snapshot.symbol}|${snapshot.timeframe}|${snapshot.openTime}`, snapshot)
    }
    for (const candle of candles) {
      if (!candle.closed) continue
      const snapshot = byOpen.get(`${candle.symbol}|${candle.timeframe}|${candle.openTime}`)
      this.#engineFor(candle.symbol, candle.timeframe).onClosedCandle(candle, snapshot?.derivatives)
      const key = `${candle.symbol}|${candle.timeframe}`
      this.#lastOpenTimes.set(key, candle.openTime)
    }
  }

  engineCount(): number {
    return this.#engines.size
  }

  #engineFor(symbol: string, timeframe: string): FeatureEngine {
    const key = `${symbol}|${timeframe}`
    let engine = this.#engines.get(key)
    if (engine === undefined) {
      engine = new FeatureEngine(this.derivativesWindowMs)
      this.#engines.set(key, engine)
    }
    return engine
  }
}
