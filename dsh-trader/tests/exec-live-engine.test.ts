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

  cancelAll(symbol?: string): Promise<void> {
    return this.paper.cancelAll(symbol)
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
    fetchedAt: START,
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
            riskPct: 0.01,
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
    const result = await createLiveEngine(h.deps).onClosedBar({
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

  it('市价单回填超时（acked）时重取持仓确认，仍然挂保护单并登记结算', async () => {
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
    expect(due.length).toBeGreaterThan(0)
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
    const result = await createLiveEngine(h.deps).onClosedBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
    })

    expect(result.kind).toBe('uncovered')
    expect(result.reason).toContain('funding.rate')
    expect(h.broker.orderCalls).toBe(0)
    const uncovered = h.db
      .prepare("SELECT payload_json FROM audit_events WHERE kind = 'plan.uncovered'")
      .all() as { payload_json: string }[]
    expect(uncovered.length).toBeGreaterThan(0)
    expect(uncovered[0]?.payload_json).toContain('UNCOVERED')
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
      fetchedAt: START,
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
              riskPct: 0.01,
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
