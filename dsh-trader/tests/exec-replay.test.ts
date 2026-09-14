import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { SUGGESTED_LIMITS, type RiskLimits } from '../src/config.js'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { PlanStore } from '../src/plan/store.js'
import { PaperBroker } from '../src/exec/paper.js'
import { replay, type ReplayDeps, type ReplayResult } from '../src/exec/replay.js'
import { buildRules } from '../src/trigger/engine.js'
import { TriggerQueue } from '../src/trigger/queue.js'
import { randomSeries } from './helpers/market.js'
import { makeCard } from './helpers/plan.js'

const SYMBOL = 'BTC/USDT'
const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000
const BARS = 720 // 30 天 × 24 根 1h

/** 起始参数在启动时提供（plan §6.5）；这里放宽单笔上限，让开仓真的能成交。 */
const LIMITS: RiskLimits = { ...SUGGESTED_LIMITS, perOrderCapUsd: 5_000, maxExposureUsd: 50_000, maxOpenOrders: 50 }

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
        invalidation: [{ id: 'inv-adx', tf: TF, when: 'adx14 > 25', then: { action: 'close' } }],
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
