import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { BudgetLedger, PriceTableStore, dayKey, symbolScope } from '../src/cost-ledger.js'
import { DEEPSEEK_PRICE_SEED } from '../src/cost.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { PlanStore } from '../src/plan/store.js'
import { TriggerQueue } from '../src/trigger/queue.js'
import { MetricsStore, dayBounds, dailyMetricsAt } from '../src/supervisor/metrics.js'
import { makeCard } from './helpers/plan.js'

const DAY = '2026-09-14'
const NOON = Date.parse(`${DAY}T12:00:00.000Z`)
const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']

let db: Database.Database
let metrics: MetricsStore

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  metrics = new MetricsStore(db)
})

afterEach(() => {
  db.close()
})

describe('dayBounds', () => {
  it('按 UTC 切一天，且校验格式', () => {
    const bounds = dayBounds(DAY)
    expect(bounds.start).toBe(Date.parse(`${DAY}T00:00:00.000Z`))
    expect(bounds.end - bounds.start).toBe(86_400_000)
    expect(() => dayBounds('2026/09/14')).toThrow(/YYYY-MM-DD/)
  })
})

describe('MetricsStore：P1 ③ 的三项指标', () => {
  it('覆盖率 = 有 active 且未过期计划卡的标的数 / 标的池', () => {
    const plans = new PlanStore(db)
    plans.save(makeCard({ planId: 'pc-btc', symbol: 'BTC/USDT', windowEndsAt: NOON + 3_600_000 }), NOON)
    plans.save(makeCard({ planId: 'pc-eth', symbol: 'ETH/USDT', windowEndsAt: NOON - 3_600_000 }), NOON)

    const result = metrics.compute({ day: DAY, symbols: SYMBOLS, asOf: NOON })
    // ETH 的计划卡在 11:00 就到期了 ⇒ 在 NOON 看不算覆盖
    expect(result.asOf).toBe(NOON)
    expect(result.coverage.withActivePlan).toEqual(['BTC/USDT'])
    expect(result.coverage.ratio).toBeCloseTo(1 / 3, 10)
  })

  it('覆盖率与评估时刻绑定：同一份数据换个时刻结论就不同', () => {
    const plans = new PlanStore(db)
    plans.save(makeCard({ planId: 'pc-eth', symbol: 'ETH/USDT', windowEndsAt: NOON + 3_600_000 }), NOON)
    expect(metrics.compute({ day: DAY, symbols: ['ETH/USDT'], asOf: NOON }).coverage.ratio).toBe(1)
    // 一小时后卡过期 ⇒ 同一份数据覆盖率变 0（这就是"离开时刻谈覆盖率没有意义"）
    expect(metrics.compute({ day: DAY, symbols: ['ETH/USDT'], asOf: NOON + 7_200_000 }).coverage.ratio).toBe(0)
  })

  it('asOf 超出当天直接报错（防止把指标算成"跨天平均"）', () => {
    expect(() => metrics.compute({ day: DAY, symbols: [], asOf: NOON + 86_400_000 })).toThrow(/不在/)
  })

  it('标的池去重，空池覆盖率为 0 而不是 NaN', () => {
    const result = metrics.compute({ day: DAY, symbols: ['BTC/USDT', 'BTC/USDT'] })
    expect(result.coverage.symbols).toEqual(['BTC/USDT'])
    expect(metrics.compute({ day: DAY, symbols: [] }).coverage.ratio).toBe(0)
  })

  it('W2/W3 频次按 purpose 与 disposition 当日聚合，跨日的算到下一天', () => {
    const queue = new TriggerQueue(db)
    // purpose 词汇表是 invalidation|commitment|novelty|info；judgment 是 **disposition**
    // （承诺/失效命中经判断通道 ⇒ 去向 judgment）
    const enqueue = (
      dedupKey: string,
      purpose: 'novelty' | 'commitment' | 'info',
      disposition: 'novelty' | 'judgment' | 'info' | 'cooldown',
      at: number,
    ) =>
      queue.enqueue({
        triggerId: dedupKey,
        dedupKey,
        purpose,
        payload: {},
        disposition,
        state: 'done',
        createdAt: at,
      })
    enqueue('a', 'novelty', 'novelty', NOON)
    enqueue('b', 'novelty', 'cooldown', NOON)
    enqueue('c', 'commitment', 'judgment', NOON)
    enqueue('d', 'info', 'info', NOON)
    enqueue('e', 'novelty', 'novelty', NOON + 86_400_000)

    const result = metrics.compute({ day: DAY, symbols: SYMBOLS })
    expect(result.frequency.byPurpose).toEqual({ commitment: 1, info: 1, novelty: 2 })
    expect(result.frequency.byDisposition).toEqual({ cooldown: 1, info: 1, judgment: 1, novelty: 1 })
    // 只有 novelty/judgment 消耗唤醒预算
    expect(result.frequency.budgetConsuming).toEqual({ judgment: 1, novelty: 1 })
  })

  it('超过 W2/W3 日上限 ⇒ 告警（只读观测不抛错）', () => {
    const queue = new TriggerQueue(db)
    for (let index = 0; index < 9; index += 1) {
      queue.enqueue({
        triggerId: `j${index}`,
        dedupKey: `j${index}`,
        purpose: 'commitment',
        payload: {},
        disposition: 'judgment',
        state: 'done',
        createdAt: NOON,
      })
    }
    const result = metrics.compute({ day: DAY, symbols: SYMBOLS, caps: { judgmentPerDay: 8, noveltyPerDay: 6 } })
    expect(result.warnings.join('\n')).toContain('W2（judgment）9 超过日上限 8')
  })

  it('每窗口成本取当日 budget_ledger，缺价目时告警且 totalUsd 不作为可信数字', () => {
    const prices = new PriceTableStore(db)
    prices.seed(DEEPSEEK_PRICE_SEED)
    const ledger = new BudgetLedger(db)
    ledger.record(
      { at: NOON, scopes: ['global', symbolScope('BTC/USDT')], model: 'deepseek-flash', usage: { tokensIn: 1_000_000, tokensOut: 0, tokensCached: 0 } },
      prices.all(),
    )
    ledger.record(
      { at: NOON, scopes: ['global'], model: 'no-such-model', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0 } },
      prices.all(),
    )

    const result = metrics.compute({ day: DAY, symbols: SYMBOLS })
    expect(result.cost.costKnown).toBe(false)
    expect(result.cost.windows.map((window) => window.scope)).toEqual(['global', symbolScope('BTC/USDT')])
    expect(result.warnings.join('\n')).toContain('成本未知')
  })

  it('决策计数：当日产出 / 已执行 / 已结算', () => {
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'd1',
      symbol: 'BTC/USDT',
      decidedAt: NOON,
      contextHash: 'ctx',
      action: 'open',
      executed: true,
    })
    journal.recordDecision({
      decisionId: 'd2',
      symbol: 'BTC/USDT',
      decidedAt: NOON,
      contextHash: 'ctx2',
      action: 'no_trade',
      executed: false,
    })
    db.prepare('UPDATE decisions SET outcome_id = ? WHERE decision_id = ?').run('o1', 'd1')

    const result = metrics.compute({ day: DAY, symbols: SYMBOLS })
    expect(result.decisions).toEqual({ total: 2, executed: 1, settled: 1 })
  })

  it('dailyMetricsAt 用注入时间算日键，不读系统时钟', () => {
    const result = dailyMetricsAt(metrics, NOON, { symbols: SYMBOLS })
    expect(result.day).toBe(dayKey(NOON))
    expect(result.day).toBe(DAY)
  })

  it('空库也给出完整形状（首次运行不崩）', () => {
    const result = metrics.compute({ day: '2020-01-01', symbols: [] })
    expect(result).toMatchObject({
      day: '2020-01-01',
      coverage: { ratio: 0 },
      cost: { totalUsd: 0, costKnown: true, windows: [] },
      decisions: { total: 0, executed: 0, settled: 0 },
      warnings: [],
    })
  })
})

describe('MetricsStore 与触发器治理口径一致', () => {
  it('budgetConsuming 与 BUDGET_DISPOSITIONS 同口径（防止两处漂移）', async () => {
    const { BUDGET_DISPOSITIONS } = await import('../src/trigger/queue.js')
    const queue = new TriggerQueue(db)
    for (const disposition of BUDGET_DISPOSITIONS) {
      queue.enqueue({
        triggerId: `t-${disposition}`,
        dedupKey: `t-${disposition}`,
        purpose: disposition === 'novelty' ? 'novelty' : 'commitment',
        payload: {},
        disposition,
        state: 'done',
        createdAt: NOON,
      })
    }
    const result = metrics.compute({ day: DAY, symbols: [] })
    expect(Object.keys(result.frequency.budgetConsuming).sort()).toEqual([...BUDGET_DISPOSITIONS].sort())
  })
})
