import { describe, expect, it } from 'vitest'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import {
  bindDecisionEnvelope,
  evaluateDecisionEligibility,
  materializeDecisionPlan,
  parseDecisionEnvelopeCandidate,
} from '../src/agents/decision-envelope.js'

const AS_OF = 1_700_000_000_000
const SYMBOL = 'BTC/USDT:USDT'

function context(over: {
  readonly frozen?: boolean
  readonly priceStatus?: string
  readonly reconciliationState?: string
  readonly predictionAvailable?: boolean
} = {}) {
  return freezeDecisionContext({
    symbol: SYMBOL,
    primaryTimeframe: '1h',
    asOf: AS_OF,
    sections: {
      mandate: { asOf: AS_OF, source: 'test', missing: [], value: {
        runtime: { mode: 'paper', limits: { perOrderCapUsd: 100, maxExposureUsd: 200 } },
        contextConfig: { accountMaxAgeMs: 10_000, specMaxAgeMs: 10_000 },
        contractSpecification: {
          observation: { eventTime: AS_OF - 1 },
          value: { linear: true, contractSize: 1, amountStepContracts: 0.001 },
        },
      } },
      market: { asOf: AS_OF, source: 'test', missing: [], value: {
        primaryTimeframe: '1h',
        timeframes: { '1h': { status: 'ok', features: {
          close: { value: 100, unit: 'USDT/BTC', status: over.priceStatus ?? 'ok' },
          atr14: { value: 2, unit: 'USDT/BTC', status: 'ok' },
        } } },
      } },
      derivatives: { asOf: AS_OF, source: 'test', missing: [], value: {} },
      benchmark: { asOf: AS_OF, source: 'test', missing: [], value: {} },
      portfolio: { asOf: AS_OF, source: 'test', missing: [], value: {
        account: { equityQuote: 1_000, pendingExposureUsd: 0, observedAt: AS_OF, freeMarginQuote: 900 },
        positions: [], positionsReadErrorType: null, openOrders: [], openOrdersReadErrorType: null,
        unresolvedIntents: [], unresolvedIntentsTruncated: false, frozenSymbols: over.frozen ? [SYMBOL] : [],
        halted: false,
        reconciliation: { state: over.reconciliationState ?? 'consistent', freezeTrading: over.reconciliationState === undefined || over.reconciliationState === 'consistent' ? false : true },
        remainingLimits: { exposureUsd: 100 }, protectionStatus: [],
      } },
      activePlan: { asOf: AS_OF, source: 'test', missing: [], value: { state: 'empty', card: null } },
      history: { asOf: AS_OF, source: 'test', missing: [], value: { decisions: [] } },
      lessons: { asOf: AS_OF, source: 'test', missing: [], value: { state: 'disabled', items: [] } },
      predictions: over.predictionAvailable === true
        ? { asOf: AS_OF, source: 'test-pm', missing: [], value: { state: 'available', items: [{ probability: { value: 0.4 } }] } }
        : { asOf: null, source: 'test', missing: ['disabled'], value: null },
    },
  })
}

const openAction = {
  action: 'open', side: 'long', method: 'market',
  stop: { method: 'structure', level: 95 },
} as const

function candidate(over: Record<string, unknown> = {}) {
  return {
    outcome: 'act',
    thesis: '基于可见价格结构尝试开仓',
    rejectedAlternatives: ['等待下一窗口'],
    claims: [{
      kind: 'observation', statement: '1h 收盘价可用',
      evidencePaths: ['/sections/market/value/timeframes/1h/features/close/value'],
    }],
    uncertainties: [],
    confidence: 0.7,
    riskFraction: 0.5,
    immediateAction: openAction,
    ...over,
  }
}

describe('DecisionEnvelope R3 validation', () => {
  it('binds identity in code, validates evidence pointers and grants only a fresh eligible risk gate', () => {
    const frozen = context()
    const parsed = parseDecisionEnvelopeCandidate(candidate(), frozen)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.evidenceIssues).toEqual([])
    const envelope = bindDecisionEnvelope(parsed.candidate, { runId: 'run-r3', context: frozen })
    expect(envelope).toMatchObject({ runId: 'run-r3', contextHash: frozen.contextHash, symbol: SYMBOL })
    expect(evaluateDecisionEligibility(frozen, envelope, parsed.evidenceIssues).state).toBe('risk_gate_required')
  })

  it('bad/absent references and frozen or stale execution state become decision_only', () => {
    const frozen = context({ frozen: true })
    const parsed = parseDecisionEnvelopeCandidate(candidate({
      claims: [{ kind: 'observation', statement: 'fabricated', evidencePaths: ['/sections/market/value/not-a-fact'] }],
    }), frozen)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.evidenceIssues.length).toBeGreaterThan(0)
    expect(evaluateDecisionEligibility(frozen, parsed.candidate, parsed.evidenceIssues)).toMatchObject({ state: 'decision_only' })

    const noPrice = context({ priceStatus: 'stale' })
    const validRef = parseDecisionEnvelopeCandidate(candidate(), noPrice)
    expect(validRef.ok).toBe(true)
    if (validRef.ok) expect(evaluateDecisionEligibility(noPrice, validRef.candidate, validRef.evidenceIssues).state).toBe('decision_only')
  })

  it('PM W3 context cannot authorize opening until an independent market gate is validated', () => {
    const pmContext = context({ predictionAvailable: true })
    const pmOnly = parseDecisionEnvelopeCandidate(candidate({
      claims: [{ kind: 'observation', statement: 'PM event probability is 0.4', evidencePaths: ['/sections/predictions/value/items/0/probability/value'] }],
    }), pmContext)
    expect(pmOnly.ok).toBe(true)
    if (pmOnly.ok) {
      expect(evaluateDecisionEligibility(pmContext, pmOnly.candidate, pmOnly.evidenceIssues)).toMatchObject({ state: 'decision_only' })
      expect(evaluateDecisionEligibility(pmContext, pmOnly.candidate, pmOnly.evidenceIssues).reasons.join(' ')).toContain('尚无经验证的独立场内开仓门槛')
    }
    const independent = parseDecisionEnvelopeCandidate(candidate(), pmContext)
    expect(independent.ok).toBe(true)
    if (independent.ok) expect(evaluateDecisionEligibility(pmContext, independent.candidate, independent.evidenceIssues).state).toBe('decision_only')
    const ordinaryW3 = context()
    const ordinary = parseDecisionEnvelopeCandidate(candidate(), ordinaryW3)
    expect(ordinary.ok).toBe(true)
    if (ordinary.ok) expect(evaluateDecisionEligibility(ordinaryW3, ordinary.candidate, ordinary.evidenceIssues).state).toBe('risk_gate_required')
    if (ordinary.ok) {
      expect(evaluateDecisionEligibility(ordinaryW3, ordinary.candidate, ordinary.evidenceIssues, { predictionEvent: true })).toMatchObject({
        state: 'decision_only',
      })
    }
  })

  it('rejects risk amplification, malformed actions, and no_trade with an open action', () => {
    expect(parseDecisionEnvelopeCandidate(candidate({ riskFraction: 1.01 }), context()).ok).toBe(false)
    expect(parseDecisionEnvelopeCandidate(candidate({
      outcome: 'no_trade', immediateAction: openAction,
    }), context()).ok).toBe(false)
  })

  it('materializes plan identity in code and injects only the bounded riskFraction', () => {
    const parsed = parseDecisionEnvelopeCandidate(candidate({
      immediateAction: undefined,
      plan: {
        thesis: '未来承诺', confidence: 0.7, keyLevels: [], noTrade: false, forbidden: [],
        invalidation: [{ id: 'inv', tf: '1h', when: 'bar.close < 90', then: { action: 'close' } }],
        commitments: [{ id: 'open', seq: 1, tf: '1h', when: 'position.qty == 0', then: openAction }],
      },
    }), context())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const envelope = bindDecisionEnvelope(parsed.candidate, { runId: 'run-plan', context: context() })
    const result = materializeDecisionPlan(envelope, {
      planId: 'pc-r3', createdAt: AS_OF, windowEndsAt: AS_OF + 3_600_000,
    })
    expect(result?.ok).toBe(true)
    if (result?.ok) expect(result.card.commitments[0]?.then).toMatchObject({ action: 'open', riskFraction: 0.5 })
  })
})
