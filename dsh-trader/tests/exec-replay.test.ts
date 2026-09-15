import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS, type RiskLimits } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { PlanStore } from '../src/plan/store.js'
import { PaperBroker } from '../src/exec/paper.js'
import { replay, type ReplayDeps, type ReplayResult } from '../src/exec/replay.js'
import { CrashRecovery } from '../src/exec/recovery.js'
import { buildRules } from '../src/trigger/engine.js'
import { TriggerQueue } from '../src/trigger/queue.js'
import { randomSeries, raw } from './helpers/market.js'
import { makeCard } from './helpers/plan.js'

const SYMBOL = 'BTC/USDT'
const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000
const BARS = 720 // 30 天 × 24 根 1h

/** 起始参数在启动时提供（plan §6.5）；这里放宽单笔上限，让开仓真的能成交。 */
const LIMITS: RiskLimits = { ...EXAMPLE_LIMITS, perOrderCapUsd: 5_000, maxExposureUsd: 50_000, maxOpenOrders: 50 }

interface Harness {
  readonly db: Database.Database
  readonly deps: ReplayDeps
  readonly broker: PaperBroker
}

function harness(seed = 1): Harness {
  const db = new Database(':memory:')
  migrate(db)
  const clock = new ReplayClock(START)
  const bars = new BarArchive(db)
  const plans = new PlanStore(db)
  const queue = new TriggerQueue(db)

  const candles = normalizeCandles(randomSeries(START, BARS, seed), SYMBOL, TF, START + BARS * HOUR).candles
  bars.upsertClosed(candles, { source: 'synthetic', fetchedAt: START })

  const broker = new PaperBroker({
    clock,
    book: { price: () => undefined }, // 回放时价格来自 onBar
    initialEquityQuote: 10_000,
    slippageBps: 5,
    feeBps: 5,
  })

  return {
    db,
    broker,
    deps: {
      db,
      bars,
      plans,
      queue,
      broker,
      clock,
      rules: buildRules(['mean_reversion_v1', 'breakout_v1'], { cooldownMs: 0 }).rules,
      riskPct: 0.01,
      mode: 'paper',
      limits: LIMITS,
    },
  }
}

function card() {
  return makeCard({
    planId: 'pc-replay-1',
    symbol: SYMBOL,
    createdAt: START,
    windowEndsAt: START + BARS * HOUR,
    invalidation: [
      {
        id: 'inv-break',
        tf: TF,
        when: 'position.qty > 0 and bar.close < ema20 * 0.99',
        then: { action: 'close' },
      },
    ],
    commitments: [
      {
        id: 'c-open',
        seq: 1,
        tf: TF,
        when: 'position.qty == 0 and rsi14 < 45',
        then: { action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskPct: 0.01 },
      },
      {
        id: 'c-take',
        seq: 2,
        tf: TF,
        when: 'position.qty > 0 and rsi14 > 60',
        then: { action: 'reduce', fraction: 0.5 },
      },
    ],
  })
}

function run(deps: ReplayDeps): Promise<ReplayResult> {
  return replay(deps, { symbol: SYMBOL, timeframe: TF, since: START, until: START + BARS * HOUR })
}

describe('T0.8b acceptance: deterministic replay (plan §10 P0 ②③)', () => {
  it('replaying 30 days twice produces identical id sets and zero duplicate clientOrderIds', async () => {
    const first = harness(7)
    const second = harness(7)
    first.deps.plans.save(card(), START)
    second.deps.plans.save(card(), START)

    const a = await run(first.deps)
    const b = await run(second.deps)

    expect(a.counters.bars).toBe(BARS)

    // ② 三个表（＋触发）的 id 集合完全相等
    expect(a.decisionIds.length).toBeGreaterThan(0)
    expect(a.intentIds).toEqual(b.intentIds)
    expect(a.clientOrderIds).toEqual(b.clientOrderIds)
    expect(a.fillIds).toEqual(b.fillIds)
    expect(a.decisionIds).toEqual(b.decisionIds)
    expect(a.triggerKeys).toEqual(b.triggerKeys)

    // ② client_order_id 重复数 = 0
    expect(a.duplicateClientOrderIds).toBe(0)
    expect(b.duplicateClientOrderIds).toBe(0)

    // 回放确实产生了动作，而不是"什么都没发生所以相等"
    expect(a.counters.matched).toBeGreaterThan(0)
    expect(a.counters.executed).toBeGreaterThan(0)
    expect(a.fillIds.length).toBeGreaterThan(0)
    expect(a.realizedPnl).toBe(b.realizedPnl)

    first.db.close()
    second.db.close()
  })

  it('attributes every hit in the log: matched / UNCOVERED / rule / denied', async () => {
    const h = harness(7)
    h.deps.plans.save(card(), START)
    const result = await run(h.deps)

    const matched = result.log.filter((line) => line.startsWith('matched:'))
    const uncovered = result.log.filter((line) => line.startsWith('UNCOVERED:'))
    const ruleLines = result.log.filter((line) => line.startsWith('rule:'))
    const denied = result.log.filter((line) => line.startsWith('denied:'))

    expect(matched).toHaveLength(result.counters.matched)
    expect(uncovered.length).toBeGreaterThanOrEqual(result.counters.uncovered)
    expect(ruleLines.length).toBeGreaterThan(0)

    // 每条规则命中都有一条归属记录，且去向是已知枚举
    const known = ['info', 'novelty', 'judgment', 'cooldown', 'rate_limited', 'executed']
    for (const line of ruleLines) {
      expect(known).toContain(line.split(':')[2])
    }
    // 允许被硬闸拒绝，但必须留痕（不能静默丢弃）
    for (const line of denied) {
      expect(line.split(':').length).toBeGreaterThanOrEqual(3)
    }

    h.db.close()
  })

  it('turns an unevaluable plan condition into UNCOVERED instead of a silent no-match', async () => {
    const h = harness(7)
    h.deps.plans.save(
      makeCard({
        planId: 'pc-uncovered',
        symbol: SYMBOL,
        createdAt: START,
        windowEndsAt: START + BARS * HOUR,
        // ★ T2.4 之后 `adx14` 已是可实现指标（回放会算出真实值），因此"不可求值"的样本
        // 改用 `funding.rate`：它在词汇表内，但回放没有注入衍生品数据 ⇒ 取值缺失 ⇒ UNCOVERED。
        // 这正是 fail-closed 要守的语义：**已实现但当时无数据**也不许静默当成 false。
        invalidation: [{ id: 'inv-funding', tf: TF, when: 'funding.rate > 0.0001', then: { action: 'close' } }],
        commitments: [],
      }),
      START,
    )

    const result = await run(h.deps)

    expect(result.counters.matched).toBe(0)
    expect(result.counters.uncovered).toBe(BARS)
    // 计划卡的行全部是 UNCOVERED；规则行是另一类归属记录
    const planLines = result.log.filter((line) => !line.startsWith('rule:'))
    expect(planLines.every((line) => line.startsWith('UNCOVERED:'))).toBe(true)
    expect(result.decisionIds).toEqual([])

    h.db.close()
  })

  it('never duplicates an intent when the same bars are replayed into the same database', async () => {
    const h = harness(7)
    h.deps.plans.save(card(), START)
    const first = await run(h.deps)

    // 同一个库、全新的纸面账户与时钟：第二轮会有新的合法动作（账户是平的），
    // 但**绝不能**重复同一个 client_order_id，也绝不能重复决策
    const clock2 = new ReplayClock(START)
    const freshBroker = new PaperBroker({
      clock: clock2,
      book: { price: () => undefined },
      initialEquityQuote: 10_000,
      slippageBps: 5,
      feeBps: 5,
    })
    const second = await run({ ...h.deps, broker: freshBroker, clock: clock2 })

    expect(second.duplicateClientOrderIds).toBe(0)
    for (const id of first.intentIds) expect(second.intentIds).toContain(id)
    expect(new Set(second.decisionIds).size).toBe(second.decisionIds.length)
    expect(second.decisionIds.length).toBeGreaterThanOrEqual(first.decisionIds.length)

    h.db.close()
  })
})

describe('回放/机械执行也要进结算队列（P1 ④ 的前置）', () => {
  it('★ 成交的决策必须登记 reflection_due_at，否则结算器永远扫不到东西', async () => {
    const { db, deps } = harness(7)
    deps.plans.save(card(), START)
    const result = await replay(deps, { symbol: SYMBOL, timeframe: TF, since: START, until: START + BARS * HOUR })
    expect(result.counters.executed).toBeGreaterThan(0)

    const { DecisionJournal } = await import('../src/exec/journal.js')
    const journal = new DecisionJournal(db)
    // 关键：pending 不为 0。少了这一步，整条反思闭环在回测里根本不会跑，
    // 而"结算成功率 ≥99%"会在 0 个样本上"通过"。
    const pending = journal.pendingSettlements(START + BARS * HOUR + 24 * HOUR, 1000)
    expect(pending.length).toBe(result.counters.executed)
    for (const decision of pending) {
      expect(decision.action === 'open' || decision.action === 'reduce' || decision.action === 'close').toBe(true)
    }
  })

  it('结算本身幂等：同一批到期决策跑两遍不会多出 outcome', async () => {
    const { db, deps } = harness(7)
    deps.plans.save(card(), START)
    await replay(deps, { symbol: SYMBOL, timeframe: TF, since: START, until: START + BARS * HOUR })
    const { DecisionJournal } = await import('../src/exec/journal.js')
    const { SettlementScheduler } = await import('../src/memory/settle.js')
    const { BarArchive } = await import('../src/market/archive.js')
    const scheduler = new SettlementScheduler({
      journal: new DecisionJournal(db),
      bars: new BarArchive(db),
      clock: new ReplayClock(START),
      timeframe: TF,
      horizonMs: 4 * HOUR,
      benchmarkSymbol: SYMBOL,
      slippageBps: 5,
    })
    const at = START + (BARS + 48) * HOUR
    const first = await scheduler.runOnce(at, 1000)
    const second = await scheduler.runOnce(at, 1000)
    expect(first.settled).toBeGreaterThan(0)
    expect(second.skipped).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM outcomes').get() as { n: number }).n).toBe(first.settled)
    expect(new DecisionJournal(db).duplicateClientOrderIds()).toBe(0)
  })
})

// ── 审计修复的回归测试（保护单/成交价/平仓/限价/计划年龄）─────────────────────
describe('回放审计修复', () => {
  const H = 3_600_000
  const S = 'BTC/USDT'
  const T = 1_700_000_000_000
  type CardOver = Parameters<typeof makeCard>[0]

  function scenario(
    rawBars: readonly ReturnType<typeof raw>[],
    cardOver: CardOver,
    brokerOver: { readonly feeBps?: number; readonly slippageBps?: number } = {},
  ) {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(T - 100 * H)
    const bars = new BarArchive(db)
    const queue = new TriggerQueue(db)
    bars.upsertClosed(normalizeCandles(rawBars, S, TF, T + 1000 * H).candles, {
      source: 'synthetic',
      fetchedAt: T,
    })
    const broker = new PaperBroker({
      clock,
      book: { price: () => undefined },
      initialEquityQuote: 100_000,
      slippageBps: brokerOver.slippageBps ?? 5,
      feeBps: brokerOver.feeBps ?? 5,
    })
    const plans = new PlanStore(db)
    plans.save(
      makeCard({ planId: 'pc-audit', symbol: S, createdAt: T, windowEndsAt: T + 100 * H, ...cardOver }),
      T,
    )
    const deps: ReplayDeps = {
      db,
      bars,
      plans,
      queue,
      broker,
      clock,
      riskPct: 0.01,
      mode: 'paper',
      limits: null,
    }
    return { db, clock, bars, queue, broker, deps }
  }

  it('★ set_stop 不再撞外键崩掉整个回放，并且保护单也进审计链', async () => {
    const h = scenario(
      [raw(T, 100), raw(T + H, 100)],
      {
        invalidation: [{ id: 'inv-x', tf: TF, when: 'bar.close < 0', then: { action: 'close' } }],
        commitments: [
          {
            id: 'c-open',
            seq: 1,
            tf: TF,
            when: 'position.qty == 0',
            then: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 90 }, riskPct: 0.01 },
          },
          {
            id: 'c-stop',
            seq: 2,
            tf: TF,
            when: 'position.qty > 0',
            then: { action: 'set_stop', price: 85 },
          },
        ],
      },
    )
    const result = await replay(h.deps, { symbol: S, timeframe: TF, since: T, until: T + 2 * H })
    expect(result.counters.executed).toBe(2)
    // 自动保护单 + set_stop 都应有 order_intents 行
    const ids = result.intentIds
    expect(ids.some((id) => id.startsWith('pi-open:'))).toBe(true)
    expect(ids.some((id) => id.startsWith('pi:'))).toBe(true)
  })

  it('★ 做空限价单挂在市价之上（偏移方向与做多相反）', async () => {
    const h = scenario(
      [raw(T, 100), raw(T + H, 100), raw(T + 2 * H, 100)],
      {
        invalidation: [{ id: 'inv-none', tf: TF, when: 'bar.close < 0', then: { action: 'close' } }],
        commitments: [
          {
            id: 'c-short-limit',
            seq: 1,
            tf: TF,
            when: 'position.qty == 0',
            then: {
              action: 'open',
              side: 'short',
              method: 'limit',
              limitOffsetBps: 50,
              stop: { method: 'structure', level: 100_000 },
              riskPct: 0.01,
            },
          },
        ],
      },
    )
    await replay(h.deps, { symbol: S, timeframe: TF, since: T, until: T + H })
    const row = h.db
      .prepare("SELECT side, price FROM order_intents WHERE client_order_id LIKE 'co:%' LIMIT 1")
      .get() as { side: string; price: number } | undefined
    expect(row?.side).toBe('sell')
    expect(row?.price).toBeGreaterThan(100) // 100 × (1 + 50bps)
  })

  it('★ close 必须 cancelAll(symbol)，否则残留保护单会反向开仓', async () => {
    const h = scenario(
      [raw(T, 100), raw(T + H, 95, { open: 100, high: 100, low: 94 })],
      {
        invalidation: [{ id: 'inv-none', tf: TF, when: 'bar.close < 0', then: { action: 'close' } }],
        commitments: [
          {
            id: 'c-open',
            seq: 1,
            tf: TF,
            when: 'position.qty == 0',
            then: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 90 }, riskPct: 0.01 },
          },
          { id: 'c-close', seq: 2, tf: TF, when: 'position.qty > 0 and bar.close < 99', then: { action: 'close' } },
        ],
      },
    )
    const result = await replay(h.deps, { symbol: S, timeframe: TF, since: T, until: T + 2 * H })
    expect(result.counters.executed).toBe(2)
    expect(await h.broker.getOpenOrders()).toHaveLength(0)
  })

  it('★ 非命中 bar 上的止损也必须计入 realizedPnl，且成交价/手续费是真实的', async () => {
    const bars: ReturnType<typeof raw>[] = []
    for (let i = 0; i < 5; i += 1) bars.push(raw(T + i * H, 100, { open: 100, high: 101, low: 99.5 }))
    bars.push(raw(T + 5 * H, 91, { open: 100, high: 101, low: 90 }))

    const h = scenario(bars, {
      invalidation: [{ id: 'inv-none', tf: TF, when: 'bar.close < 0', then: { action: 'close' } }],
      commitments: [
        {
          id: 'c-open-once',
          seq: 1,
          tf: TF,
          when: 'position.qty == 0 and bar.close > 99',
          then: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 95 }, riskPct: 0.01 },
        },
      ],
    })
    const result = await replay(h.deps, { symbol: S, timeframe: TF, since: T, until: T + 6 * H })
    expect(result.counters.executed).toBe(1)
    // 止损在最后一根（无计划命中）触发 ⇒ 盈亏必须被采样到
    expect(result.realizedPnl).not.toBe(0)
    expect(result.tradePnl.length).toBeGreaterThan(0)
    // 成交价必须含滑点（≠ 信号 bar 收盘价），手续费必须非 0
    const fills = h.db.prepare('SELECT price, fee FROM fills').all() as { price: number; fee: number }[]
    expect(fills.length).toBeGreaterThanOrEqual(2)
    expect(fills.some((fill) => fill.price !== 100)).toBe(true)
    expect(fills.every((fill) => fill.fee > 0)).toBe(true)
  })

  it('★ 计划卡引用 plan.ageMs 必须可求值（不是永久 UNCOVERED）', async () => {
    const h = scenario([raw(T, 100), raw(T + H, 100), raw(T + 2 * H, 100)], {
      invalidation: [{ id: 'inv-age', tf: TF, when: 'plan.ageMs >= 0', then: { action: 'noop' } }],
      commitments: [],
    })
    const result = await replay(h.deps, { symbol: S, timeframe: TF, since: T, until: T + 3 * H })
    expect(result.counters.uncovered).toBe(0)
    expect(result.counters.matched).toBe(3)
  })

  it('★ 自动保护单有本地记录 ⇒ 恢复不会再把它判成孤儿单', async () => {
    const h = scenario([raw(T, 100), raw(T + H, 100)], {
      invalidation: [{ id: 'inv-none', tf: TF, when: 'bar.close < 0', then: { action: 'close' } }],
      commitments: [
        {
          id: 'c-open',
          seq: 1,
          tf: TF,
          when: 'position.qty == 0',
          then: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 90 }, riskPct: 0.01 },
        },
      ],
    })
    await replay(h.deps, { symbol: S, timeframe: TF, since: T, until: T + H })
    const live = await h.broker.getOpenOrders(S)
    expect(live.length).toBeGreaterThan(0)
    const recovery = new CrashRecovery({
      journal: new (await import('../src/exec/journal.js')).DecisionJournal(h.db),
      broker: h.broker as never,
      clock: h.clock,
      symbols: [S],
    })
    const result = await recovery.run()
    expect(result.orphanOpenOrders).toEqual([])
  })
})
