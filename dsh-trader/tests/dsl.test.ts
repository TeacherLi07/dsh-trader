import { describe, expect, it } from 'vitest'
import { MAX_AST_NODES, defaultFunctions, parseExpression, referencedPaths } from '../src/plan/dsl.js'
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

  it('rejects expressions over the bounded AST size', () => {
    const expression = Array.from({ length: Math.ceil(MAX_AST_NODES / 2) + 1 }, () => '1').join(' + ') + ' > 0'
    expect(() => parseExpression(expression)).toThrow(/复杂度超过上限/)
  })

  it('reports referenced paths for vocabulary admission', () => {
    expect(referencedPaths('bar.close < 1 and position.qty > 0')).toEqual(['bar.close', 'position.qty'])
    expect(unknownPaths(['bar.close < 1 and news.headline == 2'], V0_ALLOWED_PATHS)).toEqual(['news.headline'])
    // 已实现的指标和衍生品路径都在词汇表内；真正未知路径仍必须 fail-closed。
    expect(unknownPaths(['bar.close < ema20 and rsi14 > 70'], V0_ALLOWED_PATHS)).toEqual([])
    expect(
      unknownPaths(
        ['bar.close < adx14 and funding.rate >= 0 and oi.changePct != 0 and liq.notional > 0 and basis.bps < 10'],
        V0_ALLOWED_PATHS,
      ),
    ).toEqual([])
    expect(unknownPaths(['bar.close < foo.bar'], V0_ALLOWED_PATHS)).toEqual(['foo.bar'])
    // PM alias 是动态数据，不属于机械 DSL 固定执行词汇表。
    expect(unknownPaths(['pm.future_event.prob > 0.5'], V0_ALLOWED_PATHS)).toEqual(['pm.future_event.prob'])
  })

  it('leaves crossAbove/crossBelow out of the pure-math table (they need the previous bar)', () => {
    expect(defaultFunctions('crossAbove', [1, 2])).toBeUndefined()
    expect(defaultFunctions('crossBelow', [1, 2])).toBeUndefined()
  })

  it('crossAbove/crossBelow 用前一根 bar 判定穿越；缺前值即 fail-closed（plan §12.2 I）', () => {
    // 105 → 95，向下穿越 100 ⇒ true
    expect(
      evaluateWhen('crossBelow(bar.close, 100)', createDslContext({ 'bar.close': 95 }, undefined, { 'bar.close': 105 })),
    ).toEqual({ ok: true, value: true })
    // 96 → 95：仍在下方便不是边沿 ⇒ false（真的是"没穿越"，不是"缺数据"）
    expect(
      evaluateWhen('crossBelow(bar.close, 100)', createDslContext({ 'bar.close': 95 }, undefined, { 'bar.close': 96 })),
    ).toEqual({ ok: true, value: false })
    // 95 → 95：相等不算穿越
    expect(
      evaluateWhen('crossBelow(bar.close, 100)', createDslContext({ 'bar.close': 95 }, undefined, { 'bar.close': 95 })),
    ).toEqual({ ok: true, value: false })
    // crossAbove 对称
    expect(
      evaluateWhen('crossAbove(bar.close, 100)', createDslContext({ 'bar.close': 105 }, undefined, { 'bar.close': 95 })),
    ).toEqual({ ok: true, value: true })
    // 缺 previous ⇒ ok:false（UNCOVERED），绝不静默当成"没穿越"
    expect(evaluateWhen('crossBelow(bar.close, 100)', createDslContext({ 'bar.close': 95 }))).toMatchObject({
      ok: false,
    })
    // 参数个数不对也要 fail-closed
    expect(
      evaluateWhen('crossBelow(bar.close)', createDslContext({ 'bar.close': 95 }, undefined, { 'bar.close': 105 })),
    ).toMatchObject({ ok: false })
  })
})

describe('and/or 不短路（审计修复）', () => {
  it('★ 任一侧是未知取值时整式必须 ok:false，且与书写顺序无关', () => {
    // rsi14 缺失 = 暖机期 / 未注册的 pm alias 同构
    const partial = createDslContext({ 'bar.close': 100, ema20: 90 })
    expect(evaluateWhen('bar.close < ema20 and rsi14 < 30', partial).ok).toBe(false)
    expect(evaluateWhen('rsi14 < 30 and bar.close < ema20', partial).ok).toBe(false)
    expect(evaluateWhen('bar.close > ema20 or rsi14 < 30', partial).ok).toBe(false)
    expect(evaluateWhen('rsi14 < 30 or bar.close > ema20', partial).ok).toBe(false)
    // 已知取值时行为不变
    const known = createDslContext({ 'bar.close': 100, ema20: 90, rsi14: 20 })
    expect(evaluateWhen('bar.close < ema20 and rsi14 < 30', known)).toEqual({ ok: true, value: false })
    expect(evaluateWhen('bar.close > ema20 or rsi14 < 30', known)).toEqual({ ok: true, value: true })
  })
})
