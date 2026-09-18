import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import { Statements } from '../src/db/statements.js'
import type { CcxtBalanceLike, CcxtOrderLike, CcxtPositionLike, CcxtProExchangeLike, CcxtTradeLike } from '../src/exec/ccxt-broker.js'
import type { AccountSnapshot, OrderRequest } from '../src/exec/broker.js'
import { validateIntent } from '../src/exec/gate.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { createExecRuntime, createRiskStateProvider } from '../src/exec/runtime.js'
import type { ExecRuntimeConfig } from '../src/exec/ports.js'
import { HeartbeatStore } from '../src/supervisor/heartbeat.js'
import { readStartupState } from '../src/ui/startup.js'

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
  createOrderCalls = 0

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
    this.createOrderCalls += 1
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
  it('拒绝零/超范围 riskPct 与非法 settleMs，避免配置失误静默放大风险', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    try {
      await expect(createExecRuntime(config({ riskPct: 0 }), { db, clock })).rejects.toThrow(/riskPct/)
      await expect(createExecRuntime(config({ riskPct: 0.051 }), { db, clock })).rejects.toThrow(/riskPct/)
      await expect(createExecRuntime(config({ settleMs: 0 }), { db, clock })).rejects.toThrow(/settleMs/)
    } finally {
      db.close()
    }
  })

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
    const startup = readStartupState(db, clock.now())
    expect(startup).not.toBeNull()
    expect(startup?.phase).toBe('ready')
    expect(startup?.restartCount1h).toBeGreaterThan(0)
    expect(startup?.steps.every((step) => step.status === 'succeeded')).toBe(true)

    const first = runtime.reconcileOnce()
    const second = runtime.reconcileOnce()
    expect(await first).toEqual(await second)
    // 组合根现在有两个周期任务：对账 + 结算扫描（plan §5.3）
    expect(clock.pendingTimers()).toBe(2)
    clock.advanceTo(NOW + 100)
    await Promise.resolve()
    expect(clock.pendingTimers()).toBe(2)

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
        mode: 'live_auto',
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
      config({ mode: 'live_auto', venue: 'htx', apiKey: undefined, apiSecret: undefined }),
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
        mode: 'live_auto',
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

  it('Docker 重启恢复先收敛在途意图，再进入普通对账', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'restart-decision',
      symbol: SYMBOL,
      decidedAt: NOW - 100,
      contextHash: 'ctx:restart',
      action: 'open',
      executed: false,
    })
    journal.recordIntent({
      intentId: 'restart-intent',
      clientOrderId: 'restart-client',
      decisionId: 'restart-decision',
      venue: 'paper',
      symbol: SYMBOL,
      state: 'created',
      type: 'market',
      side: 'buy',
      qty: 1,
      reduceOnly: false,
      createdAt: NOW - 100,
    })

    const runtime = await createExecRuntime(config(), { db, clock })
    try {
      const intent = db.prepare(
        'SELECT state, acked_at FROM order_intents WHERE client_order_id = ?',
      ).get('restart-client') as { state: string; acked_at: number | null }
      expect(intent).toEqual({ state: 'unknown', acked_at: null })
      expect(runtime.frozenSymbols().has(SYMBOL)).toBe(true)

      const startupKinds = db.prepare(
        "SELECT kind FROM audit_events WHERE kind IN ('crash_recovery', 'reconcile_report') ORDER BY seq",
      ).all() as { kind: string }[]
      expect(startupKinds.map((event) => event.kind)).toEqual(['crash_recovery', 'reconcile_report'])
    } finally {
      await runtime.dispose()
      db.close()
    }
  })

  it('fake HTX 非空启动链：先恢复 filled 在途意图，再对账并冻结未知远端持仓', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'htx-restart-decision',
      symbol: SYMBOL,
      decidedAt: NOW - 100,
      contextHash: 'ctx:htx-restart',
      action: 'open',
      executed: false,
    })
    journal.recordIntent({
      intentId: 'htx-restart-intent',
      clientOrderId: 'htx-restart-client',
      decisionId: 'htx-restart-decision',
      venue: 'htx',
      symbol: SYMBOL,
      state: 'created',
      type: 'market',
      side: 'buy',
      qty: 1,
      reduceOnly: false,
      createdAt: NOW - 100,
    })
    const exchange = new FakeExchange()
    exchange.trades = [{
      id: 'trade-1',
      order: 'exchange-order-1',
      clientOrderId: 'htx-restart-client',
      timestamp: NOW,
      price: 100,
      amount: 1,
      fee: { cost: 0.01 },
    }]
    exchange.positions = [{ symbol: 'OTHER/USDT:USDT', contracts: 1, entryPrice: 100, markPrice: 100 }]
    try {
      const runtime = await createExecRuntime(
        config({ mode: 'live_auto', venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
        { db, clock, createExchange: () => exchange },
      )
      try {
        expect(db.prepare('SELECT state, exchange_order_id FROM order_intents WHERE client_order_id = ?').get('htx-restart-client')).toEqual({
          state: 'filled',
          exchange_order_id: 'exchange-order-1',
        })
        expect(runtime.frozenSymbols().has('OTHER/USDT:USDT')).toBe(true)
        const startupKinds = db.prepare(
          "SELECT kind FROM audit_events WHERE kind IN ('crash_recovery', 'reconcile_report') ORDER BY seq",
        ).all() as { kind: string }[]
        expect(startupKinds.map((event) => event.kind)).toEqual(['crash_recovery', 'reconcile_report'])
      } finally {
        await runtime.dispose()
      }
    } finally {
      db.close()
    }
  })

  it('live_confirm 在构造 exchange 前 fail-closed，且不触达下单路由', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    let exchangeCalls = 0
    try {
      await expect(
        createExecRuntime(
          config({ mode: 'live_confirm', venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
          {
            db,
            clock,
            createExchange: () => {
              exchangeCalls += 1
              throw new Error('不应构造 exchange')
            },
          },
        ),
      ).rejects.toThrow('当前没有结构化逐单确认通道')
      expect(exchangeCalls).toBe(0)
      expect(db.prepare('SELECT COUNT(*) AS n FROM order_intents').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('heartbeat halt 动态冻结全部配置 symbol，resume 只解除心跳层并保留对账冻结', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const symbols = [SYMBOL, 'ETH/USDT:USDT']
    const exchange = new FakeExchange()
    exchange.positions = [{ symbol: 'DOGE/USDT:USDT', contracts: 1, entryPrice: 100, markPrice: 100 }]
    const runtime = await createExecRuntime(
      config({
        mode: 'live_auto',
        venue: 'htx',
        apiKey: 'key',
        apiSecret: 'secret',
        symbols,
        benchmark: symbols[0] as string,
      }),
      { db, clock, createExchange: () => exchange },
    )
    try {
      const heartbeat = new HeartbeatStore(new Statements(db))
      const initial = runtime.frozenSymbols()
      expect(initial.has(SYMBOL)).toBe(false)
      expect(initial.has('ETH/USDT:USDT')).toBe(false)

      heartbeat.halt(NOW + 1)
      const halted = runtime.frozenSymbols()
      expect(halted.has(SYMBOL)).toBe(true)
      expect(halted.has('ETH/USDT:USDT')).toBe(true)

      const account: AccountSnapshot = {
        venue: 'htx',
        equityQuote: 4_321,
        totalExposureUsd: 0,
        openOrders: 0,
        leverage: 0,
        dailyLossUsd: 0,
        drawdownUsd: 0,
        consecutiveLosses: 0,
        spreadBps: 0,
        observedAt: NOW + 1,
      }
      const openIntent: OrderRequest = {
        intentId: 'halt-open',
        clientOrderId: 'halt-open',
        decisionId: 'halt-open',
        symbol: SYMBOL,
        type: 'market',
        side: 'buy',
        qty: 0.01,
        notionalUsd: 10,
        reduceOnly: false,
      }
      const policy = {
        mode: 'live_auto' as const,
        limits: EXAMPLE_LIMITS,
        duplicateDecision: false,
        paperVenue: 'paper' as const,
        frozenSymbols: runtime.frozenSymbols(),
      }
      expect(validateIntent(openIntent, account, policy).kind).toBe('deny')
      // gate 在下单前拒绝，交易所只发生了执行前的只读状态重取，不会触达 createOrder。
      expect(exchange.createOrderCalls).toBe(0)
      expect(validateIntent({ ...openIntent, reduceOnly: true }, account, policy)).toEqual({ kind: 'allow' })

      await runtime.reconcileOnce()
      expect(runtime.frozenSymbols().has('DOGE/USDT:USDT')).toBe(true)
      heartbeat.resume(NOW + 2)
      const resumed = runtime.frozenSymbols()
      expect(resumed.has(SYMBOL)).toBe(false)
      expect(resumed.has('ETH/USDT:USDT')).toBe(false)
      // resume 不能抹掉对账发现的未知持仓冻结，避免人工恢复心跳掩盖状态不一致。
      expect(resumed.has('DOGE/USDT:USDT')).toBe(true)
    } finally {
      await runtime.dispose()
      db.close()
    }
  })
})
