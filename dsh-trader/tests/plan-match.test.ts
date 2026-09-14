import { describe, expect, it } from 'vitest'
import { matchPlan, planDedupKey } from '../src/plan/match.js'
import { createDslContext } from '../src/plan/evaluate.js'
import { makeCard } from './helpers/plan.js'

const NOW = 50_000
const BAR_TS = 1_700_000_000_000

function context(values: Record<string, number | boolean> = {}) {
  return createDslContext(values)
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

  it('skips conditions that already fired for this bar (edge semantics)', () => {
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
