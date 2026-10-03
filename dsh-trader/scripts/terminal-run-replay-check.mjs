#!/usr/bin/env node
/** 从真实连接日志重放已终结判断，只改 DB 副本；未知费用必须逐字保留且不能触达模型。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { createExecRuntime, migrate, runDecisionRuntime, systemClock } from '../lib/internal-api.js'

assert.ok(process.argv[2] && process.argv[3], 'usage: terminal-run-replay-check.mjs connectionDirectory newOutputDirectory')
const sourceDirectory = resolve(process.argv[2]), output = resolve(process.argv[3])
const source = join(sourceDirectory, 'paper.sqlite')
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const originalHash = hash(source), policy = JSON.parse(readFileSync(join(sourceDirectory, 'policy.json'), 'utf8'))
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal(statSync(output).mode & 0o077, 0)
const copy = join(output, 'replay.sqlite')
assert.ok(!existsSync(copy), 'use a new output directory to preserve evidence')
copyFileSync(source, copy); chmodSync(copy, 0o600)
const db = new Database(copy); migrate(db)
const runs = db.prepare("SELECT * FROM decision_runs WHERE status <> 'running' ORDER BY created_at, run_id").all()
assert.ok(runs.length > 0, 'requires nonempty terminal real runs')
const snapshot = () => ({ budget: db.prepare('SELECT * FROM budget_ledger ORDER BY day, scope').all(),
  runs: db.prepare('SELECT * FROM decision_runs ORDER BY run_id').all(),
  orders: db.prepare('SELECT * FROM order_intents ORDER BY intent_id').all() })
let runtime, providerCallbacks = 0, networkCalls = 0
const realFetch = globalThis.fetch
const model = { async *stream() { providerCallbacks++; throw Error('terminal replay invoked provider') } }
globalThis.fetch = async () => { networkCalls++; throw Error('terminal replay attempted network') }
try {
  runtime = await createExecRuntime({ mode: 'paper', liveArmed: false, riskPct: .001,
    symbols: ['ADA/USDT:USDT', 'DOGE/USDT:USDT'], timeframes: ['15m', '1h', '4h'], benchmark: 'BTC/USDT:USDT',
    venue: 'htx', accountType: 'swap', paperInitialEquityQuote: 24.9, reconcileEnabled: false,
    reconcileMs: 60_000, settleMs: 60_000, priceOf: () => undefined,
    limits: { perOrderCapUsd: 1, maxExposureUsd: 2, maxLeverage: 1, dailyLossLimitUsd: .1,
      maxDrawdownUsd: .2, maxConsecutiveLosses: 2, maxSpreadBps: 10, maxOpenOrders: 2 } }, { db, clock: systemClock() })
  const before = snapshot(), cases = []
  const config = { strategy: policy.strategy, route: { provider: policy.provider, model: policy.model,
    maxTokens: policy.maxTokens, maxChars: 180_000 }, dailyBudgetUsd: policy.dailyBudgetUsd,
    dailyTokenCap: policy.dailyTokenCap, planWindowMs: 14_400_000 }
  for (let index = 0; index < runs.length; index++) {
    const row = runs[index], trigger = JSON.parse(readFileSync(join(sourceDirectory, `trigger-${index}.json`), 'utf8'))
    assert.equal(row.trigger_source, `${trigger.source}:${trigger.id}`, 'saved event must match real run')
    const final = JSON.parse(row.final_json), expectedReason = final.failure ?? final.reason
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await runDecisionRuntime({ ports: runtime.getPorts(), model, config,
        trigger, symbol: row.symbol, timeframe: row.primary_timeframe })
      assert.equal(result.runId, row.run_id)
      assert.equal(result.replayed, true)
      assert.equal(result.status, row.status)
      assert.equal(result.reason, expectedReason)
      if (expectedReason !== undefined) assert.equal(result.retryable, false)
      assert.deepEqual(result.envelope, final.envelope)
      assert.deepEqual(result.eligibility, JSON.parse(row.eligibility_json))
    }
    cases.push({ runId: row.run_id, status: row.status, source: trigger.source, costKnown: row.cost_known,
      reasonPreserved: true, reason: expectedReason ?? null, repetitions: 2 })
  }
  assert.equal(providerCallbacks, 0); assert.equal(networkCalls, 0)
  assert.deepEqual(snapshot(), before, 'terminal replay cannot mutate fees, runs, or order intents')
  assert.equal(hash(source), originalHash, 'original evidence must remain unchanged')
  const report = { passed: true, source, originalHash, sourceRuns: runs.length, replayCalls: runs.length * 2,
    providerCallbacks, networkCalls, budgetUnchanged: true, sourceDbUnmodified: true,
    realExchangeOrdersSubmitted: 0, cases }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report))
} finally { globalThis.fetch = realFetch; await runtime?.dispose(); db.close() }
