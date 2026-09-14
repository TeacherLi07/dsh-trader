import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { DecisionJournal, type DecisionRecord } from '../src/exec/journal.js'
import {
  DEFAULT_REFLECTION_GATES,
  SettlementScheduler,
  acceptReflection,
  computeSettlement,
  type ReflectionInput,
} from '../src/memory/settle.js'
import { raw } from './helpers/market.js'

const TF = '1h'
const HOUR = 3_600_000
/** 对齐到整点 —— 结算窗口按 bar 的 open_time 对齐。 */
const T0 = 472_222 * HOUR
const HORIZON = 4 * HOUR
const BENCH = 'BTC-INDEX'
const NOW = T0 + HORIZON

let db: Database.Database
let journal: DecisionJournal
let archive: BarArchive

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  journal = new DecisionJournal(db)
  archive = new BarArchive(db)
})

afterEach(() => {
  db.close()
})

/** 写一批已收盘 bar；`now` 远大于 closeTime 以免被判为未收盘。 */
function seedBars(
  symbol: string,
  bars: readonly { readonly openTime: number; readonly close: number; readonly high?: number; readonly low?: number }[],
): void {
  const raws = bars.map((bar) =>
    raw(bar.openTime, bar.close, {
      ...(bar.high === undefined ? {} : { high: bar.high }),
      ...(bar.low === undefined ? {} : { low: bar.low }),
    }),
  )
  const normalized = normalizeCandles(raws, symbol, TF, T0 + 30 * 24 * HOUR)
  const written = archive.upsertClosed(normalized.candles, { source: 'fake', fetchedAt: T0 })
  expect(written.written).toBe(bars.length)
}

/** 一根固定收益、振幅已知的 bar 序列。 */
function flatBars(symbol: string, closes: readonly number[], range = 1): void {
  seedBars(
    symbol,
    closes.map((close, index) => ({
      openTime: T0 + index * HOUR,
      close,
      high: close + range,
      low: close - range,
    })),
  )
}

/** 一条"已成交"的决策：decisions → order_intents → orders → fills 全链打通。 */
function executedDecision(
  over: Partial<DecisionRecord> & { readonly decisionId: string },
  fill: { readonly side: 'buy' | 'sell'; readonly price: number; readonly qty: number; readonly fee: number },
): void {
  const decision: DecisionRecord = {
    symbol: 'BTC/USDT',
    decidedAt: T0,
    contextHash: `ctx:${over.decisionId}`,
    action: 'open',
    executed: false,
    ...over,
  }
  expect(journal.recordDecision(decision)).toBe(true)
  const coid = `co-${over.decisionId}`
  journal.recordIntent({
    intentId: `intent-${over.decisionId}`,
    clientOrderId: coid,
    decisionId: over.decisionId,
    venue: 'paper',
    symbol: decision.symbol,
    state: 'filled',
    type: 'market',
    side: fill.side,
    qty: fill.qty,
    reduceOnly: false,
    createdAt: T0,
  })
  const exchangeOrderId = `ex-${over.decisionId}`
  journal.recordOrder({
    orderId: exchangeOrderId,
    venue: 'paper',
    exchangeOrderId,
    clientOrderId: coid,
    symbol: decision.symbol,
    status: 'filled',
    qty: fill.qty,
    filledQty: fill.qty,
    updatedAt: T0,
  })
  journal.recordFill({
    fillId: `fill-${over.decisionId}`,
    orderId: exchangeOrderId,
    qty: fill.qty,
    price: fill.price,
    fee: fill.fee,
    feeCurrency: 'USDT',
    ts: T0,
  })
  journal.markDecisionExecuted(over.decisionId)
  journal.markDecisionReflectionDue(over.decisionId, over.reflectionDueAt ?? T0 + HORIZON)
}

function scheduler(reflector?: (input: ReflectionInput) => Promise<{ text: string; evidenceRefs: readonly string[] }>) {
  return new SettlementScheduler({
    journal,
    bars: archive,
    clock: { now: () => NOW, setInterval: () => () => {} },
    timeframe: TF,
    horizonMs: HORIZON,
    benchmarkSymbol: BENCH,
    slippageBps: 10,
    ...(reflector === undefined ? {} : { reflector }),
  })
}

describe('computeSettlement', () => {
  const decision = {
    decisionId: 'd1',
    symbol: 'BTC/USDT',
    action: 'open',
    decidedAt: T0,
    sizeQty: 1,
    stopPrice: 90,
    takeProfit: null,
    confidence: 0.6,
    rationale: 'trend',
  }

  it('结算用实际成交价，扣手续费与双边滑点，alpha 相对基准', () => {
    const result = computeSettlement(
      {
        decision,
        fills: [{ fillId: 'f1', qty: 1, price: 100, fee: 0.5, side: 'buy', ts: T0 }],
        entryPrice: 100,
        direction: 1,
        bars: [
          { openTime: T0, high: 102, low: 99, close: 100 },
          { openTime: T0 + HOUR, high: 105, low: 96, close: 104 },
        ],
        benchmarkBars: [
          { openTime: T0, close: 100 },
          { openTime: T0 + HOUR, close: 101 },
        ],
      },
      { slippageBps: 10 },
    )
    expect(result.exitPrice).toBe(104)
    expect(result.realizedGrossPct).toBeCloseTo(4, 10)
    // 0.5 手续费 / 100 名义 = 0.5%，双边滑点 2 × 10bp = 0.2%
    expect(result.realizedNetPct).toBeCloseTo(3.3, 10)
    expect(result.benchmarkPct).toBeCloseTo(1, 10)
    expect(result.alphaPct).toBeCloseTo(2.3, 10)
    expect(result.mfePct).toBeCloseTo(5, 10)
    expect(result.maePct).toBeCloseTo(-4, 10)
    expect(result.stopHit).toBe(false)
    expect(result.feesQuote).toBe(0.5)
    expect(result.evidenceRefs).toContain('fill:f1')
  })

  it('做空方向反转收益，并识别止损', () => {
    const result = computeSettlement(
      {
        decision: { ...decision, action: 'open', stopPrice: 110 },
        fills: [{ fillId: 'f1', qty: 1, price: 100, fee: 0, side: 'sell', ts: T0 }],
        entryPrice: 100,
        direction: -1,
        bars: [{ openTime: T0, high: 112, low: 95, close: 96 }],
        benchmarkBars: [{ openTime: T0, close: 100 }, { openTime: T0 + HOUR, close: 100 }],
      },
      { slippageBps: 0 },
    )
    expect(result.realizedGrossPct).toBeCloseTo(4, 10)
    expect(result.stopHit).toBe(true)
    expect(result.mfePct).toBeCloseTo(5, 10)
    expect(result.maePct).toBeCloseTo(-12, 10)
  })
})

describe('acceptReflection', () => {
  const outcome = {
    outcomeId: 'o1',
    decisionId: 'd1',
    symbol: 'BTC/USDT',
    settledAt: NOW,
    horizonMs: HORIZON,
    entryPrice: 100,
    exitPrice: 104,
    realizedGrossPct: 4,
    realizedNetPct: 3.3,
    benchmarkPct: 1,
    alphaPct: 2.3,
    mfePct: 5,
    maePct: -4,
    stopHit: false,
    feesQuote: 0.5,
    evidenceRefs: ['decision:d1', 'fill:f1'],
  }

  it('接受带真实证据指针的短反思', () => {
    const verdict = acceptReflection(
      { text: '趋势跟随有效，但入场晚了半根 bar。', evidenceRefs: ['fill:f1'] },
      outcome,
      DEFAULT_REFLECTION_GATES,
    )
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.expiresAt).toBe(NOW + DEFAULT_REFLECTION_GATES.ttlMs)
  })

  it('拒绝无证据、伪证据、超长、空文本', () => {
    const gate = DEFAULT_REFLECTION_GATES
    expect(acceptReflection({ text: '事后感觉不错', evidenceRefs: [] }, outcome, gate)).toEqual({
      ok: false,
      reason: '反思没有携带证据指针（不可证伪）',
    })
    const fake = acceptReflection({ text: '编一个', evidenceRefs: ['fill:不存在'] }, outcome, gate)
    expect(fake.ok).toBe(false)
    if (!fake.ok) expect(fake.reason).toContain('fill:不存在')
    const long = acceptReflection(
      { text: 'x'.repeat(gate.maxCharsPerLesson + 1), evidenceRefs: ['fill:f1'] },
      outcome,
      gate,
    )
    expect(long.ok).toBe(false)
    expect(acceptReflection({ text: '   ', evidenceRefs: ['fill:f1'] }, outcome, gate).ok).toBe(false)
  })
})

describe('SettlementScheduler', () => {
  it('从实际成交结算：净额、基准、alpha、MFE/MAE、止损', async () => {
    flatBars('BTC/USDT', [100, 101, 104, 105, 105])
    flatBars(BENCH, [100, 100, 101, 101, 101])
    executedDecision({ decisionId: 'd1', stopPrice: 90 }, { side: 'buy', price: 100, qty: 1, fee: 0.5 })

    const result = await scheduler().runOnce(NOW)
    expect(result).toMatchObject({ scanned: 1, settled: 1, skipped: 0, errors: [] })

    const outcome = journal.outcomeFor('d1')
    expect(outcome).toBeDefined()
    expect(outcome?.entryPrice).toBe(100)
    expect(outcome?.exitPrice).toBe(105)
    expect(outcome?.realizedNetPct).toBeCloseTo(4.3, 10)
    expect(outcome?.benchmarkPct).toBeCloseTo(1, 10)
    expect(outcome?.alphaPct).toBeCloseTo(3.3, 10)
    expect(outcome?.stopHit).toBe(false)
    expect(outcome?.evidenceRefs.some((ref) => ref.startsWith('fill:'))).toBe(true)
    expect(journal.pendingSettlements(NOW)).toHaveLength(0)
  })

  it('重复结算幂等：第二次只跳过，不追加第二条 outcome', async () => {
    flatBars('BTC/USDT', [100, 100, 100, 100, 100])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision({ decisionId: 'd1' }, { side: 'buy', price: 100, qty: 1, fee: 0 })

    const first = await scheduler().runOnce(NOW)
    expect(first.settled).toBe(1)
    // 人为把 outcome 关联抹掉、到期时间保留 —— 模拟"崩溃后重跑同一窗口"
    db.prepare('UPDATE decisions SET outcome_id = NULL, reflection_due_at = ? WHERE decision_id = ?').run(
      T0 + HORIZON,
      'd1',
    )
    const second = await scheduler().runOnce(NOW)
    expect(second).toMatchObject({ scanned: 1, settled: 0, skipped: 1 })
    expect((db.prepare('SELECT COUNT(*) AS n FROM outcomes').get() as { n: number }).n).toBe(1)
  })

  it('一次扫描结算全部标的，而不是只结算"当前正在分析的那个"', async () => {
    flatBars('BTC/USDT', [100, 100, 101, 101, 101])
    flatBars('ETH/USDT', [50, 51, 52, 53, 54])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision({ decisionId: 'd1', symbol: 'BTC/USDT' }, { side: 'buy', price: 100, qty: 1, fee: 0 })
    executedDecision({ decisionId: 'd2', symbol: 'ETH/USDT' }, { side: 'buy', price: 50, qty: 2, fee: 0 })

    const result = await scheduler().runOnce(NOW)
    expect(result.scanned).toBe(2)
    expect(result.settled).toBe(2)
    expect(journal.outcomeFor('d1')).toBeDefined()
    expect(journal.outcomeFor('d2')).toBeDefined()
  })

  it('止损：做空时 bar 高点越过止损价即标记 stop_hit', async () => {
    seedBars('BTC/USDT', [
      { openTime: T0, close: 100, high: 101, low: 99 },
      { openTime: T0 + HOUR, close: 108, high: 112, low: 100 },
    ])
    flatBars(BENCH, [100, 100, 100])
    executedDecision(
      { decisionId: 'd1', stopPrice: 110 },
      { side: 'sell', price: 100, qty: 1, fee: 0 },
    )

    await scheduler().runOnce(NOW)
    expect(journal.outcomeFor('d1')?.stopHit).toBe(true)
  })

  it('未到期的决策不结算', async () => {
    flatBars('BTC/USDT', [100, 100, 100, 100, 100])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision({ decisionId: 'd1' }, { side: 'buy', price: 100, qty: 1, fee: 0 })
    const early = await scheduler().runOnce(T0 + HOUR)
    expect(early.scanned).toBe(0)
    expect(journal.outcomeFor('d1')).toBeUndefined()
  })

  it('只有成交的决策进入结算队列（被拒决策没有仓位）', () => {
    expect(
      journal.recordDecision({
        decisionId: 'd-refused',
        symbol: 'BTC/USDT',
        decidedAt: T0,
        contextHash: 'ctx:refused',
        action: 'open',
        executed: false,
      }),
    ).toBe(true)
    expect(journal.pendingSettlements(NOW)).toHaveLength(0)
  })

  it('反思器入参只有 decision 与 outcome —— 结构上看不到历史反思', async () => {
    flatBars('BTC/USDT', [100, 100, 101, 101, 101])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision({ decisionId: 'd1' }, { side: 'buy', price: 100, qty: 1, fee: 0 })

    const seen: ReflectionInput[] = []
    const run = scheduler(async (input) => {
      seen.push(input)
      return { text: '趋势跟随有效。', evidenceRefs: ['fill:fill-d1'] }
    })
    const result = await run.runOnce(NOW)
    expect(result.reflectionsWritten).toBe(1)
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0] as object).sort()).toEqual(['decision', 'outcome'])
    expect(Object.keys((seen[0] as ReflectionInput).decision).sort()).toEqual([
      'action',
      'confidence',
      'decisionId',
      'rationale',
      'sizeQty',
      'stopPrice',
      'symbol',
      'takeProfit',
    ])
    expect(JSON.stringify(seen[0])).not.toContain('lesson')
    expect(journal.recentLessons()).toHaveLength(1)
    expect(journal.recentLessons()[0]?.text).toBe('趋势跟随有效。')

    // 再跑一次：outcome 已存在 ⇒ 不会写第二条反思
    db.prepare('UPDATE decisions SET outcome_id = NULL, reflection_due_at = ? WHERE decision_id = ?').run(
      T0 + HORIZON,
      'd1',
    )
    await run.runOnce(NOW)
    expect(journal.recentLessons()).toHaveLength(1)
  })

  it('非法反思被拒时不写入 lessons，并给出可读原因', async () => {
    flatBars('BTC/USDT', [100, 100, 101, 101, 101])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision({ decisionId: 'd1' }, { side: 'buy', price: 100, qty: 1, fee: 0 })

    const result = await scheduler(async () => ({ text: '我觉得挺好', evidenceRefs: [] })).runOnce(NOW)
    expect(result.settled).toBe(1)
    expect(result.reflectionsWritten).toBe(0)
    expect(result.reflectionsRejected).toEqual([
      { decisionId: 'd1', reason: '反思没有携带证据指针（不可证伪）' },
    ])
    expect(journal.recentLessons()).toHaveLength(0)
  })

  it('没有成交的决策用窗口内第一根 bar 收盘价作为参考入场价', async () => {
    flatBars('BTC/USDT', [102, 103, 104, 105, 106])
    flatBars(BENCH, [100, 100, 101, 101, 101])
    journal.recordDecision({
      decisionId: 'd-hold',
      symbol: 'BTC/USDT',
      decidedAt: T0,
      contextHash: 'ctx:hold',
      action: 'open',
      executed: false,
    })
    journal.markDecisionReflectionDue('d-hold', T0 + HORIZON)

    await scheduler().runOnce(NOW)
    expect(journal.outcomeFor('d-hold')?.entryPrice).toBe(102)
  })
})
