import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS, type RiskLimits } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import type {
  AccountSnapshot,
  Broker,
  OrderAck,
  OrderRequest,
  PositionSnapshot,
  ProtectiveRequest,
  UserDataEvent,
} from '../src/exec/broker.js'
import { createLiveEngine, type LiveEngineDeps } from '../src/exec/live-engine.js'
import { executeAction } from '../src/exec/execute-action.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { PaperBroker } from '../src/exec/paper.js'
import { replay, type ReplayDeps } from '../src/exec/replay.js'
import { BarArchive } from '../src/market/archive.js'
import { FeatureEngine } from '../src/market/features.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { PlanStore } from '../src/plan/store.js'
import { TriggerQueue } from '../src/trigger/queue.js'
import { makeCard } from './helpers/plan.js'
import { raw } from './helpers/market.js'

const SYMBOL = 'BTC/USDT'
const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000
const LIMITS: RiskLimits = {
  ...EXAMPLE_LIMITS,
  perOrderCapUsd: 5_000,
  maxExposureUsd: 50_000,
  maxOpenOrders: 50,
}

/** 统计 broker 真实副作用；底层 PaperBroker 仍负责确定性撮合和真实 ack。 */
class FakeBroker implements Broker {
  readonly venue = 'paper' as const
  readonly paper: PaperBroker
  orderCalls = 0
  protectiveCalls = 0
  spreadBps = 0

  constructor(clock: ReplayClock) {
    this.paper = new PaperBroker({
      clock,
      book: { price: () => 100 },
      initialEquityQuote: 10_000,
      slippageBps: 5,
      feeBps: 5,
    })
  }

  async getAccount(): Promise<AccountSnapshot> {
    const account = await this.paper.getAccount()
    return { ...account, spreadBps: this.spreadBps }
  }

  getPositions(): Promise<readonly PositionSnapshot[]> {
    return this.paper.getPositions()
  }

  getOpenOrders(symbol?: string): Promise<readonly OrderAck[]> {
    return this.paper.getOpenOrders(symbol)
  }

  async placeOrder(request: OrderRequest): Promise<OrderAck> {
    this.orderCalls += 1
    return this.paper.placeOrder(request)
  }

  async placeProtective(request: ProtectiveRequest): Promise<OrderAck> {
    this.protectiveCalls += 1
    return this.paper.placeProtective(request)
  }

  onBar(symbol: string, candle: { high: number; low: number; close: number }): readonly OrderAck[] {
    return this.paper.onBar(symbol, candle)
  }

  realizedPnl(): number {
    return this.paper.realizedPnl()
  }

  cancelOrder(exchangeOrderId: string): Promise<void> {
    return this.paper.cancelOrder(exchangeOrderId)
  }

  cancelAll(symbol?: string, options?: { readonly includeProtection?: boolean }): Promise<void> {
    return this.paper.cancelAll(symbol, options)
  }

  subscribeUserData(_onEvent: (event: UserDataEvent) => void): () => void {
    return this.paper.subscribeUserData(_onEvent)
  }
}

interface Harness {
  readonly db: Database.Database
  readonly clock: ReplayClock
  readonly broker: FakeBroker
  readonly journal: DecisionJournal
  readonly plans: PlanStore
  readonly queue: TriggerQueue
  readonly deps: LiveEngineDeps
}

function harness(cardOver: Parameters<typeof makeCard>[0] = {}, now = START + HOUR): Harness {
  const db = new Database(':memory:')
  migrate(db)
  const clock = new ReplayClock(now)
  const bars = new BarArchive(db)
  bars.upsertClosed(normalizeCandles([raw(START, 100)], SYMBOL, TF, now).candles, {
    source: 'synthetic',
    fetchedAt: now,
  })
  const plans = new PlanStore(db)
  plans.save(
    makeCard({
      planId: 'pc-live-1',
      symbol: SYMBOL,
      createdAt: START,
      windowEndsAt: START + 2 * HOUR,
      invalidation: [{ id: 'inv-none', tf: TF, when: 'bar.close < 0', then: { action: 'close' } }],
      commitments: [
        {
          id: 'c-open',
          seq: 1,
          tf: TF,
          when: 'position.qty == 0 and bar.close == 100',
          then: {
            action: 'open',
            side: 'long',
            method: 'market',
            stop: { method: 'structure', level: 90 },
            riskFraction: 1,
          },
        },
      ],
      ...cardOver,
    }),
    START,
  )
  const broker = new FakeBroker(clock)
  const journal = new DecisionJournal(db)
  const queue = new TriggerQueue(db)
  const deps: LiveEngineDeps = {
    journal,
    plans,
    bars,
    features: new FeatureEngine(),
    broker,
    clock,
    mode: 'paper',
    limits: LIMITS,
    riskPct: 0.01,
    queue,
  }
  return { db, clock, broker, journal, plans, queue, deps }
}

describe('live-engine：收盘 bar 驱动计划卡执行', () => {
  it('承诺命中后只下单一次，并立即挂保护单；重复同一 bar 幂等', async () => {
    const h = harness()
    const engine = createLiveEngine(h.deps)

    const first = await engine.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    const intentCount = h.journal.intentIds().length
    // 先证明确实产生了样本，再断言一次主单 + 一次保护单，避免空跑误报。
    expect(intentCount).toBeGreaterThan(0)
    expect(first.kind).toBe('executed')
    expect(h.broker.orderCalls).toBe(1)
    expect(h.broker.protectiveCalls).toBe(1)
    const fills = h.db.prepare('SELECT price, fee FROM fills').all() as { price: number; fee: number }[]
    expect(fills.length).toBeGreaterThan(0)
    expect(fills[0]?.price).not.toBe(100)
    expect(fills[0]?.fee).toBeGreaterThan(0)

    const second = await engine.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    expect(second.kind).toBe('noop')
    expect(h.broker.orderCalls).toBe(1)
    expect(h.broker.protectiveCalls).toBe(1)
    expect(h.journal.intentIds().length).toBe(intentCount)
    expect(h.journal.duplicateClientOrderIds()).toBe(0)
    h.db.close()
  })

  it('硬闸拒绝要有审计、没有 order intent，并返回 denied', async () => {
    const h = harness()
    h.broker.spreadBps = LIMITS.maxSpreadBps + 1
    const engine = createLiveEngine(h.deps)
    const result = await engine.onClosedBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
    })

    expect(result.kind).toBe('denied')
    expect(h.broker.orderCalls).toBe(0)
    expect(h.journal.intentIds()).toEqual([])
    const auditRows = h.db
      .prepare("SELECT payload_json FROM audit_events WHERE kind = 'execute.denied'")
      .all() as { payload_json: string }[]
    expect(auditRows.length).toBeGreaterThan(0)
    expect(auditRows.some((row) => row.payload_json.includes('点差'))).toBe(true)
    h.db.close()
  })

  it('机械执行与工具共享敞口锁，并在锁内重读而非复用进入锁前的账户快照', async () => {
    const h = harness()
    const staleAccount = await h.broker.getAccount()
    const plan = makeCard({
      planId: 'concurrent-live-plan', symbol: SYMBOL, createdAt: START,
      windowEndsAt: START + 10 * HOUR,
    })
    const limits = { ...LIMITS, maxExposureUsd: 4_000 }
    const run = (conditionId: string, barTs: number) => executeAction({
      journal: h.journal, broker: h.broker, clock: h.clock, plan, conditionId,
      action: {
        action: 'open', side: 'long', method: 'market',
        stop: { method: 'structure', level: 90 }, riskFraction: 1,
      },
      symbol: SYMBOL, timeframe: TF, barTs, referencePrice: 100, atr: null,
      account: staleAccount, position: undefined,
      riskPct: 0.03, mode: 'paper', limits, reflectionHorizonMs: 4 * HOUR,
      alreadyIntended: (clientOrderId) => h.journal.hasClientOrderId(clientOrderId),
    })

    try {
      const results = await Promise.all([run('concurrent-live-a', START), run('concurrent-live-b', START + 1)])
      expect(results.filter((result) => result.executed)).toHaveLength(1)
      expect(results.filter((result) => result.denied)).toHaveLength(1)
      expect(h.broker.orderCalls).toBe(1)
      expect((await h.broker.getAccount()).totalExposureUsd).toBeLessThanOrEqual(limits.maxExposureUsd)
    } finally {
      h.db.close()
    }
  })

  it('排队开仓在等待锁期间进入 halt 后，锁内读到新冻结状态并拒绝下单', async () => {
    const h = harness()
    const staleAccount = await h.broker.getAccount()
    const realGetAccount = h.broker.getAccount.bind(h.broker)
    const plan = makeCard({
      planId: 'halt-race-plan', symbol: SYMBOL, createdAt: START,
      windowEndsAt: START + 10 * HOUR,
    })
    let markEntered!: () => void
    let releaseRead!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve })
    h.broker.getAccount = async () => {
      markEntered()
      await heldRead
      return realGetAccount()
    }
    let halted = false

    const pending = executeAction({
      journal: h.journal, broker: h.broker, clock: h.clock, plan, conditionId: 'halt-race',
      action: {
        action: 'open', side: 'long', method: 'market',
        stop: { method: 'structure', level: 90 }, riskFraction: 1,
      },
      symbol: SYMBOL, timeframe: TF, barTs: START + 2, referencePrice: 100, atr: null,
      account: staleAccount, position: undefined,
      riskPct: 0.01, mode: 'paper', limits: LIMITS, reflectionHorizonMs: 4 * HOUR,
      alreadyIntended: (clientOrderId) => h.journal.hasClientOrderId(clientOrderId),
      frozenSymbols: () => halted ? new Set([SYMBOL]) : new Set(),
    })
    try {
      await entered
      halted = true
      releaseRead()
      const result = await pending
      expect(result.denied).toBe(true)
      expect(result.reason).toContain('已被冻结')
      expect(h.broker.orderCalls).toBe(0)
    } finally {
      releaseRead()
      h.db.close()
    }
  })

  it('市价单回填超时（acked）时重取持仓并挂保护单，但终态前不登记结算', async () => {
    const h = harness()
    const realPlace = h.broker.placeOrder.bind(h.broker)
    // 模拟 HTX：createOrder 只回 open/new，且 #awaitFill 到点仍未确认 ⇒ ack.state='acked'
    h.broker.placeOrder = async (request: OrderRequest): Promise<OrderAck> => {
      const ack = await realPlace(request)
      return { ...ack, state: 'acked' }
    }

    const result = await createLiveEngine(h.deps).onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })

    expect(result.kind).toBe('executed')
    // 成交由"重取持仓"确认 ⇒ 保护单必须挂上（旧实现只看 ack.state ⇒ 留下裸仓）
    expect(h.broker.protectiveCalls).toBe(1)
    const positions = await h.broker.getPositions()
    expect(positions.some((position) => position.symbol === SYMBOL && position.qty !== 0)).toBe(true)
    const due = h.db
      .prepare('SELECT decision_id FROM decisions WHERE reflection_due_at IS NOT NULL')
      .all() as { decision_id: string }[]
    expect(due).toEqual([])
    h.db.close()
  })

  it('保护单被交易所拒绝 ⇒ 立即降级平仓并落审计（plan §6.3）', async () => {
    const h = harness()
    h.broker.placeProtective = async (request: ProtectiveRequest): Promise<OrderAck> => ({
      intentId: request.clientOrderId ?? 'pco',
      clientOrderId: request.clientOrderId ?? 'pco',
      state: 'rejected',
      ts: h.clock.now(),
      exchangeOrderId: 'rejected-1',
    })

    const result = await createLiveEngine(h.deps).onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    expect(result.kind).toBe('executed')

    // 主单 + 降级平仓 = 2 次 placeOrder；降级必须把仓位拉回 0（裸仓是已知危险态）
    expect(h.broker.orderCalls).toBe(2)
    const positions = await h.broker.getPositions()
    expect(positions.find((position) => position.symbol === SYMBOL)?.qty ?? 0).toBe(0)
    const audit = h.db
      .prepare("SELECT kind FROM audit_events WHERE kind LIKE 'protection_%'")
      .all() as { kind: string }[]
    expect(audit.length).toBeGreaterThan(0)
    h.db.close()
  })

  it('crossBelow 端到端：用前一根 bar 判定边沿，只在穿越那一根执行（plan §12.2 I）', async () => {
    const h = harness(
      {
        windowEndsAt: START + 6 * HOUR,
        commitments: [
          {
            id: 'c-cross',
            seq: 1,
            tf: TF,
            when: 'crossBelow(bar.close, 95)',
            then: {
              action: 'open',
              side: 'long',
              method: 'market',
              stop: { method: 'structure', level: 80 },
              riskFraction: 1,
            },
          },
        ],
      },
      START + 3 * HOUR,
    )
    // 两根 bar：START close=100（未穿越 95），START+HOUR close=90（向下穿越）
    const featureEngine = new FeatureEngine()
    const snapshots = new Map<string, ReturnType<FeatureEngine['onClosedCandle']>>()
    const candles = normalizeCandles([raw(START, 100), raw(START + HOUR, 90)], SYMBOL, TF, START + 3 * HOUR).candles
    new BarArchive(h.db).upsertClosed(candles, { source: 'synthetic', fetchedAt: START + 3 * HOUR })
    for (const candle of candles) {
      snapshots.set(
        `${candle.symbol}|${candle.timeframe}|${candle.openTime}`,
        featureEngine.onClosedCandle(candle),
      )
    }
    const live = createLiveEngine({
      ...h.deps,
      // 前一根快照由 feature 层提供（生产里是 FeatureArchive.get）
      features: { get: (symbol, timeframe, openTime) => snapshots.get(`${symbol}|${timeframe}|${openTime}`) },
    })

    // 第一根：没有前一根 ⇒ cross fail-closed 成 UNCOVERED，不下单
    const first = await live.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    expect(first.kind).toBe('uncovered')
    expect(h.broker.orderCalls).toBe(0)

    // 第二根：100 → 90 向下穿越 95 ⇒ 命中并执行一次
    const second = await live.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START + HOUR })
    expect(second.kind).toBe('executed')
    expect(h.broker.orderCalls).toBe(1)
    h.db.close()
  })

  it('首次读到账户后校验风控自洽性，不自洽落 limits_inconsistent 且只落一次（plan §12 #17）', async () => {
    const h = harness()
    const live = createLiveEngine(h.deps)
    // 本 harness 的 LIMITS（单笔上限 5000）相对权益 1 万 × riskPct 1% 是不自洽的：
    // maxNotionalAtMinStop = 10000 × 0.01 ÷ 0.005 = 20000 > 5000。
    await live.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    await live.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    const rows = h.db
      .prepare("SELECT payload_json FROM audit_events WHERE kind = 'limits_inconsistent'")
      .all() as { payload_json: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.payload_json).toContain('maxNotionalAtMinStop')
    h.db.close()
  })

  it('缺少 funding.rate 时 fail-closed 记 UNCOVERED，不下单', async () => {
    const h = harness({
      commitments: [
        {
          id: 'c-funding',
          seq: 1,
          tf: TF,
          when: 'funding.rate > 0.0001',
          then: {
            action: 'open',
            side: 'long',
            method: 'market',
            stop: { method: 'structure', level: 90 },
          },
        },
      ],
    })
    const engine = createLiveEngine(h.deps)
    const result = await engine.onClosedBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
    })

    expect(result.kind).toBe('uncovered')
    expect(result.reason).toContain('funding.rate')
    expect(h.broker.orderCalls).toBe(0)
    await engine.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    expect(h.queue.countFiredSince(['commitment'], 0)).toBe(1)
    const uncovered = h.db
      .prepare("SELECT payload_json FROM audit_events WHERE kind = 'plan.uncovered'")
      .all() as { payload_json: string }[]
    expect(uncovered.length).toBeGreaterThan(0)
    expect(uncovered[0]?.payload_json).toContain('UNCOVERED')
    const wake = h.queue.claim(h.clock.now())[0]
    expect(wake).toMatchObject({ purpose: 'commitment', disposition: 'judgment', state: 'claimed' })
    expect(wake?.payload).toMatchObject({
      timeframe: TF,
      detail: { wake: 'W2', conditionId: 'c-funding' },
    })
    h.db.close()
  })

  it('失效条件无法求值时立即冻结标的，不排队等待模型', async () => {
    const h = harness({
      invalidation: [{ id: 'inv-funding', tf: TF, when: 'funding.rate > 0.0001', then: { action: 'close' } }],
    })
    const frozen: string[] = []
    const result = await createLiveEngine({ ...h.deps, freezeSymbol: (symbol) => frozen.push(symbol) }).onClosedBar({
      symbol: SYMBOL, timeframe: TF, barTs: START,
    })

    expect(result.kind).toBe('uncovered')
    expect(frozen).toEqual([SYMBOL])
    expect(h.queue.queuedCount()).toBe(0)
    const report = h.db.prepare("SELECT payload_json FROM audit_events WHERE kind = 'plan.uncovered'").get() as { payload_json: string }
    expect(report.payload_json).toContain('P0_FREEZE')
    expect(h.broker.orderCalls).toBe(0)
    h.db.close()
  })

  it('不会执行升级后 schema 不兼容或 contentHash 被改写的 active plan', async () => {
    const h = harness()
    const card = h.plans.active(SYMBOL)!
    const legacy = JSON.parse(JSON.stringify(card)) as {
      planId: string
      commitments: { id: string; seq: number; tf: string; when: string; then: Record<string, unknown> }[]
    }
    const commitment = legacy.commitments[0]!
    legacy.commitments[0] = { ...commitment, then: { ...commitment.then, riskPct: 0.5 } }
    h.db.prepare('UPDATE plan_cards SET card_json = ? WHERE plan_id = ?').run(JSON.stringify(legacy), card.planId)
    const frozen: string[] = []

    const result = await createLiveEngine({ ...h.deps, freezeSymbol: (symbol) => frozen.push(symbol) }).onClosedBar({
      symbol: SYMBOL, timeframe: TF, barTs: START,
    })

    expect(result.kind).toBe('uncovered')
    expect(frozen).toEqual([SYMBOL])
    expect(h.broker.orderCalls).toBe(0)
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'plan.active_invalid'").get()).toMatchObject({ n: 1 })
    h.db.close()
  })

  it('计划卡到期先标记 expired，且不执行', async () => {
    const h = harness({ windowEndsAt: START + HOUR / 2 })
    const result = await createLiveEngine(h.deps).onClosedBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
    })

    expect(result.kind).toBe('expired')
    expect(h.plans.active(SYMBOL)).toBeUndefined()
    expect(h.broker.orderCalls).toBe(0)
    h.db.close()
  })

  it('同一计划卡执行组合下，live 与 replay 的 decision/intent/fill id 集合一致', async () => {
    const live = harness()
    const replayDb = new Database(':memory:')
    migrate(replayDb)
    const replayBars = new BarArchive(replayDb)
    replayBars.upsertClosed(normalizeCandles([raw(START, 100)], SYMBOL, TF, START + HOUR).candles, {
      source: 'synthetic',
      fetchedAt: START + HOUR,
    })
    const replayPlans = new PlanStore(replayDb)
    replayPlans.save(
      makeCard({
        planId: 'pc-live-1',
        symbol: SYMBOL,
        createdAt: START,
        windowEndsAt: START + 2 * HOUR,
        invalidation: [{ id: 'inv-none', tf: TF, when: 'bar.close < 0', then: { action: 'close' } }],
        commitments: [
          {
            id: 'c-open',
            seq: 1,
            tf: TF,
            when: 'position.qty == 0 and bar.close == 100',
            then: {
              action: 'open',
              side: 'long',
              method: 'market',
              stop: { method: 'structure', level: 90 },
              riskFraction: 1,
            },
          },
        ],
      }),
      START,
    )
    const replayClock = new ReplayClock(START)
    const replayBroker = new FakeBroker(replayClock)
    const replayQueue = new TriggerQueue(replayDb)
    const replayResult = await replay(
      {
        db: replayDb,
        bars: replayBars,
        plans: replayPlans,
        queue: replayQueue,
        broker: replayBroker as ReplayDeps['broker'],
        clock: replayClock,
        riskPct: 0.01,
        mode: 'paper',
        limits: LIMITS,
      },
      { symbol: SYMBOL, timeframe: TF, since: START, until: START + HOUR },
    )

    const liveResult = await createLiveEngine(live.deps).onClosedBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
    })
    expect(replayResult.decisionIds.length).toBeGreaterThan(0)
    expect(liveResult.kind).toBe('executed')
    expect(live.journal.decisionIds()).toEqual(replayResult.decisionIds)
    expect(live.journal.intentIds()).toEqual(replayResult.intentIds)
    expect(live.journal.fillIds()).toEqual(replayResult.fillIds)
    // 等价性只比较计划卡执行链；replay 还可选地运行 rule/trigger 通道，live-engine 当前不消费该通道。
    live.db.close()
    replayDb.close()
  })
})

describe('★ 决策级幂等：跨引擎重放同一 bar（paper 全链路第二遍暴露）', () => {
  it('被硬闸拒的决策重放不撞 decisions 主键，也不新增任何记录', async () => {
    const h = harness({ planId: 'pc-deny' }, START + HOUR)
    // 用极小的 perOrderCap 让 open 被拒（denied 路径：有 decision、没有 intent）
    const deps: LiveEngineDeps = { ...h.deps, limits: { ...LIMITS, perOrderCapUsd: 0.01 } }
    const first = createLiveEngine(deps)
    const r1 = await first.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    expect(r1.kind).toBe('denied')
    const decisionsAfterFirst = h.journal.decisionIds().length
    expect(decisionsAfterFirst).toBeGreaterThan(0) // 非空跑：确实落了一条被拒决策
    expect(h.journal.intentIds().length).toBe(0)

    // 新引擎（内部 fired 集合为空）重放同一 bar：旧实现会抛 UNIQUE constraint failed: decisions.decision_id
    const second = createLiveEngine(deps)
    await expect(
      second.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START }),
    ).resolves.toBeDefined()
    expect(h.journal.decisionIds().length).toBe(decisionsAfterFirst)
    expect(h.journal.intentIds().length).toBe(0)
  })

  it('已执行的动作跨引擎重放也不重复下单/不新增决策', async () => {
    const h = harness()
    await createLiveEngine(h.deps).onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    const decisions = h.journal.decisionIds().length
    const orderCalls = h.broker.orderCalls
    expect(decisions).toBeGreaterThan(0)
    expect(orderCalls).toBeGreaterThan(0)

    await createLiveEngine(h.deps).onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: START })
    expect(h.journal.decisionIds().length).toBe(decisions)
    expect(h.broker.orderCalls).toBe(orderCalls)
  })
})
