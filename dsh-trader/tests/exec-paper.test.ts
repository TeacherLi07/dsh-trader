import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import type { OrderRequest } from '../src/exec/broker.js'
import { PaperBroker, type PaperBook, type PaperBrokerOptions } from '../src/exec/paper.js'

const SYMBOL = 'BTC/USDT'
const START = 1_700_000_000_000

function setup(initialPrice = 100, over: Partial<PaperBrokerOptions> = {}) {
  const clock = new ReplayClock(START)
  let price = initialPrice
  const book: PaperBook = { price: () => price }
  const broker = new PaperBroker({
    clock,
    book,
    initialEquityQuote: 10_000,
    slippageBps: 0,
    feeBps: 0,
    ...over,
  })
  return { clock, broker, setPrice: (next: number): void => void (price = next) }
}

const request = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  intentId: 'i1',
  clientOrderId: 'c1',
  decisionId: 'd1',
  symbol: SYMBOL,
  type: 'market',
  side: 'buy',
  qty: 1,
  notionalUsd: 100,
  ...over,
})

describe('PaperBroker', () => {
  it('fills a market order at the reference price', async () => {
    const { broker } = setup()
    const ack = await broker.placeOrder(request())

    expect(ack.state).toBe('filled')
    const positions = await broker.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0]?.qty).toBe(1)
    expect(positions[0]?.avgPrice).toBe(100)
  })

  it('applies slippage against the taker', async () => {
    const { broker } = setup(100, { slippageBps: 10 })
    await broker.placeOrder(request({ side: 'buy' }))
    await broker.placeOrder(request({ intentId: 'i2', clientOrderId: 'c2', side: 'sell' }))

    // 买在 100.1、卖在 99.9 ⇒ 已实现亏损，而不是"零成本来回"
    expect(broker.realizedPnl()).toBeLessThan(0)
  })

  it('charges fees and lowers equity accordingly', async () => {
    const { broker } = setup(100, { feeBps: 10 })
    await broker.placeOrder(request())

    const account = await broker.getAccount()
    // 现金 10000 - 100 - 0.1 手续费 = 9899.9；权益 = 现金 + 1×100 = 9999.9
    expect(account.equityQuote).toBeCloseTo(9_999.9, 6)
    expect(account.totalExposureUsd).toBeCloseTo(100, 6)
  })

  it('is idempotent per clientOrderId — a retry never fills twice', async () => {
    const { broker } = setup()
    await broker.placeOrder(request())
    await broker.placeOrder(request())

    const positions = await broker.getPositions()
    expect(positions[0]?.qty).toBe(1)
    expect(broker.cash()).toBeCloseTo(9_900, 6)
  })

  it('leaves an uncrossed limit order open and fills a crossed one', async () => {
    const { broker } = setup(100)

    const resting = await broker.placeOrder(
      request({ clientOrderId: 'limit-low', type: 'limit', price: 90 }),
    )
    expect(resting.state).toBe('acked')
    expect(await broker.getOpenOrders()).toHaveLength(1)

    const crossed = await broker.placeOrder(
      request({ clientOrderId: 'limit-high', type: 'limit', price: 110 }),
    )
    expect(crossed.state).toBe('filled')
  })

  it('reserves pending limit exposure and preserves protective orders during cancelAll', async () => {
    const { broker } = setup(100)
    await broker.placeOrder(request())
    const stop = await broker.placeProtective({ symbol: SYMBOL, stopLossPrice: 90, clientOrderId: 'stop' })
    expect(stop.state).toBe('acked')
    await broker.placeOrder(request({
      intentId: 'limit', clientOrderId: 'limit', type: 'limit', price: 90, qty: 2, notionalUsd: 180,
    }))

    expect((await broker.getAccount()).pendingExposureUsd).toBe(180)
    await broker.cancelAll(SYMBOL)
    expect((await broker.getOpenOrders(SYMBOL)).map((order) => order.clientOrderId)).toEqual(['stop'])
    await expect(broker.cancelAll(SYMBOL, { includeProtection: true })).rejects.toThrow(/仍有持仓/)

    await broker.placeOrder(request({ intentId: 'close', clientOrderId: 'close', side: 'sell', reduceOnly: true }))
    expect(await broker.getPositions()).toHaveLength(0)
    await broker.cancelAll(SYMBOL, { includeProtection: true })
    expect(await broker.getOpenOrders(SYMBOL)).toHaveLength(0)
  })

  it('rejects a limit order with no price instead of guessing one', async () => {
    const { broker } = setup()
    const ack = await broker.placeOrder(request({ type: 'limit' }))
    expect(ack.state).toBe('rejected')
  })

  it('triggers a protective stop from the bar low and closes the position', async () => {
    const { broker } = setup(100)
    await broker.placeOrder(request())
    await broker.placeProtective({ symbol: SYMBOL, stopLossPrice: 95 })

    const before = broker.onBar(SYMBOL, { high: 101, low: 96, close: 100 })
    expect(before).toHaveLength(0)

    const acks = broker.onBar(SYMBOL, { high: 100, low: 94, close: 94 })
    expect(acks).toHaveLength(1)
    expect(acks[0]?.state).toBe('filled')
    expect(await broker.getPositions()).toHaveLength(0)
    expect(broker.realizedPnl()).toBeCloseTo(-5, 6)
  })

  it('triggers a take-profit from the bar high', async () => {
    const { broker } = setup(100)
    await broker.placeOrder(request())
    await broker.placeProtective({ symbol: SYMBOL, takeProfitPrice: 110 })

    const acks = broker.onBar(SYMBOL, { high: 111, low: 99, close: 110 })
    expect(acks).toHaveLength(1)
    expect(broker.realizedPnl()).toBeCloseTo(10, 6)
  })

  it('tracks exposure, drawdown and per-day realized loss', async () => {
    const { broker, setPrice } = setup(100)
    await broker.placeOrder(request())

    setPrice(90)
    const account = await broker.getAccount()
    expect(account.totalExposureUsd).toBeCloseTo(90, 6)
    expect(account.drawdownUsd).toBeCloseTo(10, 6)

    await broker.placeOrder(
      request({ intentId: 'i2', clientOrderId: 'c2', side: 'sell', qty: 1 }),
    )
    const closed = await broker.getAccount()
    expect(closed.dailyLossUsd).toBeCloseTo(10, 6)
    expect(closed.consecutiveLosses).toBe(1)
    expect(closed.totalExposureUsd).toBe(0)
  })

  it('cancels open orders, per symbol or all', async () => {
    const { broker } = setup(100)
    await broker.placeOrder(request({ clientOrderId: 'a', symbol: SYMBOL, type: 'limit', price: 90 }))
    await broker.placeOrder(
      request({ clientOrderId: 'b', symbol: 'ETH/USDT', type: 'limit', price: 90 }),
    )

    await broker.cancelAll(SYMBOL)
    expect(await broker.getOpenOrders()).toHaveLength(1)
    await broker.cancelAll()
    expect(await broker.getOpenOrders()).toHaveLength(0)
  })

  it('refuses a protective order when there is no position', async () => {
    const { broker } = setup()
    await expect(broker.placeProtective({ symbol: SYMBOL, stopLossPrice: 90 })).rejects.toThrow()
  })
})

describe('reduceOnly 与手续费（审计修复）', () => {
  it('★ reduceOnly 绝不翻转仓位（保护单 qty 在挂单时被冻结）', async () => {
    const { broker } = setup(100, { feeBps: 0, slippageBps: 0 })
    await broker.placeOrder(request())
    await broker.placeProtective({ symbol: SYMBOL, stopLossPrice: 95 })
    await broker.placeOrder(
      request({ intentId: 'i2', clientOrderId: 'c2', side: 'sell', qty: 0.5, reduceOnly: true }),
    )
    // 保护单数量仍记为 1，但剩余持仓只有 0.5 —— 必须封顶而不是翻成 -0.5
    broker.onBar(SYMBOL, { high: 100, low: 90, close: 90 })
    expect(await broker.getPositions()).toEqual([])
  })

  it('★ realizedPnl 与 dailyLoss 含手续费', async () => {
    const { broker } = setup(100, { feeBps: 10 })
    await broker.placeOrder(request())
    await broker.placeOrder(request({ intentId: 'i2', clientOrderId: 'c2', side: 'sell' }))
    expect(broker.realizedPnl()).toBeLessThan(0)
    const account = await broker.getAccount()
    expect(account.dailyLossUsd).toBeGreaterThan(0)
  })
})
