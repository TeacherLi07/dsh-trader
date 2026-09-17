import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import type { TradePorts } from '../src/exec/ports.js'
import { HeartbeatStore } from '../src/supervisor/heartbeat.js'
import { readTradeState } from '../src/plugins/ui.js'

const NOW = 1_700_000_000_000

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
    })
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
      })
    } finally {
      db.close()
    }
  })
})
