import { describe, expect, it } from 'vitest'
import { defaultFunctions, parseExpression, referencedPaths } from '../src/plan/dsl.js'
import { V0_ALLOWED_PATHS, createDslContext, evaluateWhen, unknownPaths } from '../src/plan/evaluate.js'

const ctx = createDslContext({
  'bar.close': 61_000,
  'bar.high': 61_500,
  'bar.low': 60_500,
  'position.qty': 0.5,
  'equity.quote': 10_000,
  'funding.rate': 0.0003,
})

describe('when DSL v0', () => {
  it('evaluates comparisons and boolean logic', () => {
    expect(evaluateWhen('bar.close < 61200 and position.qty > 0', ctx)).toEqual({ ok: true, value: true })
    expect(evaluateWhen('bar.close < 60000 or position.qty > 0', ctx)).toEqual({ ok: true, value: true })
    expect(evaluateWhen('not (bar.close < 61200)', ctx)).toEqual({ ok: true, value: false })
  })

  it('respects arithmetic precedence', () => {
    // 61000 - 1000*2 = 59000 ；(61000 - 1000)*2 = 120000
    expect(evaluateWhen('bar.close - 1000 * 2 == 59000', ctx)).toEqual({ ok: true, value: true })
    expect(evaluateWhen('(bar.close - 1000) * 2 == 120000', ctx)).toEqual({ ok: true, value: true })
  })

  it('supports pure math functions', () => {
    expect(evaluateWhen('abs(bar.close - 61000) < 1', ctx)).toEqual({ ok: true, value: true })
    expect(evaluateWhen('between(bar.close, 60000, 62000)', ctx)).toEqual({ ok: true, value: true })
    expect(evaluateWhen('pct(bar.close, 61000) == 100', ctx)).toEqual({ ok: true, value: true })
    expect(
      evaluateWhen('min(bar.low, bar.high) == 60500 and max(bar.low, bar.high) == 61500', ctx),
    ).toEqual({ ok: true, value: true })
  })

  it('fails closed: unknown values / syntax errors / non-boolean results are ok:false, never silently false', () => {
    expect(evaluateWhen('does.not.exist > 1', ctx)).toMatchObject({ ok: false })
    expect(evaluateWhen('bar.close <', ctx)).toMatchObject({ ok: false })
    expect(evaluateWhen('bar.close', ctx)).toMatchObject({ ok: false })
    expect(evaluateWhen('bar.close / 0 == 1', ctx)).toMatchObject({ ok: false })
  })

  it('rejects malformed input at parse time', () => {
    expect(() => parseExpression('(bar.close > 1')).toThrow()
    expect(() => parseExpression('bar.close $ 1')).toThrow()
    expect(() => parseExpression('')).toThrow()
  })

  it('reports referenced paths for vocabulary admission', () => {
    expect(referencedPaths('bar.close < 1 and position.qty > 0')).toEqual(['bar.close', 'position.qty'])
    expect(unknownPaths(['bar.close < 1 and news.headline == 2'], V0_ALLOWED_PATHS)).toEqual(['news.headline'])
    expect(unknownPaths(['bar.close < funding.rate'], V0_ALLOWED_PATHS)).toEqual([])
  })

  it('leaves crossAbove/crossBelow to the feature layer (they need the previous bar)', () => {
    expect(defaultFunctions('crossAbove', [1, 2])).toBeUndefined()
    expect(defaultFunctions('crossBelow', [1, 2])).toBeUndefined()
  })
})
