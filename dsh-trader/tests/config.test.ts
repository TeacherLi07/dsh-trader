import { describe, expect, it } from 'vitest'
import {
  SUGGESTED_LIMITS,
  StartupParamsError,
  describeStartup,
  resolveStartupParams,
} from '../src/config.js'

const complete = {
  mode: 'paper' as const,
  riskPct: 0.01,
  symbols: ['BTC/USDT:USDT'],
  benchmark: 'BTC/USDT:USDT',
  limits: SUGGESTED_LIMITS,
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

  it('treats an explicit waiver as first-class and keeps it continuously visible', () => {
    const params = resolveStartupParams({ waiver: true, mode: 'live_auto' }, 1000)
    expect(params.limits).toBeNull()
    expect(params.waiver).toBe(true)
    expect(describeStartup(params).join('\n')).toContain('风控参数已放弃')
  })
})
