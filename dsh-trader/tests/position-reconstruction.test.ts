import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { PaperBroker } from '../src/exec/paper.js'
import { applyPositionFill } from '../src/exec/position.js'
import { reconstructPosition } from '../src/memory/settle.js'

describe('成交路径与持仓重建', () => {
  it.each([
    { before: { qty: 0, avgPrice: 0 }, fill: { side: 'buy', qty: 2, price: 100 },
      after: { qty: 2, avgPrice: 100, closedQty: 0, realizedGrossQuote: 0 } },
    { before: { qty: 0, avgPrice: 0 }, fill: { side: 'sell', qty: 2, price: 100 },
      after: { qty: -2, avgPrice: 100, closedQty: 0, realizedGrossQuote: 0 } },
    { before: { qty: 2, avgPrice: 100 }, fill: { side: 'buy', qty: 1, price: 130 },
      after: { qty: 3, avgPrice: 110, closedQty: 0, realizedGrossQuote: 0 } },
    { before: { qty: 2, avgPrice: 100 }, fill: { side: 'sell', qty: 1, price: 90 },
      after: { qty: 1, avgPrice: 100, closedQty: 1, realizedGrossQuote: -10 } },
    { before: { qty: -2, avgPrice: 100 }, fill: { side: 'buy', qty: 1, price: 90 },
      after: { qty: -1, avgPrice: 100, closedQty: 1, realizedGrossQuote: 10 } },
    { before: { qty: 2, avgPrice: 100 }, fill: { side: 'sell', qty: 2, price: 90 },
      after: { qty: 0, avgPrice: 0, closedQty: 2, realizedGrossQuote: -20 } },
  ])('入场、加仓、减仓和平仓的统一价差规则：%j', sample => {
    expect(applyPositionFill(sample.before, sample.fill)).toEqual(sample.after)
  })

  it.each([
    { qty: NaN, avgPrice: 100 }, { qty: 1, avgPrice: Infinity },
    { qty: 0, avgPrice: 100 }, { qty: 1, avgPrice: 0 },
  ])('未知或矛盾的旧仓位不能作为历史归因起点：%j', position => {
    expect(() => applyPositionFill(position, { side: 'buy', qty: 1, price: 100 })).toThrow(/成交前持仓/)
  })

  it('非有限的累计数量或价差不能进入镜像', () => {
    expect(() => applyPositionFill({ qty: Number.MAX_VALUE, avgPrice: 1 },
      { side: 'buy', qty: Number.MAX_VALUE, price: 1 })).toThrow(/计算溢出/)
  })

  it.each([
    { entry: 'buy', exit: 'sell', qty: -1 },
    { entry: 'sell', exit: 'buy', qty: 1 },
  ])('历史反向成交超过旧仓位时，新仓均价属于超出部分的成交：%j', sample => {
    const fills = [
      { side: sample.entry, qty: 2, price: 100 },
      { side: sample.exit, qty: 3, price: 90 },
    ]
    expect(fills).toHaveLength(2)
    expect(reconstructPosition(fills)).toEqual({ qty: sample.qty, avgPrice: 90 })
  })

  it.each(['', 'hold', 'BUY', 'unknown'])('未知方向不能默认为买入：%s', side => {
    expect(() => reconstructPosition([{ side, qty: 1, price: 100 }])).toThrow(/成交方向/)
  })

  it.each([0, -1, NaN, Infinity])('无效实际成交数量必须拒绝：%s', qty => {
    expect(() => reconstructPosition([{ side: 'buy', qty, price: 100 }])).toThrow(/成交数量或价格/)
  })

  it.each([0, -1, NaN, Infinity])('无效实际成交价格必须拒绝：%s', price => {
    expect(() => reconstructPosition([{ side: 'sell', qty: 1, price }])).toThrow(/成交数量或价格/)
  })

  it.each([0, -1, NaN, Infinity])('paper拒绝无效订单数量且不修改现金或订单：%s', async qty => {
    const broker = new PaperBroker({ clock: new ReplayClock(1_700_000_000_000),
      book: { price: () => 100 }, initialEquityQuote: 10_000, slippageBps: 0, feeBps: 0 })
    await expect(broker.placeOrder({ intentId: 'bad', clientOrderId: 'bad', decisionId: 'bad',
      symbol: 'BTC/USDT', type: 'market', side: 'buy', qty, notionalUsd: 100 }))
      .rejects.toThrow(/paper订单方向或数量无效/)
    expect(broker.cash()).toBe(10_000)
    expect(await broker.getPositions()).toEqual([])
    expect((await broker.getAccount()).openOrders).toBe(0)
  })

  it('paper拒绝未知方向且不把它猜成sell', async () => {
    const broker = new PaperBroker({ clock: new ReplayClock(1_700_000_000_000), book: { price: () => 100 } })
    await expect(broker.placeOrder({ intentId: 'bad', clientOrderId: 'bad', decisionId: 'bad',
      symbol: 'BTC/USDT', type: 'market', side: 'unknown' as never, qty: 1, notionalUsd: 100 }))
      .rejects.toThrow(/paper订单方向或数量无效/)
    expect(broker.cash()).toBe(10_000)
    expect(await broker.getPositions()).toEqual([])
    expect((await broker.getAccount()).openOrders).toBe(0)
  })

  it.each([0, 10])('paper翻仓后净盈亏和现金权益一致，feeBps=%s', async feeBps => {
    let price = 100
    const broker = new PaperBroker({ clock: new ReplayClock(1_700_000_000_000),
      book: { price: () => price }, initialEquityQuote: 10_000, slippageBps: 0, feeBps })
    const fills = [
      { side: 'buy' as const, qty: 2, price: 100 },
      { side: 'sell' as const, qty: 3, price: 90 },
      { side: 'buy' as const, qty: 1, price: 80 },
    ]
    for (const [index, fill] of fills.entries()) {
      price = fill.price
      const ack = await broker.placeOrder({ intentId: `i-${index}`, clientOrderId: `co-${index}`,
        decisionId: `d-${index}`, symbol: 'BTC/USDT', type: 'market', side: fill.side,
        qty: fill.qty, notionalUsd: fill.qty * fill.price })
      expect(ack.state).toBe('filled')
      const rebuilt = reconstructPosition(fills.slice(0, index + 1))
      const positions = await broker.getPositions()
      if (rebuilt.qty === 0) expect(positions).toEqual([])
      else {
        expect(positions[0]).toMatchObject({ qty: rebuilt.qty, avgPrice: rebuilt.avgPrice })
        expect(positions[0]?.unrealizedPnlUsd).toBeCloseTo(0)
      }
    }
    const fees = fills.reduce((sum, fill) => sum + fill.qty * fill.price * feeBps / 10_000, 0)
    expect(broker.realizedPnl()).toBeCloseTo(-10 - fees)
    expect((await broker.getAccount()).equityQuote).toBeCloseTo(10_000 + broker.realizedPnl())
    // 原client id重放不能再次改变现金、持仓或费用。
    const before = broker.cash()
    await broker.placeOrder({ intentId: 'repeat', clientOrderId: 'co-2', decisionId: 'd-2',
      symbol: 'BTC/USDT', type: 'market', side: 'buy', qty: 1, notionalUsd: 80 })
    expect(broker.cash()).toBe(before)
  })
})
