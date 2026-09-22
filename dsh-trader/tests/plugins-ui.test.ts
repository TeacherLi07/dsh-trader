import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import type { TradePorts } from '../src/exec/ports.js'
import { HeartbeatStore } from '../src/supervisor/heartbeat.js'
import { readTradeState } from '../src/plugins/ui.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { StartupTracker } from '../src/exec/startup.js'
import { readStartupState } from '../src/ui/startup.js'
import type { StartupProjection } from '../src/ui/state.js'

const NOW = 1_700_000_000_000

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => { resolve = finish })
  return { promise, resolve }
}

function makePorts(db: Database.Database, clock: ReplayClock, over: Partial<TradePorts> = {}): TradePorts {
  return {
    db,
    bars: {} as never,
    features: {} as never,
    plans: {} as never,
    journal: {} as never,
    broker: {
      venue: 'paper',
      getAccount: async () => ({
        venue: 'paper',
        equityQuote: 100,
        totalExposureUsd: 0,
        openOrders: 0,
        leverage: 0,
        dailyLossUsd: 0,
        drawdownUsd: 0,
        consecutiveLosses: 0,
        spreadBps: 0,
        observedAt: NOW,
      }),
      getPositions: async () => [],
      getOpenOrders: async () => [],
      placeOrder: async () => { throw new Error('UI route 不得下单') },
      placeProtective: async () => { throw new Error('UI route 不得挂保护单') },
      cancelOrder: async () => { throw new Error('UI route 不得撤单') },
      cancelAll: async () => { throw new Error('UI route 不得撤单') },
      subscribeUserData: () => () => undefined,
    } as never,
    clock,
    limits: null,
    mode: 'paper',
    liveArmed: false,
    waiver: true,
    riskPct: 0.002,
    symbols: ['BTC/USDT'],
    timeframes: ['1h'],
    benchmark: 'BTC/USDT',
    ...over,
  }
}

describe('trade-ui read-only state route', () => {
  it('returns rebuilding instead of inventing an empty account before exec ports exist', async () => {
    await expect(readTradeState(undefined, 1_000)).resolves.toEqual({
      ok: false,
      rebuilding: true,
      error: '交易组合根尚未就绪，状态仍在重建中',
      startup: null,
    })
  })

  it('keeps the persisted startup projection visible while exec ports are still unavailable', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    try {
      const tracker = new StartupTracker(new DecisionJournal(db), clock)
      tracker.start('exchange')
      const startup = readStartupState(db, NOW)
      expect(startup).not.toBeNull()
      if (startup === null) return
      await expect(readTradeState(undefined, 1_000, startup)).resolves.toMatchObject({
        ok: false,
        rebuilding: true,
        startup: { phase: 'rebuilding', currentStep: 'exchange', restartCount1h: 1 },
      })
    } finally {
      db.close()
    }
  })

  it('reads broker state and persistent halted without exposing a write path', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    try {
      const ports = makePorts(db, clock)
      new HeartbeatStore(db).halt(NOW)
      const body = await readTradeState(ports, 1_000)
      expect(body.ok).toBe(true)
      if (!body.ok) return
      expect(body.state.halted).toBe(true)
      expect(body.state.account).toMatchObject({ credibility: 'exchange-live', value: { equityQuote: 100 } })
      expect(body.state.positions.value).toEqual([])
      expect(body.state.openOrders.value).toEqual([])
      expect(body.startup).toBeNull()
    } finally {
      db.close()
    }
  })

  it('preserves an explicit startup override on a successful state read', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    const override: StartupProjection = {
      bootAt: NOW - 1_000,
      asOf: NOW - 100,
      uptimeMs: 900,
      phase: 'rebuilding',
      currentStep: 'exchange',
      steps: [],
      restartCount1h: 1,
      restartCount24h: 1,
      lastFailure: null,
    }
    try {
      const body = await readTradeState(makePorts(db, clock), 1_000, override)
      expect(body.ok).toBe(true)
      if (!body.ok) return
      expect(body.startup).toEqual(override)
    } finally {
      db.close()
    }
  })

  it('samples successful broker and startup state at or before one post-read asOf', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    try {
      new StartupTracker(new DecisionJournal(db), clock).start('exchange')
      const base = makePorts(db, clock)
      const ports = {
        ...base,
        broker: {
          ...base.broker,
          getAccount: async () => {
            clock.advanceTo(NOW + 1)
            return {
              venue: 'paper' as const,
              equityQuote: 100,
              totalExposureUsd: 0,
              openOrders: 0,
              leverage: 0,
              dailyLossUsd: 0,
              drawdownUsd: 0,
              consecutiveLosses: 0,
              spreadBps: 0,
              observedAt: clock.now(),
            }
          },
        },
      } as TradePorts

      const body = await readTradeState(ports, 1_000)
      expect(body.ok).toBe(true)
      if (!body.ok) return
      expect(body.asOf).toBe(NOW + 1)
      expect(body.state.account).toMatchObject({
        asOf: NOW + 1,
        credibility: 'exchange-live',
        value: { equityQuote: 100, observedAt: NOW + 1 },
      })
      expect(body.state.account.asOf).toBeLessThanOrEqual(body.asOf)
      expect(body.startup?.asOf).toBe(body.asOf)
    } finally {
      db.close()
    }
  })

  it('timestamps each broker query independently, including successful empty arrays', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    try {
      const base = makePorts(db, clock)
      const account = deferred<Awaited<ReturnType<typeof base.broker.getAccount>>>()
      const positions = deferred<Awaited<ReturnType<typeof base.broker.getPositions>>>()
      const openOrders = deferred<Awaited<ReturnType<typeof base.broker.getOpenOrders>>>()
      const ports = {
        ...base,
        broker: {
          ...base.broker,
          getAccount: () => account.promise,
          getPositions: () => positions.promise,
          getOpenOrders: () => openOrders.promise,
        },
      } as TradePorts

      const statePromise = readTradeState(ports, 15)
      clock.advanceTo(NOW + 10)
      positions.resolve([])
      await Promise.resolve()
      clock.advanceTo(NOW + 20)
      openOrders.resolve([])
      await Promise.resolve()
      clock.advanceTo(NOW + 30)
      account.resolve({
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
        observedAt: clock.now(),
      })

      const body = await statePromise
      expect(body.ok).toBe(true)
      if (!body.ok) return
      expect(body.asOf).toBe(NOW + 30)
      expect(body.state.positions).toMatchObject({
        value: [],
        asOf: NOW + 10,
        credibility: 'exchange-stale',
      })
      expect(body.state.openOrders).toMatchObject({
        value: [],
        asOf: NOW + 20,
        credibility: 'exchange-live',
      })
      expect(body.state.account).toMatchObject({ asOf: NOW + 30, credibility: 'exchange-live' })
    } finally {
      db.close()
    }
  })

  it('turns broker failure into a visible rebuilding/error response', async () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    try {
      const base = makePorts(db, clock)
      const ports = {
        ...base,
        broker: {
          ...base.broker,
          getAccount: async () => { throw new Error('exchange unavailable') },
        },
      } as TradePorts
      await expect(readTradeState(ports, 1_000)).resolves.toMatchObject({
        ok: false,
        rebuilding: true,
        error: 'Error: exchange unavailable',
        startup: null,
      })
    } finally {
      db.close()
    }
  })
})
