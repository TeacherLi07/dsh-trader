import { describe, expect, it } from 'vitest'
import {
  decideWake,
  dueWindows,
  nextFireAt,
  windowDedupKey,
  type WakeDecisionInput,
  type WakeLimits,
  type WindowSpec,
} from '../src/supervisor/windows.js'

const MINUTE = 60_000
const DAY = 86_400_000
const LIMITS: WakeLimits = {
  judgmentPerHour: 3,
  judgmentPerDay: 8,
  noveltyPerHour: 2,
  noveltyPerDay: 6,
}

const allowBudget = { allow: true as const }
const denyBudget = { allow: false as const, reason: '超出日预算：已用 1.0000 + 预估 0.5000 > 1.25' }

function wake(overrides: Partial<WakeDecisionInput> = {}): WakeDecisionInput {
  return {
    purpose: 'commitment',
    matchedCommitment: false,
    judgmentFiredLastHour: 0,
    judgmentFiredToday: 0,
    noveltyFiredLastHour: 0,
    noveltyFiredToday: 0,
    limits: LIMITS,
    budget: allowBudget,
    ...overrides,
  }
}

describe('window scheduling', () => {
  it('nextFireAt handles exact boundaries, UTC day rollover, month end and everyMs', () => {
    const exact = Date.UTC(2026, 0, 31, 12, 0)
    expect(nextFireAt({ id: 'review', at: '12:00Z' }, exact)).toBe(exact + DAY)
    expect(nextFireAt({ id: 'review', at: '11:59Z' }, exact)).toBe(exact + DAY - MINUTE)

    const monthEnd = Date.UTC(2026, 1, 28, 23, 59)
    expect(nextFireAt({ id: 'review', at: '00:30Z' }, monthEnd)).toBe(Date.UTC(2026, 2, 1, 0, 30))
    expect(nextFireAt({ id: 'poll', everyMs: 2 * MINUTE }, monthEnd)).toBe(monthEnd + 2 * MINUTE)
  })

  it('at takes precedence over everyMs', () => {
    const now = Date.UTC(2026, 8, 15, 10, 0)
    expect(nextFireAt({ id: 'review', at: '10:30Z', everyMs: 1 }, now)).toBe(Date.UTC(2026, 8, 15, 10, 30))
  })

  it('dueWindows returns a non-empty, sorted, idempotently deduped interval', () => {
    const since = Date.UTC(2026, 0, 1, 11, 59)
    const now = Date.UTC(2026, 0, 3, 12, 1)
    const specs: readonly WindowSpec[] = [
      { id: 'review', at: '12:00Z' },
      { id: 'review', at: '12:00Z' },
      { id: 'poll', everyMs: DAY },
    ]

    const first = dueWindows(specs, since, now)
    const second = dueWindows(specs, since, now)
    expect(first.length).toBeGreaterThan(0)
    expect(first).toEqual(second)
    expect(first).toEqual([
      { id: 'review', fireTs: Date.UTC(2026, 0, 1, 12, 0) },
      { id: 'poll', fireTs: since + DAY },
      { id: 'review', fireTs: Date.UTC(2026, 0, 2, 12, 0) },
      { id: 'poll', fireTs: since + 2 * DAY },
      { id: 'review', fireTs: Date.UTC(2026, 0, 3, 12, 0) },
    ])
    expect(new Set(first.map((fire) => windowDedupKey(fire.id, fire.fireTs))).size).toBe(first.length)
    expect(dueWindows(specs, now, now)).toEqual([])
    expect(dueWindows(specs, now + 1, now)).toEqual([])
  })
})

describe('decideWake', () => {
  it('keeps direct execution and info paths at zero wakeups', () => {
    const samples = [
      decideWake(wake({ matchedCommitment: true, budget: denyBudget })),
      decideWake(wake({ purpose: 'invalidation', budget: denyBudget })),
      decideWake(wake({ purpose: 'info', budget: denyBudget })),
    ]
    expect(samples.length).toBeGreaterThan(0)
    expect(samples).toEqual([
      { wake: 'none', reason: '命中承诺，直接执行，不唤醒', disposition: 'executed' },
      { wake: 'none', reason: '命中失效条件，执行降险，不唤醒', disposition: 'executed' },
      { wake: 'none', reason: '信息类触发只落库，不唤醒（零 token）', disposition: 'info' },
    ])
  })

  it('routes uncovered judgment and novelty to W2/W3 when limits and budget allow', () => {
    const samples = [decideWake(wake()), decideWake(wake({ purpose: 'novelty' }))]
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.map((sample) => sample.wake)).toEqual(['W2', 'W3'])
    expect(samples.map((sample) => sample.disposition)).toEqual(['judgment', 'novelty'])
  })

  it('rate-limits every hourly and daily boundary with auditable actual counts', () => {
    const cases: readonly { input: WakeDecisionInput; marker: string }[] = [
      { input: wake({ purpose: 'novelty', noveltyFiredLastHour: 2 }), marker: '最近 1 小时 2/2' },
      { input: wake({ purpose: 'novelty', noveltyFiredLastHour: 3 }), marker: '最近 1 小时 3/2' },
      { input: wake({ purpose: 'novelty', noveltyFiredToday: 6 }), marker: '今日 6/6' },
      { input: wake({ purpose: 'novelty', noveltyFiredToday: 7 }), marker: '今日 7/6' },
      { input: wake({ judgmentFiredLastHour: 3 }), marker: '最近 1 小时 3/3' },
      { input: wake({ judgmentFiredLastHour: 4 }), marker: '最近 1 小时 4/3' },
      { input: wake({ judgmentFiredToday: 8 }), marker: '今日 8/8' },
      { input: wake({ judgmentFiredToday: 9 }), marker: '今日 9/8' },
    ]
    expect(cases.length).toBeGreaterThan(0)

    for (const { input, marker } of cases) {
      const result = decideWake(input)
      expect(result.wake).toBe('none')
      expect(result.disposition).toBe('rate_limited')
      expect(result.reason).toContain(marker)
    }
  })

  it('records budget rejection for both W2 and W3 without waking', () => {
    const samples = [
      decideWake(wake({ budget: denyBudget })),
      decideWake(wake({ purpose: 'novelty', budget: denyBudget })),
    ]
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.every((sample) => sample.wake === 'none')).toBe(true)
    expect(samples.every((sample) => sample.disposition === 'budget_limited')).toBe(true)
    expect(samples.every((sample) => sample.reason.includes('预算拒绝'))).toBe(true)
    expect(samples.every((sample) => sample.reason.includes('0/'))).toBe(true)
  })
})

describe('window validation', () => {
  it('throws for malformed UTC times, non-positive intervals and empty schedules', () => {
    const invalid: readonly WindowSpec[] = [
      { id: 'bad-time', at: '24:00Z' },
      { id: 'bad-time', at: '12:60Z' },
      { id: 'bad-interval', everyMs: 0 },
      { id: 'bad-interval', everyMs: Number.POSITIVE_INFINITY },
      { id: 'empty' },
    ]
    expect(invalid.length).toBeGreaterThan(0)
    for (const spec of invalid) expect(() => nextFireAt(spec, 0)).toThrow(/非法窗口/)
  })
})

describe('★ 监督循环的游标语义（真跑才暴露的 bug）', () => {
  const spec = [{ id: 'arm', everyMs: 600_000 }]
  const start = 1_000_000

  it('错误用法：每轮把 since 跟到 now ⇒ everyMs 永不触发（这正是实测到的 W1 不触发）', () => {
    let wrongCursor = start
    let wrongFires = 0
    for (let t = start + 60_000; t <= start + 3 * 600_000; t += 60_000) {
      wrongFires += dueWindows(spec, wrongCursor, t).length
      wrongCursor = t
    }
    expect(wrongFires).toBe(0)
  })

  it('正确用法：只在触发后把游标推进到 fireTs ⇒ 每 everyMs 稳定触发一次', () => {
    let cursor = start
    const fireTimes: number[] = []
    for (let t = start + 60_000; t <= start + 3 * 600_000; t += 60_000) {
      const fires = dueWindows(spec, cursor, t)
      if (fires.length > 0) cursor = Math.max(...fires.map((fire) => fire.fireTs))
      fireTimes.push(...fires.map((fire) => fire.fireTs))
    }
    expect(fireTimes).toEqual([start + 600_000, start + 1_200_000, start + 1_800_000])
  })
})
