#!/usr/bin/env node
/**
 * R2 可复现验收：有界 DecisionContext、PIT 输入与最终请求渲染。
 * 用法：pnpm build && node scripts/r2-acceptance.mjs [output.json]
 * 全部使用内存 SQLite 与固定时钟；假模型只捕获最终请求，不生成裁决，也不访问网络。
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  BarArchive,
  DecisionJournal,
  DecisionRequestTooLargeError,
  EXAMPLE_LIMITS,
  FeatureArchive,
  FeatureEngine,
  MarketObservationStore,
  PlanStore,
  PriceTableStore,
  ReplayClock,
  SCHEMA_VERSION,
  buildDecisionContext,
  canonicalDecisionContext,
  computeContentHash,
  migrate,
  normalizeCandles,
  renderDecisionRequest,
  timeframeMs,
} from '../lib/index.js'

const OUT = process.argv[2]
const AS_OF = 1_700_000_000_000
const HOUR = 3_600_000
const SYMBOL = 'ADA/USDT:USDT'
const BENCHMARK = 'BTC/USDT:USDT'
const TIMEFRAMES = ['15m', '1h', '4h']

function newPorts(db, over = {}) {
  const bars = new BarArchive(db)
  const features = new FeatureArchive(db)
  const plans = new PlanStore(db)
  const journal = new DecisionJournal(db)
  const broker = {
    venue: 'paper',
    async getAccount() {
      if (over.accountError !== undefined) throw new Error(over.accountError)
      return over.account ?? {
        venue: 'paper', equityQuote: 100, freeMarginQuote: 80, totalExposureUsd: 20,
        openOrders: over.orders?.length ?? 0, leverage: 0.2, dailyLossUsd: 0,
        drawdownUsd: 0, consecutiveLosses: 0, spreadBps: 2, observedAt: AS_OF,
      }
    },
    async getPositions() { return over.positions ?? [] },
    async getOpenOrders() { return over.orders ?? [] },
  }
  return {
    db, bars, features, plans, journal, broker,
    clock: new ReplayClock(AS_OF), limits: EXAMPLE_LIMITS, mode: 'paper', riskPct: 0.002,
    symbols: [SYMBOL], timeframes: TIMEFRAMES, benchmark: BENCHMARK,
    frozenSymbols: () => new Set(),
  }
}

function seedSeries(ports, symbol, timeframe, count, base) {
  const step = timeframeMs(timeframe)
  const start = AS_OF - count * step
  const engine = new FeatureEngine()
  for (let index = 0; index < count; index += 1) {
    const openTime = start + index * step
    const close = base + index * 0.3 + (index % 5) * 0.07
    const candle = normalizeCandles([{
      openTime, open: close, high: close + 0.4, low: close - 0.4, close, volume: 100 + index,
    }], symbol, timeframe, AS_OF).candles[0]
    assert.ok(candle?.closed)
    ports.bars.upsertClosed([candle], { source: 'r2.fixture', fetchedAt: candle.closeTime })
    ports.features.upsert(engine.onClosedCandle(candle), candle.closeTime)
  }
}

function seedPlan(ports, thesis = 'R2 fixture plan: reduce below the invalidation level', planId = 'pc-r2-acceptance', createdAt = AS_OF - HOUR) {
  const base = {
    planId, symbol: SYMBOL, createdAt,
    windowEndsAt: createdAt + 7 * 24 * HOUR, thesis, confidence: 0.5,
    keyLevels: [{ kind: 'support', price: 990 }],
    invalidation: [{ id: 'inv-r2', tf: '1h', when: 'bar.close < 990', then: { action: 'reduce', fraction: 0.5 } }],
    commitments: [{ id: 'commit-r2', seq: 1, tf: '1h', when: 'bar.close > 1000', then: { action: 'reduce', fraction: 0.25 } }],
    forbidden: [], noTrade: false, author: 'model', authority: 'model',
  }
  ports.plans.save({ ...base, contentHash: computeContentHash(base) }, createdAt)
}

function seedOutcome(ports, { settledAt = AS_OF - 500, suffix = 'visible' } = {}) {
  const decisionId = `decision-r2-${suffix}`
  const outcomeId = `outcome-r2-${suffix}`
  ports.journal.recordDecision({
    decisionId, symbol: SYMBOL, timeframe: '1h', decidedAt: AS_OF - 10_000,
    contextHash: `sha256:${suffix}`, action: 'open', sizeQty: 2, stopPrice: 990,
    rationale: 'R2 fixture: prior execution result', executed: true, reflectionDueAt: AS_OF - 1_000,
  })
  ports.journal.recordOutcome({
    outcomeId, decisionId, symbol: SYMBOL, settledAt, horizonMs: 4 * HOUR,
    entryPrice: 1_000, exitPrice: 1_010, realizedGrossPct: 1, realizedNetPct: 0.8,
    benchmarkPct: 0.2, alphaPct: 0.6, mfePct: 1.2, maePct: -0.1,
    stopHit: false, feesQuote: 0.2, evidenceRefs: [`fill:${suffix}`, `bar:${suffix}`],
  })
  ports.journal.markDecisionOutcome(decisionId, outcomeId)
}

function section(context, name) { return context.sections[name].value }

const db = new Database(':memory:')
migrate(db)
assert.ok(SCHEMA_VERSION >= 6, `R2 PIT schema missing: ${SCHEMA_VERSION}`)
const ports = newPorts(db, {
  positions: [{ symbol: SYMBOL, observedAt: AS_OF, qty: 2, avgPrice: 1_000, unrealizedPnlUsd: 4, protectedStopPrice: 990 }],
  orders: [{ intentId: 'intent-r2', clientOrderId: 'client-r2', exchangeOrderId: 'exchange-r2', state: 'acked', ts: AS_OF, observedAt: AS_OF, filledQty: 0 }],
})
for (const timeframe of TIMEFRAMES) seedSeries(ports, SYMBOL, timeframe, 64, 1_000)
seedSeries(ports, BENCHMARK, '1h', 64, 60_000)

const observations = new MarketObservationStore(db)
for (const hoursAgo of [24, 4, 1, 0]) {
  const eventTime = AS_OF - hoursAgo * HOUR
  observations.record({
    kind: 'derivatives', symbol: SYMBOL, timeframe: '', eventTime, availableAt: eventTime,
    source: 'r2.fixture.derivatives', value: {
      timestamp: eventTime, fundingRate: 0.0001 + hoursAgo * 0.00001,
      openInterest: 100_000 + (24 - hoursAgo) * 100, openInterestUnit: 'quote',
      liquidations: [], spotPrice: 1_000, swapPrice: 1_002,
      fundingIntervalMs: 8 * HOUR, nextFundingTime: AS_OF + 4 * HOUR, errors: {},
    },
  })
}
observations.record({
  kind: 'spec', symbol: SYMBOL, timeframe: '', eventTime: AS_OF - 10, availableAt: AS_OF - 10,
  source: 'r2.fixture.markets', value: {
    symbol: SYMBOL, linear: true, contractSize: 1, amountStepContracts: 1,
    priceStep: 0.01, minAmountContracts: 1, minNotionalQuote: 1,
    makerFeeRate: 0.0002, takerFeeRate: 0.0005,
  },
})
new PriceTableStore(db).add({ model: 'fixture-model', effectiveFrom: AS_OF - HOUR, tier: 'any', inPerMtok: 0.1, outPerMtok: 0.2 })
db.prepare('INSERT INTO config_versions (ts, author, params_json) VALUES (?, ?, ?)')
  .run(AS_OF - 100, 'fixture', JSON.stringify({ apiSecret: 'MUST-NOT-ENTER-CONTEXT' }))
db.prepare('INSERT INTO heartbeat (id, beat_at, halted) VALUES (1, ?, 0)').run(AS_OF)
ports.journal.appendAudit({
  actor: 'system', kind: 'reconcile_report',
  payload: { acknowledgeOrphans: false, result: { actions: [], consistent: true, freezeTrading: false }, applied: [] },
  ts: AS_OF,
})
seedPlan(ports)
seedPlan(ports, 'Future plan, invisible before its creation time', 'pc-r2-future', AS_OF + 1)
seedOutcome(ports)

const context = await buildDecisionContext(ports, SYMBOL, '1h')
const rendered = renderDecisionRequest(context)
let captured
await { async invoke(request) { captured = request } }.invoke(rendered)
assert.equal(captured.contextHash, context.contextHash)
assert.ok(captured.messages[1].content.includes(canonicalDecisionContext(context)))
assert.ok(!captured.messages[1].content.includes('MUST-NOT-ENTER-CONTEXT'))

const timeframes = section(context, 'market').timeframes
const marketBars = Object.values(timeframes).reduce((sum, slice) => sum + slice.bars.length, 0)
const benchmark = section(context, 'benchmark')
const priorDecision = section(context, 'history').decisions[0]
const portfolio = section(context, 'portfolio')
assert.ok(marketBars > 0, 'R2 must exercise non-empty market sequences')
assert.ok(Object.values(timeframes).every((slice) => slice.bars.length > 0), 'all configured timeframes need samples')
assert.ok(benchmark.series.bars.length > 0, 'benchmark sequence must be non-empty')
assert.ok(benchmark.correlation.samples > 0, 'benchmark statistics need a non-empty denominator')
assert.ok(section(context, 'derivatives').changes['24h'].openInterest.value !== null)
assert.ok(portfolio.positions.length > 0 && portfolio.openOrders.length > 0)
assert.equal(portfolio.positions[0].protectedStopPrice, 990)
assert.ok(section(context, 'activePlan').card.commitments.length > 0)
assert.equal(section(context, 'activePlan').card.planId, 'pc-r2-acceptance')
assert.ok(priorDecision?.outcome?.evidenceRefs.length > 0)
assert.equal(section(context, 'lessons').state, 'disabled')
assert.equal(section(context, 'predictions').state, 'disabled')

// 正常空状态与缺失状态分开验收。
const emptyDb = new Database(':memory:')
migrate(emptyDb)
const emptyPorts = newPorts(emptyDb)
emptyDb.prepare('INSERT INTO config_versions (ts, author, params_json) VALUES (?, ?, ?)')
  .run(AS_OF + 1, 'future', JSON.stringify({ mode: 'live_auto' }))
emptyPorts.journal.appendAudit({
  actor: 'system', kind: 'reconcile_report',
  payload: { acknowledgeOrphans: false, result: { actions: [], consistent: true, freezeTrading: false }, applied: [] },
  ts: AS_OF + 1,
})
emptyDb.prepare(`INSERT INTO order_intents (intent_id, client_order_id, venue, symbol, state, created_at)
  VALUES ('future-intent', 'future-client', 'paper', ?, 'unknown', ?)`).run(SYMBOL, AS_OF + 1)
const emptyContext = await buildDecisionContext(emptyPorts, SYMBOL, '1h')
assert.equal(section(emptyContext, 'activePlan').state, 'empty')
assert.equal(section(emptyContext, 'history').status, 'empty')
assert.deepEqual(emptyContext.sections.activePlan.missing, [])
assert.deepEqual(emptyContext.sections.history.missing, [])
assert.equal(section(emptyContext, 'mandate').runtime.configVersion, null)
emptyDb.close()

const conditionDb = new Database(':memory:')
migrate(conditionDb)
const conditionPorts = newPorts(conditionDb)
const conditionObservations = new MarketObservationStore(conditionDb)
const staleOpen = AS_OF - 21 * HOUR
const stale = normalizeCandles([{
  openTime: staleOpen, open: 1_000, high: 1_001, low: 999, close: 1_000, volume: 10,
}], SYMBOL, '1h', AS_OF).candles[0]
assert.ok(stale?.closed)
conditionPorts.bars.upsertClosed([stale], { source: 'stale', fetchedAt: stale.closeTime })
conditionObservations.record({ kind: 'bar', symbol: SYMBOL, timeframe: '15m', eventTime: AS_OF, availableAt: AS_OF, source: 'warm', value: { close: 1 } })
conditionObservations.record({ kind: 'bar', symbol: SYMBOL, timeframe: '4h', eventTime: AS_OF - HOUR, availableAt: AS_OF + 1, source: 'late', value: { close: 1 } })
conditionObservations.record({ kind: 'derivatives', symbol: SYMBOL, timeframe: '', eventTime: AS_OF - 2 * HOUR, availableAt: AS_OF - 2 * HOUR, source: 'stale-derivatives', value: { fundingRate: 0.001 } })
const conditionContext = await buildDecisionContext(conditionPorts, SYMBOL, '1h')
const missingMarket = conditionContext.sections.market.missing
assert.ok(missingMarket.some((item) => item.includes('1h') && item.includes('stale')))
assert.ok(missingMarket.some((item) => item.includes('15m') && item.includes('warming')))
assert.ok(missingMarket.some((item) => item.includes('4h.bars:missing')))
assert.ok(conditionContext.sections.derivatives.missing.some((item) => item.includes('stale')))
assert.ok(!conditionObservations.recent('bar', SYMBOL, '4h', AS_OF, 10).some((item) => item.source === 'late'))
conditionDb.close()

const errorDb = new Database(':memory:')
migrate(errorDb)
const errorContext = await buildDecisionContext(newPorts(errorDb, { accountError: 'key=NEVER-RENDER-THIS' }), SYMBOL, '1h')
assert.ok(errorContext.sections.portfolio.missing.includes('account.read_failed:Error'))
assert.ok(!canonicalDecisionContext(errorContext).includes('NEVER-RENDER-THIS'))
errorDb.close()

const overflowDb = new Database(':memory:')
migrate(overflowDb)
const overflowPorts = newPorts(overflowDb)
seedPlan(overflowPorts, 'x'.repeat(20_000))
const overflowContext = await buildDecisionContext(overflowPorts, SYMBOL, '1h')
assert.equal(section(overflowContext, 'activePlan').card.thesis.text.length, 20_000)
let overflowRejected = false
try {
  renderDecisionRequest(overflowContext, { maxChars: 1_000 })
} catch (error) {
  overflowRejected = error instanceof DecisionRequestTooLargeError
}
assert.equal(overflowRejected, true)
overflowDb.close()
db.close()

const output = {
  schemaVersion: SCHEMA_VERSION,
  asOf: AS_OF,
  contextHash: context.contextHash,
  request: rendered,
  nonEmptySampleCounts: {
    marketBars,
    benchmarkBars: benchmark.series.bars.length,
    benchmarkReturnPairs: benchmark.correlation.samples,
    derivativeObservations: 4,
    priorOutcomes: 1,
    positions: portfolio.positions.length,
    orders: portfolio.openOrders.length,
    activePlanCommitments: section(context, 'activePlan').card.commitments.length,
  },
  checks: {
    actualRequestCaptured: captured.messages[1].content.includes(canonicalDecisionContext(context)),
    pointInTimeConfig: section(emptyContext, 'mandate').runtime.configVersion === null,
    normalEmptyState: section(emptyContext, 'activePlan').state === 'empty' && section(emptyContext, 'history').status === 'empty',
    futureReconciliationAndIntentExcluded: section(emptyContext, 'portfolio').reconciliation.state === 'not_reported' && section(emptyContext, 'portfolio').unresolvedIntents.length === 0,
    futurePlanExcluded: section(context, 'activePlan').card.planId === 'pc-r2-acceptance',
    staleWarmingAndFutureObservationDistinguished: true,
    failedReadSanitized: !canonicalDecisionContext(errorContext).includes('NEVER-RENDER-THIS'),
    oversizeRefusedWithoutTruncation: overflowRejected,
  },
}
if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify(output, null, 2))
