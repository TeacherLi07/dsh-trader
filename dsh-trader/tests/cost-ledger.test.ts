import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { DecisionJournal } from '../src/exec/journal.js'
import {
  DEEPSEEK_PRICE_SEED,
  budgetAllows,
  estimateCost,
  priceTier,
  selectPrice,
  type ModelPrice,
} from '../src/cost.js'
import { BudgetLedger, PriceTableStore, dayKey, symbolScope } from '../src/cost-ledger.js'

const HOUR = 3_600_000
/** 2026-09-14 是周一。UTC 12:00 = 谷时；UTC 02:00 = 峰时。 */
const MON_OFFPEAK = Date.UTC(2026, 8, 14, 12)
const MON_PEAK = Date.UTC(2026, 8, 14, 2)
const SAT = Date.UTC(2026, 8, 19, 2)

let db: Database.Database
let prices: PriceTableStore
let ledger: BudgetLedger

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  prices = new PriceTableStore(db)
  ledger = new BudgetLedger(db)
  prices.seed(DEEPSEEK_PRICE_SEED)
})

afterEach(() => {
  db.close()
})

describe('priceTier（官方峰谷口径）', () => {
  it('UTC 周一至周五 01–04 与 06–10 为峰时，其余为谷时', () => {
    expect(priceTier(MON_PEAK)).toBe('peak')
    expect(priceTier(Date.UTC(2026, 8, 14, 3, 59))).toBe('peak')
    expect(priceTier(Date.UTC(2026, 8, 14, 4))).toBe('off_peak')
    expect(priceTier(Date.UTC(2026, 8, 14, 6))).toBe('peak')
    expect(priceTier(Date.UTC(2026, 8, 14, 9, 59))).toBe('peak')
    expect(priceTier(Date.UTC(2026, 8, 14, 10))).toBe('off_peak')
    expect(priceTier(MON_OFFPEAK)).toBe('off_peak')
  })

  it('整个周末都是谷时', () => {
    expect(priceTier(SAT)).toBe('off_peak')
    expect(priceTier(Date.UTC(2026, 8, 20, 2))).toBe('off_peak')
  })
})

describe('selectPrice', () => {
  it('同版本内按峰谷取行，价差 2×', () => {
    const peak = selectPrice(DEEPSEEK_PRICE_SEED, 'deepseek-flash', MON_PEAK)
    const off = selectPrice(DEEPSEEK_PRICE_SEED, 'deepseek-flash', MON_OFFPEAK)
    expect(peak?.inPerMtok).toBe(0.3)
    expect(off?.inPerMtok).toBe(0.15)
    expect(peak?.outPerMtok).toBe(2 * (off?.outPerMtok ?? 0))
    expect(peak?.cachedInPerMtok).toBe(0.006)
    expect(off?.cachedInPerMtok).toBe(0.003)
  })

  it('版本化：只认 effectiveFrom 已生效的版本；改价后取新版本', () => {
    const later = Date.UTC(2026, 9, 1)
    const newVersion: ModelPrice = {
      model: 'deepseek-flash',
      effectiveFrom: later,
      tier: 'any',
      inPerMtok: 9,
      outPerMtok: 9,
    }
    const withNew = [...DEEPSEEK_PRICE_SEED, newVersion]
    // 改价前：旧版本按峰谷
    expect(selectPrice(withNew, 'deepseek-flash', MON_PEAK)?.inPerMtok).toBe(0.3)
    // 改价后：新版本（any 兜底行）生效，且不再分峰谷
    expect(selectPrice(withNew, 'deepseek-flash', later + HOUR)?.inPerMtok).toBe(9)
    expect(priceTier(later + HOUR)).toBeDefined()
  })

  it('价目表里没有的模型返回 undefined，而不是拿别的模型顶上', () => {
    expect(selectPrice(DEEPSEEK_PRICE_SEED, 'gpt-unknown', MON_PEAK)).toBeUndefined()
  })

  it('种子落库幂等，且版本指纹随价目变化', () => {
    expect(prices.count()).toBe(DEEPSEEK_PRICE_SEED.length)
    expect(prices.seed(DEEPSEEK_PRICE_SEED)).toBe(0)
    const before = prices.version()
    prices.add({ model: 'x', effectiveFrom: 1, inPerMtok: 1, outPerMtok: 1 })
    expect(prices.version()).not.toBe(before)
  })
})

describe('estimateCost', () => {
  it('按峰谷单价算钱，缓存命中走缓存价', () => {
    const usage = { tokensIn: 1_000_000, tokensOut: 1_000_000, tokensCached: 1_000_000 }
    const peak = estimateCost(usage, DEEPSEEK_PRICE_SEED, 'deepseek-flash', MON_PEAK)
    const off = estimateCost(usage, DEEPSEEK_PRICE_SEED, 'deepseek-flash', MON_OFFPEAK)
    expect(peak).toEqual({ known: true, usd: 0.006 + 1.2, tier: 'peak' })
    expect(off).toEqual({ known: true, usd: 0.003 + 0.6, tier: 'off_peak' })
  })

  it('缓存 token 数被夹在输入 token 数之内（脏数据不会算出负数）', () => {
    const cost = estimateCost(
      { tokensIn: 10, tokensOut: 0, tokensCached: 999 },
      DEEPSEEK_PRICE_SEED,
      'deepseek-flash',
      MON_OFFPEAK,
    )
    expect(cost.known).toBe(true)
    if (cost.known) expect(cost.usd).toBeCloseTo((10 / 1_000_000) * 0.003, 12)
  })

  it('缺价目 ⇒ known:false 且带原因（绝不静默计 0）', () => {
    const cost = estimateCost({ tokensIn: 1, tokensOut: 1, tokensCached: 0 }, [], 'deepseek-flash', MON_PEAK)
    expect(cost).toEqual({ known: false, reason: expect.stringContaining('price_table') })
  })
})

describe('budgetAllows', () => {
  const state = {
    spentUsd: 5,
    estimatedUsd: 6,
    unknownCostCalls: 0,
    tokens: 100,
    tokenCap: null,
  }

  it('超预算停 W2/W3，但 W1 照常（否则已有仓位无人看管）', () => {
    expect(budgetAllows(state, 10, { wake: 'W1' })).toEqual({ allow: true })
    expect(budgetAllows(state, 10, { wake: 'W2' }).allow).toBe(false)
    expect(budgetAllows(state, 10, { wake: 'W3' }).allow).toBe(false)
  })

  it('预算内放行', () => {
    expect(budgetAllows({ ...state, spentUsd: 1, estimatedUsd: 1 }, 10, { wake: 'W2' }).allow).toBe(true)
  })

  it('成本未知时退化为 token 上限；连上限都没有就拒', () => {
    const unknown = { ...state, spentUsd: 0, estimatedUsd: 0, unknownCostCalls: 3 }
    const noCap = budgetAllows(unknown, 10, { wake: 'W2' })
    expect(noCap.allow).toBe(false)
    if (!noCap.allow) expect(noCap.reason).toContain('成本未知')
    const withCap = budgetAllows({ ...unknown, tokenCap: 50 }, 10, { wake: 'W2' })
    expect(withCap.allow).toBe(false)
    if (!withCap.allow) expect(withCap.reason).toContain('token 上限')
  })
})

describe('BudgetLedger', () => {
  const call = (at: number, tokensIn = 1_000_000) => ({
    at,
    scopes: ['global', symbolScope('BTC/USDT')],
    model: 'deepseek-flash',
    usage: { tokensIn, tokensOut: 0, tokensCached: 0 },
  })

  it('按 (day, scope) 累加，峰谷价各自入账', () => {
    ledger.record(call(MON_PEAK), prices.all())
    ledger.record(call(MON_OFFPEAK), prices.all())

    const rows = ledger.dashboard({ day: dayKey(MON_PEAK) })
    const global = rows.find((row) => row.scope === 'global')
    // 0.30（峰） + 0.15（谷）
    expect(global?.estUsd).toBeCloseTo(0.45, 12)
    expect(global?.tokensIn).toBe(2_000_000)
    expect(global?.costKnown).toBe(true)
    // 按标的也有一行
    expect(rows.find((row) => row.scope === symbolScope('BTC/USDT'))?.estUsd).toBeCloseTo(0.45, 12)
  })

  it('跨日记到不同的日键', () => {
    ledger.record(call(MON_PEAK), prices.all())
    ledger.record(call(MON_PEAK + 24 * HOUR), prices.all())
    const days = [...new Set(ledger.dashboard().map((row) => row.day))].sort()
    expect(days).toEqual([dayKey(MON_PEAK), dayKey(MON_PEAK + 24 * HOUR)].sort())
    // 每个日键下两个 scope 各一行
    expect(ledger.dashboard({ day: dayKey(MON_PEAK) })).toHaveLength(2)
  })

  it('缺价目 ⇒ cost_known=0 并给出告警，且该格一旦不可信就保持不可信', () => {
    const result = ledger.record(
      { ...call(MON_PEAK), model: 'no-such-model' },
      prices.all(),
    )
    expect(result.costKnown).toBe(false)
    expect(result.warnings.join('\n')).toContain('成本未知')

    const state = ledger.state(dayKey(MON_PEAK), 'global', null)
    expect(state.unknownCostCalls).toBe(1)
    expect(ledger.dashboard({ day: dayKey(MON_PEAK) })[0]?.costKnown).toBe(false)

    // 之后有价目的调用也**不能**把这一格洗白
    ledger.record(call(MON_PEAK), prices.all())
    expect(ledger.dashboard({ day: dayKey(MON_PEAK) })[0]?.costKnown).toBe(false)
  })

  it('gate：超预算停 W2/W3，W1 放行；且用注入时间判日键', () => {
    ledger.record(call(MON_PEAK, 4_000_000), prices.all())
    const at = MON_PEAK
    const gate = (wake: 'W1' | 'W2' | 'W3') =>
      ledger.gate({ at, wake, dailyBudgetUsd: 1, scope: 'global' })
    expect(gate('W1').allow).toBe(true)
    // 4M tokens × $0.30/M = $1.20 > $1
    expect(gate('W2').allow).toBe(false)
    expect(gate('W3').allow).toBe(false)
    // 换一天（谷时）就又有预算
    expect(ledger.gate({ at: MON_PEAK + 24 * HOUR, wake: 'W2', dailyBudgetUsd: 1 }).allow).toBe(true)
  })

  it('token 上限兜底可见', () => {
    ledger.record(call(MON_OFFPEAK, 100), prices.all())
    const state = ledger.state(dayKey(MON_OFFPEAK), 'global', 50)
    expect(state.tokens).toBe(100)
    expect(state.tokenCap).toBe(50)
    expect(budgetAllows(state, 100, { wake: 'W3' }).allow).toBe(false)
  })

  it('未知 scope 返回零值状态而不是抛错（首次调用前不崩）', () => {
    const state = ledger.state('2020-01-01', 'global', 10)
    expect(state).toEqual({
      spentUsd: 0,
      estimatedUsd: 0,
      unknownCostCalls: 0,
      tokens: 0,
      tokenCap: 10,
    })
  })

  it('决策上回填 token/耗时/触发来源，缺价目时 cost_known=false（plan §8）', () => {
    const journal = new DecisionJournal(db)
    journal.recordDecision({
      decisionId: 'd1',
      symbol: 'BTC/USDT',
      decidedAt: MON_PEAK,
      contextHash: 'sha256:ctx',
      action: 'open',
      executed: true,
    })
    // 先记账，再回填 —— 两条路径都走一遍
    const recorded = ledger.record(call(MON_PEAK), prices.all())
    expect(recorded.costKnown).toBe(true)
    expect(
      journal.markDecisionCost('d1', {
        tokensIn: 1_000_000,
        tokensOut: 0,
        tokensCached: 0,
        costUsd: recorded.estUsd,
        costKnown: recorded.costKnown,
        durationMs: 4_200,
        triggerSource: 'W2:rule-abc',
      }),
    ).toBe(true)

    const summary = journal.recentDecisions()[0]
    expect(summary?.costUsd).toBeCloseTo(0.3, 12)
    expect(summary?.costKnown).toBe(true)
    expect(summary?.durationMs).toBe(4_200)
    expect(summary?.triggerSource).toBe('W2:rule-abc')
    expect(summary?.tokensIn).toBe(1_000_000)

    // 缺价目的调用：记 0 但 cost_known=false，审计上不能被当成零成本
    journal.markDecisionCost('d1', {
      tokensIn: 1_000_000,
      tokensOut: 0,
      tokensCached: 0,
      costUsd: 0,
      costKnown: false,
      durationMs: 4_200,
      triggerSource: 'W2:rule-abc',
    })
    expect(journal.recentDecisions()[0]?.costKnown).toBe(false)
  })

  it('回填不存在的决策返回 false，不静默成功', () => {
    const journal = new DecisionJournal(db)
    expect(
      journal.markDecisionCost('nope', {
        tokensIn: 1,
        tokensOut: 1,
        tokensCached: 0,
        costUsd: 0,
        costKnown: true,
        durationMs: 1,
        triggerSource: 'W1',
      }),
    ).toBe(false)
  })
})

describe('selectPrice：缺档位必须当作缺行（审计修复）', () => {
  it('★ 只有 peak 行时，谷时取价必须未知，绝不拿 peak 价顶上', () => {
    const peakOnly: ModelPrice[] = [
      { model: 'm', effectiveFrom: 0, tier: 'peak', inPerMtok: 0.3, outPerMtok: 1.2 },
    ]
    const offPeak = Date.UTC(2026, 8, 12, 12, 0, 0) // 周六 ⇒ 谷时
    expect(priceTier(offPeak)).toBe('off_peak')
    expect(selectPrice(peakOnly, 'm', offPeak)).toBeUndefined()
    const estimate = estimateCost(
      { tokensIn: 1_000_000, tokensOut: 0, tokensCached: 0 },
      peakOnly,
      'm',
      offPeak,
    )
    expect(estimate.known).toBe(false)

    // `any` 兜底行仍然可用（那是显式声明的不分峰谷价）
    const anyRow: ModelPrice[] = [{ model: 'm', effectiveFrom: 0, tier: 'any', inPerMtok: 0.3, outPerMtok: 1.2 }]
    expect(selectPrice(anyRow, 'm', offPeak)?.tier).toBe('any')
  })
})
