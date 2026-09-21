import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { BarArchive } from '../src/market/archive.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { DecisionJournal, type DecisionRecord } from '../src/exec/journal.js'
import {
  DEFAULT_REFLECTION_GATES,
  REFLECTOR_TIER,
  SettlementScheduler,
  acceptReflection,
  computeSettlement,
  horizonMsForTimeframe,
  reflectorRoute,
  type ReflectionInput,
  type FundingCostResolver,
} from '../src/memory/settle.js'
import { TIMEFRAMES } from '../src/plan/schema.js'
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
  const written = archive.upsertClosed(normalized.candles, { source: 'fake', fetchedAt: T0 + 30 * 24 * HOUR })
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
  fill: {
    readonly side: 'buy' | 'sell'
    readonly price: number
    readonly qty: number
    readonly fee: number | null
    readonly ts?: number
    readonly reduceOnly?: boolean
  },
  venue = 'paper',
): void {
  executedDecisionWithFills(over, [fill], venue)
}

function executedDecisionWithFills(
  over: Partial<DecisionRecord> & { readonly decisionId: string },
  fills: readonly {
    readonly side: 'buy' | 'sell'
    readonly price: number
    readonly qty: number
    readonly fee: number | null
    readonly ts?: number
    readonly reduceOnly?: boolean
  }[],
  venue = 'paper',
): void {
  const decision: DecisionRecord = {
    symbol: 'BTC/USDT',
    // 结算按 tf 过滤：fixture 必须给出与 scheduler 一致的 tf，否则会被跳过（这本身就是新语义）。
    timeframe: TF,
    decidedAt: T0,
    contextHash: `ctx:${over.decisionId}`,
    action: 'open',
    executed: false,
    ...over,
  }
  expect(journal.recordDecision(decision)).toBe(true)
  fills.forEach((fill, index) => {
    const ts = fill.ts ?? decision.decidedAt
    const coid = `co-${over.decisionId}-${index}`
    journal.recordIntent({
      intentId: `intent-${over.decisionId}-${index}`,
      clientOrderId: coid,
      decisionId: over.decisionId,
      venue,
      symbol: decision.symbol,
      state: 'filled',
      type: 'market',
      side: fill.side,
      qty: fill.qty,
      reduceOnly: fill.reduceOnly ?? decision.action !== 'open',
      createdAt: ts,
    })
    const exchangeOrderId = `ex-${over.decisionId}-${index}`
    journal.recordOrder({
      orderId: exchangeOrderId,
      venue,
      exchangeOrderId,
      clientOrderId: coid,
      symbol: decision.symbol,
      status: 'filled',
      qty: fill.qty,
      filledQty: fill.qty,
      updatedAt: ts,
    })
    journal.recordFill({
      fillId: `fill-${over.decisionId}-${index}`,
      orderId: exchangeOrderId,
      qty: fill.qty,
      price: fill.price,
      fee: fill.fee,
      feeCurrency: 'USDT',
      ts,
    })
  })
  journal.markDecisionExecuted(over.decisionId)
  journal.markDecisionReflectionDue(over.decisionId, over.reflectionDueAt ?? T0 + HORIZON)
}

function scheduler(
  reflector?: (input: ReflectionInput) => Promise<{ text: string; evidenceRefs: readonly string[] }>,
  horizonMs: number | undefined = HORIZON,
  resolveFundingCost: FundingCostResolver | null = () => ({ amountQuote: 0, source: 'fixture:known-zero' }),
) {
  return new SettlementScheduler({
    journal,
    bars: archive,
    clock: { now: () => NOW, setInterval: () => () => {} },
    timeframe: TF,
    ...(horizonMs === undefined ? {} : { horizonMs }),
    benchmarkSymbol: BENCH,
    slippageBps: 10,
    ...(resolveFundingCost === null ? {} : { resolveFundingCost }),
    ...(reflector === undefined ? {} : { reflector }),
  })
}

describe('结算视界与 Reflector 路由（plan §12 #18）', () => {
  it('按全部 TIMEFRAMES 推导四根 bar 并夹在 4h–24h', () => {
    const expected: Record<string, number> = {
      '1m': 4 * HOUR,
      '15m': 4 * HOUR,
      '1h': 4 * HOUR,
      '4h': 16 * HOUR,
      '1d': 24 * HOUR,
    }
    expect(TIMEFRAMES.length).toBeGreaterThan(0)
    for (const timeframe of TIMEFRAMES) {
      expect(horizonMsForTimeframe(timeframe)).toBe(expected[timeframe])
    }
  })

  it('未知 tf fail-loud，避免静默使用错误视界', () => {
    expect(() => horizonMsForTimeframe('2h')).toThrow(/未知结算时间框架/)
  })

  it('Reflector 固定走 quick tier', () => {
    expect(REFLECTOR_TIER).toBe('quick')
    expect(reflectorRoute({ deep: 'deep-route', quick: 'quick-route' })).toBe('quick-route')
  })
})

describe('computeSettlement', () => {
  const decision = {
    decisionId: 'd1',
    symbol: 'BTC/USDT',
    timeframe: TF,
    action: 'open',
    decidedAt: T0,
    sizeQty: 1,
    stopPrice: 90,
    takeProfit: null,
    confidence: 0.6,
    rationale: 'trend',
  }

  it('结算按已含滑点的成交价计收益，只扣已核验手续费/资金费', () => {
    const result = computeSettlement(
      {
        decision,
        fills: [{ fillId: 'f1', qty: 1, price: 100, fee: 0.5, side: 'buy', ts: T0, venue: 'paper' }],
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
        fundingCost: { amountQuote: 0, source: 'fixture:known-zero' },
      },
      { slippageBps: 500 },
    )
    expect(result.exitPrice).toBe(104)
    expect(result.realizedGrossPct).toBeCloseTo(4, 10)
    // 0.5 手续费 / 100 名义 = 0.5%；传入的滑点估算不能覆盖撮合成交价。
    expect(result.realizedNetPct).toBeCloseTo(3.5, 10)
    expect(result.benchmarkPct).toBeCloseTo(1, 10)
    expect(result.alphaPct).toBeCloseTo(2.5, 10)
    expect(result.mfePct).toBeCloseTo(5, 10)
    expect(result.maePct).toBeCloseTo(-4, 10)
    expect(result.stopHit).toBe(false)
    expect(result.feesQuote).toBe(0.5)
    expect(result.fundingFeeQuote).toBe(0)
    expect(result.settlementKind).toBe('paper_simulation')
    expect(result.valuationBasis).toBe('horizon_mark')
    expect(result.evidenceRefs).toContain('fill:f1')
  })

  it('paper entry/exit fill 已各含 10bp 撮合滑点时，实际成交收益不再扣配置滑点', () => {
    const result = computeSettlement(
      {
        decision,
        fills: [
          { fillId: 'paper-entry', qty: 1, price: 100.1, fee: 0, side: 'buy', ts: T0, venue: 'paper' },
          { fillId: 'paper-exit', qty: 1, price: 101.899, fee: 0, side: 'sell', ts: T0 + HOUR, venue: 'paper' },
        ],
        entryPrice: 100.1,
        direction: 1,
        exitPrice: 101.899,
        bars: [
          { openTime: T0, high: 101, low: 99, close: 100 },
          { openTime: T0 + HOUR, high: 102, low: 100, close: 101 },
        ],
        benchmarkBars: [
          { openTime: T0, close: 100 },
          { openTime: T0 + HOUR, close: 100 },
        ],
        fundingCost: { amountQuote: 0, source: 'fixture:known-zero' },
      },
      { slippageBps: 10 },
    )
    const fillToFillPct = ((101.899 - 100.1) / 100.1) * 100
    expect(result.realizedGrossPct).toBeCloseTo(fillToFillPct, 10)
    expect(result.realizedNetPct).toBeCloseTo(fillToFillPct, 10)
    expect(result.settlementKind).toBe('paper_simulation')
    expect(result.valuationBasis).toBe('actual_exit_fills')
  })

  it('benchmark 缺失或只有一个观测点时保留 unknown，不把零收益写成基准/alpha', () => {
    const base = {
      decision,
      fills: [{ fillId: 'f-known', qty: 1, price: 100, fee: 0, side: 'buy', ts: T0 }],
      entryPrice: 100,
      direction: 1 as const,
      bars: [
        { openTime: T0, high: 102, low: 99, close: 101 },
        { openTime: T0 + HOUR, high: 103, low: 100, close: 101 },
      ],
      fundingCost: { amountQuote: 0, source: 'fixture:known-zero' },
    }
    const missing = computeSettlement({ ...base, benchmarkBars: [] }, { slippageBps: 10 })
    const onePoint = computeSettlement(
      { ...base, benchmarkBars: [{ openTime: T0, close: 100 }] },
      { slippageBps: 10 },
    )
    const partialWindow = computeSettlement(
      {
        ...base,
        benchmarkBars: [
          { openTime: T0 + HOUR, close: 100 },
          { openTime: T0 + 2 * HOUR, close: 101 },
        ],
      },
      { slippageBps: 10 },
    )

    expect(missing.realizedNetPct).toBeCloseTo(1, 10)
    expect(missing.benchmarkPct).toBeNull()
    expect(missing.alphaPct).toBeNull()
    expect(onePoint.benchmarkPct).toBeNull()
    expect(onePoint.alphaPct).toBeNull()
    expect(partialWindow.benchmarkPct).toBeNull()
    expect(partialWindow.alphaPct).toBeNull()
    expect(missing.evidenceRefs).toContain('benchmark:unavailable')
  })

  it('缺少资金费来源时净收益 unknown，而不是把资金费当成零', () => {
    const result = computeSettlement(
      {
        decision,
        fills: [{ fillId: 'f-funding', qty: 1, price: 100, fee: 0, side: 'buy', ts: T0 }],
        entryPrice: 100,
        direction: 1,
        bars: [{ openTime: T0, high: 102, low: 99, close: 101 }],
        benchmarkBars: [{ openTime: T0, close: 100 }, { openTime: T0 + HOUR, close: 100 }],
      },
      { slippageBps: 0 },
    )
    expect(result.realizedGrossPct).toBeCloseTo(1, 10)
    expect(result.realizedNetPct).toBeNull()
    expect(result.fundingFeeQuote).toBeNull()
    expect(result.fundingSource).toBeNull()
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
  it('真实成交手续费未知时保持 pending，不把未知成本按 0 结算', async () => {
    flatBars('BTC/USDT', [100, 101, 102, 103, 104])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision({ decisionId: 'fee-unknown' }, { side: 'buy', price: 100, qty: 1, fee: null })

    const result = await scheduler().runOnce(NOW)
    expect(result.scanned).toBeGreaterThan(0)
    expect(result.deferred).toBe(1)
    expect(result.deferredIds).toContain('fee-unknown')
    expect(journal.outcomeFor('fee-unknown')).toBeUndefined()
    expect(journal.pendingSettlements(NOW)).toHaveLength(1)
  })

  it('未显式传 horizonMs 时按计划卡 tf 推导并写入 outcome', async () => {
    flatBars('BTC/USDT', [100, 101, 102, 103, 104])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision({ decisionId: 'd-derived-horizon' }, { side: 'buy', price: 100, qty: 1, fee: 0 })

    const result = await scheduler(undefined, undefined).runOnce(NOW)
    expect(result.settled).toBe(1)
    expect(journal.outcomeFor('d-derived-horizon')?.horizonMs).toBe(horizonMsForTimeframe(TF))
  })

  it('从成交与显式成本结算：净额、基准、alpha、MFE/MAE、止损', async () => {
    flatBars('BTC/USDT', [100, 101, 104, 105, 105])
    flatBars(BENCH, [100, 100, 101, 101, 101])
    executedDecision({ decisionId: 'd1', stopPrice: 90 }, { side: 'buy', price: 100, qty: 1, fee: 0.5 })

    const result = await scheduler().runOnce(NOW)
    expect(result).toMatchObject({ scanned: 1, settled: 1, skipped: 0, errors: [] })

    const outcome = journal.outcomeFor('d1')
    expect(outcome).toBeDefined()
    expect(outcome?.entryPrice).toBe(100)
    expect(outcome?.exitPrice).toBe(105)
    expect(outcome?.realizedNetPct).toBeCloseTo(4.5, 10)
    expect(outcome?.benchmarkPct).toBeCloseTo(1, 10)
    expect(outcome?.alphaPct).toBeCloseTo(3.5, 10)
    expect(outcome?.fundingFeeQuote).toBe(0)
    expect(outcome?.stopHit).toBe(false)
    expect(outcome?.evidenceRefs.some((ref) => ref.startsWith('fill:'))).toBe(true)
    expect(journal.pendingSettlements(NOW)).toHaveLength(0)
  })

  it('多笔 entry/partial exit 按方向与实际数量加权，并按退出量分摊入场费', async () => {
    flatBars('BTC/USDT', [100, 105, 110, 115, 120, 120])
    flatBars(BENCH, [100, 100, 100, 100, 100, 100])
    executedDecisionWithFills(
      { decisionId: 'multi-entry', reflectionDueAt: T0 + 100 * HOUR },
      [
        { side: 'buy', price: 100, qty: 0.4, fee: 0.04, ts: T0 },
        { side: 'buy', price: 110, qty: 0.6, fee: 0.06, ts: T0 + HOUR / 2 },
      ],
      'paper',
    )
    executedDecisionWithFills(
      { decisionId: 'multi-exit', action: 'close', decidedAt: T0 + 2 * HOUR, reflectionDueAt: T0 + HORIZON },
      [
        { side: 'sell', price: 120, qty: 0.25, fee: 0.025, ts: T0 + 2 * HOUR },
        { side: 'sell', price: 124, qty: 0.25, fee: 0.025, ts: T0 + 2 * HOUR + 1 },
      ],
      'paper',
    )

    let fundingRequest: Parameters<NonNullable<FundingCostResolver>>[0] | undefined
    const result = await scheduler(undefined, HORIZON, (request) => {
      fundingRequest = request
      return { amountQuote: 0.05, source: 'fixture:funding-ledger' }
    }).runOnce(T0 + 10 * HOUR)

    expect(result.scanned).toBe(1)
    expect(result.settled).toBe(1)
    const outcome = journal.outcomeFor('multi-exit')
    expect(outcome).toMatchObject({
      entryPrice: 106,
      exitPrice: 122,
      attributedQty: 0.5,
      feesQuote: 0.1, // 当前出场费 0.05 + 50% 的历史入场费 0.05
      fundingFeeQuote: 0.05,
      fundingSource: 'fixture:funding-ledger',
      settlementKind: 'paper_simulation',
      valuationBasis: 'actual_exit_fills',
    })
    const grossPct = ((122 - 106) / 106) * 100
    expect(outcome?.realizedGrossPct).toBeCloseTo(grossPct, 10)
    expect(outcome?.realizedNetPct).toBeCloseTo(grossPct - (0.1 / 53) * 100 - (0.05 / 53) * 100, 10)
    expect(outcome?.evidenceRefs).toEqual(expect.arrayContaining([
      'fill:fill-multi-entry-0',
      'fill:fill-multi-entry-1',
      'fill:fill-multi-exit-0',
      'fill:fill-multi-exit-1',
    ]))
    expect(fundingRequest).toMatchObject({
      from: T0,
      until: T0 + 2 * HOUR + 1,
      quantity: 0.5,
      direction: 1,
      fills: expect.arrayContaining([
        expect.objectContaining({ fillId: 'fill-multi-entry-0' }),
        expect.objectContaining({ fillId: 'fill-multi-exit-1' }),
      ]),
    })
  })

  it('多笔 paper entry 的 horizon mark 是模拟账户估值，成交滑点不重复扣', async () => {
    flatBars('BTC/USDT', [120, 120, 120, 120, 120])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecisionWithFills(
      { decisionId: 'paper-mark' },
      [
        { side: 'buy', price: 100, qty: 0.4, fee: 0, ts: T0 },
        { side: 'buy', price: 110, qty: 0.6, fee: 0, ts: T0 + 1 },
      ],
      'paper',
    )

    const result = await scheduler().runOnce(NOW)
    expect(result.settled).toBe(1)
    const outcome = journal.outcomeFor('paper-mark')
    expect(outcome).toMatchObject({
      entryPrice: 106,
      exitPrice: 120,
      attributedQty: 1,
      settlementKind: 'paper_simulation',
      valuationBasis: 'horizon_mark',
      feesQuote: 0,
      fundingFeeQuote: 0,
    })
    expect(outcome?.realizedNetPct).toBeCloseTo(outcome?.realizedGrossPct as number, 10)
  })

  it('平仓归因不跨 paper 与 htx 账户借用入场成交', async () => {
    flatBars('BTC/USDT', [100, 100, 100, 100, 100])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecision(
      { decisionId: 'paper-entry', reflectionDueAt: T0 + 100 * HOUR },
      { side: 'buy', price: 100, qty: 1, fee: 0 },
      'paper',
    )
    executedDecision(
      { decisionId: 'htx-close', action: 'close', decidedAt: T0 + HOUR, reflectionDueAt: T0 + HORIZON },
      { side: 'sell', price: 101, qty: 1, fee: 0, ts: T0 + HOUR },
      'htx',
    )

    const result = await scheduler().runOnce(NOW)
    expect(result.deferredIds).toContain('htx-close')
    expect(journal.outcomeFor('htx-close')).toBeUndefined()
  })

  it('资金费和单点 benchmark 缺失时仍记录 gross，持久 net/benchmark/alpha 均为 unknown', async () => {
    flatBars('BTC/USDT', [100, 101, 102, 103, 104])
    flatBars(BENCH, [100])
    executedDecision(
      { decisionId: 'unknown-costs' },
      { side: 'buy', price: 100, qty: 1, fee: 0 },
      'htx',
    )

    const result = await scheduler(undefined, HORIZON, null).runOnce(NOW)
    expect(result.settled).toBe(1)
    const outcome = journal.outcomeFor('unknown-costs')
    expect(outcome?.realizedGrossPct).toBeGreaterThan(0)
    expect(outcome?.realizedNetPct).toBeNull()
    expect(outcome?.benchmarkPct).toBeNull()
    expect(outcome?.alphaPct).toBeNull()
    expect(outcome?.fundingFeeQuote).toBeNull()
    expect(outcome?.fundingSource).toBeNull()
    expect(db.prepare(
      'SELECT realized_net_pct, benchmark_pct, alpha_pct, funding_fee_quote, funding_source FROM outcomes WHERE decision_id = ?',
    ).get('unknown-costs')).toEqual({
      realized_net_pct: null,
      benchmark_pct: null,
      alpha_pct: null,
      funding_fee_quote: null,
      funding_source: null,
    })
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
    expect(journal.pendingSettlements(NOW)).toHaveLength(0)
    expect(journal.outcomeFor('d1')?.settlementKind).toBe('paper_simulation')
    const audit = db.prepare(
      `SELECT payload_json FROM audit_events WHERE kind = 'settlement_completed'`,
    ).get() as { payload_json: string }
    expect(JSON.parse(audit.payload_json)).toMatchObject({ learningStatus: 'settlement_only' })
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
    expect(journal.outcomeFor('d1')).toMatchObject({ stopHit: true, realizedGrossPct: -8 })
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
        timeframe: TF,
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
    executedDecision(
      { decisionId: 'entry', reflectionDueAt: T0 + 100 * HOUR },
      { side: 'buy', price: 100, qty: 1, fee: 0 },
      'htx',
    )
    executedDecision(
      { decisionId: 'd1', action: 'close', decidedAt: T0 + 2 * HOUR, reflectionDueAt: T0 + HORIZON },
      { side: 'sell', price: 101, qty: 1, fee: 0, ts: T0 + 2 * HOUR },
      'htx',
    )

    const seen: ReflectionInput[] = []
    const run = scheduler(async (input) => {
      seen.push(input)
      return { text: '趋势跟随有效。', evidenceRefs: ['fill:fill-d1-0'] }
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
    expect(journal.outcomeFor('d1')?.settlementKind).toBe('realized')
    expect(journal.outcomeFor('d1')?.valuationBasis).toBe('actual_exit_fills')
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
    executedDecision(
      { decisionId: 'entry', reflectionDueAt: T0 + 100 * HOUR },
      { side: 'buy', price: 100, qty: 1, fee: 0 },
      'htx',
    )
    executedDecision(
      { decisionId: 'd1', action: 'close', decidedAt: T0 + 2 * HOUR, reflectionDueAt: T0 + HORIZON },
      { side: 'sell', price: 101, qty: 1, fee: 0, ts: T0 + 2 * HOUR },
      'htx',
    )

    const result = await scheduler(async () => ({ text: '我觉得挺好', evidenceRefs: [] })).runOnce(NOW)
    expect(result.settled).toBe(1)
    expect(result.reflectionsWritten).toBe(0)
    expect(result.reflectionsRejected).toEqual([
      { decisionId: 'd1', reason: '反思没有携带证据指针（不可证伪）' },
    ])
    expect(journal.recentLessons()).toHaveLength(0)
  })

  it('没有成交明细时即使有 bar 也不生成伪收益样本', async () => {
    flatBars('BTC/USDT', [102, 103, 104, 105, 106])
    flatBars(BENCH, [100, 100, 101, 101, 101])
    journal.recordDecision({
      decisionId: 'd-hold',
      symbol: 'BTC/USDT',
      timeframe: TF,
      decidedAt: T0,
      contextHash: 'ctx:hold',
      action: 'open',
      executed: false,
    })
    journal.markDecisionReflectionDue('d-hold', T0 + HORIZON)

    const result = await scheduler().runOnce(NOW)
    expect(result.settled).toBe(0)
    expect(result.deferred).toBe(1)
    expect(journal.outcomeFor('d-hold')).toBeUndefined()
    expect(journal.pendingSettlements(NOW)).toHaveLength(1)
  })
})

describe('结算的数据可用性（P1 ④）', () => {
  it('★ 缺数据时**不得**凭空结算：没有成交也没有 bar ⇒ 保持 pending 等重试', async () => {
    // 决策存在、到期了，但该标的根本没有 bar（数据缺口）
    journal.recordDecision({
      decisionId: 'd-nodata',
      symbol: 'BTC/USDT',
      timeframe: TF,
      decidedAt: T0,
      contextHash: 'ctx:nodata',
      action: 'open',
      executed: false,
    })
    journal.markDecisionReflectionDue('d-nodata', T0 + HORIZON)

    const result = await scheduler().runOnce(NOW)
    expect(result.scanned).toBe(1)
    // 关键：不能写一条 entry_price=0 的假结算
    expect(result.settled).toBe(0)
    expect(result.deferred).toBe(1)
    expect(journal.outcomeFor('d-nodata')).toBeUndefined()
    // 仍然留在待结算队列里，下一轮还能补
    expect(journal.pendingSettlements(NOW)).toHaveLength(1)
  })

  it('数据补齐后重试成功（"含重试"是可验证的）', async () => {
    executedDecision(
      { decisionId: 'd-retry' },
      { side: 'buy', price: 100, qty: 1, fee: 0 },
    )
    expect((await scheduler().runOnce(NOW)).deferred).toBe(1)

    flatBars('BTC/USDT', [100, 101, 102, 103, 104])
    flatBars(BENCH, [100, 100, 101, 101, 101])
    const second = await scheduler().runOnce(NOW)
    expect(second.settled).toBe(1)
    expect(second.deferred).toBe(0)
    expect(journal.outcomeFor('d-retry')?.entryPrice).toBe(100)
  })

  it('有成交价但窗口内没有 bar ⇒ 同样推迟（不能用 0 当出场价）', async () => {
    executedDecision({ decisionId: 'd-fillonly' }, { side: 'buy', price: 100, qty: 1, fee: 0 })
    expect((await scheduler().runOnce(NOW)).deferred).toBe(1)
    expect(journal.outcomeFor('d-fillonly')).toBeUndefined()
  })

  it('结算成功率：到期决策里已结算的比例（≥99% 的判据落点）', async () => {
    // 200 条有数据的到期决策 + 2 条无数据的（数据缺口）
    flatBars('BTC/USDT', [100, 101, 102, 103, 104])
    flatBars(BENCH, [100, 100, 101, 101, 101])
    for (let index = 0; index < 200; index += 1) {
      executedDecision(
        { decisionId: `d-ok-${index}`, reflectionDueAt: T0 + HORIZON },
        { side: 'buy', price: 100, qty: 1, fee: 0 },
      )
    }
    for (const symbol of ['NODATA/USDT', 'ALSONODATA/USDT']) {
      journal.recordDecision({
        decisionId: `d-missing-${symbol}`,
        symbol,
        timeframe: TF,
        decidedAt: T0,
        contextHash: `ctx:${symbol}`,
        action: 'open',
        executed: false,
      })
      journal.markDecisionReflectionDue(`d-missing-${symbol}`, T0 + HORIZON)
    }
    // 全部到期
    db.prepare('UPDATE decisions SET reflection_due_at = ? WHERE reflection_due_at IS NOT NULL').run(T0 + HORIZON)

    const run = await scheduler().runOnce(NOW, 500)
    expect(run.scanned).toBe(202)
    expect(run.settled).toBe(200)
    expect(run.deferred).toBe(2)
    const rate = run.settled / (run.settled + run.deferred)
    expect(rate).toBeGreaterThanOrEqual(0.99)
    // "每条决策至多一条反思"仍然成立
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcomes').get()).toEqual({ n: 200 })
  })
})

// ── 审计修复的回归测试：结算不得看未来 bar、平仓必须对齐真实入场 ────────────────
describe('结算 PIT 与交易级净额（审计修复）', () => {
  /** 一条"已成交"决策，ts/decidedAt 可控。 */
  function filled(
    id: string,
    action: 'open' | 'reduce' | 'close',
    side: 'buy' | 'sell',
    price: number,
    qty: number,
    ts: number,
    dueAt: number,
  ): void {
    journal.recordDecision({
      decisionId: id,
      symbol: 'BTC/USDT',
      timeframe: TF,
      decidedAt: ts,
      contextHash: `ctx:${id}`,
      action,
      executed: false,
      reflectionDueAt: dueAt,
    })
    const coid = `co-${id}`
    journal.recordIntent({
      intentId: `intent-${id}`,
      clientOrderId: coid,
      decisionId: id,
      venue: 'paper',
      symbol: 'BTC/USDT',
      state: 'filled',
      type: 'market',
      side,
      qty,
      reduceOnly: action !== 'open',
      createdAt: ts,
    })
    journal.recordOrder({
      orderId: `ex-${id}`,
      venue: 'paper',
      exchangeOrderId: `ex-${id}`,
      clientOrderId: coid,
      symbol: 'BTC/USDT',
      status: 'filled',
      qty,
      filledQty: qty,
      updatedAt: ts,
    })
    journal.recordFill({
      fillId: `fill-${id}`,
      orderId: `ex-${id}`,
      qty,
      price,
      fee: 0,
      feeCurrency: 'USDT',
      ts,
    })
    journal.markDecisionExecuted(id)
    journal.markDecisionReflectionDue(id, dueAt)
  }

  it('★ 结算绝不能读入"结算时点之后才收盘"的 bar（look-ahead off-by-one）', async () => {
    // 最后一根 bar 的 openTime = T0+4h（= horizon 终点）⇒ 它在 horizon 之后才收盘
    flatBars('BTC/USDT', [100, 101, 102, 103, 999])
    flatBars(BENCH, [100, 100, 101, 101, 101])
    executedDecision({
      decisionId: 'd-hold2',
      symbol: 'BTC/USDT',
      timeframe: TF,
      decidedAt: T0,
      contextHash: 'ctx:hold2',
      action: 'open',
      executed: false,
    }, { side: 'buy', price: 100, qty: 1, fee: 0 })

    await scheduler().runOnce(NOW)
    // 只能是 horizon 内最后一根（openTime T0+3h，close 103），绝不是 999
    expect(journal.outcomeFor('d-hold2')?.exitPrice).toBe(103)
  })

  it('★ close 决策以**真实入场**结算，而不是把平仓成交当新入场', async () => {
    flatBars('BTC/USDT', [100, 101, 120, 120, 120])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    filled('d-open', 'open', 'buy', 100, 1, T0, T0 + HORIZON)
    filled('d-close', 'close', 'sell', 120, 1, T0 + 2 * HOUR, T0 + 2 * HOUR + HORIZON)

    const result = await scheduler().runOnce(T0 + 6 * HOUR)
    expect(result.settled).toBe(2)

    const closeOutcome = journal.outcomeFor('d-close')
    expect(closeOutcome?.entryPrice).toBe(100)
    // 一个 +20% 的回合必须被记成 +20% 左右，而不是 ~0%
    expect(closeOutcome?.realizedGrossPct).toBeCloseTo(20, 6)
    // 实际入场/出场成交价已经包含执行滑点，不在结算时重复扣减。
    expect(closeOutcome?.realizedNetPct).toBeCloseTo(20, 6)
    expect(closeOutcome?.alphaPct).toBeCloseTo(20, 6)
  })

  it('保护单反向成交归属开仓决策，完整止损按实际 entry/exit 计算', async () => {
    flatBars('BTC/USDT', [100, 90, 90, 90, 90])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecisionWithFills({ decisionId: 'protected-open' }, [
      { side: 'buy', price: 100, qty: 1, fee: 0, ts: T0 },
      { side: 'sell', price: 90, qty: 1, fee: 0, ts: T0 + HOUR, reduceOnly: true },
    ], 'htx')

    const result = await scheduler().runOnce(NOW)
    expect(result.errors).toEqual([])
    expect(result.settled).toBe(1)
    expect(journal.outcomeFor('protected-open')).toMatchObject({
      entryPrice: 100,
      exitPrice: 90,
      realizedGrossPct: -10,
      settlementKind: 'realized',
      valuationBasis: 'actual_exit_fills',
      attributedQty: 1,
    })
  })

  it('保护单部分成交后按已实现 PnL 加剩余 horizon mark 归因', async () => {
    flatBars('BTC/USDT', [100, 104, 105, 104, 104])
    flatBars(BENCH, [100, 100, 100, 100, 100])
    executedDecisionWithFills({ decisionId: 'partially-protected-open' }, [
      { side: 'buy', price: 100, qty: 2, fee: 0, ts: T0 },
      { side: 'sell', price: 90, qty: 1, fee: 0, ts: T0 + HOUR, reduceOnly: true },
    ], 'htx')

    const result = await scheduler().runOnce(NOW)
    expect(result.errors).toEqual([])
    expect(result.settled).toBe(1)
    expect(journal.outcomeFor('partially-protected-open')).toMatchObject({
      exitPrice: 104,
      realizedGrossPct: -3,
      settlementKind: 'horizon_mark',
      valuationBasis: 'horizon_mark',
      attributedQty: 2,
    })
  })

  it('close 的 benchmark/MFE/MAE/stopHit 与真实持仓时段对齐，排除平仓后的行情', async () => {
    seedBars('BTC/USDT', [
      { openTime: T0, close: 100, high: 102, low: 98 },
      { openTime: T0 + HOUR, close: 110, high: 112, low: 108 },
      { openTime: T0 + 2 * HOUR, close: 90, high: 140, low: 80 },
      { openTime: T0 + 3 * HOUR, close: 90, high: 95, low: 85 },
      { openTime: T0 + 4 * HOUR, close: 90, high: 95, low: 85 },
    ])
    flatBars(BENCH, [100, 105, 130, 132, 133])
    executedDecision(
      { decisionId: 'held-entry', reflectionDueAt: T0 + 100 * HOUR },
      { side: 'buy', price: 100, qty: 1, fee: 0, ts: T0 },
      'htx',
    )
    executedDecision(
      {
        decisionId: 'time-aligned-close', action: 'close', decidedAt: T0 + 2 * HOUR,
        reflectionDueAt: T0 + 3 * HOUR, stopPrice: 95,
      },
      { side: 'sell', price: 110, qty: 1, fee: 0, ts: T0 + 2 * HOUR },
      'htx',
    )

    const result = await scheduler().runOnce(NOW)
    expect(result.errors).toEqual([])
    expect(journal.outcomeFor('time-aligned-close')).toMatchObject({
      realizedGrossPct: 10,
      benchmarkPct: 5,
      alphaPct: 5,
      mfePct: 12,
      maePct: -2,
      stopHit: false,
    })
  })
})
