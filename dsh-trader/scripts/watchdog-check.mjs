#!/usr/bin/env node
/**
 * 历史 P2 ③ watchdog 验收脚本（当前硬禁用）。
 *
 * 旧 JSON 证据保留在 docs/；当前 Docker 单进程不再执行 SIGSTOP → 外部撤单验收。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { ReplayClock } from '../lib/clock.js'
import { migrate } from '../lib/db/schema.js'
import { Statements } from '../lib/db/statements.js'
import { HeartbeatStore } from '../lib/supervisor/heartbeat.js'
import {
  ExternalWatchdog,
  WATCHDOG_DISABLED_REASON,
  WATCHDOG_ENABLED,
  watchdogDecision,
} from '../lib/supervisor/watchdog.js'

const OUT = process.argv[2]

if (!WATCHDOG_ENABLED) {
  const report = {
    disabled: true,
    watchdogEnabled: false,
    reason: WATCHDOG_DISABLED_REASON,
    allPassed: false,
  }
  console.log(JSON.stringify(report, null, 2))
  if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  process.exit(78)
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-watchdog-'))
const dbPath = join(dir, 'watchdog.db')
const ordersPath = join(dir, 'open-orders.json')
const baseAt = Date.now()
const intervalMs = 50
const multiple = 1
let child
let db

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForStopped(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    try {
      const status = readFileSync('/proc/' + pid + '/status', 'utf8')
      if (/^State:\s*T/m.test(status)) return true
    } catch {
      return false
    }
    await sleep(10)
  }
  return false
}

async function waitForReady(process) {
  return await new Promise((resolve) => {
    let output = ''
    const timer = setTimeout(() => resolve(false), 10_000)
    process.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.includes('READY')) {
        clearTimeout(timer)
        resolve(true)
      }
    })
    process.on('exit', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function waitForExit(process) {
  return await new Promise((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve({ code: process.exitCode, signal: process.signalCode })
      return
    }
    process.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

const checks = {
  child_stopped: false,
  heartbeat_exists: false,
  stale_detected: false,
  watchdog_halted: false,
  cancel_all_called: false,
  open_orders_cleared: false,
  halted_persisted: false,
  second_check_idempotent: false,
}

let report
try {
  {
    const initial = new Database(dbPath)
    migrate(initial)
    initial.close()
  }
  writeFileSync(
    ordersPath,
    JSON.stringify([{ exchangeOrderId: 'fake-order-1', symbol: 'BTC/USDT' }]),
    'utf8',
  )

  const heartbeatUrl = new URL('../lib/supervisor/heartbeat.js', import.meta.url).href
  const childSource = [
    "import Database from 'better-sqlite3'",
    "import { Statements } from " + JSON.stringify(new URL('../lib/db/statements.js', import.meta.url).href),
    "import { HeartbeatStore } from " + JSON.stringify(heartbeatUrl),
    "const db = new Database(" + JSON.stringify(dbPath) + ')',
    'new HeartbeatStore(new Statements(db)).beat(' + String(baseAt) + ')',
    "process.stdout.write('READY\\n')",
    "process.kill(process.pid, 'SIGSTOP')",
  ].join('\n')
  child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const ready = await waitForReady(child)
  checks.child_stopped = ready && (await waitForStopped(child.pid, 5_000))

  db = new Database(dbPath)
  const heartbeat = new HeartbeatStore(new Statements(db))
  const row = heartbeat.read()
  checks.heartbeat_exists = row !== undefined

  const checkAt = baseAt + intervalMs * (multiple + 2)
  const stale = watchdogDecision({
    now: checkAt,
    beatAt: row?.beatAt,
    intervalMs,
    multiple,
    halted: row?.halted ?? false,
  })
  checks.stale_detected = stale.action === 'halt_cancel'

  let cancelCalls = 0
  const broker = {
    cancelAll: async () => {
      cancelCalls += 1
      writeFileSync(ordersPath, '[]', 'utf8')
    },
  }
  const watchdog = new ExternalWatchdog({
    heartbeat,
    broker,
    clock: new ReplayClock(checkAt),
    intervalMs,
    multiple,
  })
  const first = await watchdog.checkOnce()
  const afterFirst = heartbeat.read()
  checks.watchdog_halted = first.halted && afterFirst?.halted === true
  checks.cancel_all_called = cancelCalls === 1
  checks.open_orders_cleared =
    existsSync(ordersPath) && JSON.parse(readFileSync(ordersPath, 'utf8')).length === 0
  checks.halted_persisted = afterFirst?.halted === true

  await watchdog.checkOnce()
  checks.second_check_idempotent = cancelCalls === 1

  report = {
    ranAt: new Date().toISOString(),
    dbPath,
    child: { pid: child.pid, ready, stopped: checks.child_stopped },
    heartbeat: row,
    stale,
    cancelCalls,
    openOrders: JSON.parse(readFileSync(ordersPath, 'utf8')),
    checks,
    allPassed: Object.values(checks).every(Boolean),
  }
  console.log(JSON.stringify(report, null, 2))
  if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
} catch (error) {
  report = {
    ranAt: new Date().toISOString(),
    dbPath,
    checks,
    allPassed: false,
    error: String(error),
  }
  console.error(JSON.stringify(report, null, 2))
  if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
} finally {
  if (child !== undefined) {
    try {
      child.kill('SIGCONT')
    } catch {
      // 子进程可能已经退出。
    }
    try {
      child.kill('SIGKILL')
    } catch {
      // 清理路径本身必须幂等。
    }
    await waitForExit(child)
  }
  db?.close()
  rmSync(dir, { recursive: true, force: true })
}

process.exit(report?.allPassed === true ? 0 : 1)
