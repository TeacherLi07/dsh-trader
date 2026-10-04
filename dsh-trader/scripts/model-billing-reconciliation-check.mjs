#!/usr/bin/env node
/** 完全离线的核销验收；账单与模型均是标注 fixture，不触碰旧真实未决费用。 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { EXAMPLE_LIMITS, ReplayClock, migrate, PaperBroker, BarArchive, FeatureArchive, PlanStore, DecisionJournal, PriceTableStore } from '../lib/internal-api.js'
import { runDecisionRuntime } from '../lib/agents/decision-runtime.js'
import { DecisionRunStore } from '../lib/agents/decision-run-store.js'

const output = resolve(process.argv[2] ?? '/tmp/model-billing-reconciliation-check')
assert.ok(!existsSync(output), 'new private output directory required')
mkdirSync(output, { recursive: true, mode: 0o700 })
const path = join(output, 'state.sqlite'), receiptPath = join(output, 'receipt.json'), evidencePath = join(output, 'synthetic-billing.json')
const clock = new ReplayClock(Date.UTC(2026, 9, 4)), symbol = 'ADA/USDT:USDT'
let db = new Database(path), calls = 0, networkCalls = 0
chmodSync(path, 0o600)
const previousFetch = globalThis.fetch
globalThis.fetch = async () => { networkCalls++; throw new Error('offline billing check attempted network') }
try {
  migrate(db)
  new PriceTableStore(db).add({ model: 'offline-billing', effectiveFrom: clock.now() - 1000,
    inPerMtok: 1, outPerMtok: 1, cachedInPerMtok: 0.1, source: 'synthetic fixture reference' })
  const journal = new DecisionJournal(db)
  const ports = { db, clock, journal, bars: new BarArchive(db), features: new FeatureArchive(db), plans: new PlanStore(db),
    broker: new PaperBroker({ clock, book: { price: () => 1 }, initialEquityQuote: 100 }),
    limits: EXAMPLE_LIMITS, mode: 'paper', liveArmed: false, waiver: false, riskPct: 0.001,
    symbols: [symbol], timeframes: ['15m', '1h', '4h'], benchmark: symbol, frozenSymbols: () => new Set() }
  const model = { async *stream(options) {
    calls++
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'synthetic-call',
      name: options.toolChoice.name, arguments: JSON.stringify({ outcome: 'no_trade', thesis: 'synthetic missing usage',
        rejectedAlternatives: ['synthetic trade'], claims: [], uncertainties: ['fixture'], confidence: 0.1, riskFraction: 1 }) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  } }
  const config = { strategy: 'critique', route: { provider: 'offline', model: 'offline-billing', maxTokens: 256, maxChars: 180000 },
    dailyBudgetUsd: 1, dailyTokenCap: 1000000, planWindowMs: 3600000 }
  const trigger = { source: 'W1', id: 'synthetic-billing', at: clock.now(), attempt: 0 }
  const first = await runDecisionRuntime({ ports, clock, model, config, trigger, symbol, timeframe: '1h' })
  assert.equal(first.status, 'review')
  assert.match(first.reason, /usage/)
  assert.equal(calls, 1)
  const rows = db.prepare("SELECT payload_json FROM audit_events WHERE kind = 'model_call_reserved'").all()
  assert.equal(rows.length, 1)
  const call = JSON.parse(rows[0].payload_json)
  const terminal = JSON.stringify(new DecisionRunStore(db).get(first.runId))
  const evidence = { synthetic: true, receiptId: 'synthetic-only', clientRequestId: call.clientRequestId,
    usage: { tokensIn: 120, tokensOut: 20, tokensCached: 40 }, costUsd: 0.0005 }
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const hash = createHash('sha256').update(readFileSync(evidencePath)).digest('hex')
  const receipt = { version: 1, callAttemptId: call.callAttemptId, runId: call.runId, requestHash: call.requestHash,
    provider: call.provider, model: call.model, clientRequestId: call.clientRequestId, providerResponseId: null,
    outcome: 'charged', usage: evidence.usage, costUsd: evidence.costUsd,
    evidence: { receiptId: evidence.receiptId, source: 'https://example.com/synthetic-billing', sha256: hash, observedAt: clock.now() } }
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  db.close()
  const cli = new URL('./model-billing-reconciliation.mjs', import.meta.url).pathname
  const invoke = args => JSON.parse(execFileSync(process.execPath, [cli, path, receiptPath, evidencePath, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }))
  const dbHash = () => createHash('sha256').update(readFileSync(path)).digest('hex')
  const beforeHash = dbHash(), inspect = invoke([])
  assert.equal(inspect.operation, 'inspect')
  assert.equal(dbHash(), beforeHash, 'inspect wrote the DB')
  const applied = invoke(['apply', inspect.plan.planHash, 'synthetic provider evidence; offline fixture'])
  assert.equal(applied.plan.alreadyApplied, false)
  db = new Database(path, { readonly: true })
  assert.equal(JSON.stringify(new DecisionRunStore(db).get(first.runId)), terminal)
  const ledger = db.prepare('SELECT * FROM budget_ledger ORDER BY scope').all()
  assert.equal(ledger.length, 2)
  assert.ok(ledger.every(e => e.cost_known === 1 && e.est_usd === evidence.costUsd && e.tokens_in === 120 && e.tokens_out === 20 && e.tokens_cached === 40))
  const audits = db.prepare("SELECT kind FROM audit_events WHERE kind = 'model_call_reconciled'").all()
  assert.equal(audits.length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_intents').get().n, 0)
  db.close()
  const repeated = invoke(['apply', inspect.plan.planHash, 'synthetic repeat'])
  assert.equal(repeated.plan.alreadyApplied, true)
  db = new Database(path, { readonly: true })
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind = 'model_call_reconciled'").get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM model_call_reconciliations').get().n, 1)
  assert.equal(networkCalls, 0)
  const report = { passed: true, syntheticModelAndBillingFixture: true, privateDirectory: output,
    originalStatus: first.status, originalFailurePreserved: true, terminalRunUnmodified: true, inspectDbHashUnchanged: true,
    ledgerRows: ledger.length, reconciledCalls: 1, reconciliationAudits: 1, repeatedApplyIdempotent: true,
    externalInvoicesVerified: 0, historicalUnknownReservationsCleared: 0, modelFixtureCalls: calls,
    paidModelCalls: 0, networkCalls, exchangeActions: 0, newOrderIntents: 0 }
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
} finally { globalThis.fetch = previousFetch; if (db.open) db.close() }
