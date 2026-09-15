import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SimExchange } from '../src/exec/sim-exchange.js'
import type { OrderRequest } from '../src/exec/broker.js'

const SYMBOL = 'BTC/USDT'

let dir: string
let dbPath: string
let exchange: SimExchange

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-sim-exchange-'))
  dbPath = join(dir, 'exchange.db')
  exchange = new SimExchange(dbPath)
})

afterEach(() => {
  exchange.close()
  rmSync(dir, { recursive: true, force: true })
})

function request(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return {
    intentId: 'intent-1',
    clientOrderId: 'client-1',
    decisionId: 'decision-1',
    symbol: SYMBOL,
    type: 'market',
    side: 'buy',
    qty: 1,
    notionalUsd: 100,
    ...overrides,
  }
}

describe('SimExchange：持久化与严格幂等', () => {
  it('同一 clientOrderId 重复提交只产生一笔成交，重开后仍返回原 ack', async () => {
    exchange.onPrice(SYMBOL, 100)
    const first = await exchange.placeOrder(request())
    const second = await exchange.placeOrder(request({ intentId: 'intent-retry', decisionId: 'decision-retry' }))

    expect(first).toEqual(second)
    expect(exchange.fillCount()).toBe(1)
    expect(exchange.allFills().length).toBeGreaterThan(0)
    expect(exchange.allFills()[0]?.clientOrderId).toBe('client-1')
    expect((await exchange.getPositions())[0]?.qty).toBe(1)

    const exchangeOrderId = first.exchangeOrderId
    expect(exchangeOrderId).toBeDefined()
    expect(await exchange.findOrderByClientOrderId('missing')).toBeUndefined()
    exchange.close()

    exchange = new SimExchange(dbPath)
    const afterRestart = await exchange.findOrderByClientOrderId('client-1')
    expect(afterRestart).toEqual(first)
    expect(exchange.fillCount()).toBe(1)
    expect(exchange.openOrderCount()).toBe(0)
    expect((await exchange.getPositions())[0]).toMatchObject({ symbol: SYMBOL, qty: 1, avgPrice: 100 })
  })
})

describe('SimExchange：市价/限价撮合与撤单', () => {
  it('未交叉的限价单在后续 onPrice 触价成交，撤单后不会再成交', async () => {
    exchange.onPrice(SYMBOL, 100)
    const limit = await exchange.placeOrder(
      request({ clientOrderId: 'limit-1', intentId: 'limit-intent-1', type: 'limit', price: 95, qty: 2 }),
    )
    expect(limit.state).toBe('acked')
    expect(exchange.openOrderCount()).toBe(1)
    expect((await exchange.getOpenOrders(SYMBOL)).length).toBe(1)

    exchange.onPrice(SYMBOL, 96)
    expect(exchange.fillCount()).toBe(0)
    exchange.onPrice(SYMBOL, 95)
    expect(exchange.fillCount()).toBe(1)
    expect((await exchange.findOrderByClientOrderId('limit-1'))?.state).toBe('filled')

    const canceled = await exchange.placeOrder(
      request({ clientOrderId: 'limit-2', intentId: 'limit-intent-2', type: 'limit', price: 90 }),
    )
    expect(canceled.state).toBe('acked')
    expect(exchange.openOrderCount()).toBe(1)
    await exchange.cancelOrder(canceled.exchangeOrderId as string)
    expect(exchange.openOrderCount()).toBe(0)
    exchange.onPrice(SYMBOL, 89)
    expect(exchange.fillCount()).toBe(1)
    expect((await exchange.findOrderByClientOrderId('limit-2'))?.state).toBe('canceled')
  })

  it('cancelAll 可按标的撤掉多个挂单，查询不到订单返回 undefined', async () => {
    exchange.onPrice(SYMBOL, 100)
    exchange.onPrice('ETH/USDT', 100)
    await exchange.placeOrder(request({ clientOrderId: 'cancel-btc-1', intentId: 'cancel-intent-1', type: 'limit', price: 90 }))
    await exchange.placeOrder(
      request({
        clientOrderId: 'cancel-eth-1',
        intentId: 'cancel-intent-2',
        symbol: 'ETH/USDT',
        type: 'limit',
        price: 90,
      }),
    )
    expect(exchange.openOrderCount()).toBe(2)
    await exchange.cancelAll(SYMBOL)
    expect(exchange.openOrderCount()).toBe(1)
    expect(exchange.openOrders().every((order) => order.symbol === 'ETH/USDT')).toBe(true)
    await exchange.cancelAll()
    expect(exchange.openOrderCount()).toBe(0)
    expect(await exchange.findOrderByClientOrderId('does-not-exist')).toBeUndefined()
  })
})

describe('SimExchange：交易所侧保护单', () => {
  it('保护单只在价格触发时 reduceOnly 平仓，且不依赖再次提交模型订单', async () => {
    exchange.onPrice(SYMBOL, 100)
    await exchange.placeOrder(request({ clientOrderId: 'entry-1', intentId: 'entry-intent-1' }))
    const protective = await exchange.placeProtective({
      symbol: SYMBOL,
      clientOrderId: 'stop-1',
      stopLossPrice: 90,
      takeProfitPrice: 120,
    })

    expect(protective.state).toBe('acked')
    expect(exchange.openOrderCount()).toBe(1)
    expect((await exchange.getPositions())[0]?.qty).toBe(1)
    const beforeTrigger = exchange.fillCount()
    expect(beforeTrigger).toBeGreaterThan(0)

    expect(exchange.onPrice(SYMBOL, 95)).toEqual([])
    expect(exchange.fillCount()).toBe(beforeTrigger)
    const triggered = exchange.onPrice(SYMBOL, 90)
    expect(triggered.length).toBe(1)
    expect(triggered[0]?.state).toBe('filled')
    expect(exchange.fillCount()).toBe(beforeTrigger + 1)
    expect(await exchange.getPositions()).toEqual([])
    expect(exchange.openOrderCount()).toBe(0)
    expect((await exchange.findOrderByClientOrderId('stop-1'))?.state).toBe('filled')
  })

  it('空仓不能挂保护单，空头保护单触发时也不会反手开仓', async () => {
    await expect(exchange.placeProtective({ symbol: SYMBOL, stopLossPrice: 90 })).rejects.toThrow('没有持仓')
    exchange.onPrice(SYMBOL, 100)
    await exchange.placeOrder(request({ clientOrderId: 'short-entry', intentId: 'short-intent', side: 'sell', qty: 2 }))
    await exchange.placeProtective({ symbol: SYMBOL, clientOrderId: 'short-stop', stopLossPrice: 110 })
    exchange.onPrice(SYMBOL, 110)
    expect(await exchange.getPositions()).toEqual([])
    expect(exchange.openOrderCount()).toBe(0)
  })
})
