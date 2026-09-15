#!/usr/bin/env node
/**
 * P1 阶段验收（plan §10 P1 ①–④）—— **可运行判定**。
 *
 * 用法：pnpm build && node scripts/p1-acceptance.mjs [days] [outPath]
 *   例：node scripts/p1-acceptance.mjs 30 /tmp/p1.json
 *
 * 判据与落点：
 *   ① 计划卡 schema 通过率 100% —— `validatePlanCard` + `checkExpressions`
 *   ② `when` 求值错误率 = 0（错误一律计 UNCOVERED 并告警）—— 回放日志可归因 + 编译全通过
 *   ③ 日输出计划覆盖率、W2/W3 频次、每窗口成本 —— `MetricsStore`
 *   ④ 到期决策结算成功率 ≥ 99%（含重试）+ **每条决策至多一条反思** —— 真实回放后跑结算
 *
 * ⚠️ ⑤（kill -9 后 resume）**不在这里**：它由 `scripts/crash-recovery-check.mjs` 单独验证。
 *
 * 数据是**真实行情**（HTX 30 天 1h）：决策来自真实回放，不是伪造的样本量。
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
import { replay } from '../lib/exec/replay.js'
import { BarArchive } from '../lib/market/archive.js'
import { backfill } from '../lib/market/backfill.js'
import { applyProxyAwareFetch, createCcxtSource } from '../lib/market/ccxt-source.js'
import { timeframeMs } from '../lib/market/normalize.js'
import { SettlementScheduler } from '../lib/memory/settle.js'
import { checkExpressions } from '../lib/plan/evaluate.js'
import { computeContentHash, validatePlanCard } from '../lib/plan/schema.js'
import { PlanStore } from '../lib/plan/store.js'
import { MetricsStore } from '../lib/supervisor/metrics.js'
import { buildRules } from '../lib/trigger/engine.js'
import { TriggerQueue } from '../lib/trigger/queue.js'

const DAYS = Number(process.argv[2] ?? '30')
const OUT = process.argv[3]
const SYMBOL = 'BTC/USDT'
const TF = '1h'
const HORIZON = 4 * 3_600_000
const RISK_PCT = 0.002
const LIMITS = { ...EXAMPLE_LIMITS, perOrderCapUsd: 5_000, maxExposureUsd: 50_000, maxOpenOrders: 50 }

// ── 1) 真实行情 ──────────────────────────────────────────────────────────────
const Exchange = ccxt.htx
const exchange = new Exchange({ enableRateLimit: true })
applyProxyAwareFetch(exchange)
const source = createCcxtSource(exchange)
const fetchDir = mkdtempSync(join(tmpdir(), 'dsh-p1-fetch-'))
const fetchDb = new Database(join(fetchDir, 'fetch.db'))
migrate(fetchDb)
const fetchArchive = new BarArchive(fetchDb)
const until = Date.now()
const since = until - DAYS * 86_400_000
const fetched = await backfill(
  { source, archive: fetchArchive, clock: systemClock() },
  { symbol: SYMBOL, timeframe: TF, since, until, pageLimit: 500 },
)
const bars = fetchArchive.closedBars(SYMBOL, TF, { limit: 100_000 })
const start = bars[0]?.openTime
const end = (bars[bars.length - 1]?.openTime ?? start) + timeframeMs(TF)
fetchDb.close()
await source.close?.()

// ── 2) 计划卡：① schema / ② 编译 ────────────────────────────────────────────
function card() {
  const base = {
    planId: `pc-p1-${TF}`,
    symbol: SYMBOL,
    createdAt: start,
    windowEndsAt: end,
    thesis: 'P1 验收：真实回放',
    confidence: 0.5,
    keyLevels: [],
    invalidation: [
      { id: 'inv-break', tf: TF, when: 'position.qty > 0 and bar.close < ema20 * 0.99', then: { action: 'close' } },
    ],
    commitments: [
      {
        id: 'c-open',
        seq: 1,
        tf: TF,
        when: 'position.qty == 0 and rsi14 < 45',
        then: { action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskPct: RISK_PCT },
      },
      { id: 'c-take', seq: 2, tf: TF, when: 'position.qty > 0 and rsi14 > 60', then: { action: 'reduce', fraction: 0.5 } },
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
const expressions = [
  ...shipped.invalidation.map((rule) => rule.when),
  ...shipped.commitments.map((rule) => rule.when),
]
const compile = checkExpressions(expressions)

// ── 3) 回放（真实数据）→ 到期决策 ────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'dsh-p1-'))
const db = new Database(join(dir, 'p1.db'))
migrate(db)
const clock = new ReplayClock(start)
const archive = new BarArchive(db)
archive.upsertClosed(bars, { source: 'htx', fetchedAt: start })
const plans = new PlanStore(db)
plans.save(shipped, start)
const queue = new TriggerQueue(db)
const broker = new PaperBroker({
  clock,
  book: { price: () => undefined },
  initialEquityQuote: 10_000,
  slippageBps: 5,
  feeBps: 5,
})
const executed = await replay(
  {
    db,
    bars: archive,
    plans,
    queue,
    broker,
    clock,
    rules: buildRules(['mean_reversion_v1', 'breakout_v1'], { cooldownMs: 0 }).rules,
    riskPct: RISK_PCT,
    mode: 'paper',
    limits: LIMITS,
  },
  { symbol: SYMBOL, timeframe: TF, since: start, until: end },
)

// ── 4) 结算（含重试）：④ 成功率 ──────────────────────────────────────────────
const { DecisionJournal } = await import('../lib/exec/journal.js')
const scheduler = new SettlementScheduler({
  journal: new DecisionJournal(db),
  bars: archive,
  clock,
  timeframe: TF,
  horizonMs: HORIZON,
  benchmarkSymbol: SYMBOL,
  slippageBps: 5,
})
// 重试：最多 5 轮，每轮都让时钟前进（模拟"行情回补完成后自然能结算"）
const passes = []
let dueTotal = 0
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const runAt = end + attempt * HORIZON
  const result = await scheduler.runOnce(runAt, 500)
  if (attempt === 1) dueTotal = result.scanned
  passes.push({ attempt, ...result })
  if (result.scanned === 0) break
}
const settledFinal = db.prepare('SELECT COUNT(*) AS n FROM outcomes').get().n
const pendingFinal = db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE reflection_due_at IS NOT NULL AND outcome_id IS NULL').get().n
const settlementRate = dueTotal === 0 ? 1 : settledFinal / dueTotal

const sql = {
  duplicate_client_order_ids: db
    .prepare(
      `SELECT COUNT(*) AS n FROM (SELECT client_order_id FROM order_intents GROUP BY client_order_id HAVING COUNT(*) > 1)`,
    )
    .get().n,
  decisions_with_multiple_outcomes: db
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT decision_id FROM outcomes GROUP BY decision_id HAVING COUNT(*) > 1)`)
    .get().n,
  decisions_with_multiple_lessons: db
    .prepare(`SELECT COUNT(*) AS n FROM (SELECT decision_id FROM lessons GROUP BY decision_id HAVING COUNT(*) > 1)`)
    .get().n,
  outcomes_total: settledFinal,
  pending_total: pendingFinal,
}

// ── 5) ② 可归因：回放日志里的 UNCOVERED 与计数器一致 ─────────────────────────
const uncoveredLines = executed.log.filter((line) => line.startsWith('UNCOVERED:')).length
const attributable = executed.log.every(
  (line) =>
    line.startsWith('matched:') ||
    line.startsWith('UNCOVERED:') ||
    line.startsWith('rule:') ||
    line.startsWith('denied:') ||
    line.startsWith('judgment:'),
)

// ── 6) ③ 每日指标（取决策最多的一天）────────────────────────────────────────
const busiest = db
  .prepare(
    `SELECT date(decided_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
     FROM decisions GROUP BY day ORDER BY n DESC LIMIT 1`,
  )
  .get()
const metrics = new MetricsStore(db)
const daily =
  busiest === undefined
    ? null
    : metrics.compute({ day: busiest.day, symbols: [SYMBOL], asOf: Date.parse(`${busiest.day}T23:00:00.000Z`) })

const checks = {
  // ① 计划卡 schema + 编译
  plan_card_valid: validation.ok === true,
  plan_when_compiles: compile.ok === true,
  // ② 求值错误一律可归因（不静默）
  replay_log_attributable: attributable,
  uncovered_is_reported: executed.counters.uncovered === uncoveredLines,
  // ③ 三项指标：覆盖率有意义、频次有真实数据、成本块自洽
  daily_coverage_metric: daily !== null && daily.coverage.symbols.length > 0 && daily.coverage.ratio > 0,
  daily_frequency_metric: daily !== null && Object.keys(daily.frequency.byPurpose).length > 0,
  // 机械回放**不调模型** ⇒ 没有 budget_ledger 行。这里验的是"账本自洽"而不是"必须有钱花"，
  // 否则这条检查要么恒假、要么只能靠编造一次模型调用来"通过"。
  daily_cost_consistent:
    daily !== null &&
    daily.cost.totalUsd ===
      daily.cost.windows.filter((w) => w.scope === 'global').reduce((sum, w) => sum + w.usd, 0) &&
    typeof daily.cost.costKnown === 'boolean',
  // ④ 结算成功率 ≥99% + 每条决策至多一条反思
  settlement_rate_ge_99: settlementRate >= 0.99,
  one_outcome_per_decision: sql.decisions_with_multiple_outcomes === 0,
  one_lesson_per_decision: sql.decisions_with_multiple_lessons === 0,
  no_duplicate_client_order_ids: sql.duplicate_client_order_ids === 0,
}

const report = {
  ranAt: new Date().toISOString(),
  days: DAYS,
  symbol: SYMBOL,
  timeframe: TF,
  backfill: { pages: fetched.pages, fetched: fetched.fetched, written: fetched.written, bars: bars.length },
  replay: executed.counters,
  settlement: {
    dueTotal,
    settled: settledFinal,
    pending: pendingFinal,
    rate: settlementRate,
    passes: passes.map((pass) => ({
      attempt: pass.attempt,
      scanned: pass.scanned,
      settled: pass.settled,
      skipped: pass.skipped,
      deferred: pass.deferred,
      deferredIds: pass.deferredIds,
    })),
  },
  sql,
  daily,
  checks,
  allPassed: Object.values(checks).every(Boolean),
  note:
    '①–④ 用真实行情跑可运行判定；⑤（kill -9 resume）由 scripts/crash-recovery-check.mjs 单独验证。' +
    'P1.5 通道有效性闸门见 scripts/ab-gate.mjs。',
}

console.log(JSON.stringify(report, null, 2))
if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
db.close()
process.exit(report.allPassed ? 0 : 1)
