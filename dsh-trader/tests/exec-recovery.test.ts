import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import type { Broker, OrderAck } from '../src/exec/broker.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { CrashRecovery, frozenSymbols, type ClientOrderLookup } from '../src/exec/recovery.js'

const NOW = 1_700_000_000_000

let db: Database.Database
let journal: DecisionJournal
let clock: ReplayClock

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  journal = new DecisionJournal(db)
  clock = new ReplayClock(NOW)
})

afterEach(() => {
  db.close()
})

/** 最小的 broker 替身：只实现恢复用到的两个方法。 */
function brokerStub(options: {
  readonly lookup?: ClientOrderLookup['findOrderByClientOrderId']
  readonly open?: readonly OrderAck[]
  readonly openThrows?: boolean
}): Broker & ClientOrderLookup {
  const base = {
    venue: 'paper' as const,
    getAccount: () => Promise.reject(new Error('未实现')),
    getPositions: () => Promise.reject(new Error('未实现')),
    getOpenOrders: () => {
      if (options.openThrows === true) return Promise.reject(new Error('交易所超时'))
      return Promise.resolve(options.open ?? [])
    },
    placeOrder: () => Promise.reject(new Error('恢复流程绝不下单')),
    placeProtective: () => Promise.reject(new Error('恢复流程绝不下单')),
    cancelOrder: () => Promise.resolve(),
    cancelAll: () => Promise.resolve(),
    subscribeUserData: () => () => {},
  } satisfies Broker
  return options.lookup === undefined ? base : { ...base, findOrderByClientOrderId: options.lookup }
}

/** 造一个"崩溃现场"：意图已落库为 created，但没有 ack（进程死在这里）。 */
function crashScene(clientOrderId: string, symbol = 'BTC/USDT', decisionId = `dec:${clientOrderId}`): void {
  journal.recordDecision({
    decisionId,
    symbol,
    decidedAt: NOW,
    contextHash: `ctx:${decisionId}`,
    action: 'open',
    executed: false,
  })
  journal.recordIntent({
    intentId: `oi:${clientOrderId}`,
    clientOrderId,
    decisionId,
    venue: 'paper',
    symbol,
    state: 'created',
    type: 'market',
    side: 'buy',
    qty: 1,
    reduceOnly: false,
    createdAt: NOW,
  })
}

describe('CrashRecovery：在途意图（plan §4.2 / P1 ⑤）', () => {
  it('能查到交易所状态 ⇒ 推进意图，不冻结、不重新下单', async () => {
    crashScene('co-1')
    const recovery = new CrashRecovery({
      journal,
      clock,
      broker: brokerStub({
        lookup: (clientOrderId) =>
          Promise.resolve({ intentId: `oi:${clientOrderId}`, clientOrderId, exchangeOrderId: 'ex-1', state: 'filled', filledQty: 1, avgPrice: 100, ts: NOW }),
      }),
    })
    const result = await recovery.run()
    expect(result.scanned).toBe(1)
    expect(result.resolved[0]?.outcome).toMatchObject({ kind: 'resolved', state: 'filled' })
    expect(result.freezeSymbols).toEqual([])
    expect(journal.inFlightIntents()).toHaveLength(0)
    expect(journal.fillIds()).toEqual(['fill:ex-1:terminal'])
    expect(journal.recentDecisions()[0]?.outcomeId).toBeNull()
    const recoveredDecision = db.prepare('SELECT executed, reflection_due_at FROM decisions WHERE decision_id = ?').get('dec:co-1') as { executed: number; reflection_due_at: number | null }
    expect(recoveredDecision.executed).toBe(1)
    expect(recoveredDecision.reflection_due_at).not.toBeNull()
    // 恢复绝不产生新决策、新意图
    expect(journal.decisionIds()).toEqual(['dec:co-1'])
    expect(journal.intentIds()).toEqual(['oi:co-1'])
  })

  it('查不到 / broker 不支持查询 ⇒ 标 unknown 并冻结该标的（绝不猜）', async () => {
    crashScene('co-2', 'ETH/USDT')
    const recovery = new CrashRecovery({ journal, clock, broker: brokerStub({ lookup: () => Promise.resolve(undefined) }) })
    const result = await recovery.run()

    expect(result.freezeSymbols).toEqual(['ETH/USDT'])
    expect(journal.inFlightIntents()[0]?.state).toBe('unknown')
    expect(result.alerts.some((alert) => alert.code === 'orphan_intent_unknown')).toBe(true)
    expect(frozenSymbols(result).has('ETH/USDT')).toBe(true)

  })

  it('broker 不支持按 client_order_id 查询 ⇒ 同样只能判未知（不许猜）', async () => {
    crashScene('co-3', 'SOL/USDT')
    const result = await new CrashRecovery({ journal, clock, broker: brokerStub({}) }).run()
    expect(result.scanned).toBe(1)
    expect(result.freezeSymbols).toEqual(['SOL/USDT'])
    expect(result.resolved[0]?.outcome).toMatchObject({ kind: 'unknown' })
    expect((result.resolved[0]?.outcome as { reason: string }).reason).toContain('不支持按 client_order_id 查询')
  })

  it('查询本身抛错也算"未知"（不把故障当成"没这单"）', async () => {
    crashScene('co-4')
    const recovery = new CrashRecovery({
      journal,
      clock,
      broker: brokerStub({ lookup: () => Promise.reject(new Error('ECONNRESET')) }),
    })
    const result = await recovery.run()
    expect(result.resolved[0]?.outcome).toMatchObject({ kind: 'unknown' })
    expect((result.resolved[0]?.outcome as { reason: string }).reason).toContain('ECONNRESET')
  })

  it('恢复可重复执行：第二遍是 no-op，且**不新增决策**（P1 ⑤ 的"无重复决策"）', async () => {
    crashScene('co-5')
    const recovery = new CrashRecovery({ journal, clock, broker: brokerStub({}) })
    const first = await recovery.run()
    const decisionsAfterFirst = journal.decisionIds()
    const intentsAfterFirst = journal.intentIds()

    const second = await recovery.run()
    // 第一遍已把它标成 unknown ⇒ 仍在"在途"集合里（unknown 需要人工处理），
    // 但状态与集合都不再变化
    expect(second.freezeSymbols).toEqual(first.freezeSymbols)
    expect(journal.decisionIds()).toEqual(decisionsAfterFirst)
    expect(journal.intentIds()).toEqual(intentsAfterFirst)
    expect(journal.duplicateClientOrderIds()).toBe(0)
  })

  it('孤儿挂单：交易所挂着、本地无记录 ⇒ 报 critical（不静默）', async () => {
    crashScene('co-6')
    const recovery = new CrashRecovery({
      journal,
      clock,
      symbols: ['BTC/USDT'],
      broker: brokerStub({
        lookup: () => Promise.resolve(undefined),
        open: [
          { intentId: 'x', clientOrderId: 'co-6', exchangeOrderId: 'ex-known', state: 'acked', ts: NOW },
          { intentId: 'y', clientOrderId: 'co-orphan', exchangeOrderId: 'ex-orphan', state: 'acked', ts: NOW },
        ],
      }),
    })
    const result = await recovery.run()
    expect(result.orphanOpenOrders).toEqual([{ symbol: 'BTC/USDT', exchangeOrderId: 'ex-orphan' }])
    expect(result.alerts.some((alert) => alert.code === 'orphan_open_order')).toBe(true)
  })

  it('读挂单失败 ⇒ 告警"恢复不完整"，而不是当成"没有孤儿订单"', async () => {
    crashScene('co-7')
    const recovery = new CrashRecovery({
      journal,
      clock,
      symbols: ['BTC/USDT'],
      broker: brokerStub({ lookup: () => Promise.resolve(undefined), openThrows: true }),
    })
    const result = await recovery.run()
    expect(result.orphanOpenOrders).toEqual([])
    expect(result.alerts.some((alert) => alert.code === 'open_orders_unavailable')).toBe(true)
  })

  it('没有在途意图时是干净的空操作', async () => {
    const recovery = new CrashRecovery({ journal, clock, broker: brokerStub({}) })
    expect(await recovery.run()).toMatchObject({ scanned: 0, freezeSymbols: [], orphanOpenOrders: [] })
  })
})

describe('恢复对未定状态必须冻结（审计修复）', () => {
  it('★ 交易所返回 created/unknown ⇒ 标 unknown + 冻结标的，绝不记 acked', async () => {
    crashScene('co-unknown')
    const recovery = new CrashRecovery({
      journal,
      clock,
      broker: brokerStub({
        lookup: (clientOrderId) =>
          Promise.resolve({ intentId: `oi:${clientOrderId}`, clientOrderId, state: 'unknown', ts: NOW }),
      }),
    })
    const result = await recovery.run()
    expect(result.freezeSymbols).toContain('BTC/USDT')
    expect(result.resolved[0]?.outcome.kind).toBe('unknown')
    const row = db.prepare('SELECT state, acked_at FROM order_intents WHERE client_order_id = ?').get('co-unknown') as {
      state: string
      acked_at: number | null
    }
    expect(row.state).toBe('unknown')
    expect(row.acked_at).toBeNull()

    crashScene('co-created')
    const recovery2 = new CrashRecovery({
      journal,
      clock,
      broker: brokerStub({
        lookup: (clientOrderId) =>
          Promise.resolve({ intentId: `oi:${clientOrderId}`, clientOrderId, state: 'created', ts: NOW }),
      }),
    })
    expect((await recovery2.run()).freezeSymbols).toContain('BTC/USDT')
  })
})
