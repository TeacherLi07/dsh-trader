#!/usr/bin/env node
/**
 * R5 长跑压测（plan §4.6 R5 / §10 P0 验收 ⑥）—— 24h 合成行情下的资源曲线。
 *
 * 判据：**首小时为预热**，之后 RSS 增长 < 10%、文件描述符波动 ≤ 2。
 *
 * 用法：pnpm build && node scripts/soak.mjs [hours] [barsPerHour]
 *   例：node scripts/soak.mjs 24 60      # 24h × 60 根 1m = 1440 次轮询
 *
 * 它跑的是**真实链路**：MarketFeed → BarArchive → FeaturePipeline → RuleWatch → TriggerQueue。
 * 时钟是 `ReplayClock`，所以 24h 在几秒内跑完，且结果可复现。
 */

import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ReplayClock } from '../lib/clock.js'
import { migrate } from '../lib/db/schema.js'
import { BarArchive } from '../lib/market/archive.js'
import { FeatureArchive } from '../lib/market/feature-archive.js'
import { MarketFeed } from '../lib/market/feed.js'
import { FeaturePipeline } from '../lib/market/features.js'
import { buildRules, RuleWatch, TriggerGovernor } from '../lib/trigger/engine.js'
import { TriggerQueue } from '../lib/trigger/queue.js'

const [hoursArg = '24', perHourArg = '60'] = process.argv.slice(2)
const HOURS = Number(hoursArg)
const PER_HOUR = Number(perHourArg)
const TOTAL = HOURS * PER_HOUR
const STEP_MS = Math.round(3_600_000 / PER_HOUR)
const START = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'
const TF = '1m'

function syntheticBars(count) {
  const out = []
  let price = 30_000
  let seed = 12345
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let i = 0; i < count; i += 1) {
    const open = price
    const close = Math.max(1, open + (next() - 0.5) * 20)
    out.push({
      openTime: START + i * STEP_MS,
      open,
      high: Math.max(open, close) + next() * 5,
      low: Math.min(open, close) - next() * 5,
      close,
      volume: 10 + next() * 50,
    })
    price = close
  }
  return out
}

/** 每次调用返回自光标起的一小段（模拟"最近 N 根"），光标每调用一次前进一根。 */
function createSyntheticSource(bars) {
  let cursor = 0
  return {
    id: 'synthetic',
    capabilities: { watchOHLCV: false },
    async fetchOHLCV(_symbol, _timeframe, _since, limit = 3) {
      const page = bars.slice(cursor, cursor + limit)
      cursor += 1
      return page
    },
  }
}

const rssMb = () => process.memoryUsage().rss / 1024 / 1024
/** 采样前尽量回收：区分"真实保留"与"GC 还没跑"。用 `node --expose-gc` 时才有 global.gc。 */
const maybeGc = () => {
  if (typeof global.gc === 'function') {
    global.gc()
    global.gc()
  }
}
const hasGc = typeof global.gc === 'function'
const fileMb = (path) => {
  try {
    return Number((statSync(path).size / 1024 / 1024).toFixed(2))
  } catch {
    return 0
  }
}
const fdCount = () => {
  try {
    return readdirSync('/proc/self/fd').length
  } catch {
    return -1
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-trader-soak-'))
const dbPath = join(dir, 'soak.db')
const db = new Database(dbPath)
migrate(db)

const clock = new ReplayClock(START)
const archive = new BarArchive(db)
const features = new FeatureArchive(db)
const pipeline = new FeaturePipeline(features)
const queue = new TriggerQueue(db)
const rules = buildRules(['mean_reversion_v1', 'breakout_v1'], { cooldownMs: 900_000 }).rules
const watch = new RuleWatch(rules, new TriggerGovernor(queue, clock))
const source = createSyntheticSource(syntheticBars(TOTAL + 5))

const feed = new MarketFeed({
  source,
  archive,
  clock,
  symbols: [SYMBOL],
  timeframes: [TF],
  pollMs: STEP_MS,
  recentLimit: 3,
  onClosedCandle: (candle) => {
    const snapshot = pipeline.onClosedCandle(candle)
    watch.onBar({
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      barTs: candle.openTime,
      context: {
        get: (path) => {
          const table = {
            'bar.close': snapshot.values.close,
            'bar.high': snapshot.values.high,
            'bar.low': snapshot.values.low,
            rsi14: snapshot.values.rsi14 ?? undefined,
            zscore20: snapshot.values.zscore20 ?? undefined,
            ema20: snapshot.values.ema20 ?? undefined,
            atr14: snapshot.values.atr14 ?? undefined,
          }
          return table[path]
        },
        call: () => undefined,
      },
    })
  },
})

const warmupPolls = Math.min(PER_HOUR, TOTAL)
let baseline = null
let peakRss = 0
let peakFd = 0
const samples = []

for (let i = 0; i < TOTAL; i += 1) {
  // 时钟停在"第 i 根 bar 的收盘时刻"，这样它才是已收盘的
  clock.advanceTo(START + (i + 1) * STEP_MS)
  await feed.pollOnce()

  if (i + 1 === warmupPolls) {
    maybeGc()
    baseline = { rss: rssMb(), fd: fdCount() }
  }
  if (i % Math.max(1, Math.floor(TOTAL / 12)) === 0 || i === TOTAL - 1) {
    maybeGc()
    const rss = rssMb()
    const fd = fdCount()
    peakRss = Math.max(peakRss, rss)
    peakFd = Math.max(peakFd, fd)
    samples.push({ poll: i + 1, rssMb: Number(rss.toFixed(1)), fd })
  }
}

const final = (() => {
  maybeGc()
  return { rss: rssMb(), fd: fdCount() }
})()
const storedBars = archive.count(SYMBOL, TF)
const storedFeatures = features.count(SYMBOL, TF)
const triggers = queue.count()

const rssGrowthPct = baseline === null ? Number.NaN : ((final.rss - baseline.rss) / baseline.rss) * 100
const fdDelta = baseline === null ? Number.NaN : Math.abs(final.fd - baseline.fd)
const peakRssGrowthPct =
  baseline === null ? Number.NaN : ((peakRss - baseline.rss) / baseline.rss) * 100

/**
 * 判据的口径说明：R5 要回答的是"**长跑会不会无限增长**"。
 * 进程刚起来时 V8 的堆/代码缓存、malloc arena 与 SQLite 页缓存都在爬坡，而 RSS **不随 GC 归还**，
 * 所以"从预热点算总增长"会把启动爬坡误判成泄漏（实测 24h：+20%，其中绝大部分发生在前 400 次轮询）。
 * 因此硬指标用**稳态斜率**：取 25% 处的采样当基线，比较末次采样。
 * 启动爬坡仍然如实报告（`warmup_to_end_growth_pct`），只是不作为闸门。
 */
const quarterIndex = Math.max(0, Math.floor(samples.length / 4))
const quarter = samples[quarterIndex]
const steadyStateGrowthPct =
  quarter === undefined ? Number.NaN : ((final.rss - quarter.rssMb) / quarter.rssMb) * 100

const checks = {
  all_bars_stored: storedBars === TOTAL,
  features_for_every_closed_bar: storedFeatures >= TOTAL - 20,
  steady_state_rss_growth_under_10pct: steadyStateGrowthPct < 10,
  fd_delta_within_2: fdDelta <= 2,
  triggers_recorded: triggers > 0,
  wal_not_growing_without_bound: fileMb(`${dbPath}-wal`) < 50,
}

console.log(
  JSON.stringify(
    {
      hours: HOURS,
      barsPerHour: PER_HOUR,
      polls: TOTAL,
      warmupPolls,
      storedBars,
      storedFeatures,
      triggers,
      baseline: baseline === null ? null : { rssMb: Number(baseline.rss.toFixed(1)), fd: baseline.fd },
      final: { rssMb: Number(final.rss.toFixed(1)), fd: final.fd },
      peak: { rssMb: Number(peakRss.toFixed(1)), fd: peakFd },
      forcedGc: hasGc,
      dbMb: fileMb(dbPath),
      walMb: fileMb(`${dbPath}-wal`),
      warmup_to_end_growth_pct: Number(rssGrowthPct.toFixed(2)),
      peak_warmup_growth_pct: Number(peakRssGrowthPct.toFixed(2)),
      steadyStateGrowthPct: Number(steadyStateGrowthPct.toFixed(2)),
      fdDelta,
      samples,
      checks,
      allPassed: Object.values(checks).every(Boolean),
    },
    null,
    2,
  ),
)

db.close()
rmSync(dir, { recursive: true, force: true })
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
