import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import {
  CcxtBroker,
  type CcxtBalanceLike,
  type CcxtMarketLike,
  type CcxtOrderLike,
  type CcxtPositionLike,
  type CcxtProExchangeLike,
  type CcxtTickerLike,
  type CcxtTradeLike,
} from '../src/exec/ccxt-broker.js'
import type { OrderRequest } from '../src/exec/broker.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { resolveExecBroker, shouldUseLiveBroker } from '../src/plugins/exec.js'

const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT:USDT'
const API_KEY = 'test-api-key'
const API_SECRET = 'test-api-secret'

class FakeExchange implements CcxtProExchangeLike {
  readonly id = 'fake'
  readonly has: Readonly<Record<string, unknown>> = {
    fetchOrder: true,
    fetchOpenOrders: true,
    fetchMyTrades: true,
  }
  loads = 0
  sandbox = false
  fetchOrderCalls: { id: string; params?: Readonly<Record<string, unknown>> }[] = []
  fetchOpenOrdersCalls: {
    symbol?: string
    params?: Readonly<Record<string, unknown>>
  }[] = []
  fetchMyTradesCalls: { params?: Readonly<Record<string, unknown>> }[] = []
  createCalls: {
    symbol: string
    type: string
    side: string
    amount: number
    price?: number
    params?: Readonly<Record<string, unknown>>
  }[] = []
  cancelCalls: string[] = []
  cancelOrderCalls: {
    id: string
    symbol?: string
    params?: Readonly<Record<string, unknown>>
  }[] = []
  balanceParams: (Readonly<Record<string, unknown>> | undefined)[] = []
  /** 默认空 = 现货语义（contractSize 视为 1）；永续测试自行注入 contractSize/precision。 */
  markets: Readonly<Record<string, CcxtMarketLike>> = {}
  balance: CcxtBalanceLike = { total: { USDT: '10000' } }
  positions: readonly CcxtPositionLike[] = []
  positionsReadCount = 0
  positionsOnRead: { readonly read: number; readonly value: readonly CcxtPositionLike[] } | undefined
  openOrders: CcxtOrderLike[] = []
  /** HTX 算法挂单不出现在普通列表；按请求的 flag 提供独立返回，复现真实端点语义。 */
  algorithmOrders: Partial<Record<'stopLossTakeProfit' | 'stopLoss' | 'takeProfit' | 'trigger' | 'trailing', readonly CcxtOrderLike[]>> = {}
  trades: readonly CcxtTradeLike[] = []
  directOrder: CcxtOrderLike | undefined
  ticker: CcxtTickerLike = { bid: 100, ask: 100.2 }
  createError: unknown
  createStatus = 'open'

  async loadMarkets(): Promise<unknown> {
    this.loads += 1
    return {}
  }

  async fetchBalance(params?: Readonly<Record<string, unknown>>): Promise<CcxtBalanceLike> {
    this.balanceParams.push(params)
    return this.balance
  }

  amountToPrecision(symbol: string, amount: number): string {
    const step = this.markets[symbol]?.precision?.amount ?? 1
    return String(Math.floor(amount / step) * step)
  }

  async fetchPositions(): Promise<readonly CcxtPositionLike[]> {
    this.positionsReadCount += 1
    if (this.positionsOnRead?.read === this.positionsReadCount) this.positions = this.positionsOnRead.value
    return this.positions
  }

  async fetchOpenOrders(
    symbol?: string,
    _since?: number,
    _limit?: number,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<readonly CcxtOrderLike[]> {
    this.fetchOpenOrdersCalls.push({ symbol, params })
    const flag = Object.keys(params ?? {})[0] as keyof typeof this.algorithmOrders | undefined
    const source = flag === undefined ? this.openOrders : this.algorithmOrders[flag] ?? []
    return symbol === undefined
      ? source
      : source.filter((order) => order.symbol === undefined || order.symbol === symbol)
  }

  async createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<CcxtOrderLike> {
    this.createCalls.push({ symbol, type, side, amount, ...(price === undefined ? {} : { price }), params })
    if (this.createError !== undefined) throw this.createError
    const order: CcxtOrderLike = {
      id: `exchange-${this.createCalls.length}`,
      clientOrderId: params?.['clientOrderId'],
      symbol,
      type,
      side,
      amount,
      status: this.createStatus,
    }
    this.openOrders = [...this.openOrders, order]
    return order
  }

  async cancelOrder(
    id: string,
    symbol?: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.cancelCalls.push(id)
    this.cancelOrderCalls.push({ id, symbol, params })
    this.openOrders = this.openOrders.filter((order) => order.id !== id)
    for (const flag of ['stopLossTakeProfit', 'stopLoss', 'takeProfit', 'trigger', 'trailing'] as const) {
      const orders = this.algorithmOrders[flag]
      if (orders !== undefined) this.algorithmOrders[flag] = orders.filter((order) => order.id !== id)
    }
  }

  async fetchOrder(
    id: string,
    _symbol?: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<CcxtOrderLike | undefined> {
    this.fetchOrderCalls.push({ id, params })
    return this.directOrder
  }

  async fetchMyTrades(
    _symbol?: string,
    _since?: number,
    _limit?: number,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<readonly CcxtTradeLike[]> {
    this.fetchMyTradesCalls.push({ params })
    return this.trades
  }

  async fetchTicker(_symbol: string): Promise<CcxtTickerLike> {
    return this.ticker
  }

  setSandboxMode(enabled: boolean): void {
    this.sandbox = enabled
  }
}

function makeBroker(exchange: FakeExchange, over: Partial<ConstructorParameters<typeof CcxtBroker>[0]> = {}) {
  return new CcxtBroker({
    exchange,
    venue: 'htx',
    clock: new ReplayClock(NOW),
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    riskStateProvider: () => ({ dailyLossUsd: 12, drawdownUsd: 34, consecutiveLosses: 2 }),
    spreadSymbol: SYMBOL,
    // 默认关闭成交轮询：绝大多数用例只测映射，不想等真实 sleep；需要测轮询的用例自行覆盖。
    fillPollAttempts: 0,
    ...over,
  })
}

const orderRequest = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  intentId: 'intent-1',
  clientOrderId: 'client-1',
  decisionId: 'decision-1',
  symbol: SYMBOL,
  type: 'market',
  side: 'buy',
  qty: 2,
  notionalUsd: 200,
  ...over,
})

describe('CcxtBroker', () => {
  it('maps account, positions, open orders, risk state, and ticker spread', async () => {
    const exchange = new FakeExchange()
    exchange.positions = [
      {
        symbol: SYMBOL,
        side: 'long',
        contracts: '2',
        entryPrice: '100',
        markPrice: '110',
        notional: '220',
        unrealizedPnl: '20',
      },
    ]
    exchange.openOrders = [
      { id: 'stop-1', clientOrderId: 'protect-1', symbol: SYMBOL, status: 'open', reduceOnly: true, type: 'stop', stopPrice: '95' },
      { id: 'limit-1', info: { 'client-order-id': 'client-2' }, symbol: SYMBOL, status: 'open', type: 'limit' },
      { id: 'ghost', symbol: SYMBOL, status: 'open', type: 'limit' },
    ]
    const broker = makeBroker(exchange)

    const account = await broker.getAccount()
    expect(account).toMatchObject({
      venue: 'htx',
      equityQuote: 10_000,
      totalExposureUsd: 220,
      pendingExposureUsd: null,
      openOrders: 3,
      dailyLossUsd: 12,
      drawdownUsd: 34,
      consecutiveLosses: 2,
    })
    expect(account.spreadBps).toBeCloseTo((0.2 / 100.1) * 10_000, 8)

    const positions = await broker.getPositions()
    expect(positions).toEqual([
      {
        symbol: SYMBOL,
        observedAt: NOW,
        qty: 2,
        avgPrice: 100,
        unrealizedPnlUsd: 20,
        protectedStopPrice: 95,
      },
    ])

    const open = await broker.getOpenOrders()
    expect(open).toHaveLength(3)
    expect(open.map((item) => item.clientOrderId)).toEqual(['protect-1', 'client-2', 'ghost'])
    expect(exchange.loads).toBe(1)
  })

  it('保留交易所真实可用保证金，缺字段不把 equity 猜成 free margin', async () => {
    const exchange = new FakeExchange()
    exchange.balance = { total: { USDT: '10000' }, free: { USDT: '7350.5' } }
    const broker = makeBroker(exchange)
    expect((await broker.getAccount()).freeMarginQuote).toBe(7350.5)

    exchange.balance = { total: { USDT: '10000' } }
    expect((await broker.getAccount()).freeMarginQuote).toBeNull()
  })

  it('为有价格的未成交增加敞口订单预留名义，无法估值时返回 unknown', async () => {
    const exchange = new FakeExchange()
    exchange.openOrders = [{
      id: 'pending-limit', symbol: SYMBOL, status: 'open', type: 'limit', side: 'buy',
      amount: 3, remaining: 2, price: 100,
    }]
    expect((await makeBroker(exchange).getAccount()).pendingExposureUsd).toBe(200)

    exchange.openOrders = [{
      id: 'pending-market', symbol: SYMBOL, status: 'open', type: 'market', amount: 3,
      filled: 1, remaining: 2, price: 100, average: 100, cost: 100,
    }]
    expect((await makeBroker(exchange).getAccount()).pendingExposureUsd).toBeNull()

    // ccxt 的 cost 是已成交金额，不能将它外推成剩余委托的保证名义。
    exchange.openOrders = [{
      id: 'pending-partial-no-price', symbol: SYMBOL, status: 'open', type: 'limit',
      amount: 3, filled: 1, remaining: 2, cost: 100,
    }]
    expect((await makeBroker(exchange).getAccount()).pendingExposureUsd).toBeNull()
  })

  it('fails closed with infinite spread when bid or ask is missing', async () => {
    const exchange = new FakeExchange()
    exchange.ticker = { bid: 100 }
    const account = await makeBroker(exchange).getAccount()

    expect(account.spreadBps).toBe(Number.POSITIVE_INFINITY)
  })

  it('short-circuits duplicate clientOrderId without a second createOrder', async () => {
    const exchange = new FakeExchange()
    const broker = makeBroker(exchange)

    const first = await broker.placeOrder(orderRequest())
    const second = await broker.placeOrder(orderRequest())

    expect(exchange.createCalls.length).toBeGreaterThan(0)
    expect(exchange.createCalls).toHaveLength(1)
    expect(second).toEqual(expect.objectContaining({ exchangeOrderId: first.exchangeOrderId, clientOrderId: 'client-1' }))
  })

  it('throws transport failures and leaves a journaled intent in created, not acked', async () => {
    const exchange = new FakeExchange()
    exchange.createError = new Error(`transport ${API_KEY} ${API_SECRET}`)
    const broker = makeBroker(exchange)
    const db = new Database(':memory:')
    migrate(db)
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'decision-transport',
      symbol: SYMBOL,
      decidedAt: NOW,
      contextHash: 'ctx',
      action: 'open',
      executed: false,
    })
    journal.recordIntent({
      intentId: 'intent-transport',
      clientOrderId: 'client-transport',
      decisionId: 'decision-transport',
      venue: 'htx',
      symbol: SYMBOL,
      state: 'created',
      type: 'market',
      side: 'buy',
      qty: 1,
      reduceOnly: false,
      createdAt: NOW,
    })

    await expect(broker.placeOrder(orderRequest({ clientOrderId: 'client-transport' }))).rejects.toThrow()
    expect(journal.inFlightIntents()[0]?.state).toBe('created')
    expect(JSON.stringify([await broker.getAccount(), await broker.getOpenOrders()])).not.toContain(API_KEY)
    expect(JSON.stringify([await broker.getAccount(), await broker.getOpenOrders()])).not.toContain(API_SECRET)
    expect(String(await broker.findOrderByClientOrderId('missing'))).not.toContain(API_KEY)
    expect(String(await broker.findOrderByClientOrderId('missing'))).not.toContain(API_SECRET)
    try {
      await broker.placeOrder(orderRequest({ clientOrderId: 'client-transport' }))
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY)
      expect(String(error)).not.toContain(API_SECRET)
    }
    db.close()
  })

  it('throws when a successful create response has an unknown state', async () => {
    const exchange = new FakeExchange()
    exchange.createStatus = 'provider-specific-state'

    await expect(makeBroker(exchange).placeOrder(orderRequest())).rejects.toThrow('无法确认')
  })

  it('finds an order through fetchOrder, open orders, trades, or returns undefined', async () => {
    const directExchange = new FakeExchange()
    directExchange.directOrder = { id: 'direct-1', clientOrderId: 'target', status: 'closed', average: 101 }
    const direct = await makeBroker(directExchange).findOrderByClientOrderId('target')
    expect(direct).toMatchObject({ exchangeOrderId: 'direct-1', state: 'filled', avgPrice: 101 })
    expect(directExchange.fetchOrderCalls[0]?.params).toEqual({ clientOrderId: 'target' })

    const openExchange = new FakeExchange()
    openExchange.openOrders = [{ id: 'open-1', clientOrderId: 'target', status: 'open' }]
    const open = await makeBroker(openExchange).findOrderByClientOrderId('target')
    expect(open).toMatchObject({ exchangeOrderId: 'open-1', state: 'acked' })

    const tradeExchange = new FakeExchange()
    tradeExchange.trades = [{ id: 'trade-1', order: 'filled-1', price: '102', info: { clientOrderId: 'target' } }]
    const trade = await makeBroker(tradeExchange).findOrderByClientOrderId('target')
    expect(trade).toMatchObject({ exchangeOrderId: 'filled-1', state: 'filled', avgPrice: 102 })
    expect(tradeExchange.fetchMyTradesCalls[0]?.params).toEqual({ clientOrderId: 'target' })

    const missingExchange = new FakeExchange()
    const missing = await makeBroker(missingExchange).findOrderByClientOrderId('target')
    expect(missing).toBeUndefined()
  })

  it('converts HTX contract fill quantities back to the broker base-quantity unit', async () => {
    const exchange = new FakeExchange()
    exchange.markets = { [SYMBOL]: { linear: true, contractSize: 10 } }
    exchange.directOrder = {
      id: 'contract-fill', clientOrderId: 'contract-client', symbol: SYMBOL,
      status: 'closed', filled: 2, average: 100,
    }
    const order = await makeBroker(exchange).findOrderByExchangeOrderId('contract-fill', SYMBOL)
    expect(order).toMatchObject({ symbol: SYMBOL, filledQty: 20, avgPrice: 100 })
  })

  it('order 缺少费用时只回填同一订单且 USDT 计价的逐笔手续费', async () => {
    const exchange = new FakeExchange()
    exchange.directOrder = {
      id: 'fee-order', clientOrderId: 'fee-client', symbol: SYMBOL,
      status: 'closed', filled: 2, average: 100,
    }
    exchange.trades = [
      { id: 'fee-trade-1', order: 'fee-order', symbol: SYMBOL, fee: { cost: 0.01, currency: 'USDT' } },
      { id: 'fee-trade-2', order: 'fee-order', symbol: SYMBOL, fee: { cost: 0.02, currency: 'USDT' } },
      { id: 'other-order-trade', order: 'other-order', symbol: SYMBOL, fee: { cost: 100, currency: 'USDT' } },
    ]

    const order = await makeBroker(exchange).findOrderByExchangeOrderId('fee-order', SYMBOL)
    expect(order).toMatchObject({ state: 'filled', fee: 0.03 })
  })

  it('非计价币手续费不冒充 USDT 成本', async () => {
    const exchange = new FakeExchange()
    exchange.directOrder = {
      id: 'base-fee-order', clientOrderId: 'base-fee-client', symbol: SYMBOL,
      status: 'closed', filled: 1, average: 100, fee: { cost: 0.001, currency: 'BTC' },
    }

    const order = await makeBroker(exchange).findOrderByExchangeOrderId('base-fee-order', SYMBOL)
    expect(order).not.toHaveProperty('fee')
  })

  it('places a configurable protective reduceOnly conditional order', async () => {
    const exchange = new FakeExchange()
    exchange.positions = [{ symbol: SYMBOL, side: 'long', contracts: 2, entryPrice: 100, notional: 200 }]
    const broker = makeBroker(exchange, { protectiveOrderType: 'stop-market' })

    const ack = await broker.placeProtective({ symbol: SYMBOL, clientOrderId: 'protect-1', stopLossPrice: 95 })
    expect(exchange.createCalls.length).toBeGreaterThan(0)
    expect(exchange.createCalls[0]).toMatchObject({
      symbol: SYMBOL,
      type: 'stop-market',
      side: 'sell',
      amount: 2,
      params: { clientOrderId: 'protect-1', reduceOnly: true, stopLossPrice: 95 },
    })
    expect(ack.clientOrderId).toBe('protect-1')
  })

  it('拒绝用小于已确认累计成交量的远端仓位挂保护', async () => {
    const exchange = new FakeExchange()
    exchange.positions = [{ symbol: SYMBOL, side: 'long', contracts: 2, entryPrice: 100, notional: 200 }]
    const broker = makeBroker(exchange)

    await expect(broker.placeProtective({
      symbol: SYMBOL, clientOrderId: 'undersized-protection', expectedPositionQty: 3, stopLossPrice: 95,
    })).rejects.toThrow(/小于已确认成交暴露/)
    expect(exchange.createCalls).toEqual([])
  })

  it('cancels every open order after fetching them', async () => {
    const exchange = new FakeExchange()
    exchange.openOrders = [
      { id: 'open-1', clientOrderId: 'one', symbol: SYMBOL, type: 'limit', status: 'open' },
      { id: 'open-2', clientOrderId: 'two', symbol: SYMBOL, type: 'limit', status: 'open' },
    ]
    await makeBroker(exchange).cancelAll(SYMBOL)

    expect(exchange.cancelCalls).toEqual(['open-1', 'open-2'])
  })

  it('counts algorithm-only protective orders in account openOrders', async () => {
    const exchange = new FakeExchange()
    const protective: CcxtOrderLike = {
      id: 'algo-only-1',
      clientOrderId: 'protect-1',
      symbol: SYMBOL,
      status: 'open',
      type: 'stop',
      reduceOnly: true,
      stopPrice: 95,
    }
    exchange.algorithmOrders.stopLossTakeProfit = [protective]

    const account = await makeBroker(exchange).getAccount()

    expect(account.openOrders).toBe(1)
    expect(exchange.fetchOpenOrdersCalls.some((call) => call.params?.['stopLossTakeProfit'] === true)).toBe(true)
  })

  it('explicit includeProtection cancels algorithm-only orders only when flat', async () => {
    const exchange = new FakeExchange()
    const protective: CcxtOrderLike = {
      id: 'algo-only-1',
      clientOrderId: 'protect-1',
      symbol: SYMBOL,
      status: 'open',
      type: 'stop',
      reduceOnly: true,
      stopPrice: 95,
    }
    exchange.algorithmOrders.stopLossTakeProfit = [protective]

    await makeBroker(exchange).cancelAll(SYMBOL, { includeProtection: true })

    expect(exchange.cancelCalls).toEqual(['algo-only-1'])
    expect(exchange.cancelOrderCalls[0]).toMatchObject({ id: 'algo-only-1', symbol: SYMBOL })
    expect((await makeBroker(exchange).getOpenOrders(SYMBOL)).length).toBe(0)
  })

  it('保护单批量撤销期间若仓位快照转为非空就立即停止，不能继续撤止损', async () => {
    const exchange = new FakeExchange()
    exchange.algorithmOrders.stopLossTakeProfit = [{
      id: 'race-stop', clientOrderId: 'race-protect', symbol: SYMBOL,
      status: 'open', type: 'stop', reduceOnly: true, stopPrice: 95,
    }]
    exchange.positionsOnRead = {
      read: 2,
      value: [{ symbol: SYMBOL, side: 'long', contracts: 1, entryPrice: 100, notional: 100 }],
    }

    await expect(makeBroker(exchange).cancelAll(SYMBOL, { includeProtection: true })).rejects.toThrow(/撤保护前发现持仓/)
    expect(exchange.cancelCalls).toEqual([])
  })

  it('includeProtection 发现普通/未知挂单时不开始撤单', async () => {
    const exchange = new FakeExchange()
    exchange.openOrders = [{ id: 'still-entry', symbol: SYMBOL, type: 'limit', status: 'open', amount: 1, price: 100 }]
    exchange.algorithmOrders.stopLossTakeProfit = [{
      id: 'still-stop', symbol: SYMBOL, type: 'stop', status: 'open', reduceOnly: true, stopPrice: 95,
    }]

    await expect(makeBroker(exchange).cancelAll(SYMBOL, { includeProtection: true })).rejects.toThrow(/仍有未撤普通/)
    expect(exchange.cancelCalls).toEqual([])
  })

  it('default cancelAll preserves reduce-only protection even while canceling entries', async () => {
    const exchange = new FakeExchange()
    exchange.positions = [{ symbol: SYMBOL, side: 'long', contracts: 1, entryPrice: 100, markPrice: 100 }]
    exchange.openOrders = [{ id: 'entry-1', clientOrderId: 'entry', symbol: SYMBOL, status: 'open', type: 'limit', amount: 1, price: 101 }]
    exchange.algorithmOrders.stopLossTakeProfit = [{
      id: 'stop-1', clientOrderId: 'protect', symbol: SYMBOL, status: 'open',
      type: 'stop', stopPrice: 95,
    }]

    await makeBroker(exchange).cancelAll(SYMBOL)
    expect(exchange.cancelCalls).toEqual(['entry-1'])
    expect((await makeBroker(exchange).getOpenOrders(SYMBOL)).map((order) => order.exchangeOrderId)).toContain('stop-1')
    await expect(makeBroker(exchange).cancelAll(SYMBOL, { includeProtection: true })).rejects.toThrow(/仍有持仓/)
  })

  it('refuses to cancel an order whose type cannot be classified as entry vs protection', async () => {
    const exchange = new FakeExchange()
    exchange.openOrders = [{ id: 'unknown-kind', symbol: SYMBOL, status: 'open' }]
    await expect(makeBroker(exchange).cancelAll(SYMBOL)).rejects.toThrow(/类型不可识别/)
    expect(exchange.cancelCalls).toEqual([])
  })

  it('uses each order symbol when canceling all markets instead of spreadSymbol', async () => {
    const exchange = new FakeExchange()
    const ethSymbol = 'ETH/USDT:USDT'
    exchange.openOrders = [{ id: 'eth-order', clientOrderId: 'eth-1', symbol: ethSymbol, type: 'limit', status: 'open' }]

    await makeBroker(exchange).cancelAll()

    expect(exchange.cancelOrderCalls[0]).toMatchObject({ id: 'eth-order', symbol: ethSymbol })
    expect(exchange.cancelOrderCalls[0]?.symbol).not.toBe(SYMBOL)
  })

  it('resolves the actual symbol for public cancelOrder when only exchange id is supplied', async () => {
    const exchange = new FakeExchange()
    const ethSymbol = 'ETH/USDT:USDT'
    exchange.openOrders = [{ id: 'eth-order', clientOrderId: 'eth-1', symbol: ethSymbol, type: 'limit', status: 'open' }]

    await makeBroker(exchange).cancelOrder('eth-order')

    expect(exchange.cancelOrderCalls[0]).toMatchObject({ id: 'eth-order', symbol: ethSymbol })
    expect(exchange.cancelOrderCalls[0]?.symbol).not.toBe(SYMBOL)
  })

  it('does not invent spreadSymbol when public cancelOrder cannot resolve an order', async () => {
    const exchange = new FakeExchange()

    await makeBroker(exchange).cancelOrder('unknown-order')

    expect(exchange.cancelOrderCalls[0]).toMatchObject({ id: 'unknown-order' })
    expect(exchange.cancelOrderCalls[0]?.symbol).toBeUndefined()
  })

  it('deduplicates the same order returned by ordinary and algorithm endpoints', async () => {
    const exchange = new FakeExchange()
    const order: CcxtOrderLike = {
      id: 'duplicate-1',
      clientOrderId: 'protect-duplicate',
      symbol: SYMBOL,
      status: 'open',
      type: 'stop',
      reduceOnly: true,
      stopPrice: 95,
    }
    exchange.openOrders = [order]
    exchange.algorithmOrders.stopLossTakeProfit = [order]

    const openOrders = await makeBroker(exchange).getOpenOrders(SYMBOL)

    expect(openOrders).toHaveLength(1)
    expect(openOrders[0]?.exchangeOrderId).toBe('duplicate-1')
  })

  it('sets sandbox without requiring a network call', () => {
    const exchange = new FakeExchange()
    makeBroker(exchange, { sandbox: true })

    expect(exchange.sandbox).toBe(true)
    expect(exchange.loads).toBe(0)
  })

  it('refuses account reads without a RiskStateProvider', async () => {
    const exchange = new FakeExchange()
    await expect(makeBroker(exchange, { riskStateProvider: undefined, riskState: undefined }).getAccount()).rejects.toThrow(
      'RiskStateProvider',
    )
  })

  it('★ 把凭据回填到 exchange 实例（否则 ccxt 私有端点一律 unauthorized），且错误信息脱敏', async () => {
    const exchange = new FakeExchange()
    // 交易所把密钥回显进错误消息，也必须被 #safeError 脱敏
    exchange.createError = new Error(`bad signature for secret=${API_SECRET} key=${API_KEY}`)
    const broker = makeBroker(exchange)

    // 实测：不把凭据挂到 exchange 上，HTX 私有端点直接报 `htx requires "apiKey" credential`；
    // 只设 `apiSecret` 而不是 ccxt 的 `secret`，则报 `htx requires "secret" credential`。
    expect((exchange as { apiKey?: string }).apiKey).toBe(API_KEY)
    expect((exchange as { secret?: string }).secret).toBe(API_SECRET)

    let message = ''
    try {
      await broker.placeOrder(orderRequest())
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(API_SECRET)
    expect(message).not.toContain(API_KEY)
  })

  it('★ 按 accountType 读对应账户（HTX 现货/永续分离），否则会给 sizing 一个假的 0', async () => {
    const swap = new FakeExchange()
    await makeBroker(swap, { accountType: 'swap' }).readOnlyBalance()
    expect(swap.balanceParams.at(-1)).toEqual({ type: 'swap' })

    const spot = new FakeExchange()
    await makeBroker(spot).readOnlyBalance()
    // 未配置 = 沿用 ccxt 默认（现货），显式传空参数而不是猜一个类型
    expect(spot.balanceParams.at(-1)).toEqual({})
  })

  it('★ 基础币数量 ↔ ccxt 张数按 contractSize 换算（差一个 contractSize = 几十倍仓位）', async () => {
    const exchange = new FakeExchange()
    // HTX BTC 永续：1 张 = 0.001 BTC，amount 精度 1 张
    exchange.markets = { [SYMBOL]: { contractSize: 0.001, linear: true, precision: { amount: 1 } } }
    const broker = makeBroker(exchange)

    // 下单：0.05 BTC ⇒ 50 张（而不是把 0.05 当张数）
    await broker.placeOrder(orderRequest({ qty: 0.05, notionalUsd: 4000 }))
    expect(exchange.createCalls.at(-1)?.amount).toBe(50)

    // 持仓：ccxt contracts=50 ⇒ 0.05 BTC
    exchange.positions = [
      { symbol: SYMBOL, contracts: 50, side: 'long', entryPrice: 60_000, markPrice: 60_000 },
    ]
    const positions = await broker.getPositions()
    expect(positions.length).toBe(1)
    expect(positions[0]?.qty).toBeCloseTo(0.05, 10)
  })

  it('不足一张最小合约时拒绝下单（绝不四舍五入放大仓位）', async () => {
    const exchange = new FakeExchange()
    exchange.markets = { [SYMBOL]: { contractSize: 0.001, linear: true, precision: { amount: 1 } } }
    const broker = makeBroker(exchange)
    // 0.0004 BTC < 1 张（0.001 BTC）
    await expect(broker.placeOrder(orderRequest({ qty: 0.0004, notionalUsd: 30 }))).rejects.toThrow(
      /不足一张最小合约/,
    )
  })

  it('inverse 合约拒绝换算（口径不同，宁可拒绝也不下错）', async () => {
    const exchange = new FakeExchange()
    exchange.markets = { [SYMBOL]: { contractSize: 100, inverse: true, precision: { amount: 1 } } }
    const broker = makeBroker(exchange)
    await expect(broker.placeOrder(orderRequest({ qty: 0.5, notionalUsd: 100 }))).rejects.toThrow(/inverse/)
  })
})

describe('exec plugin broker routing', () => {
  const base = { mode: 'live_auto' as const, liveArmed: true }

  it('selects ccxt only for armed live_auto with both credentials', () => {
    expect(shouldUseLiveBroker({ ...base, apiKey: API_KEY, apiSecret: API_SECRET })).toBe(true)
    expect(resolveExecBroker({ ...base, apiKey: API_KEY, apiSecret: API_SECRET })).toBe('ccxt')
    expect(resolveExecBroker({ ...base, apiKey: API_KEY })).toBe('paper')
    expect(resolveExecBroker({ ...base, liveArmed: false, apiKey: API_KEY, apiSecret: API_SECRET })).toBe('paper')
    expect(resolveExecBroker({ mode: 'paper', apiKey: API_KEY, apiSecret: API_SECRET })).toBe('paper')
    expect(resolveExecBroker({ ...base, apiKey: ' ', apiSecret: API_SECRET })).toBe('paper')
  })
})

describe('HTX 实盘冒烟暴露的修复（position_side / 市价单成交 / clientOrderId 查询）', () => {
  it('★ 算法保护单必须带 position_side（HTX 缺它直接报 code 1067）', async () => {
    const exchange = new FakeExchange()
    const broker = makeBroker(exchange, { positionSide: 'both' })
    // 先造一个持仓，placeProtective 才有量可挂
    exchange.positions = [
      { symbol: SYMBOL, contracts: 1, side: 'long', entryPrice: 100, markPrice: 100 },
    ]
    await broker.placeProtective({ symbol: SYMBOL, stopLossPrice: 90 })
    expect(exchange.createCalls.at(-1)?.params?.['position_side']).toBe('both')
  })

  it('★ 市价单 create 返回 open 时，轮询 fetchOrder 成交后回填 filled + avgPrice', async () => {
    const exchange = new FakeExchange()
    exchange.createStatus = 'open'
    // fetchOrder 返回已成交
    exchange.directOrder = {
      id: 'o-1',
      symbol: SYMBOL,
      status: 'closed',
      amount: 2,
      filled: 2,
      average: 101,
      clientOrderId: 'client-1',
    }
    const broker = makeBroker(exchange, { fillPollAttempts: 2, fillPollMs: 1 })
    const ack = await broker.placeOrder(orderRequest())
    expect(ack.state).toBe('filled')
    expect(ack.avgPrice).toBe(101)
  })
})
