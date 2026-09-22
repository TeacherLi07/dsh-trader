import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DECISION_CONTEXT_CONFIG } from '../src/agents/context-config.js'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import { evaluateDecisionEligibility, parseDecisionEnvelopeCandidate } from '../src/agents/decision-envelope.js'
import { migrate } from '../src/db/schema.js'
import { marketSlice } from '../src/agents/context-market.js'
import { MarketObservationStore } from '../src/market/observations.js'
import type { Candle } from '../src/market/types.js'
import type { FeatureSnapshot } from '../src/market/features.js'

const AS_OF = 1_700_000_000_000
const SYMBOL = 'BTC/USDT:USDT'
const HOUR = 3_600_000

const openAction = {
  action: 'open', side: 'long', method: 'market',
  stop: { method: 'structure', level: 95 },
} as const

function fact(value: number | null, status = 'ok', eventTime = AS_OF, availableAt = eventTime) {
  return { value, unit: 'test', window: 'latest', asOf: eventTime, availableAt, status, samples: 1 }
}

function context(over: {
  readonly rsi?: number | null
  readonly rsiStatus?: string
  readonly hiddenPositionCount?: number
  readonly hiddenOpenOrderCount?: number
  readonly positions?: readonly Record<string, unknown>[]
  readonly openOrders?: readonly Record<string, unknown>[]
  readonly featureOverrides?: Readonly<Record<string, unknown>>
  readonly marketSlice?: unknown
} = {}) {
  const bars = [1, 0].map((offset) => ({
    openTime: AS_OF - (offset + 1) * HOUR,
    closeTime: AS_OF - offset * HOUR,
    availableAt: AS_OF - offset * HOUR,
    open: 100, high: 101, low: 99, close: 100, volume: 10,
  }))
  return freezeDecisionContext({
    symbol: SYMBOL,
    primaryTimeframe: '1h',
    asOf: AS_OF,
    sections: {
      mandate: { asOf: AS_OF, source: 'test', missing: [], value: {
        runtime: { mode: 'paper', riskPct: 0.002, timeframes: ['15m', '1h', '4h'], limits: { perOrderCapUsd: 100, maxExposureUsd: 200 } },
        contextConfig: { accountMaxAgeMs: 10_000, specMaxAgeMs: 10_000, marketGraceMs: 120_000 },
        contractSpecification: {
          observation: { eventTime: AS_OF - 1 },
          value: { linear: true, contractSize: 1, amountStepContracts: 0.001, priceStep: 0.01, minAmountContracts: 0.001, minNotionalQuote: 1 },
        },
      } },
      market: { asOf: AS_OF - 1, source: 'test', missing: [], value: {
        primaryTimeframe: '1h',
        timeframes: { '1h': over.marketSlice ?? { status: 'ok', bars, features: {
          close: fact(100), atr14: fact(2), rsi14: fact(over.rsi === undefined ? 20 : over.rsi, over.rsiStatus ?? 'ok'),
          ...over.featureOverrides,
        } } },
      } },
      derivatives: { asOf: AS_OF, source: 'test', missing: [], value: {} },
      benchmark: { asOf: AS_OF, source: 'test', missing: [], value: {} },
      portfolio: { asOf: AS_OF, source: 'test', missing: [], value: {
        account: { equityQuote: 1_000, pendingExposureUsd: 0, observedAt: AS_OF, freeMarginQuote: 900 },
        positions: over.positions ?? [], positionsReadErrorType: null,
        openOrders: over.openOrders ?? [], openOrdersReadErrorType: null,
        hiddenPositionCount: over.hiddenPositionCount ?? 0,
        hiddenOpenOrderCount: over.hiddenOpenOrderCount ?? 0,
        unresolvedIntents: [], unresolvedIntentsTruncated: false, frozenSymbols: [], halted: false,
        reconciliation: { state: 'consistent', freezeTrading: false },
        remainingLimits: { exposureUsd: 100 }, protectionStatus: [],
      } },
      activePlan: { asOf: AS_OF, source: 'test', missing: [], value: { state: 'empty', card: null } },
      history: { asOf: AS_OF, source: 'test', missing: [], value: { decisions: [] } },
      lessons: { asOf: null, source: 'test', missing: [], value: { state: 'disabled', items: [] } },
      predictions: { asOf: null, source: 'test', missing: ['disabled'], value: null },
    },
  })
}

function openPlanCandidate(when = 'rsi14 > 30') {
  return {
    outcome: 'act', thesis: '依赖 RSI 的计划', rejectedAlternatives: [], claims: [], uncertainties: [],
    confidence: 0.6, riskFraction: 0.5,
    plan: {
      thesis: 'RSI 条件满足时开仓', confidence: 0.6, keyLevels: [], forbidden: [], noTrade: false,
      invalidation: [{ id: 'exit', tf: '1h', when: 'bar.close < 90', then: { action: 'close' } }],
      commitments: [{ id: 'entry', seq: 1, tf: '1h', when, then: openAction }],
    },
  }
}

function parsedOpenPlan(overrides: Parameters<typeof context>[0] = {}, when?: string) {
  const frozen = context(overrides)
  const parsed = parseDecisionEnvelopeCandidate(openPlanCandidate(when), frozen)
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error(parsed.errors.join('; '))
  return { frozen, parsed }
}

describe('open-plan eligibility dependencies', () => {
  it('accepts an available RSI dependency even when the current condition is false', () => {
    const { frozen, parsed } = parsedOpenPlan({ rsi: 20 })
    expect(evaluateDecisionEligibility(frozen, parsed.candidate, parsed.evidenceIssues)).toMatchObject({ state: 'risk_gate_required' })
  })

  it('downgrades missing or stale RSI dependencies to decision_only', () => {
    for (const input of [
      { rsi: null, rsiStatus: 'warming' },
      { rsi: 20, rsiStatus: 'stale' },
    ]) {
      const { frozen, parsed } = parsedOpenPlan(input)
      const eligibility = evaluateDecisionEligibility(frozen, parsed.candidate, parsed.evidenceIssues)
      expect(eligibility.state).toBe('decision_only')
      expect(eligibility.reasons.join(' ')).toContain('rsi14')
    }
  })

  it('crossAbove 使用 eventTime 对齐的当前与前值；缺前值时 fail-closed', () => {
    const currentAndPrevious = parsedOpenPlan({ featureOverrides: {
      ema20: { ...fact(101), previous: fact(99, 'ok', AS_OF - HOUR) },
      ema50: { ...fact(100), previous: fact(100, 'ok', AS_OF - HOUR) },
    } }, 'crossAbove(ema20, ema50)')
    expect(evaluateDecisionEligibility(
      currentAndPrevious.frozen, currentAndPrevious.parsed.candidate, currentAndPrevious.parsed.evidenceIssues,
    )).toMatchObject({ state: 'risk_gate_required' })

    const invalidPreviousFacts = [
      undefined,
      fact(99, 'stale', AS_OF - HOUR),
      fact(99, 'ok', AS_OF - 2 * HOUR),
      fact(99, 'ok', AS_OF - HOUR, AS_OF + 1),
    ]
    expect(invalidPreviousFacts).toHaveLength(4)
    for (const previous of invalidPreviousFacts) {
      const noPrevious = parsedOpenPlan({ featureOverrides: {
        ema20: { ...fact(101), ...(previous === undefined ? {} : { previous }) },
        ema50: { ...fact(100), ...(previous === undefined ? {} : { previous: fact(100, previous.status, previous.asOf!, previous.availableAt!) }) },
      } }, 'crossAbove(ema20, ema50)')
      const eligibility = evaluateDecisionEligibility(noPrevious.frozen, noPrevious.parsed.candidate, noPrevious.parsed.evidenceIssues)
      expect(eligibility.state).toBe('decision_only')
      expect(eligibility.reasons.join(' ')).toContain('前值缺失')
    }
  })

  it('PIT context 暴露 derivatives 特征，future snapshot 与 correction tombstone 不泄漏', () => {
    const db = new Database(':memory:')
    try {
      migrate(db)
      const store = new MarketObservationStore(db)
      const values = (patch: Partial<FeatureSnapshot['values']>): FeatureSnapshot['values'] => ({
        open: 100, high: 102, low: 98, close: 100, volume: 10,
        ema20: 100, ema50: 100, rsi14: 50, atr14: 2, adx14: 20,
        vwap20: 100, zscore20: 0, volRealized20: 0.01,
        fundingRate: 0.001, oiChangePct: 0.2, liqNotional: 1_000, basisBps: 5,
        ...patch,
      })
      const candle = (closeTime: number): Candle => ({
        symbol: SYMBOL, timeframe: '1h', openTime: closeTime - HOUR, closeTime,
        open: 100, high: 102, low: 98, close: 100, volume: 10, closed: true,
      })
      const snapshot = (closeTime: number, patch: Partial<FeatureSnapshot['values']>): FeatureSnapshot => ({
        symbol: SYMBOL, timeframe: '1h', openTime: closeTime - HOUR, closeTime,
        values: values(patch), fingerprint: `fixture-${closeTime}`,
      })
      for (const closeTime of [AS_OF - HOUR, AS_OF, AS_OF + HOUR]) {
        const bar = candle(closeTime)
        store.record({ kind: 'bar', symbol: SYMBOL, timeframe: '1h', eventTime: closeTime,
          availableAt: closeTime, source: 'fixture', value: bar })
        store.record({ kind: 'feature', symbol: SYMBOL, timeframe: '1h', eventTime: closeTime,
          availableAt: closeTime, source: 'feature-fixture', value: snapshot(closeTime, {
            ema20: closeTime === AS_OF - HOUR ? 99 : 101,
            ema50: 100,
            fundingRate: closeTime === AS_OF - HOUR ? 0.001 : 0.002,
            oiChangePct: 0.2, liqNotional: 1_000, basisBps: 5,
          }) })
      }

      const beforeCorrection = marketSlice(store, SYMBOL, '1h', AS_OF, DEFAULT_DECISION_CONTEXT_CONFIG)
      expect(beforeCorrection.bars).toHaveLength(2)
      expect(beforeCorrection.bars.every((bar) => bar.availableAt <= AS_OF && bar.closeTime <= AS_OF)).toBe(true)
      expect(beforeCorrection.features.ema20).toMatchObject({
        value: 101, status: 'ok', asOf: AS_OF, availableAt: AS_OF,
        previous: { value: 99, status: 'ok', asOf: AS_OF - HOUR, availableAt: AS_OF - HOUR },
      })
      expect(beforeCorrection.features.fundingRate).toMatchObject({ value: 0.002, status: 'ok' })
      expect(beforeCorrection.features.oiChangePct).toMatchObject({ value: 0.2, status: 'ok' })
      expect(beforeCorrection.features.liqNotional).toMatchObject({ value: 1_000, status: 'ok' })
      expect(beforeCorrection.features.basisBps).toMatchObject({ value: 5, status: 'ok' })

      const correctionAvailableAt = AS_OF + 500
      const invalidatedValues = Object.fromEntries(Object.keys(values({})).map((key) => [key, null]))
      store.record({
        kind: 'feature', symbol: SYMBOL, timeframe: '1h', eventTime: AS_OF - HOUR,
        availableAt: correctionAvailableAt, source: 'feature-pipeline-invalidation',
        value: {
          ...snapshot(AS_OF - HOUR, invalidatedValues as Partial<FeatureSnapshot['values']>),
          values: invalidatedValues,
          invalidated: true,
          recoveryRequired: true,
        },
      })
      const afterCorrection = marketSlice(store, SYMBOL, '1h', correctionAvailableAt, DEFAULT_DECISION_CONTEXT_CONFIG)
      expect(afterCorrection.features.ema20).toMatchObject({
        previous: { value: null, status: 'invalid', asOf: AS_OF - HOUR, availableAt: correctionAvailableAt },
      })

      const derivativePlan = parsedOpenPlan({ marketSlice: beforeCorrection }, 'funding.rate > 0')
      expect(evaluateDecisionEligibility(
        derivativePlan.frozen, derivativePlan.parsed.candidate, derivativePlan.parsed.evidenceIssues,
      )).toMatchObject({ state: 'risk_gate_required' })
    } finally {
      db.close()
    }
  })

  it('blocks hidden and stale portfolio snapshots without requiring portfolio.status=ok', () => {
    const hiddenPosition = parsedOpenPlan({ hiddenPositionCount: 1 })
    const hiddenPositionEligibility = evaluateDecisionEligibility(hiddenPosition.frozen, hiddenPosition.parsed.candidate, hiddenPosition.parsed.evidenceIssues)
    expect(hiddenPositionEligibility.state).toBe('decision_only')
    expect(hiddenPositionEligibility.reasons.join(' ')).toContain('hidden position')

    const hiddenOrder = parsedOpenPlan({ hiddenOpenOrderCount: 1 })
    const hiddenOrderEligibility = evaluateDecisionEligibility(hiddenOrder.frozen, hiddenOrder.parsed.candidate, hiddenOrder.parsed.evidenceIssues)
    expect(hiddenOrderEligibility.state).toBe('decision_only')
    expect(hiddenOrderEligibility.reasons.join(' ')).toContain('hidden open-order')

    const stalePosition = parsedOpenPlan({ positions: [{
      symbol: SYMBOL, observedAt: AS_OF - 10_001, qty: 1, avgPrice: 100, unrealizedPnlUsd: 0,
      protectedStopPrice: 95,
    }] })
    const eligibility = evaluateDecisionEligibility(stalePosition.frozen, stalePosition.parsed.candidate, stalePosition.parsed.evidenceIssues)
    expect(eligibility.state).toBe('decision_only')
    expect(eligibility.reasons.join(' ')).toContain('position[0] snapshot stale')
  })
})
