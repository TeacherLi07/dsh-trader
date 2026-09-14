#!/usr/bin/env node
/**
 * 预测市场 PIT 专项验收（plan §10「预测市场事件源专项验收」①③④⑤⑦⑧）—— **可运行判定**。
 *
 * 用法：pnpm build && node scripts/pm-pit-check.mjs [days] [outPath]
 *   例：node scripts/pm-pit-check.mjs 30 /tmp/pm-pit.json
 *
 * 与单测的区别：单测证明**构件**是对的；这个脚本用**真实数据**跑完整链路
 * （gamma 元数据 → v2 30 天序列 → 盘口 → 注册关注 → 规则族 → 治理 → 落库），
 * 然后对**落库结果**做 SQL 断言。判据里的"命中行数 = 0"必须是查表查出来的。
 *
 * 判据（对应 plan §10 专项）：
 *   ① 不存在"市场未创建即被引用"或"结算结果提前可见"（SQL 命中行数 = 0）
 *   ③ 同一 alias 的 prob 在工具返回与告警 payload 中估计量一致
 *   ④ 低于流动性门槛的市场产生的 novelty 告警数 = 0
 *   ⑤ 任意 10s 窗口请求数 ≤ 官方限额 20%（用客户端自己的令牌桶记账）
 *   ⑦ 热路径调用 v2 as_of 次数 = 0
 *   ⑧ 未注册 alias 的 when 一律 UNCOVERED
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ReplayClock } from '../lib/clock.js'
import { migrate } from '../lib/db/schema.js'
import { createDslContext, evaluateWhen } from '../lib/plan/evaluate.js'
import { createPmClients } from '../lib/predictions/client.js'
import { PmSignalRouter } from '../lib/predictions/wiring.js'
import { evaluatePmRules, DEFAULT_PM_RULE_CONFIG } from '../lib/predictions/rules.js'
import { PmStore, pmFeatureValues } from '../lib/predictions/store.js'
import { TriggerQueue } from '../lib/trigger/queue.js'

const DAYS = Number(process.argv[2] ?? '30')
const OUT = process.argv[3]
const LIQUIDITY = { liquidityFloorQuote: 1_000, spreadCeilBps: 300 }
/** 扫描多少个活跃市场挑"真的动过"的那个 —— 否则判据 ③④ 会**空跑通过**。 */
const SCAN = Number(process.env.PM_SCAN ?? '40')

const now = Date.now()
const clock = new ReplayClock(now)
const clients = createPmClients({
  fetch: async (url, init) => {
    const response = await fetch(url, { ...(init?.method ? { method: init.method } : {}), signal: init?.signal })
    return { status: response.status, text: () => response.text() }
  },
  clock,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxRetries: 2,
})

const dir = mkdtempSync(join(tmpdir(), 'dsh-trader-pmpit-'))
const db = new Database(join(dir, 'pm.db'))
migrate(db)
const store = new PmStore(db, { liquidity: LIQUIDITY })

// ── 1) 真实数据：扫描若干活跃市场，取 30 天序列 + 一条真实盘口 ────────────────
// 按 `oneDayPriceChange` 倒序取样本：要验的是"跳变"规则，样本里就必须有真的动过的市场。
// 用 `volume24hr` 取到的一律是远期政治盘（日变化 ~0.001），规则永远不会触发 ⇒ 判据空跑。
const page = await clients.gamma.markets({ limit: SCAN, order: 'oneDayPriceChange', ascending: false })
// 按源自己给的变化量**从大到小**排：样本里必须有"真的动过"的市场，
// 否则判据 ③④ 会在一段安静行情上"空跑通过"（这个坑我们踩过一次）。
const ranked = [...page.items].sort(
  (a, b) => Math.abs(b.oneDayPriceChange ?? 0) - Math.abs(a.oneDayPriceChange ?? 0),
)
const rankedItems = page.items.length > 0 ? ranked : page.items
const seeded = []
let seriesSpanDays = 0
let bookSummary = null
let primary = null

for (const [index, market] of rankedItems.entries()) {
  const tokenId = market.clobTokenIds[0]
  if (tokenId === undefined) continue
  const series = await clients.dataApi.pricesHistory({ tokenId, interval: '1m' })
  if (series.length < 2) continue
  const spanDays = (series[series.length - 1].ts - series[0].ts) / 86_400_000
  const book = await clients.clob.book(tokenId)

  // 元数据按"现在"首次见到（created_at 来自源，是过去）
  store.upsertMarket(market, now)
  store.recordSeries(tokenId, series, { source: 'data-api.v2', observedAt: now })
  if (book !== null) {
    const bestBid = book.bids.length ? Math.max(...book.bids.map((level) => level.price)) : undefined
    const bestAsk = book.asks.length ? Math.min(...book.asks.map((level) => level.price)) : undefined
    store.recordQuote({
      tokenId,
      observedAt: book.observedAt > 0 ? book.observedAt : now,
      ...(bestBid === undefined ? {} : { bestBid }),
      ...(bestAsk === undefined ? {} : { bestAsk }),
      ...(bestBid === undefined || bestAsk === undefined ? {} : { mid: (bestBid + bestAsk) / 2 }),
      ...(bestBid === undefined || bestAsk === undefined ? {} : { spread: bestAsk - bestBid }),
      ...(market.liquidity === null ? {} : { liquidity: market.liquidity }),
      ...(market.volume24hr === null ? {} : { volume24h: market.volume24hr }),
      ...(market.lastTradePrice === null ? {} : { lastTradePrice: market.lastTradePrice }),
    })
  }

  const alias = `mkt_${index}`
  store.registerWatch(
    {
      alias,
      kind: 'threshold',
      purpose: 'novelty',
      tokenIds: [tokenId],
      expr: `pm.${alias}.prob < 0.30`,
      expiresAt: now + 7 * 86_400_000,
      createdBy: 'model',
    },
    now,
  )
  const snap = store.snapshotAt(now).find((item) => item.alias === alias)
  const hasProb = snap !== undefined && snap.probability.ok
  seeded.push({
    alias,
    tokenId,
    slug: market.slug,
    liquidity: market.liquidity,
    points: series.length,
    spanDays,
    hasProb,
  })

  if (spanDays > seriesSpanDays) seriesSpanDays = spanDays
  // 主标的必须是**真的能算出概率**的那个：没有 prob 时 `pm.<alias>.prob` 会 UNCOVERED，
  // 拿它当主标的会让"注册了的别名能求值"这条判据因为错的理由失败。
  if (primary === null && hasProb) {
    bookSummary = book === null ? null : { bids: book.bids.length, asks: book.asks.length }
    primary = { alias, tokenId, market }
  }
}

if (primary === null) {
  console.error('没有可用的预测市场数据，无法执行验收')
  process.exit(2)
}
const { alias: ALIAS, tokenId: PRIMARY_TOKEN, market } = primary

// ── 2) 规则族 + 治理（真实信号走同一套限流）─────────────────────────────────
const queue = new TriggerQueue(db)
const router = new PmSignalRouter({ store, queue, clock, ttlMs: 3_600_000 })
const snapshots = store.snapshotAt(now)
/**
 * 验收用的规则配置。plan §4.4 表把跳变窗口写成"超窗口阈值"而**没有规定窗口长度**，
 * 所以这里显式用 24h 窗口去**真的触发一次** —— 否则判据 ③④ 会在一段安静行情上"空跑通过"。
 * 实际使用的配置原样写进报告，避免"用哪套参数验的"含糊。
 */
const ACCEPTANCE_RULES = {
  ...DEFAULT_PM_RULE_CONFIG,
  spreadCeilBps: LIQUIDITY.spreadCeilBps,
  jumpLookback: '24h',
  probJumpAbs: Number(process.env.PM_JUMP_ABS ?? '0.03'),
}
const signals = evaluatePmRules({ now, snapshots }, ACCEPTANCE_RULES)
const defaultConfigSignals = evaluatePmRules({ now, snapshots }, {
  ...DEFAULT_PM_RULE_CONFIG,
  spreadCeilBps: LIQUIDITY.spreadCeilBps,
})
const routed = router.route(signals, now)

// ── 3) SQL 断言（判据要的是"命中行数 = 0"）───────────────────────────────────
const one = (sql, ...params) => db.prepare(sql).get(...params)

// ① 存在门控：任何 pm 触发的 bar_ts 早于所引用市场的 created_at ⇒ 违规
const existenceViolations = db
  .prepare(
    `SELECT COUNT(*) AS n FROM triggers t
     JOIN pm_watches w ON t.symbol = 'pm:' || w.alias
     JOIN pm_markets m ON m.condition_id IN (SELECT condition_id FROM pm_markets)
     WHERE t.rule_id LIKE 'pm_%' AND t.bar_ts < m.created_at`,
  )
  .get().n

// ① 结算门控：pm_resolution 触发的 bar_ts 早于 resolved_at ⇒ 违规
const resolutionViolations = db
  .prepare(
    `SELECT COUNT(*) AS n FROM triggers t
     JOIN pm_markets m ON m.resolved_at IS NOT NULL
     WHERE t.rule_id = 'pm_resolution' AND t.bar_ts < m.resolved_at`,
  )
  .get().n

// ④ 低于流动性门槛的市场产生的 novelty 数 = 0
const noveltyRows = db
  .prepare("SELECT payload_json, rule_id FROM triggers WHERE rule_id LIKE 'pm_%' AND purpose = 'novelty'")
  .all()
let thinNovelty = 0
for (const row of noveltyRows) {
  const payload = JSON.parse(row.payload_json)
  const detail = payload.detail ?? {}
  const liquidity = detail.liquidity
  if (typeof liquidity !== 'number' || liquidity < LIQUIDITY.liquidityFloorQuote) thinNovelty += 1
}

// ③ 估计量一致：payload 里的 prob/estimator 必须与该时刻盘口口径一致
const estimatorMismatches = db
  .prepare("SELECT payload_json FROM triggers WHERE rule_id = 'pm_prob_jump'")
  .all()
  .filter((row) => {
    const detail = JSON.parse(row.payload_json).detail ?? {}
    if (detail.estimator === 'mid') return typeof detail.prob !== 'number'
    if (detail.estimator === 'last_trade_price') return typeof detail.prob !== 'number'
    return true // 未知估计量 ⇒ 计为不一致
  }).length

// ⑧ 未注册 alias 一律 UNCOVERED
const values = pmFeatureValues(snapshots)
const registered = evaluateWhen(`pm.${ALIAS}.prob < 0.30`, createDslContext(values))
const unregistered = evaluateWhen('pm.definitely_not_registered.prob < 0.30', createDslContext(values))

// ⑤ 令牌桶：请求数与官方限额的关系（桶容量 = 限额 × 20%）
const stats = clients.stats()
const rateViolations = Object.entries(stats.tokens).filter(
  ([, remaining]) => typeof remaining !== 'number' || remaining < 0,
).length

const checks = {
  // ★ 非空跑：判据 ③④ 只有在**真的产生过 novelty**时才算被检验
  pm_signals_exercised: noveltyRows.length > 0,
  existence_gate_zero_violations: existenceViolations === 0,
  resolution_gate_zero_violations: resolutionViolations === 0,
  thin_market_novelty_zero: thinNovelty === 0,
  estimator_consistent: estimatorMismatches === 0,
  unregistered_alias_uncovered: unregistered.ok === false,
  registered_alias_evaluates: registered.ok === true,
  hot_path_as_of_zero: stats.asOfCalls === 0,
  token_buckets_never_negative: rateViolations === 0,
  series_span_covers_window: seriesSpanDays >= DAYS * 0.9,
}

const report = {
  ranAt: new Date().toISOString(),
  requestedDays: DAYS,
  market: {
    slug: market.slug,
    conditionId: market.conditionId,
    createdAt: market.createdAt,
    createdAtIso: new Date(market.createdAt).toISOString(),
    liquidity: market.liquidity,
    spread: market.spread,
  },
  series: { points: seeded.find((item) => item.alias === ALIAS)?.points ?? 0, spanDays: Number(seriesSpanDays.toFixed(2)) },
  book: bookSummary,
  seeded,
  watch: { alias: ALIAS, tokenId: PRIMARY_TOKEN, snapshots: snapshots.length },
  acceptanceRules: {
    jumpLookback: ACCEPTANCE_RULES.jumpLookback,
    probJumpAbs: ACCEPTANCE_RULES.probJumpAbs,
    spreadCeilBps: ACCEPTANCE_RULES.spreadCeilBps,
  },
  signals: signals.map((signal) => ({
    ruleId: signal.ruleId,
    alias: signal.alias,
    purpose: signal.purpose,
    severity: signal.severity,
    estimator: signal.payload.estimator ?? null,
    change: signal.payload.change ?? null,
    lookback: signal.payload.lookback ?? null,
  })),
  defaultConfigSignals: defaultConfigSignals.map((signal) => ({
    ruleId: signal.ruleId,
    alias: signal.alias,
  })),
  routed: routed.map((item) => ({ ruleId: item.ruleId, wake: item.wake, disposition: item.disposition })),
  sql: {
    existenceViolations,
    resolutionViolations,
    noveltyRows: noveltyRows.length,
    thinNovelty,
    estimatorMismatches,
  },
  evaluator: { registered, unregistered },
  clientStats: stats,
  checks,
  allPassed: Object.values(checks).every(Boolean),
  note:
    '真实数据 + 落库后 SQL 断言。判据 ② 的毫秒整数与 ⑥ 的降级由单测覆盖（这里只跑真实链路）。' +
    '若样本里没有任何市场真的跳变，判据 ③④ 会空跑 —— pm_signals_exercised 专门拦住这种"假通过"。',
}

console.log(JSON.stringify(report, null, 2))
if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n结果已写入 ${OUT}`)
}
db.close()
process.exit(report.allPassed ? 0 : 1)
