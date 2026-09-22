import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import { Statements } from '../src/db/statements.js'
import type { CcxtBalanceLike, CcxtMarketLike, CcxtOrderLike, CcxtPositionLike, CcxtProExchangeLike, CcxtTradeLike } from '../src/exec/ccxt-broker.js'
import type { AccountSnapshot, OrderRequest } from '../src/exec/broker.js'
import { validateIntent } from '../src/exec/gate.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { executeAction } from '../src/exec/execute-action.js'
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
  markets: Readonly<Record<string, CcxtMarketLike>> = {}
  openOrders: readonly CcxtOrderLike[] = []
  trades: readonly CcxtTradeLike[] = []
  directOrder: CcxtOrderLike | undefined
  createdOrders: CcxtOrderLike[] = []
  createOrderCalls = 0
  fetchOpenOrdersCalls = 0
  failFetchOpenOrdersCall: number | undefined

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
    this.fetchOpenOrdersCalls += 1
    if (this.fetchOpenOrdersCalls === this.failFetchOpenOrdersCall) throw new Error('temporary order read failure')
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
    const order: CcxtOrderLike = {
      id: `fake-order-${this.createOrderCalls}`,
      clientOrderId: params?.['clientOrderId'],
      symbol,
      type,
      side,
      amount,
      ...(price === undefined ? {} : { price }),
      ...(params?.['reduceOnly'] === undefined ? {} : { reduceOnly: params['reduceOnly'] }),
      ...(params?.['stopLossPrice'] === undefined ? {} : { stopPrice: params['stopLossPrice'] }),
      status: 'open',
    }
    this.createdOrders.push(order)
    this.openOrders = [...this.openOrders, order]
    return order
  }

  async cancelOrder(id: string): Promise<void> {
    this.cancelCalls.push(id)
    if (this.directOrder?.id === id) this.directOrder = { ...this.directOrder, status: 'canceled' }
    this.openOrders = this.openOrders.filter((order) => order.id !== id)
  }

  async fetchOrder(
    _id: string,
    _symbol?: string,
    _params?: Readonly<Record<string, unknown>>,
  ): Promise<CcxtOrderLike | undefined> {
    return this.directOrder?.id === _id
      ? this.directOrder
      : this.openOrders.find((order) => order.id === _id)
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

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

class DeferredPositionsExchange extends FakeExchange {
  // 让 HTX 撤单复核不等待模拟的最终一致性计时器；取消仍经过同一 broker 流程。
  override readonly has = { fetchOrder: true, fetchOpenOrders: false, fetchMyTrades: true }
  #nextPositionRead: { readonly entered: Deferred<void>; readonly release: Deferred<void> } | undefined
  #nextOpenOrdersRead: { readonly entered: Deferred<void>; readonly release: Deferred<void> } | undefined

  blockNextPositionsRead(): { readonly entered: Promise<void>; readonly release: () => void } {
    const entered = deferred<void>()
    const release = deferred<void>()
    this.#nextPositionRead = { entered, release }
    return { entered: entered.promise, release: () => release.resolve() }
  }

  blockNextOpenOrdersRead(): { readonly entered: Promise<void>; readonly release: () => void } {
    const entered = deferred<void>()
    const release = deferred<void>()
    this.#nextOpenOrdersRead = { entered, release }
    return { entered: entered.promise, release: () => release.resolve() }
  }

  override async fetchPositions(): Promise<readonly CcxtPositionLike[]> {
    const blocked = this.#nextPositionRead
    if (blocked !== undefined) {
      this.#nextPositionRead = undefined
      blocked.entered.resolve()
      await blocked.release.promise
    }
    return this.positions
  }

  override async fetchOpenOrders(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<readonly CcxtOrderLike[]> {
    const blocked = this.#nextOpenOrdersRead
    if (blocked !== undefined) {
      this.#nextOpenOrdersRead = undefined
      blocked.entered.resolve()
      await blocked.release.promise
    }
    return super.fetchOpenOrders(symbol, since, limit, params)
  }
}

function config(over: Partial<ExecRuntimeConfig> = {}): ExecRuntimeConfig {
  const merged: ExecRuntimeConfig = {
    mode: 'paper',
    liveArmed: false,
    waiver: false,
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
  return merged
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

  it('versions the effective runtime config while persisting credential presence only', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const cfg = config({ apiKey: 'RUNTIME-KEY-DO-NOT-STORE', apiSecret: 'RUNTIME-SECRET-DO-NOT-STORE' })
    const first = await createExecRuntime(cfg, { db, clock })
    const row = db.prepare('SELECT version, waiver, params_json FROM config_versions ORDER BY version DESC LIMIT 1').get() as {
      version: number; waiver: number; params_json: string
    }
    const serialized = row.params_json
    const saved = JSON.parse(serialized) as {
      mode: string; liveArmed: boolean; waiver: boolean; credentials: { keyInjected: boolean; secretInjected: boolean }
    }
    expect(saved).toMatchObject({
      mode: 'paper', liveArmed: false, waiver: false,
      credentials: { keyInjected: true, secretInjected: true },
    })
    expect(row.waiver).toBe(0)
    expect(serialized).not.toContain('RUNTIME-KEY-DO-NOT-STORE')
    expect(serialized).not.toContain('RUNTIME-SECRET-DO-NOT-STORE')
    await first.dispose()

    const second = await createExecRuntime(cfg, { db, clock })
    expect(db.prepare('SELECT COUNT(*) AS n FROM config_versions').get()).toMatchObject({ n: 1 })
    await second.dispose()
    db.close()
  })

  it('paper 无限额只有显式 waiver 才能运行，且配置版本准确标记 waiver', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    try {
      await expect(createExecRuntime(config({ limits: null }), { db, clock }))
        .rejects.toThrow(/显式 waiver=true/)
      expect(db.prepare('SELECT COUNT(*) AS n FROM config_versions').get()).toMatchObject({ n: 0 })

      const runtime = await createExecRuntime(config({ limits: null, waiver: true }), { db, clock })
      const saved = db.prepare('SELECT waiver, params_json FROM config_versions ORDER BY version DESC LIMIT 1').get() as {
        waiver: number; params_json: string
      }
      expect(saved.waiver).toBe(1)
      expect(JSON.parse(saved.params_json)).toMatchObject({ mode: 'paper', waiver: true, limits: null })
      expect(runtime.getPorts()).toMatchObject({ mode: 'paper', waiver: true, limits: null })
      await runtime.dispose()
    } finally {
      db.close()
    }
  })

  it('ccxt runtime 将 accountType 传给 fetchBalance；armed live_auto 缺凭据时 fail-closed', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const exchange = new FakeExchange()
    const live = await createExecRuntime(
      config({
        mode: 'live_auto',
        liveArmed: true,
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

    let missingCredentialExchangeCalls = 0
    await expect(createExecRuntime(
      config({ mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: undefined, apiSecret: undefined }),
      {
        db, clock,
        createExchange: () => {
          missingCredentialExchangeCalls += 1
          return new FakeExchange()
        },
      },
    )).rejects.toThrow(/API key 与 secret/)
    expect(missingCredentialExchangeCalls).toBe(0)
    db.close()
  })

  it('HTX live_auto 无论 spot 或永续符号都拒绝 spot accountType，且在构造交易所前失败', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    let exchangeCalls = 0
    try {
      for (const symbol of [SYMBOL, 'BTC/USDT']) {
        await expect(createExecRuntime(
          config({
            mode: 'live_auto', liveArmed: true, venue: 'htx',
            apiKey: 'key', apiSecret: 'secret', accountType: 'spot',
            symbols: [symbol], benchmark: symbol,
          }),
          {
            db,
            clock,
            createExchange: () => {
              exchangeCalls += 1
              return new FakeExchange()
            },
          },
        )).rejects.toThrow(/HTX live_auto 固定使用 swap accountType/)
        expect(exchangeCalls).toBe(0)
      }
    } finally {
      db.close()
    }
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
    exchange.markets = { 'ETH/USDT:USDT': { linear: true, swap: true, contractSize: 1 } }
    exchange.positions = [{ symbol: 'ETH/USDT:USDT', contracts: 1, entryPrice: 100, markPrice: 100 }]
    const runtime = await createExecRuntime(
      config({
        mode: 'live_auto',
        liveArmed: true,
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

  it('report-only 模式发现远端孤儿挂单时冻结该 symbol', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const exchange = new FakeExchange()
    exchange.openOrders = [{ id: 'orphan-order', clientOrderId: 'foreign-client', symbol: SYMBOL, status: 'open', type: 'limit', amount: 1, price: 100 }]
    const runtime = await createExecRuntime(
      config({ mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: 'key', apiSecret: 'secret', liveAckOrphans: false }),
      { db, clock, createExchange: () => exchange },
    )
    try {
      const report = await runtime.reconcileOnce()
      expect(report.result.actions.some((action) => action.kind === 'cancel_orphan')).toBe(true)
      expect(report.freezeTrading).toBe(true)
      expect(runtime.frozenSymbols().has(SYMBOL)).toBe(true)
      expect(exchange.cancelCalls).toEqual([])
    } finally {
      await runtime.dispose()
      db.close()
    }
  })

  it('acked intent 按交易所订单号查不到时转 unknown 并冻结，不能静默跳过', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'missing-order-decision', symbol: SYMBOL, decidedAt: NOW,
      contextHash: 'missing-order-context', action: 'open', executed: false,
    })
    journal.recordIntent({
      intentId: 'missing-order-intent', clientOrderId: 'missing-order-client', decisionId: 'missing-order-decision',
      venue: 'htx', symbol: SYMBOL, state: 'acked', type: 'market', side: 'buy', qty: 1,
      stopPrice: 90, reduceOnly: false, createdAt: NOW, exchangeOrderId: 'missing-exchange-id',
    })
    const runtime = await createExecRuntime(
      config({ mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
      { db, clock, createExchange: () => new FakeExchange() },
    )
    try {
      expect(journal.pollableIntents()[0]?.clientOrderId).toBe('missing-order-client')
      expect(journal.inFlightIntents()[0]?.state).toBe('unknown')
      expect(runtime.frozenSymbols().has(SYMBOL)).toBe(true)
      const account = await runtime.broker.getAccount()
      expect(validateIntent({
        intentId: 'new-open', clientOrderId: 'new-open', decisionId: 'new-open',
        symbol: SYMBOL, type: 'market', side: 'buy', qty: 0.01, notionalUsd: 1,
      }, account, {
        mode: 'live_auto', liveArmed: true, limits: EXAMPLE_LIMITS, duplicateDecision: false,
        paperVenue: 'paper', frozenSymbols: runtime.frozenSymbols(),
      })).toMatchObject({ kind: 'deny' })
    } finally {
      await runtime.dispose()
      db.close()
    }
  })

  it('周期状态轮询把延迟部分成交落账并补挂交易所侧保护', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'late-open-decision', symbol: SYMBOL, decidedAt: NOW,
      contextHash: 'late-open-context', action: 'open', executed: false,
    })
    journal.recordIntent({
      intentId: 'late-open-intent', clientOrderId: 'late-open-client', decisionId: 'late-open-decision',
      venue: 'htx', symbol: SYMBOL, state: 'acked', type: 'market', side: 'buy', qty: 1,
      stopPrice: 90, reduceOnly: false, createdAt: NOW, exchangeOrderId: 'late-open-exchange',
    })
    const exchange = new FakeExchange()
    exchange.markets = { [SYMBOL]: { linear: true, swap: true, contractSize: 0.1, precision: { amount: 0.1 } } }
    exchange.positions = [{ symbol: SYMBOL, side: 'long', contracts: 2.5, entryPrice: 100, markPrice: 100 }]
    exchange.directOrder = {
      id: 'late-open-exchange', clientOrderId: 'late-open-client', symbol: SYMBOL,
      type: 'market', side: 'buy', amount: 10, filled: 2.5, average: 100, status: 'partial',
    }
    exchange.openOrders = [exchange.directOrder]

    const runtime = await createExecRuntime(
      config({ mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
      { db, clock, createExchange: () => exchange },
    )
    try {
      expect(journal.fillIds()).toEqual(['fill:late-open-exchange:terminal'])
      expect(journal.fillsForDecision('late-open-decision')).toMatchObject([{ qty: 0.25, price: 100 }])
      expect(exchange.createdOrders.some((order) => order.stopPrice === 90)).toBe(true)
      const position = (await runtime.broker.getPositions()).find((item) => item.symbol === SYMBOL)
      expect(position).toMatchObject({ qty: 0.25, protectedStopPrice: 90 })
      expect(runtime.frozenSymbols().has(SYMBOL)).toBe(false)
    } finally {
      await runtime.dispose()
      db.close()
    }
  })

  it('迟到部分成交轮询持有共享账户锁直至落账并挂保护，排队开仓随后重读并被敞口闸拒绝', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const exchange = new DeferredPositionsExchange()
    const otherSymbol = 'ETH/USDT:USDT'
    exchange.markets = {
      [SYMBOL]: { linear: true, swap: true, contractSize: 0.1, precision: { amount: 0.1 } },
      [otherSymbol]: { linear: true, swap: true, contractSize: 0.1, precision: { amount: 0.1 } },
    }
    const runtime = await createExecRuntime(
      config({
        mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: 'key', apiSecret: 'secret',
        symbols: [SYMBOL, otherSymbol], maxExposureUsd: 40, perOrderCapUsd: 1_000,
      }),
      { db, clock, createExchange: () => exchange },
    )
    const journal = runtime.getPorts().journal
    journal.recordDecision({
      decisionId: 'race-late-open-decision', symbol: SYMBOL, decidedAt: NOW,
      contextHash: 'race-late-open-context', action: 'open', executed: false,
    })
    journal.recordIntent({
      intentId: 'race-late-open-intent', clientOrderId: 'race-late-open-client',
      decisionId: 'race-late-open-decision', venue: 'htx', symbol: SYMBOL,
      state: 'acked', type: 'market', side: 'buy', qty: 1, stopPrice: 90,
      reduceOnly: false, createdAt: NOW, exchangeOrderId: 'race-late-open-exchange',
    })
    exchange.directOrder = {
      id: 'race-late-open-exchange', clientOrderId: 'race-late-open-client', symbol: SYMBOL,
      type: 'market', side: 'buy', amount: 10, filled: 2.5, average: 100, status: 'partial',
    }
    exchange.openOrders = [exchange.directOrder]

    try {
      const hold = exchange.blockNextPositionsRead()
      const reconciliation = runtime.reconcileOnce()
      await hold.entered

      const balanceReadsBeforeQueuedOpen = exchange.balanceParams.length
      const freezeSymbol = runtime.getPorts().freezeSymbol
      const competingOpen = executeAction({
        journal,
        broker: runtime.broker,
        clock,
        plan: { planId: 'race-other-symbol-plan' },
        conditionId: 'open-other-symbol',
        action: {
          action: 'open', side: 'long', method: 'market',
          stop: { method: 'structure', level: 90 }, riskFraction: 1,
        },
        symbol: otherSymbol,
        barTs: NOW + 1,
        referencePrice: 100,
        atr: null,
        riskPct: 0.005,
        mode: 'live_auto',
        liveArmed: true,
        limits: { ...EXAMPLE_LIMITS, maxExposureUsd: 40, perOrderCapUsd: 1_000 },
        reflectionHorizonMs: 4 * 3_600_000,
        alreadyIntended: (clientOrderId) => journal.hasClientOrderId(clientOrderId),
        frozenSymbols: runtime.frozenSymbols,
        ...(freezeSymbol === undefined ? {} : { freezeSymbol }),
      })

      // 锁已由对账持有且停在保护前的持仓确认点；竞争开仓尚未读取账户。
      expect(exchange.balanceParams).toHaveLength(balanceReadsBeforeQueuedOpen)
      expect(exchange.createdOrders).toEqual([])

      // 释放模拟的持仓快照延迟，成交量和保护单都必须在锁释放前收敛。
      exchange.positions = [{ symbol: SYMBOL, side: 'long', contracts: 2.5, entryPrice: 100, markPrice: 100 }]
      hold.release()
      const [report, openResult] = await Promise.all([reconciliation, competingOpen])

      expect(report.consistent).toBe(true)
      expect(journal.fillsForDecision('race-late-open-decision')).toMatchObject([{ qty: 0.25, price: 100 }])
      expect(exchange.createdOrders).toHaveLength(1)
      expect(exchange.createdOrders[0]).toMatchObject({ type: 'stop', stopPrice: 90 })
      expect(openResult).toMatchObject({ executed: false, denied: true })
      expect(openResult.reason).toContain('超过上限 40')
      expect(exchange.balanceParams).toHaveLength(balanceReadsBeforeQueuedOpen + 1)
      expect((await runtime.broker.getPositions()).find((position) => position.symbol === SYMBOL))
        .toMatchObject({ qty: 0.25, protectedStopPrice: 90 })
    } finally {
      await runtime.dispose()
      db.close()
    }
  })

  it('默认只读对账持锁完成快照与冻结，排队开仓重读冻结状态后拒绝', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const exchange = new DeferredPositionsExchange()
    const otherSymbol = 'ETH/USDT:USDT'
    exchange.markets = {
      [SYMBOL]: { linear: true, swap: true, contractSize: 0.1, precision: { amount: 0.1 } },
      [otherSymbol]: { linear: true, swap: true, contractSize: 0.1, precision: { amount: 0.1 } },
    }
    const runtime = await createExecRuntime(
      config({
        mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: 'key', apiSecret: 'secret',
        symbols: [SYMBOL, otherSymbol],
      }),
      { db, clock, createExchange: () => exchange },
    )
    const journal = runtime.getPorts().journal
    exchange.openOrders = [{
      id: 'unscoped-orphan-order', clientOrderId: 'unscoped-orphan-client',
      type: 'limit', side: 'buy', amount: 1, remaining: 1, price: 100, status: 'open',
    }]

    try {
      const hold = exchange.blockNextOpenOrdersRead()
      const reconciliation = runtime.reconcileOnce()
      await hold.entered

      const balanceReadsBeforeQueuedOpen = exchange.balanceParams.length
      const competingOpen = executeAction({
        journal,
        broker: runtime.broker,
        clock,
        plan: { planId: 'reconcile-freeze-other-symbol-plan' },
        conditionId: 'open-during-readonly-reconcile',
        action: {
          action: 'open', side: 'long', method: 'market',
          stop: { method: 'structure', level: 90 }, riskFraction: 1,
        },
        symbol: otherSymbol,
        barTs: NOW + 2,
        referencePrice: 100,
        atr: null,
        riskPct: 0.005,
        mode: 'live_auto',
        liveArmed: true,
        limits: EXAMPLE_LIMITS,
        reflectionHorizonMs: 4 * 3_600_000,
        alreadyIntended: (clientOrderId) => journal.hasClientOrderId(clientOrderId),
        frozenSymbols: runtime.frozenSymbols,
      })

      expect(exchange.balanceParams).toHaveLength(balanceReadsBeforeQueuedOpen)
      expect(exchange.createOrderCalls).toBe(0)

      hold.release()
      const [report, openResult] = await Promise.all([reconciliation, competingOpen])

      expect(report.actions).toContainEqual(expect.objectContaining({ kind: 'cancel_orphan' }))
      expect(report.freezeTrading).toBe(true)
      expect(runtime.frozenSymbols().has(otherSymbol)).toBe(true)
      expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'reconcile_report'").get())
        .toMatchObject({ n: 2 })
      expect(openResult).toMatchObject({ executed: false, denied: true })
      expect(openResult.reason).toContain('已被冻结')
      expect(exchange.balanceParams).toHaveLength(balanceReadsBeforeQueuedOpen + 1)
      expect(exchange.createOrderCalls).toBe(0)
    } finally {
      await runtime.dispose()
      db.close()
    }
  })

  it('启动对账短暂失败时保留 runtime：冻结新敞口但仍可走减险硬闸', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    const exchange = new FakeExchange()
    // CrashRecovery 会按单标的读 6 个普通/算法列表；让随后的第一次完整对账读失败一次。
    exchange.failFetchOpenOrdersCall = 7
    const runtime = await createExecRuntime(
      config({ mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
      { db, clock, createExchange: () => exchange },
    )
    try {
      expect(runtime.getPorts()).toBeDefined()
      expect(runtime.frozenSymbols().has(SYMBOL)).toBe(true)
      const account = await runtime.broker.getAccount()
      const reducing: OrderRequest = {
        intentId: 'reduce-after-startup-reconcile-failure',
        clientOrderId: 'reduce-after-startup-reconcile-failure',
        decisionId: 'reduce-after-startup-reconcile-failure',
        symbol: SYMBOL,
        type: 'market',
        side: 'sell',
        qty: 0.01,
        notionalUsd: 1,
        reduceOnly: true,
      }
      expect(validateIntent(reducing, account, {
        mode: 'live_auto', liveArmed: true, limits: EXAMPLE_LIMITS, duplicateDecision: false,
        paperVenue: 'paper', frozenSymbols: runtime.frozenSymbols(),
      })).toEqual({ kind: 'allow' })

      const report = await runtime.reconcileOnce()
      expect(report.consistent).toBe(true)
      await Promise.resolve()
      expect(runtime.frozenSymbols().has(SYMBOL)).toBe(false)
    } finally {
      await runtime.dispose()
      db.close()
    }
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

  it('fake HTX 非空启动链：无 exchangeOrderId 的在途意图保持 unknown，并冻结相关标的', async () => {
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
    exchange.markets = {
      [SYMBOL]: { linear: true, swap: true, contractSize: 1 },
      'OTHER/USDT:USDT': { linear: true, swap: true, contractSize: 1 },
    }
    exchange.positions = [{ symbol: 'OTHER/USDT:USDT', contracts: 1, entryPrice: 100, markPrice: 100 }]
    try {
      const runtime = await createExecRuntime(
        config({ mode: 'live_auto', liveArmed: true, venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
        { db, clock, createExchange: () => exchange },
      )
      try {
        expect(db.prepare('SELECT state, exchange_order_id FROM order_intents WHERE client_order_id = ?').get('htx-restart-client')).toEqual({
          state: 'unknown',
          exchange_order_id: null,
        })
        expect(runtime.frozenSymbols().has(SYMBOL)).toBe(true)
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

  it('live_auto 必须显式 arm 且限额非空；拒绝发生在构造 exchange 前', async () => {
    const db = openDatabase()
    const clock = new ReplayClock(NOW)
    let exchangeCalls = 0
    try {
      await expect(
        createExecRuntime(
          config({ mode: 'live_auto', liveArmed: false, venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
          {
            db,
            clock,
            createExchange: () => {
              exchangeCalls += 1
              throw new Error('不应构造 exchange')
            },
          },
        ),
      ).rejects.toThrow(/显式 liveArmed=true/)
      await expect(
        createExecRuntime(
          config({ mode: 'live_auto', liveArmed: true, limits: null, venue: 'htx', apiKey: 'key', apiSecret: 'secret' }),
          {
            db,
            clock,
            createExchange: () => {
              exchangeCalls += 1
              throw new Error('不应构造 exchange')
            },
          },
        ),
      ).rejects.toThrow(/全部硬风险限额/)
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
    exchange.markets = { 'DOGE/USDT:USDT': { linear: true, swap: true, contractSize: 1 } }
    exchange.positions = [{ symbol: 'DOGE/USDT:USDT', contracts: 1, entryPrice: 100, markPrice: 100 }]
    const runtime = await createExecRuntime(
      config({
        mode: 'live_auto',
        liveArmed: true,
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
        pendingExposureUsd: 0,
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
