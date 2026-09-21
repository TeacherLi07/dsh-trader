import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { R5ControlRegistry } from '../src/supervisor/r5-registry.js'

const AT = Date.UTC(2026, 8, 20, 12)
const budgets = { dailyBudgetUsd: 1, dailyTokenCap: 1_000, totalBudgetUsd: 2 }

function experiment(over: Partial<Parameters<R5ControlRegistry['registerExperiment']>[0]> = {}) {
  return {
    experimentId: 'r5-exp-001', manifestHash: `sha256:${'a'.repeat(64)}`, routeHash: `sha256:${'b'.repeat(64)}`,
    split: 'validation' as const, datasetId: 'dataset-1', datasetHash: `sha256:${'e'.repeat(64)}`,
    pitDataHash: `sha256:${'7'.repeat(64)}`,
    pitWindowHashes: [`sha256:${'8'.repeat(64)}`],
    stateDbId: `sha256:${'c'.repeat(64)}`, credentialRef: 'TRADER_R5_API_KEY' as const,
    keyIsolationAcknowledged: true, budgets, priceTableVersion: `sha256:${'d'.repeat(64)}`, ...over,
  }
}

function reservation(requestHash: string, over: Partial<Parameters<R5ControlRegistry['reserveCall']>[0]> = {}) {
  return {
    experimentId: 'r5-exp-001', stateDbId: `sha256:${'c'.repeat(64)}`, requestHash,
    runId: 'run-1', sampleId: 'sample-1', strategy: 'single' as const,
    model: 'deepseek-flash', symbol: 'BTC/USDT:USDT', stage: 'strategist', at: AT,
    estimatedTokens: 500, reservedUsd: 0.6,
    owner: { pid: 1234, bootId: 'test-boot', startTicks: '100' }, ...over,
  }
}

describe('R5 shared control registry', () => {
  it('registry refuses an experiment without an isolated-key acknowledgement', () => {
    const db = new Database(':memory:')
    migrate(db)
    const registry = new R5ControlRegistry(db, new ReplayClock(AT))
    try {
      expect(() => registry.registerExperiment(experiment({ keyIsolationAcknowledged: false })))
        .toThrow(/专用 key 引用与显式隔离确认/)
    } finally { db.close() }
  })

  it('atomically enforces one experiment identity, shared daily caps, and unique request hashes', () => {
    const db = new Database(':memory:')
    migrate(db)
    const registry = new R5ControlRegistry(db, new ReplayClock(AT))
    try {
      registry.registerExperiment(experiment())
      expect(registry.reserveCall(reservation('request-1'))).toEqual({ allow: true })
      expect(registry.reserveCall(reservation('request-1'))).toMatchObject({ allow: false, reason: expect.stringContaining('未结算 reservation') })
      registry.settleCall({
        experimentId: 'r5-exp-001', requestHash: 'request-1', at: AT + 1,
        actualTokens: 300, actualUsd: 0.4, costKnown: true, failed: false,
      })
      expect(registry.reserveCall(reservation('request-1'))).toMatchObject({ allow: false, reason: expect.stringContaining('重复付费') })

      expect(() => registry.registerExperiment(experiment({ stateDbId: `sha256:${'e'.repeat(64)}` })))
        .toThrow(/另一 state DB/)
      expect(() => registry.registerExperiment(experiment({
        experimentId: 'r5-exp-replayed-validation',
        manifestHash: `sha256:${'1'.repeat(64)}`,
        stateDbId: `sha256:${'2'.repeat(64)}`,
        datasetHash: `sha256:${'3'.repeat(64)}`,
        pitDataHash: `sha256:${'4'.repeat(64)}`,
      }))).toThrow(/禁止事后重用验证段/)
      registry.registerExperiment(experiment({
        experimentId: 'r5-exp-002', stateDbId: `sha256:${'f'.repeat(64)}`,
        manifestHash: `sha256:${'9'.repeat(64)}`,
        datasetId: 'dataset-2', datasetHash: `sha256:${'1'.repeat(64)}`,
        pitDataHash: `sha256:${'8'.repeat(64)}`,
        pitWindowHashes: [`sha256:${'9'.repeat(64)}`],
      }))
      expect(registry.reserveCall(reservation('request-2', {
        experimentId: 'r5-exp-002', stateDbId: `sha256:${'f'.repeat(64)}`, runId: 'run-2', sampleId: 'sample-2',
      }))).toMatchObject({ allow: false, reason: expect.stringContaining('日预算将超限') })
    } finally { db.close() }
  })

  it('rejects a validation window reused under different IDs, labels, manifest, or dataset hash', () => {
    const db = new Database(':memory:')
    migrate(db)
    const registry = new R5ControlRegistry(db, new ReplayClock(AT))
    try {
      registry.registerExperiment(experiment())
      expect(() => registry.registerExperiment(experiment({
        experimentId: 'r5-exp-validation-overlap',
        manifestHash: `sha256:${'1'.repeat(64)}`,
        datasetId: 'renamed-dataset',
        datasetHash: `sha256:${'2'.repeat(64)}`,
        pitDataHash: `sha256:${'3'.repeat(64)}`,
        pitWindowHashes: [`sha256:${'8'.repeat(64)}`, `sha256:${'9'.repeat(64)}`],
      }))).toThrow(/validation PIT window.*重叠/)
    } finally { db.close() }
  })

  it('an unresolved reservation or actual usage overrun globally stops future calls', () => {
    const db = new Database(':memory:')
    migrate(db)
    const registry = new R5ControlRegistry(db, new ReplayClock(AT))
    try {
      registry.registerExperiment(experiment())
      expect(registry.reserveCall(reservation('pending-request'))).toEqual({ allow: true })
      expect(registry.snapshot('r5-exp-001').blocker).toContain('未结算 reservation')
      expect(registry.reserveCall(reservation('later-request'))).toMatchObject({ allow: false })
      expect(registry.recoverAbandonedCalls(() => false)).toBe(1)
      expect(registry.snapshot('r5-exp-001')).toMatchObject({ blocker: null, unresolvedRequestHashes: [], costUnknownCalls: 1 })
      expect(registry.reserveCall(reservation('after-recovery', { estimatedTokens: 100, reservedUsd: 0.3 })))
        .toEqual({ allow: true })
    } finally { db.close() }

    const overrunDb = new Database(':memory:')
    migrate(overrunDb)
    const overrunRegistry = new R5ControlRegistry(overrunDb, new ReplayClock(AT))
    try {
      overrunRegistry.registerExperiment(experiment())
      overrunRegistry.reserveCall(reservation('overrun-request', { estimatedTokens: 10, reservedUsd: 0.1 }))
      expect(overrunRegistry.settleCall({
        experimentId: 'r5-exp-001', requestHash: 'overrun-request', at: AT + 1,
        actualTokens: 20, actualUsd: 0.2, costKnown: true, failed: false,
      })).toEqual({ overrun: true })
      expect(overrunRegistry.snapshot('r5-exp-001').blocker).toContain('超限')
      expect(overrunRegistry.reserveCall(reservation('future-request'))).toMatchObject({ allow: false })
    } finally { overrunDb.close() }
  })
})
