import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import type { CcxtBalanceLike, CcxtOrderLike, CcxtPositionLike, CcxtProExchangeLike, CcxtTradeLike } from '../src/exec/ccxt-broker.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { createExecRuntime, createRiskStateProvider } from '../src/exec/runtime.js'
import type { ExecRuntimeConfig } from '../src/exec/ports.js'

const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT:USDT'

class FakeExchange implements CcxtProExchangeLike {
  readonly id = 'fake'
  readonly has: Readonly<Record<string, unknown>> = {
    fetchOrder: true,
    fetchOpenOrders: true,
    fetchMyTrades: true,
  }
  fetchImplementation?: unknown
  apiKey?: string
  secret?: string
  loads = 0
  balanceParams: (Readonly<Record<string, unknown>> | undefined)[] = []
  cancelCalls: string[] = []
  balance: CcxtBalanceLike = { total: { USDT: '1234.5' } }
  positions: readonly CcxtPositionLike[] = []
  openOrders: readonly CcxtOrderLike[] = []
  trades: readonly CcxtTradeLike[] = []

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

  async fetchOpenOrders(
    symbol?: string,
    _since?: number,
    _limit?: number,
    _params?: Readonly<Record<string, unknown>>,
  ): Promise<readonly CcxtOrderLike[]> {
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
    return {
      id: 'fake-order',
      clientOrderId: params?.['clientOrderId'],
      symbol,
      type,
      side,
      amount,
      ...(price === undefined ? {} : { price }),
      status: 'open',
    }
  }

  async cancelOrder(id: string): Promise<void> {
    this.cancelCalls.push(id)
  }

  async fetchOrder(
    _id: string,
    _symbol?: string,
    _params?: Readonly<Record<string, unknown>>,
  ): Promise<CcxtOrderLike | undefined> {
    return undefined
  }

  async fetchMyTrades(
    _symbol?: string,
    _since?: number,
    _limit?: number,
    _params?: Readonly<Record<string, unknown>>,
  ): Promise<readonly CcxtTradeLike[]> {
    return this.trades
  }

  async fetchTicker(): Promise<{ bid: number; ask: number }> {
    return { bid: 100, ask: 100.1 }
  }
}

function config(over: Partial<ExecRuntimeConfig> = {}): ExecRuntimeConfig {
  return {
    mode: 'paper',
    riskPct: 0.005,
    symbols: [SYMBOL],
    timeframes: ['1h'],
    benchmark: SYMBOL,
    venue: 'paper',
    accountType: 'swap',
    ...EXAMPLE_LIMITS,
    reconcileMs: 100,
    paperInitialEquityQuote: 4321,
    paperSlippageBps: 5,
    paperFeeBps: 5,
    ...over,
  }
}

function openDatabase(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

describe('ExecRuntime 组合根', () => {
  it('paper runtime 组装非零权益，周期对账可重入，dispose 后取消周期任务', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const runtime = await createExecRuntime(config(), { db, clock })

    const ports = runtime.getPorts()
    expect(ports.broker).toBe(runtime.broker)
    expect(ports.symbols).toEqual([SYMBOL])
    expect(ports.timeframes).toEqual(['1h'])
    expect(ports.benchmark).toBe(SYMBOL)
    const account = await runtime.broker.getAccount()
    expect(account.equityQuote).toBe(4321)
    expect(account.equityQuote).toBeGreaterThan(0)

    const first = runtime.reconcileOnce()
    const second = runtime.reconcileOnce()
    expect(await first).toEqual(await second)
    expect(clock.pendingTimers()).toBe(1)
    clock.advanceTo(NOW + 100)
    await Promise.resolve()
    expect(clock.pendingTimers()).toBe(1)

    await runtime.dispose()
    expect(clock.pendingTimers()).toBe(0)
    clock.advanceTo(NOW + 500)
    expect(clock.pendingTimers()).toBe(0)
    await expect(runtime.reconcileOnce()).rejects.toThrow('已 dispose')
    db.close()
  })

  it('ccxt runtime 将 accountType 传给 fetchBalance；缺凭据安全降级为 paper', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const exchange = new FakeExchange()
    const live = await createExecRuntime(
      config({
        mode: 'live_confirm',
        venue: 'htx',
        apiKey: 'key',
        apiSecret: 'secret',
        accountType: 'swap',
      }),
      {
        db,
        clock,
        createExchange: (_venue, options) => {
          expect(options).toEqual({ enableRateLimit: true, defaultType: 'swap' })
          return exchange
        },
      },
    )

    const equity = await (live.broker as unknown as { readOnlyBalance: () => Promise<number> }).readOnlyBalance()
    expect(equity).toBe(1234.5)
    expect(exchange.balanceParams.at(-1)).toEqual({ type: 'swap' })
    expect(live.broker.venue).toBe('htx')
    await live.dispose()

    const fallback = await createExecRuntime(
      config({ mode: 'live_confirm', venue: 'htx', apiKey: undefined, apiSecret: undefined }),
      { db, clock },
    )
    expect(fallback.broker.venue).toBe('paper')
    const fallbackAccount = await fallback.broker.getAccount()
    expect(fallbackAccount.equityQuote).toBeGreaterThan(0)
    await fallback.dispose()
    db.close()
  })

  it('RiskStateProvider 随已结算亏损样本变化，不是常量 0', () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'loss-decision',
      symbol: SYMBOL,
      decidedAt: NOW - 1000,
      contextHash: 'ctx:loss',
      action: 'open',
      sizeQty: 0.1,
      executed: true,
    })
    journal.recordIntent({
      intentId: 'loss-intent',
      clientOrderId: 'loss-client',
      decisionId: 'loss-decision',
      venue: 'paper',
      symbol: SYMBOL,
      state: 'filled',
      type: 'market',
      side: 'buy',
      qty: 0.1,
      reduceOnly: false,
      createdAt: NOW - 1000,
    })
    journal.recordOrder({
      orderId: 'loss-order',
      venue: 'paper',
      exchangeOrderId: 'loss-order',
      clientOrderId: 'loss-client',
      symbol: SYMBOL,
      status: 'filled',
      qty: 0.1,
      filledQty: 0.1,
      avgPrice: 100,
      updatedAt: NOW - 1000,
    })
    journal.recordFill({
      fillId: 'loss-fill',
      orderId: 'loss-order',
      qty: 0.1,
      price: 100,
      fee: 0.1,
      feeCurrency: 'USDT',
      ts: NOW - 1000,
    })
    journal.recordOutcome({
      outcomeId: 'loss-outcome',
      decisionId: 'loss-decision',
      symbol: SYMBOL,
      settledAt: NOW - 500,
      horizonMs: 14_400_000,
      entryPrice: 100,
      exitPrice: 90,
      realizedGrossPct: -10,
      realizedNetPct: -10.1,
      benchmarkPct: 0,
      alphaPct: -10.1,
      mfePct: 0,
      maePct: -10,
      stopHit: true,
      feesQuote: 0.1,
      evidenceRefs: ['loss-fill'],
    })

    // 非空跑守卫：先证明确实有一条可读取的结算样本，再断言风险状态。
    expect(journal.outcomeFor('loss-decision')).toBeDefined()
    const state = createRiskStateProvider(db, clock, journal)()
    expect(state.dailyLossUsd).toBeGreaterThan(0)
    expect(state.consecutiveLosses).toBeGreaterThan(0)
    expect(state.drawdownUsd).toBeGreaterThan(0)
    db.close()
  })

  it('启动对账发现未知远端持仓时冻结 symbol，liveAckOrphans=false 不执行撤单', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const exchange = new FakeExchange()
    exchange.positions = [{ symbol: 'ETH/USDT:USDT', contracts: 1, entryPrice: 100, markPrice: 100 }]
    const runtime = await createExecRuntime(
      config({
        mode: 'live_confirm',
        venue: 'htx',
        apiKey: 'key',
        apiSecret: 'secret',
        liveAckOrphans: false,
      }),
      { db, clock, createExchange: () => exchange },
    )

    const frozen = runtime.frozenSymbols()
    expect(frozen.size).toBeGreaterThan(0)
    expect(frozen.has('ETH/USDT:USDT')).toBe(true)
    const report = await runtime.reconcileOnce()
    expect(report.result.actions.length).toBeGreaterThan(0)
    expect(report.result.actions.some((action) => action.kind === 'alert_unknown_position')).toBe(true)
    expect(exchange.cancelCalls).toHaveLength(0)
    await runtime.dispose()
    db.close()
  })
})
