import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDatabase, getDatabase, openDatabase } from '../src/db/runtime.js'
import { Statements } from '../src/db/statements.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { HeartbeatStore } from '../src/supervisor/heartbeat.js'
import { apply, safeError, type SupervisorConfig } from '../src/plugins/supervisor.js'

const NOW = 1_700_000_000_000

function config(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    l3: { provider: 'test-provider', model: 'test-model' },
    dailyBudgetUsd: 10,
    dailyTokenCap: 100,
    windows: [],
    ...overrides,
  }
}

function makeContext(): {
  readonly ctx: Context
  readonly cleanups: (() => void)[]
  readonly effect: ReturnType<typeof vi.fn>
  readonly logger: ReturnType<typeof vi.fn>
  dispose(): void
} {
  const cleanups: (() => void)[] = []
  const effect = vi.fn((register: () => void | (() => void)) => {
    const cleanup = register()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  })
  const logger = vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
  const ctx = {
    effect,
    logger,
    llm: { stream: vi.fn() },
  } as unknown as Context
  return {
    ctx,
    cleanups,
    effect,
    logger,
    dispose: () => { for (const cleanup of cleanups.splice(0)) cleanup() },
  }
}

function auditCount(): number {
  const row = new Statements(getDatabase())
    .get('SELECT COUNT(*) AS count FROM audit_events')
    .get() as { count: number }
  return row.count
}

beforeEach(() => {
  closeDatabase()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  openDatabase(':memory:')
})

afterEach(() => {
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
  closeDatabase()
})

describe('trade-supervisor timer lifecycle and error redaction', () => {
  it.each([
    { key: 'heartbeatMs', value: Number.NaN, message: /heartbeatMs/ },
    { key: 'windowScanMs', value: 0, message: /windowScanMs/ },
    { key: 'wakeTimeoutMs', value: 0, message: /wakeTimeoutMs/ },
    { key: 'heartbeatMs', value: 2_147_483_648, message: /heartbeatMs/ },
    { key: 'windowScanMs', value: 1.5, message: /windowScanMs/ },
    { key: 'wakeTimeoutMs', value: 2_147_483_648, message: /wakeTimeoutMs/ },
    { key: 'heartbeatMs', value: 1.5, message: /heartbeatMs/ },
    { key: 'windowScanMs', value: 2_147_483_648, message: /windowScanMs/ },
    { key: 'wakeTimeoutMs', value: 1.5, message: /wakeTimeoutMs/ },
  ])('rejects invalid $key before side effects', ({ key, value, message }) => {
    const harness = makeContext()
    expect(() => apply(harness.ctx, config({ [key]: value }))).toThrow(message)
    expect(vi.getTimerCount()).toBe(0)
    expect(new HeartbeatStore(getDatabase()).read()).toBeUndefined()
    expect(auditCount()).toBe(0)
    expect(harness.effect).not.toHaveBeenCalled()
    expect(harness.logger).not.toHaveBeenCalled()
  })

  it('positive control: heartbeat and audit helpers observe writes in the shared database', () => {
    const db = getDatabase()
    new HeartbeatStore(db).beat(NOW)
    new DecisionJournal(db).appendAudit({
      actor: 'system',
      kind: 'test.helper_positive_control',
      payload: {},
      ts: NOW,
    })

    expect(new HeartbeatStore(getDatabase()).read()).toMatchObject({ beatAt: NOW, halted: false })
    expect(auditCount()).toBe(1)
  })

  it('keeps default heartbeat and scan intervals and disposes both', () => {
    const harness = makeContext()
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    apply(harness.ctx, config())

    expect(intervalSpy.mock.calls.map((call) => call[1])).toEqual([15_000, 60_000])
    expect(new HeartbeatStore(getDatabase()).read()?.beatAt).toBe(NOW)
    expect(vi.getTimerCount()).toBe(2)
    harness.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts explicit positive timer values without changing them', () => {
    const harness = makeContext()
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    apply(harness.ctx, config({ heartbeatMs: 23_000, windowScanMs: 41_000, wakeTimeoutMs: 1_234 }))

    expect(intervalSpy.mock.calls.map((call) => call[1])).toEqual([23_000, 41_000])
    harness.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('accepts the inclusive Node timer delay ceiling', () => {
    const harness = makeContext()
    const intervalSpy = vi.spyOn(globalThis, 'setInterval')
    apply(harness.ctx, config({
      heartbeatMs: 2_147_483_647,
      windowScanMs: 2_147_483_647,
      wakeTimeoutMs: 2_147_483_647,
    }))

    expect(intervalSpy.mock.calls.map((call) => call[1])).toEqual([2_147_483_647, 2_147_483_647])
    harness.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('registers cleanup before a later interval installation can fail', () => {
    const harness = makeContext()
    const nativeSetInterval = globalThis.setInterval.bind(globalThis)
    let calls = 0
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      calls += 1
      if (calls === 2) throw new Error('synthetic second interval failure')
      return nativeSetInterval(handler, timeout, ...args)
    })

    expect(() => apply(harness.ctx, config())).toThrow(/synthetic second interval failure/)
    expect(harness.cleanups).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    harness.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('redacts complete bearer credentials in plain and JSON-like errors', () => {
    const credential = 'synthetic-bearer-credential-never-real'
    const apiKeyBearer = safeError(new Error(`provider trace apiKey: Bearer ${credential}`))
    const secretBasic = safeError(new Error(`provider trace secret: Basic ${credential}`))
    const plain = safeError(new Error(`request failed; Authorization: Bearer ${credential}`))
    const tokenHeader = safeError(new Error(`request failed; TOKEN: Bearer ${credential}`))
    const json = safeError(new Error(`provider trace {"token":"Bearer ${credential}"}`))

    expect(apiKeyBearer).toContain('[REDACTED]')
    expect(secretBasic).toContain('[REDACTED]')
    expect(plain).toContain('[REDACTED]')
    expect(tokenHeader).toContain('[REDACTED]')
    expect(json).toContain('[REDACTED]')
    expect(apiKeyBearer).not.toContain(credential)
    expect(secretBasic).not.toContain(credential)
    expect(plain).not.toContain(credential)
    expect(tokenHeader).not.toContain(credential)
    expect(json).not.toContain(credential)
    expect(plain).toMatch(/^Error:/)
    expect(safeError(new Error('x'.repeat(1_200)))).toHaveLength(1_000)
  })
})
