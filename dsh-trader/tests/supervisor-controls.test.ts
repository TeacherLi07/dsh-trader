import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { Statements } from '../src/db/statements.js'
import {
  Reconciler,
  type ReconciliationEvent,
  type LocalOrderSnapshot,
  type LocalPositionSnapshot,
} from '../src/exec/reconcile.js'
import type { OrderAck } from '../src/exec/broker.js'
import { PaperBroker } from '../src/exec/paper.js'
import { makeHaltHandler, makeResumeHandler } from '../src/plugins/commands.js'
import { HeartbeatStore, type HeartbeatAuditEvent } from '../src/supervisor/heartbeat.js'


const START = 1_700_000_000_000

function heartbeatDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function noOpInvocation(): never {
  return undefined as never
}

describe('HeartbeatStore', () => {
  it('beats, halts and resumes idempotently', () => {
    const db = heartbeatDb()
    try {
      const store = new HeartbeatStore(new Statements(db))
      expect(store.read()).toBeUndefined()
      store.beat(START)
      store.beat(START + 1)
      expect(store.read()).toEqual({ beatAt: START + 1, halted: false })

      store.halt(START + 2)
      store.halt(START + 3)
      expect(store.read()).toEqual({ beatAt: START + 3, halted: true })
      expect(store.isHalted()).toBe(true)

      store.resume(START + 4)
      store.resume(START + 5)
      expect(store.read()).toEqual({ beatAt: START + 5, halted: false })
      expect(store.isHalted()).toBe(false)
      expect(db.prepare('SELECT COUNT(*) AS n FROM heartbeat').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })
})

const cleanOrders: readonly LocalOrderSnapshot[] = [
  { clientOrderId: 'local-1', symbol: 'BTC/USDT', state: 'open' },
]
const protectedPositions: readonly LocalPositionSnapshot[] = [
  { symbol: 'BTC/USDT', qty: 1, protectedStopPrice: 95 },
]

function reconciler(
  remoteOrders: readonly { clientOrderId: string; exchangeOrderId?: string; symbol?: string }[],
  remotePositions: readonly { symbol: string; qty: number }[],
  localOrders: readonly LocalOrderSnapshot[] = cleanOrders,
  localPositions: readonly LocalPositionSnapshot[] = protectedPositions,
  onAlert: (event: ReconciliationEvent) => void = () => {},
  cancelOrder: (id: string) => Promise<void> = async () => {},
): Reconciler {
  return new Reconciler({
    broker: {
      getOpenOrders: async () =>
        remoteOrders.map(
          (order) =>
            ({
              intentId: order.clientOrderId,
              clientOrderId: order.clientOrderId,
              ...(order.exchangeOrderId === undefined ? {} : { exchangeOrderId: order.exchangeOrderId }),
              state: 'acked',
              ts: START,
              ...(order.symbol === undefined ? {} : { symbol: order.symbol }),
            }) as OrderAck & { readonly symbol?: string },
        ),
      getPositions: async () =>
        remotePositions.map((position) => ({
          ...position,
          avgPrice: 100,
          unrealizedPnlUsd: 0,
        })),
      cancelOrder,
    },
    clock: new ReplayClock(START),
    localOrders,
    localPositions,
    onAlert,
  })
}

describe('Reconciler', () => {
  it('cancels an orphan order and audits the applied action', async () => {
    const cancelled: string[] = []
    const events: ReconciliationEvent[] = []
    const runner = reconciler(
      [
        { clientOrderId: 'local-1', symbol: 'BTC/USDT' },
        // 孤儿单必须带 exchangeOrderId：撤单端点的契约参数是它，不能用 clientOrderId 顶替。
        { clientOrderId: 'orphan-1', exchangeOrderId: 'ex-orphan-1', symbol: 'BTC/USDT' },
      ],
      [{ symbol: 'BTC/USDT', qty: 1 }],
      cleanOrders,
      protectedPositions,
      (event) => events.push(event),
      async (id) => {
        cancelled.push(id)
      },
    )

    const output = await runner.runOnce()
    expect(output.result.actions.length).toBeGreaterThan(0)
    expect(output.applied.length).toBeGreaterThan(0)
    expect(cancelled).toEqual(['ex-orphan-1'])
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.action.kind).toBe('cancel_orphan')
    expect(output.freezeTrading).toBe(true)
  })

  it('alerts and freezes on unknown positions', async () => {
    const events: ReconciliationEvent[] = []
    const output = await reconciler(
      [{ clientOrderId: 'local-1', symbol: 'BTC/USDT' }],
      [
        { symbol: 'BTC/USDT', qty: 1 },
        { symbol: 'ETH/USDT', qty: 2 },
      ],
      cleanOrders,
      protectedPositions,
      (event) => events.push(event),
    ).runOnce()

    expect(output.result.actions.length).toBeGreaterThan(0)
    expect(output.result.actions.some((action) => action.kind === 'alert_unknown_position')).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    expect(output.freezeTrading).toBe(true)
  })

  it('alerts and freezes on an unprotected position', async () => {
    const events: ReconciliationEvent[] = []
    const output = await reconciler(
      [{ clientOrderId: 'local-1', symbol: 'BTC/USDT' }],
      [{ symbol: 'BTC/USDT', qty: 1 }],
      cleanOrders,
      [{ symbol: 'BTC/USDT', qty: 1 }],
      (event) => events.push(event),
    ).runOnce()

    expect(output.result.actions.length).toBeGreaterThan(0)
    expect(output.result.actions.some((action) => action.kind === 'alert_unprotected_position')).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    expect(output.freezeTrading).toBe(true)
  })

  it('alerts and freezes on a quantity mismatch', async () => {
    const events: ReconciliationEvent[] = []
    const output = await reconciler(
      [{ clientOrderId: 'local-1', symbol: 'BTC/USDT' }],
      [{ symbol: 'BTC/USDT', qty: 2 }],
      cleanOrders,
      protectedPositions,
      (event) => events.push(event),
    ).runOnce()

    expect(output.result.actions.length).toBeGreaterThan(0)
    expect(output.result.actions.some((action) => action.kind === 'alert_qty_mismatch')).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    expect(output.freezeTrading).toBe(true)
  })
})

describe('halt/resume command handlers', () => {
  it('halt 撤普通挂单并保留非空持仓的保护单，提示与实际结果一致', async () => {
    const db = heartbeatDb()
    try {
      const clock = new ReplayClock(START)
      const heartbeat = new HeartbeatStore(new Statements(db))
      const broker = new PaperBroker({ clock, book: { price: () => 100 }, initialEquityQuote: 1_000, slippageBps: 0, feeBps: 0 })
      await broker.placeOrder({ intentId: 'entry', clientOrderId: 'entry', decisionId: 'entry', symbol: 'BTC/USDT', type: 'market', side: 'buy', qty: 1, notionalUsd: 100 })
      await broker.placeProtective({ symbol: 'BTC/USDT', clientOrderId: 'stop', stopLossPrice: 95 })
      await broker.placeOrder({ intentId: 'pending', clientOrderId: 'pending', decisionId: 'pending', symbol: 'BTC/USDT', type: 'limit', side: 'buy', price: 90, qty: 1, notionalUsd: 90 })
      expect(await broker.getOpenOrders()).toHaveLength(2)
      expect(await broker.getPositions()).toHaveLength(1)

      const halt = makeHaltHandler({ heartbeat, clock, broker })
      const first = await halt(noOpInvocation())
      const second = await halt(noOpInvocation())
      expect(first).toEqual({ kind: 'success', text: '已暂停交易并撤销普通挂单，保护单保留。' })
      expect(second).toEqual(first)
      expect(heartbeat.isHalted()).toBe(true)
      expect((await broker.getOpenOrders()).map((order) => order.clientOrderId)).toEqual(['stop'])
      expect((await broker.getPositions())[0]).toMatchObject({ qty: 1, protectedStopPrice: 95 })
    } finally {
      db.close()
    }
  })

  it('在 handler 调用时读取晚到的 broker，而不是在注册时捕获空值', async () => {
    const db = heartbeatDb()
    try {
      const heartbeat = new HeartbeatStore(new Statements(db))
      const clock = new ReplayClock(START)
      let currentBroker: { cancelAll: () => Promise<void> } | undefined
      let cancelCalls = 0
      const halt = makeHaltHandler({
        heartbeat,
        clock,
        brokerProvider: () => currentBroker,
      })

      const beforeRuntime = await halt(noOpInvocation())
      expect(beforeRuntime.kind).toBe('error')
      expect(heartbeat.isHalted()).toBe(true)

      // 模拟 exec runtime 在 commands 注册之后才就绪；下一次命令必须使用新 broker。
      currentBroker = { cancelAll: async () => void cancelCalls++ }
      const afterRuntime = await halt(noOpInvocation())
      expect(afterRuntime.kind).toBe('success')
      expect(cancelCalls).toBe(1)
    } finally {
      db.close()
    }
  })

  it('halts and cancels successfully, then resumes without trading actions', async () => {
    const db = heartbeatDb()
    try {
      const heartbeat = new HeartbeatStore(new Statements(db))
      const clock = new ReplayClock(START)
      let cancelCalls = 0
      const audit: HeartbeatAuditEvent[] = []
      const halt = makeHaltHandler({
        heartbeat,
        clock,
        broker: { cancelAll: async () => void cancelCalls++ },
        audit: (event) => audit.push(event),
      })
      const resume = makeResumeHandler({
        heartbeat,
        clock,
        audit: (event) => audit.push(event),
      })

      const halted = await halt(noOpInvocation())
      expect(halted.kind).toBe('success')
      expect(heartbeat.isHalted()).toBe(true)
      expect(cancelCalls).toBe(1)
      expect(audit.length).toBeGreaterThan(0)
      expect(audit[0]?.actor).toBe('human')

      const resumed = await resume(noOpInvocation())
      expect(resumed.kind).toBe('success')
      expect(heartbeat.isHalted()).toBe(false)
      expect(cancelCalls).toBe(1)
      expect(audit.length).toBeGreaterThan(1)
    } finally {
      db.close()
    }
  })

  it('keeps halt when broker is unavailable or cancel fails', async () => {
    const db = heartbeatDb()
    try {
      const clock = new ReplayClock(START)
      const unavailable = new HeartbeatStore(new Statements(db))
      const unavailableResult = await makeHaltHandler({
        heartbeat: unavailable,
        clock,
      })(noOpInvocation())
      expect(unavailableResult.kind).toBe('error')
      expect(unavailableResult.text).toContain('撤单未执行，需人工核对交易所挂单')
      expect(unavailable.isHalted()).toBe(true)

      const failed = new HeartbeatStore(new Statements(db))
      const failureResult = await makeHaltHandler({
        heartbeat: failed,
        clock,
        broker: { cancelAll: async () => { throw new Error('cancel failed') } },
      })(noOpInvocation())
      expect(failureResult.kind).toBe('error')
      expect(failureResult.text).toContain('需人工核对交易所挂单')
      expect(failed.isHalted()).toBe(true)
    } finally {
      db.close()
    }
  })
})
