import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import {
  CcxtBroker,
  type CcxtBalanceLike,
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
  balanceParams: (Readonly<Record<string, unknown>> | undefined)[] = []
  balance: CcxtBalanceLike = { total: { USDT: '10000' } }
  positions: readonly CcxtPositionLike[] = []
  openOrders: CcxtOrderLike[] = []
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

  async fetchPositions(): Promise<readonly CcxtPositionLike[]> {
    return this.positions
  }

  async fetchOpenOrders(symbol?: string): Promise<readonly CcxtOrderLike[]> {
    return symbol === undefined
      ? this.openOrders
      : this.openOrders.filter((order) => order.symbol === undefined || order.symbol === symbol)
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

  async cancelOrder(id: string): Promise<void> {
    this.cancelCalls.push(id)
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
        qty: 2,
        avgPrice: 100,
        unrealizedPnlUsd: 20,
        protectedStopPrice: 95,
      },
    ])

    const open = await broker.getOpenOrders()
    expect(open).toHaveLength(2)
    expect(open.map((item) => item.clientOrderId)).toEqual(['protect-1', 'client-2'])
    expect(exchange.loads).toBe(1)
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

  it('cancels every open order after fetching them', async () => {
    const exchange = new FakeExchange()
    exchange.openOrders = [
      { id: 'open-1', clientOrderId: 'one', symbol: SYMBOL, status: 'open' },
      { id: 'open-2', clientOrderId: 'two', symbol: SYMBOL, status: 'open' },
    ]
    await makeBroker(exchange).cancelAll(SYMBOL)

    expect(exchange.cancelCalls).toEqual(['open-1', 'open-2'])
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
})

describe('exec plugin broker routing', () => {
  const base = { mode: 'live_confirm' as const }

  it('only selects ccxt for non-paper mode with both credentials', () => {
    expect(shouldUseLiveBroker({ ...base, apiKey: API_KEY, apiSecret: API_SECRET })).toBe(true)
    expect(resolveExecBroker({ ...base, apiKey: API_KEY, apiSecret: API_SECRET })).toBe('ccxt')
    expect(resolveExecBroker({ ...base, apiKey: API_KEY })).toBe('paper')
    expect(resolveExecBroker({ mode: 'paper', apiKey: API_KEY, apiSecret: API_SECRET })).toBe('paper')
    expect(resolveExecBroker({ ...base, apiKey: ' ', apiSecret: API_SECRET })).toBe('paper')
  })
})
