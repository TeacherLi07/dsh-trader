import type { Candle } from '../market/types.js'
import type { FeatureSnapshot } from '../market/features.js'
import { timeframeMs } from '../market/normalize.js'
import { MarketObservationStore, type MarketObservation } from '../market/observations.js'
import { basisBps, normalizeLiquidations, type DerivativesObservation } from '../market/derivatives.js'
import type { DecisionContextConfig } from './context-config.js'

export const CONTEXT_TIMEFRAMES = ['15m', '1h', '4h'] as const
export type FactStatus = 'ok' | 'missing' | 'stale' | 'warming' | 'invalid'
export interface NumericFact {
  readonly value: number | null
  readonly unit: string
  readonly window: string
  readonly asOf: number | null
  readonly availableAt: number | null
  readonly status: FactStatus
  readonly samples: number
}

export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function fact(value: unknown, unit: string, window: string, observation?: Pick<MarketObservation, 'eventTime' | 'availableAt'>,
  status: FactStatus = 'ok', samples = observation === undefined ? 0 : 1): NumericFact {
  const number = finite(value)
  return { value: number, unit, window, asOf: observation?.eventTime ?? null,
    availableAt: observation?.availableAt ?? null, status: number === null && status === 'ok' ? 'missing' : status, samples }
}

const FEATURE_UNITS: Readonly<Record<string, string>> = {
  open: 'quote/base', high: 'quote/base', low: 'quote/base', close: 'quote/base', volume: 'venue-volume',
  ema20: 'quote/base', ema50: 'quote/base', rsi14: 'index-0-100', atr14: 'quote/base', adx14: 'index-0-100',
  vwap20: 'quote/base', zscore20: 'standard-deviations', volRealized20: 'log-return',
}

export function marketSlice(store: MarketObservationStore, symbol: string, timeframe: string, asOf: number, config: DecisionContextConfig) {
  const bars = store.recent<Candle>('bar', symbol, timeframe, asOf, config.barsPerTimeframe)
  const snapshots = store.recent<FeatureSnapshot>('feature', symbol, timeframe, asOf, config.barsPerTimeframe)
  const latest = bars.at(-1)
  const snapshot = snapshots.at(-1)
  const step = timeframeMs(timeframe)
  const stale = latest !== undefined && asOf - latest.eventTime > step + config.marketGraceMs
  const gaps = bars.slice(1).filter((bar, index) => bar.eventTime - bars[index]!.eventTime !== step).map(bar => bar.eventTime)
  const count = config.statisticsWindow
  const window = bars.slice(-count)
  const warm = window.length === count && gaps.length === 0
  const closes = window.map(bar => bar.value.close)
  const mean = closes.reduce((sum, value) => sum + value, 0) / closes.length
  const xMean = (closes.length - 1) / 2
  const denominator = closes.reduce((sum, _, index) => sum + (index - xMean) ** 2, 0)
  const slope = warm && denominator > 0 ? closes.reduce((sum, value, index) => sum + (index - xMean) * (value - mean), 0) / denominator : null
  const low = Math.min(...window.map(bar => bar.value.low))
  const high = Math.max(...window.map(bar => bar.value.high))
  const close = latest?.value.close
  const metricStatus: FactStatus = stale ? 'stale' : !warm ? 'warming' : 'ok'
  const features: Record<string, NumericFact> = {}
  for (const [key, unit] of Object.entries(FEATURE_UNITS)) {
    const value = snapshot?.value.values[key as keyof FeatureSnapshot['values']]
    const status: FactStatus = snapshot === undefined ? 'missing' : snapshot.eventTime !== latest?.eventTime || stale ? 'stale' : value === null ? 'warming' : 'ok'
    features[key] = fact(value, unit, `${timeframe}:${key.match(/\d+$/)?.[0] ?? 1} bars; EMA/Wilder retain prior state`, snapshot, status)
  }
  const summary = {
    slope: fact(slope, 'quote/base/bar', `OLS close; ${count} ${timeframe} bars`, latest, metricStatus, window.length),
    rangePosition: fact(warm && close !== undefined && high > low ? (close - low) / (high - low) : null,
      'fraction', `close within high-low; ${count} ${timeframe} bars`, latest, metricStatus, window.length),
    closePercentile: fact(warm && close !== undefined ? closes.filter(value => value <= close).length / count : null,
      'fraction', `empirical <= close; ${count} ${timeframe} bars`, latest, metricStatus, window.length),
    returnPct: fact(warm && closes[0]! > 0 && close !== undefined ? (close / closes[0]! - 1) * 100 : null,
      'percent', `first-to-last close; ${count} ${timeframe} bars`, latest, metricStatus, window.length),
  }
  const missing = [...Object.entries(features), ...Object.entries(summary)]
    .filter(([, item]) => item.status !== 'ok').map(([key, item]) => `${timeframe}.${key}:${item.status}`)
  if (bars.length === 0) missing.push(`${timeframe}.bars:missing`)
  if (gaps.length > 0) missing.push(`${timeframe}.bars:gap`)
  return {
    symbol, timeframe, status: latest === undefined ? 'missing' : stale ? 'stale' : warm ? 'ok' : 'warming',
    asOf: latest?.eventTime ?? null, availableAt: latest?.availableAt ?? null,
    units: { openTime: 'unix-ms', closeTime: 'unix-ms', open: 'quote/base', high: 'quote/base', low: 'quote/base', close: 'quote/base', volume: 'venue-volume' },
    window: `last ${config.barsPerTimeframe} closed ${timeframe} bars; newest revision available at context.asOf`,
    bars: bars.map(bar => ({ ...bar.value, availableAt: bar.availableAt, source: bar.source, fingerprint: bar.fingerprint })),
    gaps, features, summary, missing,
  }
}

export function benchmarkSlice(store: MarketObservationStore, symbol: string, benchmark: string, asOf: number, config: DecisionContextConfig) {
  const series = marketSlice(store, benchmark, '1h', asOf, config)
  const asset = store.recent<Candle>('bar', symbol, '1h', asOf, config.barsPerTimeframe)
  const index = new Map(series.bars.map(bar => [bar.closeTime, bar]))
  const pairs = asset.flatMap(bar => { const other = index.get(bar.eventTime); return other === undefined ? [] : [{ time: bar.eventTime, x: bar.value.close, y: other.close }] }).slice(-(config.statisticsWindow + 1))
  const returns = pairs.slice(1).flatMap((pair, i) => {
    const previous = pairs[i]!
    return pair.time - previous.time === 3_600_000 && previous.x > 0 && previous.y > 0
      ? [{ x: pair.x / previous.x - 1, y: pair.y / previous.y - 1 }] : []
  })
  const n = returns.length
  const xMean = returns.reduce((sum, value) => sum + value.x, 0) / n
  const yMean = returns.reduce((sum, value) => sum + value.y, 0) / n
  const covariance = returns.reduce((sum, value) => sum + (value.x - xMean) * (value.y - yMean), 0)
  const variance = Math.sqrt(returns.reduce((sum, value) => sum + (value.x - xMean) ** 2, 0) * returns.reduce((sum, value) => sum + (value.y - yMean) ** 2, 0))
  const valid = n === config.statisticsWindow
  const first = pairs[0], last = pairs.at(-1)
  const current = asset.at(-1)
  const stale = series.status === 'stale' || current === undefined || asOf - current.eventTime > 3_600_000 + config.marketGraceMs || current.eventTime !== last?.time || series.asOf !== last?.time
  const status = stale ? 'stale' : valid ? 'ok' : 'warming'
  const obs = current === undefined ? undefined : { eventTime: last?.time ?? current.eventTime, availableAt: Math.max(current.availableAt, series.availableAt ?? 0) }
  return { series,
    correlation: fact(valid && variance > 0 ? Math.max(-1, Math.min(1, covariance / variance)) : null, 'correlation', `${config.statisticsWindow} aligned hourly simple returns`, obs, status, n),
    relativeStrength: fact(valid && first !== undefined && last !== undefined ? ((last.x / first.x - 1) - (last.y / first.y - 1)) * 100 : null,
      'percentage-points', `${config.statisticsWindow} aligned hourly returns; asset minus benchmark`, obs, status, n),
  }
}

export function derivativesSlice(store: MarketObservationStore, symbol: string, asOf: number, config: DecisionContextConfig) {
  const observations = store.recent<DerivativesObservation>('derivatives', symbol, '', asOf, 512)
  const latest = observations.at(-1)
  const status = latest === undefined ? 'missing' : asOf - latest.eventTime > config.derivativesMaxAgeMs ? 'stale' : 'ok'
  const values = (item: MarketObservation<DerivativesObservation> | undefined) => ({
    fundingRate: finite(item?.value.fundingRate), openInterest: finite(item?.value.openInterest),
    basisBps: item === undefined ? null : basisBps(finite(item.value.spotPrice) ?? NaN, finite(item.value.swapPrice) ?? NaN),
    liquidationNotional: item?.value.liquidations === undefined ? null : normalizeLiquidations(item.value.liquidations).notional,
  })
  const currentValues = values(latest)
  const units = { fundingRate: 'fraction', openInterest: latest?.value.openInterestUnit ?? 'unknown', basisBps: 'bps', liquidationNotional: 'quote' }
  const current = Object.fromEntries(Object.entries(currentValues).map(([key, value]) => [key,
    fact(key === 'openInterest' && units.openInterest === 'unknown' ? null : value, units[key as keyof typeof units], key === 'liquidationNotional' ? 'latest source response; not a complete period sum' : 'latest source observation', latest, status)]))
  const changes = Object.fromEntries([1, 4, 24].map(hours => {
    const target = (latest?.eventTime ?? asOf) - hours * 3_600_000
    const past = observations.findLast(item => item.eventTime <= target)
    const pastValues = values(past)
    const valid = past !== undefined && target - past.eventTime <= config.derivativesMaxAgeMs
    return [`${hours}h`, Object.fromEntries(Object.entries(currentValues).map(([key, value]) => {
      const previous = pastValues[key as keyof typeof pastValues]
      const sameUnit = key !== 'openInterest' || (units.openInterest !== 'unknown' && units.openInterest === past?.value.openInterestUnit)
      return [key, fact(valid && sameUnit && value !== null && previous !== null ? value - previous : null,
        units[key as keyof typeof units], `current minus observation at/before t-${hours}h; max lag ${config.derivativesMaxAgeMs}ms`, latest,
        status === 'stale' ? 'stale' : valid ? 'ok' : 'warming', valid ? 2 : observations.length)]
    }))]
  }))
  return { asOf: latest?.eventTime ?? null, availableAt: latest?.availableAt ?? null, current, changes,
    fundingIntervalMs: fact(latest?.value.fundingIntervalMs, 'ms', 'source declared interval', latest, status),
    nextFundingTime: fact(latest?.value.nextFundingTime, 'unix-ms', 'schedule known at source observation', latest, status),
    sourceErrors: latest?.value.errors ?? {},
  }
}
