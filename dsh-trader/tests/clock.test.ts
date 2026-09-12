import { describe, expect, it } from 'vitest'
import { ClockError, ReplayClock } from '../src/clock.js'

describe('ReplayClock', () => {
  it('advances deterministically and fires periodic tasks in virtual-time order', () => {
    const clock = new ReplayClock(0)
    const seen: number[] = []
    clock.setInterval(() => seen.push(clock.now()), 100)
    clock.setInterval(() => seen.push(-clock.now()), 250)

    clock.advanceTo(300)

    expect(seen).toEqual([100, 200, -250, 300])
    expect(clock.now()).toBe(300)
  })

  it('produces identical event sequences on repeated runs (replay determinism)', () => {
    const run = (): number[] => {
      const clock = new ReplayClock(0)
      const seen: number[] = []
      clock.setInterval(() => seen.push(clock.now()), 60)
      clock.advanceTo(1_000)
      return seen
    }
    expect(run()).toEqual(run())
  })

  it('refuses to move time backwards', () => {
    const clock = new ReplayClock(500)
    expect(() => clock.advanceTo(499)).toThrow(ClockError)
  })

  it('rejects non-positive or non-finite periods', () => {
    const clock = new ReplayClock(0)
    expect(() => clock.setInterval(() => undefined, 0)).toThrow(ClockError)
    expect(() => clock.setInterval(() => undefined, Number.NaN)).toThrow(ClockError)
  })

  it('unregisters tasks through the returned disposer', () => {
    const clock = new ReplayClock(0)
    const dispose = clock.setInterval(() => undefined, 10)
    expect(clock.pendingTimers()).toBe(1)
    dispose()
    expect(clock.pendingTimers()).toBe(0)
  })
})
