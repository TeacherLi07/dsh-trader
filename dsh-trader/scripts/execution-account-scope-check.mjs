#!/usr/bin/env node
/** 只读生产账户身份/重启验收：所有交易所请求强制GET，UID不写日志。 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import { createExecRuntime, migrate, systemClock } from '../lib/internal-api.js'

const output = resolve(process.argv[2] ?? '')
assert.ok(process.argv[2], 'usage: execution-account-scope-check.mjs newPrivateDirectory')
assert.ok(!existsSync(output), 'refuse to overwrite earlier evidence')
assert.ok(process.env.TRADER_API_KEY && process.env.TRADER_API_SECRET, 'HTX credentials not injected')
mkdirSync(output, { recursive: true, mode: 0o700 })
const clock = systemClock()
const reads = []
const identities = []
let mutationAttempts = 0
let runtime
const db = new Database(output + '/runtime.sqlite')
chmodSync(output + '/runtime.sqlite', 0o600)
migrate(db)
const config = {
  mode: 'live_auto', liveArmed: true, venue: 'htx', accountType: 'swap', positionSide: 'both',
  apiKey: process.env.TRADER_API_KEY, apiSecret: process.env.TRADER_API_SECRET,
  riskPct: 0.001, symbols: ['FIL/USDT:USDT'], timeframes: ['1h'], benchmark: 'BTC/USDT:USDT',
  reconcileMs: 3_600_000, settleMs: 3_600_000, liveAckOrphans: false,
  limits: { perOrderCapUsd: 0.1, maxExposureUsd: 0.1, maxLeverage: 0.01,
    dailyLossLimitUsd: 0.01, maxDrawdownUsd: 0.01, maxConsecutiveLosses: 1,
    maxSpreadBps: 10, maxOpenOrders: 1 },
}
const report = { at: clock.now(), passed: false, readOnly: true, reads, runs: [] }
const factory = () => {
  const exchange = new ccxt.htx({ enableRateLimit: true, timeout: 20000 })
  const request = exchange.request.bind(exchange)
  exchange.request = async (path, api, method = 'GET', ...rest) => {
    if (method !== 'GET') mutationAttempts++
    assert.equal(method, 'GET', 'read-only probe rejected exchange mutation')
    const raw = await request(path, api, method, ...rest)
    // 仅存端点和成功码，不存签名URL、请求头、UID或完整身份响应。
    reads.push({ path, method, code: raw?.code ?? raw?.status ?? null })
    if (path === 'v2/user/uid') identities.push(raw?.data)
    return raw
  }
  return exchange
}
try {
  for (let run = 0; run < 2; run++) {
    runtime = await createExecRuntime(config, { db, clock, createExchange: factory })
    const scopeHash = runtime.getPorts().journal.executionScopeHash
    assert.match(scopeHash, /^sha256:[0-9a-f]{64}$/)
    const resolved = await runtime.broker.resolveExecutionAccountScope()
    assert.equal(resolved.accountScopeHash, scopeHash)
    const account = await runtime.broker.getAccount()
    assert.ok(account.equityQuote > 0, 'nonempty authenticated account required')
    report.runs.push({ scopeHash, equityQuote: account.equityQuote,
      openOrders: account.openOrders, frozenSymbols: [...runtime.frozenSymbols()] })
    await runtime.dispose()
    runtime = undefined
  }
  assert.equal(report.runs[0].scopeHash, report.runs[1].scopeHash)
  assert.equal(identities.length, 2, 'UID must be read once per new exchange instance')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_intents').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0)
  assert.equal(mutationAttempts, 0)
  report.binding = db.prepare('SELECT mode, account_scope_hash FROM execution_scope_binding').get()
  report.uidReads = identities.length
  report.exchangeMutationAttempts = mutationAttempts
  report.orders = 0
  report.passed = true
} catch (error) {
  report.error = String(error)
} finally {
  await runtime?.dispose()
  db.close()
  let text = JSON.stringify(report, null, 2)
  for (const secret of [process.env.TRADER_API_KEY, process.env.TRADER_API_SECRET,
    process.env.SUB2API_KEY, process.env.DEEPSEEK_API_KEY].filter(Boolean)) {
    text = text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]')
  }
  for (const uid of identities) text = text.replaceAll(String(uid), '[UID REDACTED]')
  writeFileSync(output + '/report.json', text + '\n', { mode: 0o600, flag: 'wx' })
}
console.log(JSON.stringify({ passed: report.passed, uidReads: report.uidReads,
  exchangeMutationAttempts: mutationAttempts, orders: report.orders }))
if (!report.passed) process.exitCode = 1
