#!/usr/bin/env node
/** 已有真实运行 DB 的独立安全分支；只改副本，生产 dispatcher 不得触达模型。 */
import assert from 'node:assert/strict'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import Database from 'better-sqlite3'
import { BudgetLedger, TriggerQueue, createExecRuntime, dispatchNextTrigger, migrate, systemClock } from '../lib/internal-api.js'

const source = resolve(process.argv[2])
const output = resolve(process.argv[3])
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const originalHash = hash(source)
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal(statSync(output).mode & 0o077, 0)
const copy = join(output, 'guard.sqlite')
assert.ok(!existsSync(copy), 'use a new directory; preserve prior evidence')
copyFileSync(source, copy); chmodSync(copy, 0o600)
const db = new Database(copy)
migrate(db)
const sourceRuns = db.prepare('SELECT COUNT(*) AS n FROM decision_runs').get().n
assert.ok(sourceRuns > 0, 'requires nonempty real source runs')
const ledger = () => db.prepare("SELECT * FROM budget_ledger WHERE scope='global'").all()
const beforeBudget = ledger()
const clock = systemClock()
let runtime
let callbacks = 0
const results = []
try {
  runtime = await createExecRuntime({ mode: 'paper', liveArmed: false, riskPct: .001,
    symbols: ['ADA/USDT:USDT', 'DOGE/USDT:USDT'], timeframes: ['15m', '1h', '4h'], benchmark: 'BTC/USDT:USDT',
    venue: 'htx', accountType: 'swap', paperInitialEquityQuote: 24.9, reconcileEnabled: false, reconcileMs: 60_000, settleMs: 60_000,
    priceOf: () => undefined, limits: { perOrderCapUsd: 1, maxExposureUsd: 2, maxLeverage: 1,
      dailyLossLimitUsd: .1, maxDrawdownUsd: .2, maxConsecutiveLosses: 2, maxSpreadBps: 10, maxOpenOrders: 2 } }, { db, clock })
  const ports = runtime.getPorts(), queue = new TriggerQueue(db), budget = new BudgetLedger(db)
  for (const name of ['expired', 'no-budget', 'invalidation']) {
    const at = clock.now(), id = `safety-${originalHash}-${name}`
    const event = { triggerId: id, dedupKey: id, symbol: 'ADA/USDT:USDT', purpose: name === 'invalidation' ? 'invalidation' : 'commitment',
      disposition: 'judgment', state: 'queued', createdAt: name === 'expired' ? at - 100 : at,
      ...(name === 'expired' ? { expiresAt: at - 1 } : {}), payload: { timeframe: '1h', safetyFixture: true } }
    assert.equal(queue.enqueue(event), true)
    assert.equal(queue.enqueue(event), false, 'duplicate trigger cannot create another claim')
    const outcome = await dispatchNextTrigger({ queue, budget, journal: ports.journal, clock,
      symbols: ports.symbols, timeframes: ports.timeframes, dailyBudgetUsd: name === 'no-budget' ? undefined : 1,
      dailyTokenCap: 2_000_000, retryPolicy: { maxAttempts: 1 }, freezeSymbol: ports.freezeSymbol, halt: ports.halt,
      run: async () => { callbacks++; throw Error('safety case reached model callback') } })
    const stored = queue.get(id)
    assert.ok(stored)
    const audits = db.prepare("SELECT kind FROM audit_events WHERE json_extract(payload_json, '$.triggerId') = ?").all(id)
    assert.ok(audits.length > 0, 'rejection or freeze must leave nonempty audit')
    results.push({ name, state: stored.state, outcome: outcome.kind, reason: stored.lastError ?? outcome.reason, audits: audits.map(row => row.kind) })
  }
  assert.deepEqual(results.map(row => row.state), ['expired', 'failed', 'done'])
  assert.ok(results[1].reason.includes('未配置正数日预算'))
  assert.equal(results[2].outcome, 'frozen')
  assert.ok(ports.frozenSymbols().has('ADA/USDT:USDT'))
  assert.equal(callbacks, 0)
  assert.deepEqual(ledger(), beforeBudget)
  assert.equal(hash(source), originalHash, 'original DB must remain unchanged')
  const report = { passed: true, source, originalHash, sourceRuns, sourceDbUnmodified: true,
    providerCallbacks: callbacks, providerRequests: 0, budgetUnchanged: true, realExchangeOrdersSubmitted: 0, cases: results }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify(report))
} finally { await runtime?.dispose(); db.close() }
