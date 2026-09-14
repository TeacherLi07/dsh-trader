#!/usr/bin/env node
/**
 * 真实数据联通性冒烟（**不**在 CI 跑：需要网络与代理）。
 *
 * 用途：验证"交易所可达 + 回补逻辑 + 只落已收盘 bar"在真实数据上成立（T0.4 的验收之一）。
 *
 * 用法：
 *   pnpm build
 *   node scripts/smoke-live.mjs [venue] [symbol] [timeframe] [days]
 *   例：node scripts/smoke-live.mjs htx BTC/USDT 1h 30
 *
 * 代理：ccxt 自带 fetch 不读 HTTP(S)_PROXY，这里显式注入 Node 全局 fetch
 * （本机实测：不注入 ⇒ ECONNREFUSED；注入后正常）。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import { systemClock } from '../lib/clock.js'
import { migrate } from '../lib/db/schema.js'
import { BarArchive } from '../lib/market/archive.js'
import { backfill } from '../lib/market/backfill.js'
import { applyProxyAwareFetch, createCcxtSource } from '../lib/market/ccxt-source.js'
import { FeatureEngine } from '../lib/market/features.js'

const [venue = 'htx', symbol = 'BTC/USDT', timeframe = '1h', days = '30'] = process.argv.slice(2)
const dayCount = Number(days)
const Exchange = ccxt[venue]
if (Exchange === undefined) {
  console.error(`未知交易所：${venue}`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-trader-smoke-'))
const db = new Database(join(dir, 'smoke.db'))
migrate(db)
const archive = new BarArchive(db)

const exchange = new Exchange({ enableRateLimit: true })
applyProxyAwareFetch(exchange)
const source = createCcxtSource(exchange)

const until = Date.now()
const since = until - dayCount * 86_400_000

const startedAt = Date.now()
const result = await backfill(
  { source, archive, clock: systemClock() },
  { symbol, timeframe, since, until, pageLimit: 500 },
)
const elapsedMs = Date.now() - startedAt

const bars = archive.closedBars(symbol, timeframe)
const summary = {
  venue,
  symbol,
  timeframe,
  days: dayCount,
  ...result,
  stored: archive.count(symbol, timeframe),
  elapsedMs,
  firstOpenTime: bars[0]?.openTime,
  lastOpenTime: bars[bars.length - 1]?.openTime,
  lastClose: bars[bars.length - 1]?.close,
  allClosed: bars.every((bar) => bar.closed),
}

// 特征层（T0.5）：把归档的已收盘 bar 顺序喂给增量引擎，打印最后一根的完整快照
const engine = new FeatureEngine()
let lastSnapshot
for (const bar of bars) lastSnapshot = engine.onClosedCandle(bar)
summary.lastFeatures = lastSnapshot?.values ?? null

console.log(JSON.stringify(summary, null, 2))

await source.close?.()
db.close()
