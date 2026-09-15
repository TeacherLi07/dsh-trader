#!/usr/bin/env node
/**
 * P1.5 通道有效性闸门 —— **可运行判定**（plan §10 / T1.7）。
 *
 * 用法：pnpm build && node scripts/ab-gate.mjs [venue] [symbol] [timeframe] [days] [outPath]
 *   例：node scripts/ab-gate.mjs htx BTC/USDT 1h 90 /tmp/ab-gate.md
 *
 * 做什么：
 *   1. 回补真实行情（注入系统时钟，只在取数阶段）；
 *   2. 同一批 bar、同一套规则/风控/成本模型，跑两臂：
 *        A = 纯机械执行（不注入判断通道）
 *        B = 注入判断通道（`standInJudge`，见 src/supervisor/ab.ts 的说明）
 *   3. 用**固定种子**的配对 bootstrap 算净 PnL 差值的 95% CI，套 §10 的保留条件；
 *   4. 输出 Markdown 报告 + JSON，并给出明确判定。
 *
 * ⚠️ 诚实声明：B 臂用的是**确定性替身**而不是 LLM 判断通道（需要模型凭据，plan §12 第 20 项）。
 *    因此本脚本产出的是**闸门本身的可运行判定**；换成真 LLM 通道就能得到最终判定。
 *    如果样本量不够，判定会是"结论无效"而不是"保留" —— 没有证据就不升级信任。
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
import { computeContentHash } from '../lib/plan/schema.js'
import { PlanStore } from '../lib/plan/store.js'
import {
  DEFAULT_GATE_THRESHOLDS,
  computeArmMetrics,
  evaluateChannelGate,
  pairDifferences,
  pairedBootstrapCi,
  renderGateReport,
  standInJudge,
} from '../lib/supervisor/ab.js'
import { buildRules } from '../lib/trigger/engine.js'
import { TriggerQueue } from '../lib/trigger/queue.js'

const [venue = 'htx', symbol = 'BTC/USDT', timeframe = '1h', days = '90', outPath] =
  process.argv.slice(2)

const RISK_PCT = 0.002
const LIMITS = { ...EXAMPLE_LIMITS, perOrderCapUsd: 5_000, maxExposureUsd: 50_000, maxOpenOrders: 50 }
const BARS_PER_DAY = 24
const THRESHOLDS = { ...DEFAULT_GATE_THRESHOLDS, minBars: 90 * BARS_PER_DAY }

function planCard(start, end) {
  const base = {
    planId: `pc-ab-${timeframe}`,
    symbol,
    createdAt: start,
    windowEndsAt: end,
    thesis: 'P1.5 channel-validity A/B',
    confidence: 0.5,
    keyLevels: [],
    invalidation: [
      { id: 'inv-break', tf: timeframe, when: 'position.qty > 0 and bar.close < ema20 * 0.99', then: { action: 'close' } },
    ],
    commitments: [
      {
        id: 'c-open',
        seq: 1,
        tf: timeframe,
        when: 'position.qty == 0 and rsi14 < 45',
        then: { action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskPct: RISK_PCT },
      },
      { id: 'c-take', seq: 2, tf: timeframe, when: 'position.qty > 0 and rsi14 > 60', then: { action: 'reduce', fraction: 0.5 } },
    ],
    forbidden: [],
    noTrade: false,
    author: 'model',
    authority: 'model',
  }
  return { ...base, contentHash: computeContentHash(base) }
}

// ── 1) 真实回补 ──────────────────────────────────────────────────────────────
const Exchange = ccxt[venue]
const exchange = new Exchange({ enableRateLimit: true })
applyProxyAwareFetch(exchange)
const source = createCcxtSource(exchange)

const fetchDir = mkdtempSync(join(tmpdir(), 'dsh-trader-abfetch-'))
const fetchDb = new Database(join(fetchDir, 'fetch.db'))
migrate(fetchDb)
const fetchArchive = new BarArchive(fetchDb)
const until = Date.now()
const since = until - Number(days) * 86_400_000
const fetched = await backfill(
  { source, archive: fetchArchive, clock: systemClock() },
  { symbol, timeframe, since, until, pageLimit: 500 },
)
// ⚠️ 不传 limit 会被 BarArchive 的默认值截到 1000 根 —— 90 天 1h 是 2160 根
const bars = fetchArchive.closedBars(symbol, timeframe, { limit: 100_000 })
const start = bars[0]?.openTime
const end = (bars[bars.length - 1]?.openTime ?? start) + timeframeMs(timeframe)
fetchDb.close()
await source.close?.()

// ── 2) 两臂：唯一差异是判断通道 ──────────────────────────────────────────────
async function runArm(judgment) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trader-ab-'))
  const db = new Database(join(dir, 'arm.db'))
  migrate(db)
  const clock = new ReplayClock(start)
  const archive = new BarArchive(db)
  archive.upsertClosed(bars, { source: venue, fetchedAt: start })
  const plans = new PlanStore(db)
  plans.save(planCard(start, end), start)
  const queue = new TriggerQueue(db)
  const broker = new PaperBroker({
    clock,
    book: { price: () => undefined },
    initialEquityQuote: 10_000,
    slippageBps: 5,
    feeBps: 5,
  })
  const result = await replay(
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
      ...(judgment === undefined ? {} : { judgment }),
    },
    { symbol, timeframe, since: start, until: end },
  )
  db.close()
  return result
}

const armA = await runArm(undefined)
const armB = await runArm(standInJudge())

const metricsA = computeArmMetrics({
  tradePnl: armA.tradePnl,
  executionDeviations: armA.counters.denied,
  bars: armA.counters.bars,
  triggers: armA.counters.matched + armA.counters.uncovered,
})
const metricsB = computeArmMetrics({
  tradePnl: armB.tradePnl,
  executionDeviations: armB.counters.denied,
  judgment: armB.judgment,
  bars: armB.counters.bars,
  triggers: armB.counters.matched + armB.counters.uncovered,
})

const ci = pairedBootstrapCi(pairDifferences(armA.tradePnl, armB.tradePnl), {
  iterations: THRESHOLDS.iterations,
  confidence: THRESHOLDS.confidence,
  seed: THRESHOLDS.seed,
})
const verdict = evaluateChannelGate(metricsA, metricsB, ci, THRESHOLDS)
const report = renderGateReport(verdict, { judge: 'stand-in（确定性替身，非 LLM；见 §12 第 20 项）' })

const payload = {
  venue,
  symbol,
  timeframe,
  days: Number(days),
  backfill: { pages: fetched.pages, fetched: fetched.fetched, written: fetched.written, stoppedBy: fetched.stoppedBy },
  thresholds: THRESHOLDS,
  armA: {
    counters: armA.counters,
    judgment: armA.judgment,
    realizedPnl: armA.realizedPnl,
    tradePnlCount: armA.tradePnl.length,
    metrics: metricsA,
  },
  armB: {
    counters: armB.counters,
    judgment: armB.judgment,
    realizedPnl: armB.realizedPnl,
    tradePnlCount: armB.tradePnl.length,
    metrics: metricsB,
  },
  ci,
  verdict,
  judge: 'stand-in',
  note: 'B 臂为确定性替身；LLM 判断通道需要模型凭据（plan §12 第 20 项）。样本不足时判定为"结论无效"。',
}

process.stdout.write(`${report}\n`)
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)

if (outPath !== undefined) {
  writeFileSync(outPath, report, 'utf8')
  writeFileSync(`${outPath}.json`, JSON.stringify(payload, null, 2), 'utf8')
  process.stdout.write(`\n报告已写入 ${outPath} 与 ${outPath}.json\n`)
}
