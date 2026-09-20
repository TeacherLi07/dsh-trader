#!/usr/bin/env node
/**
 * 回放确定性验收（plan §10 P0 验收 ②③）—— **用真实行情**跑两遍并对比。
 *
 * 不进入 CI（需要网络与代理）。用法：
 *   pnpm build && node scripts/replay-check.mjs [venue] [symbol] [timeframe] [days]
 *   例：node scripts/replay-check.mjs htx BTC/USDT 1h 30
 *
 * 判据：
 *   ② 决策 / 订单意图 / 成交 / 触发 的 id 集合两遍完全相等，且 client_order_id 重复数 = 0
 *   ③ 每次命中都能归因（matched: / UNCOVERED: / rule: / denied:）
 */

import { mkdtempSync } from 'node:fs'
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
import { buildRules } from '../lib/trigger/engine.js'
import { TriggerQueue } from '../lib/trigger/queue.js'

const [venue = 'htx', symbol = 'BTC/USDT', timeframe = '1h', days = '30'] = process.argv.slice(2)

/**
 * 注意 `riskPct` 与单笔名义上限的关系：
 *   notional ≈ equity × riskPct × (price / stopDistance)
 * BTC 的 2×ATR 止损距离只有价格的 ~0.5%，因此 riskPct=1% 会推出 ~2× 权益的名义金额，
 * 必然撞上单笔上限。这里用 0.2% 让验收回放真的成交（而不是"全部被硬闸拒绝"）。
 */
const RISK_PCT = 0.002
const LIMITS = {
  ...EXAMPLE_LIMITS,
  perOrderCapUsd: 5_000,
  maxExposureUsd: 50_000,
  maxOpenOrders: 50,
}

function planCard(start, end) {
  const base = {
    planId: `pc-live-${timeframe}`,
    symbol,
    createdAt: start,
    windowEndsAt: end,
    thesis: 'live replay determinism check',
    confidence: 0.5,
    keyLevels: [],
    invalidation: [
      {
        id: 'inv-break',
        tf: timeframe,
        when: 'position.qty > 0 and bar.close < ema20 * 0.99',
        then: { action: 'close' },
      },
    ],
    commitments: [
      {
        id: 'c-open',
        seq: 1,
        tf: timeframe,
        when: 'position.qty == 0 and rsi14 < 45',
        then: { action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskFraction: 1 },
      },
      {
        id: 'c-take',
        seq: 2,
        tf: timeframe,
        when: 'position.qty > 0 and rsi14 > 60',
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

// ── 1) 真实回补 ──────────────────────────────────────────────────────────────
const Exchange = ccxt[venue]
const exchange = new Exchange({ enableRateLimit: true })
applyProxyAwareFetch(exchange)
const source = createCcxtSource(exchange)

const fetchDir = mkdtempSync(join(tmpdir(), 'dsh-trader-fetch-'))
const fetchDb = new Database(join(fetchDir, 'fetch.db'))
migrate(fetchDb)
const fetchArchive = new BarArchive(fetchDb)
const until = Date.now()
const since = until - Number(days) * 86_400_000
const fetched = await backfill(
  { source, archive: fetchArchive, clock: systemClock() },
  { symbol, timeframe, since, until, pageLimit: 500 },
)
const bars = fetchArchive.closedBars(symbol, timeframe)
const start = bars[0]?.openTime
const end = (bars[bars.length - 1]?.openTime ?? start) + timeframeMs(timeframe)
fetchDb.close()
await source.close?.()

// ── 2) 同一批 bar 回放两遍（各自全新的库）────────────────────────────────────
async function runOnce() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trader-replay-'))
  const db = new Database(join(dir, 'replay.db'))
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
    },
    { symbol, timeframe, since: start, until: end },
  )
  db.close()
  return result
}

const first = await runOnce()
const second = await runOnce()

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const checks = {
  decisions_equal: same(first.decisionIds, second.decisionIds),
  intents_equal: same(first.intentIds, second.intentIds),
  client_order_ids_equal: same(first.clientOrderIds, second.clientOrderIds),
  fills_equal: same(first.fillIds, second.fillIds),
  triggers_equal: same(first.triggerKeys, second.triggerKeys),
  no_duplicate_client_order_ids:
    first.duplicateClientOrderIds === 0 && second.duplicateClientOrderIds === 0,
  log_attributable: first.log.every(
    (line) =>
      line.startsWith('matched:') ||
      line.startsWith('UNCOVERED:') ||
      line.startsWith('rule:') ||
      line.startsWith('denied:'),
  ),
  realized_pnl_equal: first.realizedPnl === second.realizedPnl,
}

console.log(
  JSON.stringify(
    {
      venue,
      symbol,
      timeframe,
      days: Number(days),
      backfill: {
        pages: fetched.pages,
        fetched: fetched.fetched,
        written: fetched.written,
        stoppedBy: fetched.stoppedBy,
      },
      replay: {
        bars: first.counters.bars,
        matched: first.counters.matched,
        uncovered: first.counters.uncovered,
        denied: first.counters.denied,
        executed: first.counters.executed,
        decisions: first.decisionIds.length,
        intents: first.intentIds.length,
        fills: first.fillIds.length,
        triggers: first.triggerKeys.length,
        realizedPnl: first.realizedPnl,
      },
      sampleLog: first.log.slice(0, 6),
      checks,
      allPassed: Object.values(checks).every(Boolean),
    },
    null,
    2,
  ),
)

process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
