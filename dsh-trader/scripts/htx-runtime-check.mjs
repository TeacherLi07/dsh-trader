#!/usr/bin/env node
/** 受控真实最小仓位：同一个生产 runtime 的硬闸、journal、保护、恢复和 merged 对账。 */
import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import {
  applyProxyAwareFetch, createExecRuntime, executeAction, marketSpecification,
  migrate, numericClientOrderId, sanitizeModelTrace, systemClock,
} from '../lib/internal-api.js'
import { assertSmokeAccountFlat, cleanupSmokePosition, evaluateSmokeLossEnvelope } from '../lib/exec/smoke-safety.js'

const args = process.argv.slice(2)
const executing = args.includes('--execute')
const output = resolve(args.find((arg) => !arg.startsWith('--')) ?? '/tmp/htx-runtime-check')
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal(statSync(output).mode & 0o077, 0, 'private output directory required')
const reportPath = join(output, 'report.json')
const dbPath = join(output, 'runtime.sqlite')
assert.ok(!existsSync(reportPath) && !existsSync(dbPath), 'refuse to overwrite prior evidence')
const symbol = 'FIL/USDT:USDT'
const clock = systemClock()
const secrets = [process.env.TRADER_API_KEY, process.env.TRADER_API_SECRET].filter(Boolean)
const redact = (value) => {
  let text = JSON.stringify(sanitizeModelTrace(value))
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]')
  return JSON.parse(text)
}
const report = { executing, symbol, startedAt: clock.now(), steps: [], passed: false }
const record = (name, detail) => {
  const event = redact({ at: clock.now(), name, detail })
  report.steps.push(event)
  appendFileSync(join(output, 'events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 })
  writeFileSync(reportPath, JSON.stringify(redact(report), null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(event))
}
const exchange = new ccxt.htx({ enableRateLimit: true, timeout: 30_000,
  apiKey: process.env.TRADER_API_KEY, secret: process.env.TRADER_API_SECRET, options: { defaultType: 'swap' } })
applyProxyAwareFetch(exchange)
const db = new Database(dbPath)
chmodSync(dbPath, 0o600)
migrate(db)
let runtime
let broker
let preflightPassed = false
let failure
try {
  await exchange.loadMarkets()
  const spec = marketSpecification(symbol, exchange.markets[symbol], exchange.precisionMode)
  assert.equal(spec.minimumRule, 'htx-whole-contracts-v1')
  const ticker = await exchange.fetchTicker(symbol)
  const price = Number(ticker.ask ?? ticker.last)
  const balance = await exchange.fetchBalance({ type: 'swap' })
  const equity = Number(balance.total.USDT)
  const envelope = evaluateSmokeLossEnvelope({ equityQuote: equity, maxDrawdownPct: 0.02,
    oneContractBase: spec.contractSize, referencePrice: price })
  assert.ok(envelope.fits, 'one-contract entire principal exceeds authorized 2% envelope')
  const limits = { perOrderCapUsd: spec.contractSize * price * 1.02,
    maxExposureUsd: spec.contractSize * price * 1.05, maxLeverage: 0.02,
    dailyLossLimitUsd: equity * 0.01, maxDrawdownUsd: equity * 0.02,
    maxConsecutiveLosses: 1, maxSpreadBps: 10, maxOpenOrders: 2 }
  record('loss_envelope', { equity, envelope, spec, limits })
  if (!executing) {
    report.passed = true
    record('dry_run', { realOrdersSubmitted: 0 })
  } else {
    const stop = price * 0.97
    const riskPct = spec.contractSize * 1.005 * (price - stop) / equity
    const config = { mode: executing ? 'live_auto' : 'paper', liveArmed: executing,
      venue: 'htx', accountType: 'swap', positionSide: 'both', apiKey: process.env.TRADER_API_KEY,
      apiSecret: process.env.TRADER_API_SECRET, limits, riskPct, symbols: [symbol], timeframes: ['1h'],
      benchmark: 'BTC/USDT:USDT', reconcileMs: 3_600_000, settleMs: 3_600_000,
      paperInitialEquityQuote: equity, priceOf: () => price }
    runtime = await createExecRuntime(config, { db, clock, createExchange: () => exchange })
    let ports = runtime.getPorts()
    broker = runtime.broker
    assertSmokeAccountFlat(await broker.getPositions(), await broker.getOpenOrders())
    record('preflight', { venue: broker.venue, equity, envelope, spec, limits, riskPct })
    const argsFor = (conditionId, action) => ({ journal: ports.journal, broker, clock,
      plan: { planId: `runtime-check-${report.startedAt}` }, conditionId, action, symbol,
      timeframe: '1h', barTs: report.startedAt, referencePrice: price, atr: null,
      riskPct, mode: config.mode, liveArmed: config.liveArmed, limits, reflectionHorizonMs: 3_600_000,
      alreadyIntended: (id) => ports.journal.hasClientOrderId(id), frozenSymbols: ports.frozenSymbols,
      freezeSymbol: ports.freezeSymbol, halt: ports.halt })
    if (executing) preflightPassed = true
    const openArgs = argsFor('open', { action: 'open', side: 'long', method: 'market',
      stop: { method: 'structure', level: stop }, riskFraction: 1 })
    const opened = await executeAction(openArgs)
    record('open', opened)
    assert.ok(opened.executed, opened.reason)
    const positions = await broker.getPositions()
    assert.equal(positions.length, 1)
    assert.equal(positions[0].qty, spec.contractSize)
    assert.ok(positions[0].protectedStopPrice > 0)
    const protections = await broker.getOpenOrders()
    assert.ok(protections.length > 0)
    record('nonempty_remote_protection', { positions, protections })
    const nonempty = await runtime.reconcileOnce()
    record('nonempty_reconcile', nonempty)
    assert.equal(nonempty.consistent, true)
    assert.equal(nonempty.freezeTrading, false)
    const before = db.prepare('SELECT COUNT(*) AS n FROM order_intents').get().n
    const repeat = await executeAction(openArgs)
    assert.equal(repeat.alreadyIntended, true)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_intents').get().n, before)
    record('same_open_idempotent', repeat)
    if (executing) {
      await runtime.dispose()
      runtime = await createExecRuntime(config, { db, clock, createExchange: () => exchange })
      ports = runtime.getPorts()
      broker = runtime.broker
      const restored = await runtime.reconcileOnce()
      record('restart_nonempty_recovery', restored)
      assert.equal(restored.consistent, true)
      assert.equal(restored.freezeTrading, false)
    }
    const preserved = await executeAction(argsFor('cancel-open-only', { action: 'cancel_all', scope: 'symbol' }))
    assert.ok(preserved.executed, preserved.reason)
    assert.ok((await broker.getOpenOrders()).length > 0)
    assert.ok((await broker.getPositions())[0].protectedStopPrice > 0)
    record('cancel_preserves_protection', preserved)
    const closed = await executeAction(argsFor('close', { action: 'close' }))
    record('reduce_only_close', closed)
    assert.ok(closed.executed, closed.reason)
    assert.equal((await broker.getPositions()).length, 0)
    const canceled = await executeAction(argsFor('cancel-flat', { action: 'cancel_all', scope: 'symbol' }))
    assert.ok(canceled.executed, canceled.reason)
    assert.equal((await broker.getOpenOrders()).length, 0)
    const final = await runtime.reconcileOnce()
    record('final_flat_reconcile', final)
    assert.equal(final.consistent, true)
    const counts = Object.fromEntries(['decisions', 'order_intents', 'orders', 'fills', 'audit_events']
      .map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
    assert.ok(counts.fills >= 2 && counts.order_intents >= 3)
    record('nonempty_journal_counts', counts)
    report.passed = true
  }
} catch (error) {
  failure = error
  record('failed', { error: String(error) })
} finally {
  if (preflightPassed && broker) {
    const cleanup = await cleanupSmokePosition(broker, symbol, async (qty) => {
      const clientOrderId = numericClientOrderId(`runtime-cleanup-${report.startedAt}`)
      await broker.placeOrder({ intentId: clientOrderId, clientOrderId, decisionId: 'runtime-cleanup',
        symbol, type: 'market', side: qty > 0 ? 'sell' : 'buy', qty: Math.abs(qty),
        notionalUsd: Math.abs(qty) * Number((await exchange.fetchTicker(symbol)).last), reduceOnly: true })
    })
    record('cleanup', cleanup)
    if (!cleanup.flattened || !cleanup.cancelAll) report.passed = false
  }
  report.finishedAt = clock.now()
  writeFileSync(reportPath, JSON.stringify(redact(report), null, 2) + '\n', { mode: 0o600 })
  await runtime?.dispose()
  await exchange.close()
  db.close()
}
if (failure || !report.passed) process.exitCode = 1
