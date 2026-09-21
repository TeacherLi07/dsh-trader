import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS, StartupParamsError } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import type { AccountSnapshot, Broker, OrderAck, OrderRequest, PositionSnapshot } from '../src/exec/broker.js'
import { validateIntent } from '../src/exec/gate.js'
import { DecisionJournal } from '../src/exec/journal.js'
import {
  hasReadOnlyBalance,
  LocalStateReader,
  runReadOnlyPreflight,
  type ReadOnlyBalanceSource,
} from '../src/exec/preflight.js'
import { apply as applyExecPlugin, credentialStatus, limitsFromConfig } from '../src/plugins/exec.js'
import type { LocalOrderSnapshot } from '../src/exec/reconcile.js'

const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT:USDT'

function localOrder(
  clientOrderId: string,
  options: { readonly state?: LocalOrderSnapshot['state'] } = {},
): LocalOrderSnapshot {
  return { clientOrderId, symbol: SYMBOL, state: options.state ?? 'open' }
}

interface FakeBrokerCalls {
  getAccount: number
  placeOrder: number
  placeProtective: number
  cancelOrder: number
  cancelAll: number
}

interface FakeBrokerOptions {
  readonly positions?: readonly PositionSnapshot[]
  readonly openOrders?: readonly OrderAck[]
  /** 省略 = broker 不提供只读余额能力（报告应写 null，而不是 0）。 */
  readonly equity?: number
}

function fakeBroker(options: FakeBrokerOptions = {}): {
  readonly broker: Broker & Partial<ReadOnlyBalanceSource>
  readonly calls: FakeBrokerCalls
} {
  const calls: FakeBrokerCalls = {
    getAccount: 0,
    placeOrder: 0,
    placeProtective: 0,
    cancelOrder: 0,
    cancelAll: 0,
  }
  const base: Broker = {
    venue: 'htx',
    getAccount: () => {
      calls.getAccount += 1
      return Promise.reject(new Error('只读预检不得调用 getAccount（它需要 RiskStateProvider）'))
    },
    getPositions: () => Promise.resolve(options.positions ?? []),
    getOpenOrders: () => Promise.resolve(options.openOrders ?? []),
    placeOrder: (_request: OrderRequest) => {
      calls.placeOrder += 1
      return Promise.reject(new Error('只读预检不得下单'))
    },
    placeProtective: () => {
      calls.placeProtective += 1
      return Promise.reject(new Error('只读预检不得挂保护单'))
    },
    cancelOrder: () => {
      calls.cancelOrder += 1
      return Promise.resolve()
    },
    cancelAll: () => {
      calls.cancelAll += 1
      return Promise.resolve()
    },
    subscribeUserData: () => () => {},
  }
  if (options.equity === undefined) return { broker: base, calls }
  return { broker: { ...base, readOnlyBalance: () => Promise.resolve(options.equity as number) }, calls }
}

function position(qty: number): PositionSnapshot {
  return { symbol: SYMBOL, qty, avgPrice: 60_000, unrealizedPnlUsd: 1.23 }
}

function openOrder(clientOrderId: string): OrderAck {
  return { intentId: clientOrderId, clientOrderId, exchangeOrderId: `x-${clientOrderId}`, state: 'acked', ts: NOW }
}

describe('T2.x 只读预检（plan §12.2 A 第①步）', () => {
  it('报告远端未知持仓为 P0 冻结，且**绝不**执行任何动作', async () => {
    const { broker, calls } = fakeBroker({ positions: [position(0.1)], equity: 1234.5 })
    const report = await runReadOnlyPreflight({
      broker,
      clock: new ReplayClock(NOW),
      localOrders: [],
      localPositions: [],
    })

    // 非空跑：远端确实有 1 个持仓，否则"孤儿=0"式的结论没有意义
    expect(report.remote.positions).toBe(1)
    expect(report.equityQuote).toBe(1234.5)
    expect(report.freezeTrading).toBe(true)
    expect(report.actionKinds['alert_unknown_position']).toBe(1)
    expect(report.consistent).toBe(false)

    // 只读的结构性证据
    expect(report.readOnly).toBe(true)
    expect(report.executedActions).toEqual([])
    expect(calls.placeOrder).toBe(0)
    expect(calls.placeProtective).toBe(0)
    expect(calls.cancelOrder).toBe(0)
    expect(calls.cancelAll).toBe(0)
    expect(calls.getAccount).toBe(0)
  })

  it('本地与远端一致时报告 consistent，且不产生动作', async () => {
    const { broker, calls } = fakeBroker({
      // 保护必须来自远端 broker snapshot；本地 stop intent 不是交易所生效证据。
      positions: [{ ...position(0.1), protectedStopPrice: 59_000 }],
      openOrders: [openOrder('co-1')],
      equity: 1000,
    })
    const report = await runReadOnlyPreflight({
      broker,
      clock: new ReplayClock(NOW),
      localOrders: [localOrder('co-1', { state: 'open' })],
      localPositions: [{ symbol: SYMBOL, qty: 0.1, protectedStopPrice: 59_000 }],
    })

    expect(report.remote.openOrders).toBe(1)
    expect(report.consistent).toBe(true)
    expect(report.actions).toEqual([])
    expect(report.freezeTrading).toBe(false)
    expect(calls.cancelAll).toBe(0)
  })

  it('broker 没有只读余额能力时写 null，绝不用 0 冒充', async () => {
    const { broker } = fakeBroker({})
    const report = await runReadOnlyPreflight({
      broker,
      clock: new ReplayClock(NOW),
      localOrders: [],
      localPositions: [],
    })
    expect(report.equityQuote).toBeNull()
    expect(report.notes.some((note) => note.includes('readOnlyBalance'))).toBe(true)
    expect(hasReadOnlyBalance(broker)).toBe(false)
  })

  it('hasReadOnlyBalance 能识别能力', () => {
    const without = fakeBroker({}).broker
    const withBalance = fakeBroker({ equity: 5 }).broker
    expect(hasReadOnlyBalance(without)).toBe(false)
    expect(hasReadOnlyBalance(withBalance)).toBe(true)
  })

  it('★ 安全性质：mode=paper + venue=htx 时硬闸结构性 deny（只读阶段的真正保障）', () => {
    const account: AccountSnapshot = {
      venue: 'htx',
      equityQuote: 10_000,
      totalExposureUsd: 0,
      pendingExposureUsd: 0,
      openOrders: 0,
      leverage: 0,
      dailyLossUsd: 0,
      drawdownUsd: 0,
      consecutiveLosses: 0,
      spreadBps: 1,
      observedAt: NOW,
    }
    const policy = {
      mode: 'paper' as const,
      limits: EXAMPLE_LIMITS,
      tradingWindowOpen: true,
      duplicateDecision: false,
      paperVenue: 'paper' as const,
    }
    const open: OrderRequest = {
      intentId: 'i1',
      clientOrderId: 'c1',
      decisionId: 'd1',
      symbol: SYMBOL,
      type: 'market',
      side: 'buy',
      qty: 1,
      notionalUsd: 10,
      reduceOnly: false,
    }
    // 降险单也拦：模式一致性属于"永远生效"的检查，在 reduceOnly 放行之前
    const reduce: OrderRequest = { ...open, intentId: 'i2', clientOrderId: 'c2', reduceOnly: true }

    const openVerdict = validateIntent(open, account, policy)
    const reduceVerdict = validateIntent(reduce, account, policy)
    expect(openVerdict.kind).toBe('deny')
    expect(reduceVerdict.kind).toBe('deny')
  })
})

describe('凭据状态：只输出布尔', () => {
  it('paper 模式即使有凭据也不 live（安全默认）', () => {
    const status = credentialStatus({ mode: 'paper', apiKey: 'k', apiSecret: 's' })
    expect(status).toEqual({ keyInjected: true, secretInjected: true, liveCapable: false, route: 'paper' })
  })

  it('live broker route 缺凭据标记为 paper；runtime 启动仍另行 fail-closed', () => {
    expect(credentialStatus({ mode: 'live_auto' })).toEqual({
      keyInjected: false,
      secretInjected: false,
      liveCapable: false,
      route: 'paper',
    })
    expect(credentialStatus({ mode: 'live_auto', liveArmed: true, apiKey: 'k' }).liveCapable).toBe(false)
    expect(credentialStatus({ mode: 'live_auto', apiKey: 'k', apiSecret: 's' }).route).toBe('paper')
  })

  it('live_auto + 显式 arm + 两把凭据才 liveCapable', () => {
    const status = credentialStatus({ mode: 'live_auto', liveArmed: true, apiKey: 'k', apiSecret: 's' })
    expect(status.liveCapable).toBe(true)
    expect(status.route).toBe('ccxt')
  })
})

describe('plugin 风险限额解析', () => {
  it('全空表示未提供，部分配置必须报错而不能混同为 waiver', () => {
    expect(limitsFromConfig({ mode: 'paper' })).toBeNull()
    expect(() => limitsFromConfig({ mode: 'paper', perOrderCapUsd: 10 })).toThrow(StartupParamsError)
  })

  it('armed live_auto 缺 API 凭据时在插件入口同步拒绝，不启动 paper runtime', () => {
    const context = { logger: () => ({ info: () => undefined }) } as never
    expect(() => applyExecPlugin(context, {
      mode: 'live_auto', liveArmed: true, reconcileEnabled: true,
    })).toThrow(/API key 与 secret/)
  })
})

describe('LocalStateReader（只读本地状态）', () => {
  function seeded(): Database.Database {
    const db = new Database(':memory:')
    migrate(db)
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'd1',
      symbol: SYMBOL,
      decidedAt: NOW,
      contextHash: 'ctx:1',
      action: 'open',
      executed: true,
    })
    journal.recordIntent({
      intentId: 'oi1',
      clientOrderId: 'co-filled',
      decisionId: 'd1',
      venue: 'paper',
      symbol: SYMBOL,
      state: 'filled',
      type: 'market',
      side: 'buy',
      qty: 0.1,
      reduceOnly: false,
      createdAt: NOW,
    })
    journal.recordOrder({
      orderId: 'o1',
      venue: 'paper',
      exchangeOrderId: 'o1',
      clientOrderId: 'co-filled',
      symbol: SYMBOL,
      status: 'filled',
      qty: 0.1,
      filledQty: 0.1,
      avgPrice: 60_000,
      updatedAt: NOW,
    })
    journal.recordFill({
      fillId: 'f1',
      orderId: 'o1',
      qty: 0.1,
      price: 60_000,
      fee: 0.3,
      feeCurrency: 'USDT',
      ts: NOW,
    })
    // 部分平仓 0.05 ⇒ 本地净持仓应为 0.05
    journal.recordDecision({
      decisionId: 'd2',
      symbol: SYMBOL,
      decidedAt: NOW + 1000,
      contextHash: 'ctx:2',
      action: 'reduce',
      executed: true,
    })
    journal.recordIntent({
      intentId: 'oi2',
      clientOrderId: 'co-close',
      decisionId: 'd2',
      venue: 'paper',
      symbol: SYMBOL,
      state: 'filled',
      type: 'market',
      side: 'sell',
      qty: 0.05,
      reduceOnly: true,
      createdAt: NOW + 1000,
    })
    journal.recordOrder({
      orderId: 'o2',
      venue: 'paper',
      exchangeOrderId: 'o2',
      clientOrderId: 'co-close',
      symbol: SYMBOL,
      status: 'filled',
      qty: 0.05,
      filledQty: 0.05,
      avgPrice: 61_000,
      updatedAt: NOW + 1000,
    })
    journal.recordFill({
      fillId: 'f2',
      orderId: 'o2',
      qty: 0.05,
      price: 61_000,
      fee: 0.15,
      feeCurrency: 'USDT',
      ts: NOW + 1000,
    })
    // 一条 created（未 ack）与一条 acked（挂着）——才应进入本地挂单视图
    journal.recordIntent({
      intentId: 'oi3',
      clientOrderId: 'co-created',
      decisionId: 'd1',
      venue: 'paper',
      symbol: SYMBOL,
      state: 'created',
      type: 'limit',
      side: 'buy',
      qty: 0.02,
      reduceOnly: false,
      createdAt: NOW + 2000,
    })
    journal.recordIntent({
      intentId: 'oi4',
      clientOrderId: 'co-acked',
      decisionId: 'd1',
      venue: 'paper',
      symbol: SYMBOL,
      state: 'acked',
      type: 'limit',
      side: 'sell',
      qty: 0.01,
      reduceOnly: true,
      createdAt: NOW + 3000,
    })
    return db
  }

  it('orders() 只映射 created→pending 与 acked→open', () => {
    const db = seeded()
    const reader = new LocalStateReader(db)
    const orders = reader.orders()
    expect(orders.length).toBe(2) // 非空跑：恰好两条未结
    const byId = new Map(orders.map((order) => [order.clientOrderId, order.state]))
    expect(byId.get('co-created')).toBe('pending')
    expect(byId.get('co-acked')).toBe('open')
    db.close()
  })

  it('positions() 用真实成交重建净持仓（买 0.1 / 卖 0.05 ⇒ 0.05）', () => {
    const db = seeded()
    const reader = new LocalStateReader(db)
    const positions = reader.positions()
    expect(positions.length).toBe(1) // 非空跑
    expect(positions[0]?.symbol).toBe(SYMBOL)
    expect(positions[0]?.qty).toBeCloseTo(0.05, 10)
    db.close()
  })

  it('空库 ⇒ 空挂单/空持仓（不编造）', () => {
    const db = new Database(':memory:')
    migrate(db)
    const reader = new LocalStateReader(db)
    expect(reader.orders()).toEqual([])
    expect(reader.positions()).toEqual([])
    db.close()
  })
})
