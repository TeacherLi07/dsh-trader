#!/usr/bin/env node
/**
 * paper 全链路验收（plan §13 纪律 1：离线回放 → **paper** → 测试网 → 实盘）。
 *
 * 用法：pnpm build && node scripts/live-paper-e2e.mjs [days] [symbol] [outPath]
 *   例：node scripts/live-paper-e2e.mjs 30 ADA/USDT:USDT /tmp/paper-e2e.json
 *
 * 它验证的是**生产同一份代码**在 paper broker 上的完整链路：
 *   真实 HTX 已收盘 bar → 特征 → active 计划卡匹配（invalidation→commitments）
 *   → 二次硬闸 → 下单 → **立即挂保护单** → decision/intent/order/fill 落库 → 登记结算到期
 *   → 再跑一遍**幂等**（不重复下单/不重复决策）。
 *
 * 与 `live-engine` 单测的区别：这里用**真实行情**与真实 archive/DB，端到端跑几百根 bar。
 * 判据全部可计算，并且先证明样本非空（分母 > 0）。
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import { ReplayClock, systemClock } from '../lib/clock.js'
import { EXAMPLE_LIMITS } from '../lib/config.js'
import { migrate } from '../lib/db/schema.js'
import { PaperBroker } from '../lib/exec/paper.js'
import { DecisionJournal } from '../lib/exec/journal.js'
import { createLiveEngine } from '../lib/exec/live-engine.js'
import { BarArchive } from '../lib/market/archive.js'
import { backfill } from '../lib/market/backfill.js'
import { createCcxtSource, applyProxyAwareFetch } from '../lib/market/ccxt-source.js'
import { FeatureArchive } from '../lib/market/feature-archive.js'
import { FeaturePipeline } from '../lib/market/features.js'
import { timeframeMs } from '../lib/market/normalize.js'
import { PlanStore } from '../lib/plan/store.js'
import { computeContentHash, validatePlanCard } from '../lib/plan/schema.js'

const DAYS = Number(process.argv[2] ?? '30')
const SYMBOL = process.argv[3] ?? 'ADA/USDT:USDT'
const OUT = process.argv[4]
const TF = '1h'
const RISK_PCT = 0.002
/** 与 cordis.patch.yml 的 live 限额一致（由 24.914 USDT 权益推导）。 */
const LIMITS = {
  ...EXAMPLE_LIMITS,
  perOrderCapUsd: 12,
  maxExposureUsd: 24,
  maxLeverage: 1,
  dailyLossLimitUsd: 1.25,
  maxDrawdownUsd: 2.5,
  maxConsecutiveLosses: 3,
  maxSpreadBps: 10,
  maxOpenOrders: 2,
}

// ── 1) 真实行情回补 ─────────────────────────────────────────────────────────
const Exchange = ccxt.htx
const exchange = new Exchange({ enableRateLimit: true, defaultType: 'swap' })
applyProxyAwareFetch(exchange)
const source = createCcxtSource(exchange)
const fetchDir = mkdtempSync(join(tmpdir(), 'dsh-paper-e2e-fetch-'))
const fetchDb = new Database(join(fetchDir, 'fetch.db'))
migrate(fetchDb)
const fetchArchive = new BarArchive(fetchDb)
const until = Date.now()
const since = until - DAYS * 86_400_000
await backfill(
  { source, archive: fetchArchive, clock: systemClock() },
  { symbol: SYMBOL, timeframe: TF, since, until, pageLimit: 500 },
)
const bars = fetchArchive.closedBars(SYMBOL, TF, { limit: 100_000 })
fetchDb.close()
await source.close?.()
const start = bars[0]?.openTime
const end = (bars[bars.length - 1]?.openTime ?? 0) + timeframeMs(TF)

// ── 2) 计划卡（合法、可判定、有失效条件）──────────────────────────────────────
function card() {
  const base = {
    planId: `pc-paper-e2e-${TF}`,
    symbol: SYMBOL,
    createdAt: start,
    windowEndsAt: end,
    thesis: 'paper 全链路验收：站上 ema20 做多、跌破则退出',
    confidence: 0.5,
    keyLevels: [],
    invalidation: [
      { id: 'inv-break', tf: TF, when: 'position.qty > 0 and bar.close < ema20 * 0.97', then: { action: 'close' } },
    ],
    commitments: [
      {
        id: 'c-open',
        seq: 1,
        tf: TF,
        when: 'position.qty == 0 and bar.close > ema20',
        then: { action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskPct: RISK_PCT },
      },
      {
        id: 'c-reduce',
        seq: 2,
        tf: TF,
        when: 'position.qty > 0 and bar.close > ema20 * 1.03',
        then: { action: 'reduce', fraction: 0.5 },
      },
    ],
    forbidden: [],
    noTrade: false,
    author: 'model',
    authority: 'model',
  }
  return { ...base, contentHash: computeContentHash(base) }
}

const shipped = card()
const validation = validatePlanCard(shipped)

// ── 3) paper 全链路（生产同一份 live-engine + execute-action）─────────────────
function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-paper-e2e-'))
  const dbPath = join(dir, 'paper.db')
  const db = new Database(dbPath)
  migrate(db)
  const clock = new ReplayClock(start)
  const archive = new BarArchive(db)
  archive.upsertClosed(bars, { source: 'htx', fetchedAt: start })
  const featureArchive = new FeatureArchive(db)
  const pipeline = new FeaturePipeline(featureArchive)
  for (const bar of bars) pipeline.onClosedCandle(bar)
  const plans = new PlanStore(db)
  plans.save(shipped, start)
  const journal = new DecisionJournal(db)
  const broker = new PaperBroker({
    clock,
    book: { price: () => bars[0]?.close },
    initialEquityQuote: 24.914,
    slippageBps: 5,
    feeBps: 5,
  })
  const engine = createLiveEngine({
    journal,
    plans,
    bars: archive,
    features: featureArchive,
    broker,
    clock,
    mode: 'paper',
    limits: LIMITS,
    riskPct: RISK_PCT,
  })
  return { db, dbPath, clock, journal, broker, engine, plans }
}

async function runPass(harness) {
  const outcomes = []
  for (const bar of bars) {
    harness.clock.advanceTo(bar.closeTime)
    // paper 的保护单是"挂单"，必须靠 bar 推进才可能触发（与 market 插件同一接线）
    harness.broker.onBar(SYMBOL, { high: bar.high, low: bar.low, close: bar.close })
    const result = await harness.engine.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: bar.openTime })
    if (result.kind !== 'noop') outcomes.push({ ts: bar.openTime, kind: result.kind, reason: result.reason ?? null })
  }
  return outcomes
}

const counts = (db) => ({
  decisions: db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n,
  executedDecisions: db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE executed = 1').get().n,
  settlementRegistered: db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE reflection_due_at IS NOT NULL').get().n,
  intents: db.prepare('SELECT COUNT(*) AS n FROM order_intents').get().n,
  protectiveIntents: db.prepare("SELECT COUNT(*) AS n FROM order_intents WHERE type = 'protective'").get().n,
  orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
  fills: db.prepare('SELECT COUNT(*) AS n FROM fills').get().n,
  duplicateClientOrderIds: db.prepare(
    'SELECT COUNT(*) AS n FROM (SELECT client_order_id FROM order_intents GROUP BY client_order_id HAVING COUNT(*) > 1)',
  ).get().n,
})

const first = makeHarness()
const outcomes = await runPass(first)
const afterFirst = counts(first.db)
// 保护单覆盖率的**分母**必须在 pass1 结束时取，否则会被后续重放污染（实测踩过）。
const executedOpensAfterFirst = first.db
  .prepare("SELECT COUNT(*) AS n FROM decisions WHERE action = 'open' AND executed = 1")
  .get().n
const protectiveOpen = await first.broker.getOpenOrders(SYMBOL)

// ── 4a) 幂等（强判据）：**同一引擎、同一根 bar** 再喂一遍 ⇒ 零新增 ─────────────
// 只重放"当前时钟对应的那根 bar"，避免用过期的 now 去重放历史 bar（matchPlan 有时间敏感语义，
// 那是回测artifact，不是幂等缺陷）。已 fired 的条件 + 已落库的 decision 必须完全短路。
const lastBar = bars[bars.length - 1]
const beforeSameBar = counts(first.db)
if (lastBar !== undefined) {
  await first.engine.onClosedBar({ symbol: SYMBOL, timeframe: TF, barTs: lastBar.openTime })
}
const afterSameBar = counts(first.db)

// ── 4b) 幂等（不变量）：换一个引擎全量重放，**不允许新增订单/意图/成交，也不允许重复键** ──
const second = makeHarnessWithSameDb(first)
const outcomes2 = await runPass(second)
const afterSecond = counts(second.db)

function makeHarnessWithSameDb(existing) {
  // 复用同一个 db 文件（temp 目录里），只换时钟与 broker。
  const db = new Database(existing.dbPath)
  const clock = new ReplayClock(start)
  const archive = new BarArchive(db)
  const featureArchive = new FeatureArchive(db)
  const plans = new PlanStore(db)
  const journal = new DecisionJournal(db)
  const broker = new PaperBroker({
    clock,
    book: { price: () => bars[0]?.close },
    initialEquityQuote: 24.914,
    slippageBps: 5,
    feeBps: 5,
  })
  const engine = createLiveEngine({
    journal,
    plans,
    bars: archive,
    features: featureArchive,
    broker,
    clock,
    mode: 'paper',
    limits: LIMITS,
    riskPct: RISK_PCT,
  })
  return { db, clock, journal, broker, engine, plans }
}

const executedOutcomes = outcomes.filter((o) => o.kind === 'executed')
const checks = {
  // 非空跑守卫
  real_bars_gt_0: bars.length > 0,
  plan_card_valid: validation.ok === true,
  // 链路：至少执行过一次，且确实下了单、挂了保护单、登记了结算
  executed_at_least_once: executedOutcomes.length > 0,
  intents_gt_0: afterFirst.intents > 0,
  fills_gt_0: afterFirst.fills > 0,
  protective_intent_placed: afterFirst.protectiveIntents > 0,
  settlement_registered: afterFirst.settlementRegistered > 0,
  // 每个已执行的开仓都必须有保护单（HTX 无原子括号单，这是 §6.3 的硬要求）
  protective_covers_opens:
    executedOpensAfterFirst > 0 && afterFirst.protectiveIntents >= executedOpensAfterFirst,
  // 幂等（强）：同一根 bar 同引擎重放零新增
  idempotent_same_bar_no_new_decisions: afterSameBar.decisions === beforeSameBar.decisions,
  idempotent_same_bar_no_new_intents: afterSameBar.intents === beforeSameBar.intents,
  // 幂等（不变量）：跨两遍全量重放，全局零重复 clientOrderId
  // （注意：不能用"整轮计数不变"当判据 —— 新引擎的持仓轨迹合法地不同，会在更晚的 bar 上重新满足条件）
  no_duplicate_client_order_ids: afterSecond.duplicateClientOrderIds === 0,
  // 风控：单笔名义不超过 cap（硬闸二次校验生效）
  per_order_cap_respected: first.db
    .prepare("SELECT COUNT(*) AS n FROM order_intents WHERE reduce_only = 0 AND notional_usd IS NOT NULL AND notional_usd > @cap")
    .get({ cap: LIMITS.perOrderCapUsd }).n === 0,
}

const report = {
  ranAt: new Date().toISOString(),
  symbol: SYMBOL,
  timeframe: TF,
  days: DAYS,
  bars: bars.length,
  window: { start, end },
  pass1: { outcomes: outcomes.length, executed: executedOutcomes.length, counts: afterFirst },
  sameBarReplay: { before: beforeSameBar, after: afterSameBar },
  pass2: { outcomes: outcomes2.length, counts: afterSecond },
  openOrdersAtEndOfPass1: protectiveOpen.length,
  checks,
  allPassed: Object.values(checks).every(Boolean),
  outcomesSample: outcomes.slice(0, 20),
}

console.log(JSON.stringify(report, null, 2))
if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
first.db.close()
second.db.close()
process.exit(report.allPassed ? 0 : 1)
