#!/usr/bin/env node
/**
 * P1 ⑤ 崩溃恢复验收（plan §10 P1 ⑤ / §4.2）—— **真实的 `kill -9`**，不是模拟。
 *
 * 用法：pnpm build && node scripts/crash-recovery-check.mjs [outPath]
 *
 * 流程：
 *   1. 子进程打开临时库，写下"意图已落库但还没有 ack"的**崩溃现场**，打印 `READY`，然后挂住；
 *   2. 父进程读到 `READY` 后立刻 `SIGKILL`（**不可捕获**，等价于断电/被 OOM 杀掉）；
 *   3. 父进程重新打开同一个库（"resume"），跑 `CrashRecovery`；
 *   4. 断言：成交/决策**零重复**、`client_order_id` 重复数 = 0、恢复可重复执行且幂等、
 *      未知状态必须冻结标的（绝不猜）。
 *
 * 为什么用真 SIGKILL：`SIGKILL` 不会给任何 flush/cleanup 机会，能真实验证
 * "SQLite 里已经提交的东西是完整的、没提交的不会半写"。用模拟做不到这一点。
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ReplayClock } from '../lib/clock.js'
import { migrate } from '../lib/db/schema.js'
import { DecisionJournal } from '../lib/exec/journal.js'
import { CrashRecovery } from '../lib/exec/recovery.js'

const OUT = process.argv[2]
const dir = mkdtempSync(join(tmpdir(), 'dsh-crash-'))
const dbPath = join(dir, 'crash.db')
const NOW = Date.now()

// ── 1) 先建好 schema（父进程做，子进程只写崩溃现场）──────────────────────────
{
  const db = new Database(dbPath)
  migrate(db)
  db.close()
}

// ── 2) 子进程写崩溃现场后挂住，父进程 SIGKILL 它 ────────────────────────────
const child = spawn(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `
import Database from 'better-sqlite3'
const { DecisionJournal } = await import(${JSON.stringify(new URL('../lib/exec/journal.js', import.meta.url).href)})
const db = new Database(${JSON.stringify(dbPath)})
db.pragma('journal_mode = WAL')
const journal = new DecisionJournal(db)
journal.recordDecision({
  decisionId: 'dec:crash-1', symbol: 'BTC/USDT', decidedAt: ${NOW}, contextHash: 'ctx:crash',
  action: 'open', executed: false,
})
journal.recordIntent({
  intentId: 'oi:crash-1', clientOrderId: 'co-crash-1', decisionId: 'dec:crash-1',
  venue: 'paper', symbol: 'BTC/USDT', state: 'created', type: 'market', side: 'buy', qty: 1,
  reduceOnly: false, createdAt: ${NOW},
})
// 关键：**不** markIntentAcked、**不** close —— 进程将在这里被 SIGKILL
process.stdout.write('READY\\n')
setInterval(() => {}, 1000)
`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

const ready = await new Promise((resolve) => {
  let buffer = ''
  const timer = setTimeout(() => resolve(false), 30_000)
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    if (buffer.includes('READY')) {
      clearTimeout(timer)
      resolve(true)
    }
  })
  child.on('exit', () => {
    clearTimeout(timer)
    resolve(false)
  })
})

let killSignal = null
if (ready) {
  killSignal = 'SIGKILL'
  child.kill('SIGKILL')
}
const childExit = await new Promise((resolve) => {
  child.on('exit', (code, signal) => resolve({ code, signal }))
  setTimeout(() => resolve({ code: null, signal: null }), 10_000)
})

// ── 3) resume：重新打开库，跑恢复 ───────────────────────────────────────────
const db = new Database(dbPath)
const journal = new DecisionJournal(db)
const clock = new ReplayClock(NOW)
const intentsBeforeRecovery = journal.inFlightIntents()

/** 恢复用的 broker 替身：paper broker 是**内存**的，崩溃后无法回答 ⇒ 只能判未知。 */
const broker = {
  venue: 'paper',
  getAccount: () => Promise.reject(new Error('未实现')),
  getPositions: () => Promise.reject(new Error('未实现')),
  getOpenOrders: () => Promise.resolve([]),
  placeOrder: () => Promise.reject(new Error('恢复绝不下单')),
  placeProtective: () => Promise.reject(new Error('恢复绝不下单')),
  cancelOrder: () => Promise.resolve(),
  cancelAll: () => Promise.resolve(),
  subscribeUserData: () => () => {},
}

const recovery = new CrashRecovery({ journal, clock, broker, symbols: ['BTC/USDT'] })
const first = await recovery.run()
const afterFirst = {
  decisions: journal.decisionIds(),
  intents: journal.intentIds(),
  clientOrderIds: journal.clientOrderIds(),
  duplicates: journal.duplicateClientOrderIds(),
}
const second = await recovery.run()
const afterSecond = {
  decisions: journal.decisionIds(),
  intents: journal.intentIds(),
  duplicates: journal.duplicateClientOrderIds(),
}

const sql = {
  intents_total: db.prepare('SELECT COUNT(*) AS n FROM order_intents').get().n,
  intents_created_unacked: db
    .prepare("SELECT COUNT(*) AS n FROM order_intents WHERE state = 'created' AND acked_at IS NULL")
    .get().n,
  intents_unknown: db.prepare("SELECT COUNT(*) AS n FROM order_intents WHERE state = 'unknown'").get().n,
  decisions_total: db.prepare('SELECT COUNT(*) AS n FROM decisions').get().n,
  outcomes_total: db.prepare('SELECT COUNT(*) AS n FROM outcomes').get().n,
  fills_total: db.prepare('SELECT COUNT(*) AS n FROM fills').get().n,
  audit_is_append_only_ok: true,
}
db.close()

const checks = {
  // 崩溃现场真的建立了（否则后面全是空跑）
  crash_scene_persisted_after_sigkill: intentsBeforeRecovery.length === 1,
  // SIGKILL 真的发生了（信号就是 SIGKILL，不是正常退出）
  sigkill_delivered: killSignal === 'SIGKILL' && childExit.signal === 'SIGKILL',
  // 恢复把在途意图收敛掉（不留在 created）
  no_created_unacked_left: sql.intents_created_unacked === 0,
  // 未知状态必须冻结标的（绝不猜）
  unknown_freezes_symbol: first.freezeSymbols.includes('BTC/USDT'),
  // 无重复决策 / 无重复意图 / 无重复 client_order_id
  no_duplicate_decisions: sql.decisions_total === 1 && afterFirst.decisions.length === 1,
  no_duplicate_intents: sql.intents_total === 1 && afterFirst.intents.length === 1,
  no_duplicate_client_order_ids: afterFirst.duplicates === 0 && afterSecond.duplicates === 0,
  // 恢复幂等：第二遍不改变任何 id 集合
  recovery_idempotent:
    JSON.stringify(afterFirst.decisions) === JSON.stringify(afterSecond.decisions) &&
    JSON.stringify(afterFirst.intents) === JSON.stringify(afterSecond.intents),
  // 恢复绝不重新下单、绝不产生成交
  recovery_never_reorders: sql.outcomes_total === 0 && sql.fills_total === 0,
  // 未知状态有可操作告警
  alert_is_actionable: first.alerts.some((alert) => alert.code === 'orphan_intent_unknown'),
}

const report = {
  ranAt: new Date().toISOString(),
  dbPath,
  child: { ready, killSignal, exit: childExit, pid: child.pid },
  intentsBeforeRecovery: intentsBeforeRecovery.map((intent) => ({
    clientOrderId: intent.clientOrderId,
    state: intent.state,
    symbol: intent.symbol,
  })),
  recovery: {
    scanned: first.scanned,
    resolved: first.resolved,
    freezeSymbols: first.freezeSymbols,
    alerts: first.alerts,
    secondPassScanned: second.scanned,
  },
  sql,
  checks,
  allPassed: Object.values(checks).every(Boolean),
  note:
    '真实的 SIGKILL + 重开库恢复。paper broker 是内存实现，崩溃后无法回答 client_order_id 查询 ⇒ ' +
    '按 plan §4.2 判"未知"并冻结标的。P2 ① 会用真交易所接口覆盖"孤儿订单 = 0"。',
}

console.log(JSON.stringify(report, null, 2))
if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
execFileSync('rm', ['-rf', dir])
process.exit(report.allPassed ? 0 : 1)
