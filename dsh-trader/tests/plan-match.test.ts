import { describe, expect, it } from 'vitest'
import { matchPlan, planDedupKey } from '../src/plan/match.js'
import { createDslContext } from '../src/plan/evaluate.js'
import { makeCard } from './helpers/plan.js'

const NOW = 50_000
const BAR_TS = 1_700_000_000_000

function context(
  values: Record<string, number | boolean> = {},
  previous?: Record<string, number | boolean>,
) {
  return createDslContext(values, undefined, previous)
}

describe('matchPlan', () => {
  it('returns none when nothing matches', () => {
    const outcome = matchPlan({
      plan: makeCard(),
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 100 }),
    })
    expect(outcome).toEqual({ kind: 'none' })
  })

  it('matches a commitment and reports the dedup key', () => {
    const plan = makeCard()
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome).toMatchObject({ kind: 'commitment', id: 'c-1' })
    if (outcome.kind === 'commitment') {
      expect(outcome.dedupKey).toBe(planDedupKey('pc-btc-1', 'c-1', 'BTC/USDT', BAR_TS))
      expect(outcome.action).toEqual({ action: 'reduce', fraction: 0.25 })
      expect(outcome.expression).toBe('bar.close > 110')
    }
  })

  it('gives invalidation priority over a commitment that also matches', () => {
    const plan = makeCard({
      invalidation: [
        { id: 'inv-1', tf: '15m', when: 'bar.close < 130', then: { action: 'close' } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome).toMatchObject({ kind: 'invalidation', id: 'inv-1' })
  })

  it('does not let a later true invalidation hide an earlier unevaluable condition', () => {
    const plan = makeCard({
      invalidation: [
        { id: 'inv-missing', tf: '15m', when: 'adx14 > 25', then: { action: 'reduce', fraction: 0.5 } },
        { id: 'inv-hit', tf: '15m', when: 'bar.close < 130', then: { action: 'reduce', fraction: 0.5 } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })

    expect(outcome).toMatchObject({ kind: 'uncovered', id: 'inv-missing' })
  })

  it('does not let a later true invalidation hide a forbidden action', () => {
    const plan = makeCard({
      forbidden: ['reduce'],
      invalidation: [
        { id: 'inv-forbidden', tf: '15m', when: 'bar.close < 130', then: { action: 'reduce', fraction: 0.5 } },
        { id: 'inv-hit', tf: '15m', when: 'bar.close < 140', then: { action: 'close' } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })

    expect(outcome).toMatchObject({ kind: 'uncovered', id: 'inv-forbidden', reason: 'forbidden_action' })
  })

  it('only evaluates conditions declared for the current timeframe', () => {
    const outcome = matchPlan({
      plan: makeCard(),
      timeframe: '1h',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome).toEqual({ kind: 'none' })
  })

  it('evaluates commitments in seq order', () => {
    const plan = makeCard({
      noTrade: false,
      invalidation: [
        { id: 'inv-1', tf: '15m', when: 'bar.close < 0', then: { action: 'close' } },
      ],
      commitments: [
        { id: 'c-late', seq: 5, tf: '15m', when: 'bar.close > 100', then: { action: 'reduce', fraction: 0.1 } },
        { id: 'c-early', seq: 2, tf: '15m', when: 'bar.close > 100', then: { action: 'reduce', fraction: 0.9 } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome).toMatchObject({ kind: 'commitment', id: 'c-early' })
  })

  it('does not let a later true commitment hide an earlier unevaluable condition', () => {
    const plan = makeCard({
      invalidation: [],
      commitments: [
        { id: 'c-missing', seq: 1, tf: '15m', when: 'adx14 > 25', then: { action: 'reduce', fraction: 0.5 } },
        { id: 'c-hit', seq: 2, tf: '15m', when: 'bar.close > 110', then: { action: 'reduce', fraction: 0.5 } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })

    expect(outcome).toMatchObject({ kind: 'uncovered', id: 'c-missing' })
  })

  it('does not let a later true commitment hide a forbidden action', () => {
    const plan = makeCard({
      invalidation: [],
      forbidden: ['reduce'],
      commitments: [
        { id: 'c-forbidden', seq: 1, tf: '15m', when: 'bar.close > 110', then: { action: 'reduce', fraction: 0.5 } },
        { id: 'c-hit', seq: 2, tf: '15m', when: 'bar.close > 100', then: { action: 'close' } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })

    expect(outcome).toMatchObject({ kind: 'uncovered', id: 'c-forbidden', reason: 'forbidden_action' })
  })

  it('skips conditions that already fired for this bar (per-bar dedup)', () => {
    const plan = makeCard()
    const fired = planDedupKey('pc-btc-1', 'c-1', 'BTC/USDT', BAR_TS)
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
      alreadyFired: (key) => key === fired,
    })
    expect(outcome).toEqual({ kind: 'none' })
  })

  it('电平语义：条件持续为真 ⇒ 每根新 bar 都会再触发（plan §12.1 #23）', () => {
    const plan = makeCard()
    const fireOn = (barTs: number) =>
      matchPlan({ plan, timeframe: '15m', barTs, now: NOW, context: context({ 'bar.close': 120 }) })
    // 同一条件（bar.close > 110）在连续两根 bar 都为真
    expect(fireOn(BAR_TS)).toMatchObject({ kind: 'commitment', id: 'c-1' })
    expect(fireOn(BAR_TS + 900_000)).toMatchObject({ kind: 'commitment', id: 'c-1' })
  })

  it('cross* 是边沿语义：只在穿越那一根触发；缺前值则 fail-closed（plan §12.2 I）', () => {
    const plan = makeCard({
      invalidation: [],
      commitments: [
        {
          id: 'c-cross',
          seq: 1,
          tf: '15m',
          when: 'crossBelow(bar.close, 100)',
          then: { action: 'reduce', fraction: 0.5 },
        },
      ],
    })
    const fire = (close: number, prevClose: number) =>
      matchPlan({
        plan,
        timeframe: '15m',
        barTs: BAR_TS,
        now: NOW,
        context: context({ 'bar.close': close }, { 'bar.close': prevClose }),
      })

    // 105 → 95：向下穿越 ⇒ 命中一次
    expect(fire(95, 105)).toMatchObject({ kind: 'commitment', id: 'c-cross' })
    // 96 → 95：仍在下方，不是边沿 ⇒ 不命中（这正是 edge 与电平的区别）
    expect(fire(95, 96)).toEqual({ kind: 'none' })
    // 没有 previous（回放第一根 / 指标暖机）⇒ UNCOVERED，绝不静默当"没穿越"
    expect(
      matchPlan({
        plan,
        timeframe: '15m',
        barTs: BAR_TS,
        now: NOW,
        context: context({ 'bar.close': 95 }),
      }).kind,
    ).toBe('uncovered')
  })

  it('fails closed: an unevaluable condition becomes uncovered, never silently "no match"', () => {
    const plan = makeCard({
      commitments: [
        { id: 'c-1', seq: 1, tf: '15m', when: 'adx14 > 25', then: { action: 'close' } },
      ],
      invalidation: [
        { id: 'inv-1', tf: '15m', when: 'bar.close < 0', then: { action: 'close' } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome.kind).toBe('uncovered')
    if (outcome.kind === 'uncovered') {
      expect(outcome.id).toBe('c-1')
      expect(outcome.reason).toContain('未知')
    }
  })

  it('returns expired once the window has passed, regardless of conditions', () => {
    const outcome = matchPlan({
      plan: makeCard({ windowEndsAt: NOW - 1 }),
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome).toEqual({ kind: 'expired' })
  })

  it('ignores commitments in a noTrade window but still allows invalidation', () => {
    const noTrade = makeCard({ noTrade: true })
    expect(
      matchPlan({
        plan: noTrade,
        timeframe: '15m',
        barTs: BAR_TS,
        now: NOW,
        context: context({ 'bar.close': 120 }),
      }),
    ).toEqual({ kind: 'none' })

    const withInvalidation = makeCard({
      noTrade: true,
      invalidation: [
        { id: 'inv-1', tf: '15m', when: 'bar.close < 130', then: { action: 'reduce', fraction: 0.5 } },
      ],
    })
    expect(
      matchPlan({
        plan: withInvalidation,
        timeframe: '15m',
        barTs: BAR_TS,
        now: NOW,
        context: context({ 'bar.close': 120 }),
      }),
    ).toMatchObject({ kind: 'invalidation' })
  })

  it('refuses to execute a forbidden action and reports it as uncovered', () => {
    const plan = makeCard({ forbidden: ['reduce'] })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome).toMatchObject({ kind: 'uncovered', id: 'c-1', reason: 'forbidden_action' })
  })
})

describe('失效条件不可判定时 fail-closed（审计修复）', () => {
  it('★ 失效条件引用未知路径 ⇒ 即使承诺为真也必须 UNCOVERED', () => {
    const plan = makeCard({
      invalidation: [{ id: 'inv-adx', tf: '15m', when: 'adx14 > 25', then: { action: 'close' } }],
      commitments: [
        { id: 'c-1', seq: 1, tf: '15m', when: 'bar.close > 110', then: { action: 'reduce', fraction: 0.5 } },
      ],
    })
    const outcome = matchPlan({
      plan,
      timeframe: '15m',
      barTs: BAR_TS,
      now: NOW,
      context: context({ 'bar.close': 120 }),
    })
    expect(outcome.kind).toBe('uncovered')
  })
})
