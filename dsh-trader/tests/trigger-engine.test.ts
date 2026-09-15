import { describe, expect, it } from 'vitest'
import { createDslContext } from '../src/plan/evaluate.js'
import { UNIMPLEMENTED_PATHS, V0_ALLOWED_PATHS, unknownPaths } from '../src/plan/evaluate.js'
import {
  RULE_PACKS,
  buildRules,
  evaluateRules,
  ruleDedupKey,
  severityFor,
  validateRuleSpec,
  type RuleSpec,
} from '../src/trigger/engine.js'

const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'
const TF = '1h'

const context = (values: Record<string, number | boolean> = {}) => createDslContext(values)

const rule = (over: Partial<RuleSpec> = {}): RuleSpec => ({
  id: 'r1',
  purpose: 'info',
  when: 'rsi14 > 70',
  cooldownMs: 0,
  ...over,
})

describe('severityFor', () => {
  it('maps purpose to severity: risk first, info last', () => {
    expect(severityFor('invalidation')).toBe('P0')
    expect(severityFor('commitment')).toBe('P1')
    expect(severityFor('novelty')).toBe('P1')
    expect(severityFor('info')).toBe('P2')
  })
})

describe('validateRuleSpec', () => {
  it('accepts a well-formed rule', () => {
    expect(validateRuleSpec(rule())).toEqual([])
  })

  it('rejects a rule that cannot answer "what happens on a hit"', () => {
    expect(validateRuleSpec(rule({ purpose: 'teleport' as never }))).toHaveLength(1)
    expect(validateRuleSpec(rule({ id: '' }))).toContain('id 不能为空')
    expect(validateRuleSpec(rule({ when: '' }))).toContain('when 不能为空')
    expect(validateRuleSpec(rule({ cooldownMs: -1 }))).toHaveLength(1)
  })
})

describe('evaluateRules', () => {
  it('returns hits with severity and a deterministic dedup key', () => {
    const result = evaluateRules({
      rules: [rule(), rule({ id: 'r2', purpose: 'novelty', when: 'abs(zscore20) > 2' })],
      symbol: SYMBOL,
      timeframe: TF,
      barTs: NOW,
      context: context({ rsi14: 75, zscore20: 2.5 }),
    })

    expect(result.hits.map((hit) => hit.ruleId)).toEqual(['r1', 'r2'])
    expect(result.hits[0]?.severity).toBe('P2')
    expect(result.hits[1]?.severity).toBe('P1')
    expect(result.hits[0]?.dedupKey).toBe(ruleDedupKey('r1', SYMBOL, NOW))
    expect(result.failures).toEqual([])
  })

  it('skips rules bound to another symbol or timeframe', () => {
    const result = evaluateRules({
      rules: [rule({ tf: '15m' }), rule({ id: 'r2', symbol: 'ETH/USDT' }), rule({ id: 'r3' })],
      symbol: SYMBOL,
      timeframe: TF,
      barTs: NOW,
      context: context({ rsi14: 75 }),
    })
    expect(result.hits.map((hit) => hit.ruleId)).toEqual(['r3'])
  })

  it('separates unevaluable rules as failures — never "no match"', () => {
    const result = evaluateRules({
      rules: [rule({ id: 'warmup', when: 'rsi14 > 70' }), rule({ id: 'bad', when: 'adx14 > 25' })],
      symbol: SYMBOL,
      timeframe: TF,
      barTs: NOW,
      context: context({}), // rsi14 与 adx14 都缺（暖机/未实现）
    })
    expect(result.hits).toEqual([])
    expect(result.failures.map((failure) => failure.ruleId)).toEqual(['warmup', 'bad'])
    expect(result.failures[0]?.reason).toContain('未知取值')
  })

  it('is pure: identical input gives identical output', () => {
    const input = {
      rules: [rule()],
      symbol: SYMBOL,
      timeframe: TF,
      barTs: NOW,
      context: context({ rsi14: 75 }),
    }
    expect(evaluateRules(input)).toEqual(evaluateRules(input))
  })
})

describe('buildRules', () => {
  it('builds known packs and reports unknown names instead of skipping silently', () => {
    const built = buildRules(['mean_reversion_v1', 'nope'], { cooldownMs: 1_000 })
    expect(built.unknownPacks).toEqual(['nope'])
    expect(built.rules).toHaveLength(RULE_PACKS['mean_reversion_v1']!({ cooldownMs: 1_000 }).length)
  })

  it('every built-in rule uses only implemented vocabulary (no guaranteed-UNCOVERED rules)', () => {
    for (const pack of Object.values(RULE_PACKS)) {
      const rules = pack({ cooldownMs: 0 })
      for (const spec of rules) {
        expect(validateRuleSpec(spec)).toEqual([])
        expect(unknownPaths([spec.when], V0_ALLOWED_PATHS)).toEqual([])
      }
    }
  })

  it('keeps the unimplemented paths explicit and admits all T2.4 indicators', () => {
    expect(UNIMPLEMENTED_PATHS).toEqual([])
    const completed = ['adx14', 'funding.rate', 'oi.changePct', 'liq.notional', 'basis.bps']
    expect(completed.length).toBeGreaterThan(0)
    for (const path of completed) expect(V0_ALLOWED_PATHS).toContain(path)
  })
})
