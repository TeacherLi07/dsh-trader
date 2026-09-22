import { describe, expect, it } from 'vitest'
import {
  classifyExchangeReading,
  derivedReading,
  localAuditReading,
  projectStartupState,
  projectState,
} from '../src/ui/state.js'

const AS_OF = 1_700_000_000_000

describe('UI state projection', () => {
  it('distinguishes live, stale, rebuilding and unverifiable exchange readings', () => {
    const live = classifyExchangeReading({
      value: { equity: 10 },
      observedAt: AS_OF - 100,
      asOf: AS_OF,
      staleAfterMs: 1_000,
      rebuilding: false,
    })
    const stale = classifyExchangeReading({
      value: { equity: 10 },
      observedAt: AS_OF - 2_000,
      asOf: AS_OF,
      staleAfterMs: 1_000,
      rebuilding: false,
    })
    const rebuilding = classifyExchangeReading({
      value: { equity: 10 },
      observedAt: AS_OF - 100,
      asOf: AS_OF,
      staleAfterMs: 1_000,
      rebuilding: true,
    })
    const future = classifyExchangeReading({
      value: { equity: 10 },
      observedAt: AS_OF + 1,
      asOf: AS_OF,
      staleAfterMs: 1_000,
      rebuilding: false,
    })

    expect(live).toMatchObject({ value: { equity: 10 }, credibility: 'exchange-live' })
    expect(stale).toMatchObject({ value: { equity: 10 }, credibility: 'exchange-stale' })
    expect(rebuilding).toMatchObject({ value: null, credibility: 'unknown' })
    expect(future).toMatchObject({ value: null, credibility: 'unknown' })
  })

  it('keeps audit and derived readings explicitly distinct from exchange truth', () => {
    expect(localAuditReading({ kind: 'halt' }, AS_OF)).toEqual({
      value: { kind: 'halt' },
      source: 'local-audit',
      asOf: AS_OF,
      credibility: 'local-audit',
    })
    expect(derivedReading(0, AS_OF)).toEqual({
      value: 0,
      source: 'derived',
      asOf: AS_OF,
      credibility: 'derived',
    })
  })

  it('projects startup rebuild and failure without inventing readiness', () => {
    const rebuilding = projectStartupState({
      bootAt: AS_OF,
      asOf: AS_OF + 5_000,
      steps: [
        { id: 'database', status: 'succeeded' },
        { id: 'exchange', status: 'running' },
        { id: 'recovery', status: 'pending' },
        { id: 'ready', status: 'pending' },
      ],
      restartCount1h: 2,
      restartCount24h: 4,
    })
    const failed = projectStartupState({
      bootAt: AS_OF,
      asOf: AS_OF + 5_000,
      steps: [
        { id: 'database', status: 'succeeded' },
        { id: 'exchange', status: 'failed', error: 'network down' },
      ],
      restartCount1h: 3,
      restartCount24h: 5,
    })

    expect(rebuilding).toMatchObject({ phase: 'rebuilding', currentStep: 'exchange' })
    expect(failed).toMatchObject({ phase: 'failed', currentStep: 'exchange', lastFailure: 'network down' })
  })

  it('marks all exchange-backed state unknown while rebuilding', () => {
    const state = projectState({
      mode: 'paper',
      venue: 'paper',
      halted: false,
      rebuilding: true,
      asOf: AS_OF,
      account: {
        venue: 'paper',
        equityQuote: 100,
        totalExposureUsd: 0,
        pendingExposureUsd: 0,
        openOrders: 0,
        leverage: 0,
        dailyLossUsd: 0,
        drawdownUsd: 0,
        consecutiveLosses: 0,
        spreadBps: 0,
        observedAt: AS_OF,
      },
      accountObservedAt: AS_OF,
      positions: [],
      positionsObservedAt: AS_OF,
      openOrders: [],
      openOrdersObservedAt: AS_OF,
      staleAfterMs: 1_000,
    })

    expect(state.account.value).toBeNull()
    expect(state.positions.value).toBeNull()
    expect(state.openOrders.value).toBeNull()
    expect(state.account.credibility).toBe('unknown')
  })

  it('classifies each exchange query at its own completion time, including empty arrays', () => {
    const state = projectState({
      mode: 'paper',
      venue: 'paper',
      halted: false,
      rebuilding: false,
      asOf: AS_OF,
      account: {
        venue: 'paper',
        equityQuote: 100,
        totalExposureUsd: 0,
        pendingExposureUsd: 0,
        openOrders: 0,
        leverage: 0,
        dailyLossUsd: 0,
        drawdownUsd: 0,
        consecutiveLosses: 0,
        spreadBps: 0,
        observedAt: AS_OF - 2_000,
      },
      accountObservedAt: AS_OF - 2_000,
      positions: [],
      positionsObservedAt: AS_OF - 2_000,
      openOrders: [],
      openOrdersObservedAt: AS_OF - 100,
      staleAfterMs: 1_000,
    })

    expect(state.account).toMatchObject({ asOf: AS_OF - 2_000, credibility: 'exchange-stale' })
    expect(state.positions).toMatchObject({ value: [], asOf: AS_OF - 2_000, credibility: 'exchange-stale' })
    expect(state.openOrders).toMatchObject({ value: [], asOf: AS_OF - 100, credibility: 'exchange-live' })
  })
})
