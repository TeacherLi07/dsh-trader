import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import {
  Reconciler,
  reconcile,
  severityOf,
  type ReconciliationEvent,
  type ReconciliationInput,
} from '../src/exec/reconcile.js'

const clean: ReconciliationInput = {
  localOrders: [{ clientOrderId: 'o1', symbol: 'BTC/USDT', state: 'open' }],
  remoteOrders: [{ clientOrderId: 'o1', symbol: 'BTC/USDT' }],
  localPositions: [{ symbol: 'BTC/USDT', qty: 1, protectedStopPrice: 95 }],
  remotePositions: [{ symbol: 'BTC/USDT', qty: 1 }],
}

describe('reconcile', () => {
  it('reports consistency when local mirror and exchange agree', () => {
    const result = reconcile(clean)
    expect(result.actions).toEqual([])
    expect(result.consistent).toBe(true)
    expect(result.freezeTrading).toBe(false)
  })

  it('cancels an orphan order the local mirror does not know about', () => {
    const result = reconcile({
      ...clean,
      remoteOrders: [...clean.remoteOrders, { clientOrderId: 'ghost', symbol: 'BTC/USDT' }],
    })

    expect(result.actions).toEqual([
      { kind: 'cancel_orphan', clientOrderId: 'ghost', reason: '本地无记录' },
    ])
    expect(result.consistent).toBe(false)
    expect(result.freezeTrading).toBe(false)
    expect(severityOf(result.actions[0]!)).toBe('P1')
  })

  it('cancels an order the local mirror already considers finished', () => {
    const result = reconcile({
      ...clean,
      localOrders: [{ clientOrderId: 'o1', symbol: 'BTC/USDT', state: 'canceled' }],
    })
    expect(result.actions).toEqual([
      { kind: 'cancel_orphan', clientOrderId: 'o1', reason: '本地状态为 canceled' },
    ])
  })

  it('flags a locally-open order that the exchange does not have', () => {
    const result = reconcile({ ...clean, remoteOrders: [] })
    expect(result.actions).toEqual([
      {
        kind: 'alert_missing_order',
        clientOrderId: 'o1',
        reason: '本地标记为未结，但交易所无此单',
      },
    ])
  })

  it('freezes trading on an unknown position rather than guessing', () => {
    const result = reconcile({
      ...clean,
      remotePositions: [
        { symbol: 'BTC/USDT', qty: 1 },
        { symbol: 'ETH/USDT', qty: 3 },
      ],
    })

    expect(result.actions).toContainEqual({
      kind: 'alert_unknown_position',
      symbol: 'ETH/USDT',
      qty: 3,
    })
    expect(result.freezeTrading).toBe(true)
    expect(severityOf({ kind: 'alert_unknown_position', symbol: 'ETH/USDT', qty: 3 })).toBe('P0')
  })

  it('treats a position without a protective order as a P0 inconsistency', () => {
    const result = reconcile({
      ...clean,
      localPositions: [{ symbol: 'BTC/USDT', qty: 1 }],
    })
    expect(result.actions).toEqual([{ kind: 'alert_unprotected_position', symbol: 'BTC/USDT' }])
    expect(severityOf(result.actions[0]!)).toBe('P0')
  })

  it('flags a quantity mismatch in both directions', () => {
    const result = reconcile({
      ...clean,
      localPositions: [{ symbol: 'BTC/USDT', qty: 1, protectedStopPrice: 95 }],
      remotePositions: [{ symbol: 'BTC/USDT', qty: 2 }],
    })
    expect(result.actions).toContainEqual({
      kind: 'alert_qty_mismatch',
      symbol: 'BTC/USDT',
      local: 1,
      remote: 2,
    })
  })

  it('flags a local position the exchange does not have (ghost position)', () => {
    const result = reconcile({ ...clean, remotePositions: [] })
    expect(result.actions).toContainEqual({
      kind: 'alert_qty_mismatch',
      symbol: 'BTC/USDT',
      local: 1,
      remote: 0,
    })
  })

  it('is pure — identical input gives identical output', () => {
    expect(reconcile(clean)).toEqual(reconcile(clean))
  })

  it('把远端 exchangeOrderId 带进 cancel_orphan（撤单必须用它，不能用 clientOrderId 顶替）', () => {
    const result = reconcile({
      ...clean,
      remoteOrders: [
        ...clean.remoteOrders,
        { clientOrderId: 'ghost', exchangeOrderId: 'ex-9', symbol: 'BTC/USDT' },
      ],
    })
    expect(result.actions).toEqual([
      { kind: 'cancel_orphan', clientOrderId: 'ghost', exchangeOrderId: 'ex-9', reason: '本地无记录' },
    ])
  })
})

/**
 * 撤单端点的契约参数是 exchangeOrderId（broker.ts）。旧实现把 clientOrderId 当 exchangeOrderId
 * 传给交易所，在"交易所不回显我们 client id"的 venue（HTX 实测）上会指向不存在的订单。
 * 这组测试钉住：① 用对 id；② 缺 id 时 fail-closed（不撤单 + 冻结 + P0 告警）。
 */
describe('Reconciler：孤儿单撤单的 ID 语义', () => {
  function build(
    remoteOrders: readonly { readonly clientOrderId: string; readonly exchangeOrderId?: string }[],
    onAlert?: (event: ReconciliationEvent) => void,
  ): { readonly canceled: string[]; readonly reconciler: Reconciler } {
    const canceled: string[] = []
    const reconciler = new Reconciler({
      broker: {
        getOpenOrders: () => remoteOrders,
        getPositions: () => [],
        cancelOrder: async (exchangeOrderId: string) => {
          canceled.push(exchangeOrderId)
        },
      },
      clock: new ReplayClock(0),
      localOrders: [],
      localPositions: [],
      onAlert: (event) => onAlert?.(event),
    })
    return { canceled, reconciler }
  }

  it('用 exchangeOrderId 撤单，而不是 clientOrderId', async () => {
    const { canceled, reconciler } = build([{ clientOrderId: 'c1', exchangeOrderId: 'ex9' }])
    const result = await reconciler.runOnce()
    expect(canceled).toEqual(['ex9'])
    expect(result.freezeTrading).toBe(false)
  })

  it('缺 exchangeOrderId ⇒ 不调用撤单、冻结、P0 告警', async () => {
    const events: ReconciliationEvent[] = []
    const { canceled, reconciler } = build([{ clientOrderId: 'c1' }], (event) => events.push(event))
    const result = await reconciler.runOnce()
    expect(canceled).toEqual([])
    expect(result.freezeTrading).toBe(true)
    expect(events.some((event) => event.level === 'P0' && event.message.includes('exchangeOrderId'))).toBe(true)
  })
})
