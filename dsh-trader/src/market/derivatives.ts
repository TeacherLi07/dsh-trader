/**
 * 衍生品特征的纯归一化与增量状态。
 *
 * 单位口径固定为：funding.rate 是小数比例（0.0001 = 1bp），basis.bps 是
 * (swap - spot) / spot * 10000，liq.notional 是窗口内 trade_turnover 的累加，
 * oi.changePct 是相对上一个有效 OI 观测的百分比变化（不是小数比例）。
 * 本文件不读墙钟；所有窗口边界都使用调用方注入的 timestamp。
 */

import type { CcxtExchangeLike } from './ccxt-source.js'

function finiteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  return null
}

/** funding.rate 保留交易所返回的小数比例，不乘 100 或 10000。 */
export function normalizeFundingRate(raw: unknown): number | null {
  return finiteNumber(raw)
}

/** OI 只做数值归一化；无效值返回 null，不能用 0 冒充缺失。 */
export function normalizeOpenInterest(raw: unknown): number | null {
  const value = finiteNumber(raw)
  return value !== null && value >= 0 ? value : null
}

export interface LiquidationNormalization {
  /** 窗口内应累加的计价货币名义金额。 */
  readonly notional: number
  /** 无法解析 trade_turnover/volume 的行数。 */
  readonly skipped: number
}

interface RecordLike {
  readonly [key: string]: unknown
}

function asRecord(raw: unknown): RecordLike | null {
  return raw !== null && typeof raw === 'object' ? (raw as RecordLike) : null
}

function rowNumber(row: unknown, key: string): number | null {
  const record = asRecord(row)
  if (record === null) return null
  const direct = finiteNumber(record[key])
  if (direct !== null) return direct
  // 部分 ccxt 版本把 HTX 原始字段放在 info；能解析就采用，不能解析仍 fail-closed。
  return finiteNumber(asRecord(record.info)?.[key])
}

/** 每行优先采用 trade_turnover，否则采用 volume；坏行跳过但不把缺失伪装成 0。 */
export function normalizeLiquidations(rows: readonly unknown[]): LiquidationNormalization {
  let notional = 0
  let skipped = 0
  for (const row of rows) {
    const turnover = rowNumber(row, 'trade_turnover') ?? rowNumber(row, 'volume')
    if (turnover === null || turnover < 0) {
      skipped += 1
      continue
    }
    notional += turnover
  }
  return { notional, skipped }
}

/** basis.bps = (swap - spot) / spot * 10000；非正或不可用价格不作估算。 */
export function basisBps(spot: number, swap: number): number | null {
  if (!(Number.isFinite(spot) && spot > 0) || !(Number.isFinite(swap) && swap > 0)) return null
  return ((swap - spot) / spot) * 10_000
}

export interface DerivativesObservation {
  /** 由行情源/蜡烛 closeTime 注入，绝不在此处读取墙钟。 */
  readonly timestamp: number
  readonly fundingRate?: unknown
  readonly openInterest?: unknown
  /** 本次观测覆盖的清算行；undefined 表示该源不可用，空数组表示确实没有清算。 */
  readonly liquidations?: readonly unknown[]
  readonly spotPrice?: unknown
  readonly swapPrice?: unknown
}

export interface DerivativesValues {
  readonly fundingRate: number | null
  readonly oiChangePct: number | null
  readonly liqNotional: number | null
  readonly basisBps: number | null
}

export const EMPTY_DERIVATIVES_VALUES: DerivativesValues = {
  fundingRate: null,
  oiChangePct: null,
  liqNotional: null,
  basisBps: null,
}

interface LiquidationBucket {
  readonly timestamp: number
  readonly notional: number
}

function assertWindow(windowMs: number): void {
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new Error(`衍生品窗口必须是非负有限毫秒数，收到 ${String(windowMs)}`)
  }
}

function assertTimestamp(timestamp: number): void {
  if (!Number.isFinite(timestamp)) {
    throw new Error(`衍生品观测时间戳必须是有限数字，收到 ${String(timestamp)}`)
  }
}

/**
 * 逐点维护衍生品快照；队列只保留窗口内清算名义，OI 仅保留上一有效观测。
 * 时间戳要求单调不减，这是 O(1) 摊还淘汰和确定性回放的前提。
 */
export class DerivativesTracker {
  #previousOpenInterest: number | null = null
  #lastTimestamp: number | undefined
  #liquidations: LiquidationBucket[] = []
  #liquidationHead = 0
  #liquidationTotal = 0

  constructor(private readonly windowMs: number) {
    assertWindow(windowMs)
  }

  push(observation: DerivativesObservation): DerivativesValues {
    assertTimestamp(observation.timestamp)
    if (this.#lastTimestamp !== undefined && observation.timestamp < this.#lastTimestamp) {
      throw new Error('衍生品观测时间戳必须单调不减')
    }
    this.#lastTimestamp = observation.timestamp

    const currentOpenInterest = normalizeOpenInterest(observation.openInterest)
    const oiChangePct =
      currentOpenInterest !== null && this.#previousOpenInterest !== null && this.#previousOpenInterest > 0
        ? ((currentOpenInterest - this.#previousOpenInterest) / this.#previousOpenInterest) * 100
        : null
    if (currentOpenInterest !== null) this.#previousOpenInterest = currentOpenInterest

    const liquidations = observation.liquidations
    let liqNotional: number | null = null
    if (liquidations !== undefined) {
      const normalized = normalizeLiquidations(liquidations)
      liqNotional = this.#addLiquidationBucket(observation.timestamp, normalized.notional)
    }

    const fundingRate = normalizeFundingRate(observation.fundingRate)
    const spot = finiteNumber(observation.spotPrice)
    const swap = finiteNumber(observation.swapPrice)
    return {
      fundingRate,
      oiChangePct,
      liqNotional,
      basisBps: spot !== null && swap !== null ? basisBps(spot, swap) : null,
    }
  }

  #addLiquidationBucket(timestamp: number, notional: number): number {
    this.#liquidations.push({ timestamp, notional })
    this.#liquidationTotal += notional
    const cutoff = timestamp - this.windowMs
    while (
      this.#liquidationHead < this.#liquidations.length &&
      (this.#liquidations[this.#liquidationHead] as LiquidationBucket).timestamp < cutoff
    ) {
      this.#liquidationTotal -= (this.#liquidations[this.#liquidationHead] as LiquidationBucket).notional
      this.#liquidationHead += 1
    }
    // 只在前缀已经淘汰时压缩，避免每根 bar shift 导致 O(n) 热路径。
    if (this.#liquidationHead > 64 && this.#liquidationHead * 2 >= this.#liquidations.length) {
      this.#liquidations = this.#liquidations.slice(this.#liquidationHead)
      this.#liquidationHead = 0
    }
    return this.#liquidationTotal
  }
}

/**
 * 全量参考：每个点重新扫描清算窗口，刻意不复用 tracker 的队列实现，
 * 这样对拍可以发现窗口淘汰或上一观测状态的偏差，而不是两边共享同一个 bug。
 */
export function derivativesValues(
  series: readonly DerivativesObservation[],
  windowMs: number,
): readonly DerivativesValues[] {
  assertWindow(windowMs)
  const buckets: LiquidationBucket[] = []
  let previousOpenInterest: number | null = null
  let previousTimestamp: number | undefined
  const out: DerivativesValues[] = []

  for (const observation of series) {
    assertTimestamp(observation.timestamp)
    if (previousTimestamp !== undefined && observation.timestamp < previousTimestamp) {
      throw new Error('衍生品观测时间戳必须单调不减')
    }
    previousTimestamp = observation.timestamp

    const currentOpenInterest = normalizeOpenInterest(observation.openInterest)
    const oiChangePct =
      currentOpenInterest !== null && previousOpenInterest !== null && previousOpenInterest > 0
        ? ((currentOpenInterest - previousOpenInterest) / previousOpenInterest) * 100
        : null
    if (currentOpenInterest !== null) previousOpenInterest = currentOpenInterest

    let liqNotional: number | null = null
    if (observation.liquidations !== undefined) {
      buckets.push({
        timestamp: observation.timestamp,
        notional: normalizeLiquidations(observation.liquidations).notional,
      })
      const cutoff = observation.timestamp - windowMs
      liqNotional = buckets
        .filter((bucket) => bucket.timestamp >= cutoff)
        .reduce((sum, bucket) => sum + bucket.notional, 0)
    }

    const fundingRate = normalizeFundingRate(observation.fundingRate)
    const spot = finiteNumber(observation.spotPrice)
    const swap = finiteNumber(observation.swapPrice)
    out.push({
      fundingRate,
      oiChangePct,
      liqNotional,
      basisBps: spot !== null && swap !== null ? basisBps(spot, swap) : null,
    })
  }
  return out
}

function pickField(raw: unknown, keys: readonly string[]): unknown {
  const direct = finiteNumber(raw)
  if (direct !== null) return direct
  const record = asRecord(raw)
  if (record === null) return undefined
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  const info = record.info
  const infoRecord = asRecord(info)
  if (infoRecord !== null) {
    for (const key of keys) {
      if (infoRecord[key] !== undefined) return infoRecord[key]
    }
  }
  return undefined
}

function optionalCall<T>(call: (() => Promise<T>) | undefined): Promise<T | undefined> {
  if (call === undefined) return Promise.resolve(undefined)
  // 衍生品是可选特征；单个端点不可用时保留其它字段，不能用估算值填洞。
  return call().catch(() => undefined)
}

export interface CcxtDerivativesSource {
  readonly id: string
  fetch(symbol: string, timestamp: number, spotSymbol?: string): Promise<DerivativesObservation>
  fetchSnapshot(symbol: string, timestamp: number, spotSymbol?: string): Promise<DerivativesObservation>
}

/**
 * CCXT 可选能力到统一 observation 的映射。spotSymbol 必须显式传入，避免把永续 ticker
 * 误当现货；这里不联网、不读时钟，调用方负责提供观测时间戳。
 */
export function createCcxtDerivativesSource(exchange: CcxtExchangeLike): CcxtDerivativesSource {
  const fetch = async (
    symbol: string,
    timestamp: number,
    spotSymbol?: string,
  ): Promise<DerivativesObservation> => {
    const [fundingRaw, openInterestRaw, liquidationsRaw, swapTickerRaw, spotTickerRaw] = await Promise.all([
      optionalCall(exchange.fetchFundingRate === undefined ? undefined : () => exchange.fetchFundingRate!(symbol)),
      optionalCall(exchange.fetchOpenInterest === undefined ? undefined : () => exchange.fetchOpenInterest!(symbol)),
      optionalCall(
        exchange.fetchLiquidations === undefined ? undefined : () => exchange.fetchLiquidations!(symbol),
      ),
      optionalCall(exchange.fetchTicker === undefined ? undefined : () => exchange.fetchTicker!(symbol)),
      optionalCall(
        spotSymbol === undefined || exchange.fetchTicker === undefined
          ? undefined
          : () => exchange.fetchTicker!(spotSymbol),
      ),
    ])

    const liquidationRows = Array.isArray(liquidationsRaw) ? liquidationsRaw : undefined
    const swapPrice = pickField(swapTickerRaw, ['last', 'close'])
    const spotPrice = pickField(spotTickerRaw, ['last', 'close'])
    return {
      timestamp,
      // HTX 实测字段是 snake_case；同时接受 ccxt 规范字段，避免换版本后静默丢值。
      fundingRate: normalizeFundingRate(pickField(fundingRaw, ['funding_rate', 'fundingRate'])),
      openInterest: normalizeOpenInterest(
        pickField(openInterestRaw, ['openInterestValue', 'openInterest', 'open_interest']),
      ),
      liquidations: liquidationRows,
      spotPrice: finiteNumber(spotPrice),
      swapPrice: finiteNumber(swapPrice),
    }
  }

  return {
    id: exchange.id,
    fetch,
    fetchSnapshot: fetch,
  }
}
