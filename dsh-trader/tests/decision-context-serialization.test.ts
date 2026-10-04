import { describe, expect, it } from 'vitest'
import { assertDecisionContext, canonicalDecisionContext, freezeDecisionContext, serializeDecisionContextForPrompt, type DecisionContext } from '../src/agents/decision-context.js'

function snapshot(asOf: number, close: number, mode = 'paper') {
  return freezeDecisionContext({ symbol: 'ADA/USDT:USDT', primaryTimeframe: '1h', asOf, sections: {
    mandate: { asOf, source: 'config+facts', missing: [], value: {
      allowedPlanActions: ['noop', 'open'], contextConfig: { maxChars: 50_000, contextBars: 64 },
      runtime: { mode, symbols: ['ADA/USDT:USDT', 'DOGE/USDT:USDT'], riskPct: .001, limits: { maxExposureUsd: 2 } },
      runtimeFingerprint: 'stable-config', remainingLimits: { exposureUsd: close },
      costAssumptions: { slippageBps: null, fee: 0 }, newPolicyField: { values: [false, null, 0, '未决失败原文'] },
    } },
    market: { asOf, source: 'fixture', missing: [], value: { close, bars: [{ close: close - 1 }, { close }] } },
    derivatives: { asOf, source: 'fixture', missing: ['funding'], value: { funding: null } },
    benchmark: { asOf, source: 'fixture', missing: [], value: { close: 90 } },
    portfolio: { asOf, source: 'fixture', missing: [], value: { positions: [{ qty: 1, stop: 95 }], equityQuote: close } },
    activePlan: { asOf, source: 'fixture', missing: [], value: { thesis: '完整论点', commitments: [{ when: 'bar.close > 1' }] } },
    history: { asOf, source: 'fixture', missing: [], value: { failures: ['OUTCOME_UNKNOWN'] } },
    lessons: { asOf: null, source: 'disabled', missing: [], value: null },
    predictions: { asOf: null, source: 'disabled', missing: [], value: null },
  } })
}
function prefix(a: string, b: string) { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return a.slice(0, i) }

describe('DecisionContext prompt 的稳定前缀和完整性', () => {
  it('只改键顺序，所有事实、未知字段、缺失/失败/身份和审计 hash 均原样保留', () => {
    const context = snapshot(1_700_000_000_000, 100), before = canonicalDecisionContext(context)
    const text = serializeDecisionContextForPrompt(context), decoded = JSON.parse(text) as DecisionContext
    expect(decoded).toEqual(context)
    expect(() => assertDecisionContext(decoded)).not.toThrow()
    expect(canonicalDecisionContext(decoded)).toBe(before)
    expect(canonicalDecisionContext(context)).toBe(before)
    expect(text).toContain('OUTCOME_UNKNOWN')
    expect(text).toContain('未决失败原文')
    expect(text.length).toBe(before.length)
  })
  it('先放静态配置，变化的时点和账户/行情不会阻断此前政策前缀，也不会被旧值替代', () => {
    const first = snapshot(1_700_000_000_000, 100), second = snapshot(1_700_000_060_000, 105)
    const a = serializeDecisionContextForPrompt(first), b = serializeDecisionContextForPrompt(second)
    const shared = prefix(a, b), oldShared = prefix(canonicalDecisionContext(first), canonicalDecisionContext(second))
    expect(oldShared.length).toBeGreaterThan(0)
    expect(shared.length).toBeGreaterThan(oldShared.length)
    expect(shared).toContain('"contextBars":64')
    expect(shared).toContain('"riskPct":0.001')
    expect(shared).not.toContain('"remainingLimits":{"exposureUsd":100}')
    const current = JSON.parse(b) as DecisionContext
    expect(current.asOf).toBe(second.asOf)
    expect(current.contextHash).not.toBe(first.contextHash)
    expect(current.sections.market.value).toEqual({ close: 105, bars: [{ close: 104 }, { close: 105 }] })
    expect(current.sections.portfolio.value).toMatchObject({ equityQuote: 105, positions: [{ qty: 1, stop: 95 }] })
  })
  it('热改 mode/limits 不会复用旧配置内容；同一快照的文本确定性一致', () => {
    const first = snapshot(1000, 100), changed = snapshot(1000, 100, 'live_auto')
    expect(serializeDecisionContextForPrompt(first)).toBe(serializeDecisionContextForPrompt(first))
    expect(serializeDecisionContextForPrompt(changed)).not.toBe(serializeDecisionContextForPrompt(first))
    expect(serializeDecisionContextForPrompt(changed)).toContain('live_auto')
    expect(changed.contextHash).not.toBe(first.contextHash)
  })
})
