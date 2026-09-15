import { describe, expect, it } from 'vitest'
import {
  EXAMPLE_LIMITS,
  StartupParamsError,
  checkLimitsConsistency,
  describeStartup,
  resolveStartupParams,
} from '../src/config.js'

const complete = {
  mode: 'paper' as const,
  riskPct: 0.01,
  symbols: ['BTC/USDT:USDT'],
  benchmark: 'BTC/USDT:USDT',
  limits: EXAMPLE_LIMITS,
}

describe('startup params', () => {
  it('refuses to start with no params instead of guessing a "safe" number', () => {
    expect(() => resolveStartupParams({}, 1000)).toThrow(StartupParamsError)
    try {
      resolveStartupParams({}, 1000)
    } catch (error) {
      expect(error).toBeInstanceOf(StartupParamsError)
      expect((error as StartupParamsError).errors.length).toBeGreaterThan(0)
    }
  })

  it('rejects an out-of-range riskPct and a missing limits block', () => {
    expect(() => resolveStartupParams({ ...complete, riskPct: 0.5 }, 1000)).toThrow(StartupParamsError)
    const { limits: _drop, ...withoutLimits } = complete
    expect(() => resolveStartupParams(withoutLimits, 1000)).toThrow(StartupParamsError)
  })

  it('accepts a complete parameter set, freezes it, and stamps the decision time', () => {
    const params = resolveStartupParams(complete, 1000)
    expect(params.waiver).toBe(false)
    expect(params.decidedAt).toBe(1000)
    expect(Object.isFrozen(params)).toBe(true)
  })

  it('rejects inconsistent limits and reports both available fixes', () => {
    expect(() => resolveStartupParams({ ...complete, equityQuoteUsd: 10_000 }, 1000)).toThrow(StartupParamsError)
    try {
      resolveStartupParams({ ...complete, equityQuoteUsd: 10_000 }, 1000)
    } catch (error) {
      expect(error).toBeInstanceOf(StartupParamsError)
      const errors = (error as StartupParamsError).errors
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.join('\n')).toContain('调低 riskPct')
      expect(errors.join('\n')).toContain('调高 perOrderCapUsd')
      expect(errors.join('\n')).toContain('180')
      expect(errors.join('\n')).toContain('0.2%')
    }
  })

  it('accepts a self-consistent parameter set when equity is supplied', () => {
    const params = resolveStartupParams(
      { ...complete, equityQuoteUsd: 10_000, limits: { ...EXAMPLE_LIMITS, perOrderCapUsd: 25_000 } },
      1000,
    )
    expect(params.limits?.perOrderCapUsd).toBe(25_000)
  })

  it('keeps the example limits explicit and frozen', () => {
    expect(EXAMPLE_LIMITS).toBeDefined()
    expect(Object.isFrozen(EXAMPLE_LIMITS)).toBe(true)
  })

  it('returns errors instead of calculating with invalid consistency inputs', () => {
    const invalidValues = [0, -1, Number.NaN]
    expect(invalidValues.length).toBeGreaterThan(0)
    for (const value of invalidValues) {
      expect(
        checkLimitsConsistency({
          equityQuoteUsd: value,
          riskPct: 0.002,
          perOrderCapUsd: 500,
          minStopDistancePct: 0.005,
        }),
      ).toEqual(expect.any(String))
      expect(
        checkLimitsConsistency({
          equityQuoteUsd: 10_000,
          riskPct: value,
          perOrderCapUsd: 500,
          minStopDistancePct: 0.005,
        }),
      ).toEqual(expect.any(String))
      expect(
        checkLimitsConsistency({
          equityQuoteUsd: 10_000,
          riskPct: 0.002,
          perOrderCapUsd: 500,
          minStopDistancePct: value,
        }),
      ).toEqual(expect.any(String))
    }
  })

  it('treats an explicit waiver as first-class and keeps it continuously visible', () => {
    const params = resolveStartupParams({ waiver: true, mode: 'live_auto' }, 1000)
    expect(params.limits).toBeNull()
    expect(params.waiver).toBe(true)
    expect(describeStartup(params).join('\n')).toContain('风控参数已放弃')
  })
})
