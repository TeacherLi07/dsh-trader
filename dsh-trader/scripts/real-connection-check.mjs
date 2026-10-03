#!/usr/bin/env node
/** 真实 HTX 只读 + DSH critique/paper 执行链；私有目录保留日志与 SQLite，绝不自动启用实盘。 */

import assert from 'node:assert/strict'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import {
  applyProxyAwareFetch, createCcxtDerivativesSource, createCcxtSource, createExecRuntime, DEEPSEEK_PRICE_SEED,
  FeatureEngine, fingerprint, HtxBroker, MarketObservationStore, marketSpecification,
  migrate, normalizeCandles, PriceTableStore, runDecisionRuntime, sanitizeModelTrace, systemClock,
} from '../lib/internal-api.js'

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const output = resolve(value('--output-dir', '/tmp/dsh-real-connection-check'))
const executeModels = args.includes('--execute-models')
const resume = args.includes('--resume')
const api = value('--api', 'responses')
assert.ok(['responses', 'chat-completions'].includes(api), 'unsupported model API')
const provider = api === 'responses' ? 'deepseek-responses' : 'deepseek-official'
const sampleCount = Number(value('--samples', '2'))
const maxTokens = Number(value('--max-output-tokens', '32768'))
const dailyBudgetUsd = Number(value('--daily-budget-usd', '2'))
const totalBudgetUsd = Number(value('--total-budget-usd', '5'))
const dailyTokenCap = Number(value('--daily-token-cap', '20000000'))
assert.ok(Number.isSafeInteger(sampleCount) && sampleCount > 0 && sampleCount <= 100)
assert.ok(Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= 65536)
assert.ok(dailyBudgetUsd > 0 && dailyBudgetUsd <= 5 && totalBudgetUsd > 0 && totalBudgetUsd <= 10)
assert.ok(Number.isSafeInteger(dailyTokenCap) && dailyTokenCap > 0 && dailyTokenCap <= 30_000_000)
const apiKey = process.env.TRADER_API_KEY?.trim()
const apiSecret = process.env.TRADER_API_SECRET?.trim()
assert.ok(apiKey && apiSecret, 'HTX credentials missing')
if (executeModels) assert.ok(process.env.DEEPSEEK_API_KEY?.trim(), 'model credential missing')
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal((statSync(output).mode & 0o077), 0, 'output directory must be private')
const statePath = join(output, 'paper.sqlite')
if (existsSync(statePath) && !resume) throw new Error('state DB exists; use --resume, do not overwrite evidence')
const policyPath = join(output, 'policy.json')
const clock = systemClock()
const buildManifest = JSON.parse(readFileSync(new URL('../lib/build-manifest.json', import.meta.url), 'utf8'))
const versions = { ...buildManifest, validationScriptHash: fingerprint(readFileSync(new URL(import.meta.url), 'utf8')) }
const secrets = [apiKey, apiSecret, process.env.DEEPSEEK_API_KEY].filter(Boolean)
const redact = (value) => {
  let text = JSON.stringify(sanitizeModelTrace(value))
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]')
  return JSON.parse(text)
}
const write = (name, data) => writeFileSync(join(output, name), JSON.stringify(redact(data), null, 2) + '\n', { mode: 0o600 })
const event = (kind, detail) => {
  const entry = redact({ at: clock.now(), kind, detail })
  appendFileSync(join(output, 'events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(entry))
}
const policy = existsSync(policyPath) ? JSON.parse(readFileSync(policyPath, 'utf8')) : {
  id: randomUUID(), createdAt: clock.now(), mode: 'paper', strategy: 'critique', versions,
  dailyBudgetUsd, totalBudgetUsd, dailyTokenCap, maxTokens,
  api, provider, thinking: 'enabled', reasoningEffort: 'high', credentialScope: 'authorized .env key; test state isolated, provider account isolation not asserted',
}
assert.equal(policy.dailyBudgetUsd, dailyBudgetUsd)
assert.equal(policy.totalBudgetUsd, totalBudgetUsd)
assert.equal(policy.dailyTokenCap, dailyTokenCap)
assert.equal(policy.maxTokens, maxTokens)
assert.equal(policy.api, api)
assert.deepEqual(policy.versions, versions, 'resume must use the frozen code/build/script versions')
if (!existsSync(policyPath)) write('policy.json', policy)
const realFetch = globalThis.fetch
let httpCalls = 0
let modelHttpCalls = 0
let modelInvocations = 0
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const id = ++httpCalls
  const isModel = url.hostname === 'api.deepseek.com' && ['/chat/completions', '/responses'].some((path) => url.pathname.endsWith(path))
  if (isModel) modelHttpCalls += 1
  const startedAt = clock.now()
  const request = { id, method: options?.method ?? 'GET', origin: url.origin, path: url.pathname,
    queryKeys: [...url.searchParams.keys()].filter((key) => !/signature|key|authorization/i.test(key)),
    ...(isModel ? { modelRequest: JSON.parse(String(options.body)) } : {}) }
  event('http.started', request)
  try {
    const response = await realFetch(input, options)
    event('http.headers', { ...request, status: response.status, durationMs: clock.now() - startedAt,
      requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id') })
    if (response.headers.get('content-type')?.includes('json')) {
      const text = await response.clone().text()
      appendFileSync(join(output, 'http.jsonl'), JSON.stringify(redact({ id, path: url.pathname, status: response.status,
        body: text, bodyHash: fingerprint(text) })) + '\n', { mode: 0o600 })
    }
    return response
  } catch (error) {
    event('http.failed', { ...request, durationMs: clock.now() - startedAt, error: String(error) })
    throw error
  }
}

const exchange = new ccxt.htx({ enableRateLimit: true, defaultType: 'swap', timeout: 30_000, apiKey, secret: apiSecret })
applyProxyAwareFetch(exchange)
let db
let runtime
let llmFiber
let providerFiber
const report = { policy, startedAt: clock.now(), phases: {}, samples: [], realExchangeOrdersSubmitted: 0,
  r5OverallPassed: false, economicGate: 'not_run', providerAccountIsolationVerified: false }
let failed
try {
  await exchange.loadMarkets()
  const broker = new HtxBroker({ exchange, clock, venue: 'htx', apiKey, apiSecret, accountType: 'swap', positionSide: 'both', symbol: 'ADA/USDT:USDT' })
  const equity = await broker.readOnlyBalance()
  const positions = await broker.getPositions()
  const orders = await broker.getOpenOrders()
  write('htx-account.json', { equity, positions, orders })
  report.phases.privateRead = { equity, positions: positions.length, orders: orders.length, passed: Number.isFinite(equity) && equity > 0 }
  assert.ok(report.phases.privateRead.passed)
  const tickers = await exchange.fetchTickers(undefined, { type: 'swap', subType: 'linear' })
  write('market-specifications.json', ['FIL/USDT:USDT', 'ADA/USDT:USDT', 'DOGE/USDT:USDT', 'BTC/USDT:USDT']
    .map((symbol) => ({ symbol, market: exchange.markets[symbol] })))
  const candidates = Object.values(exchange.markets).filter((market) => market.swap && market.linear && market.settle === 'USDT' && market.active !== false)
    .flatMap((market) => {
      const ticker = tickers[market.symbol]
      const price = Number(ticker?.ask ?? ticker?.last)
      const spec = marketSpecification(market.symbol, market, exchange.precisionMode)
      const contracts = Math.max(spec.minAmountContracts ?? NaN, spec.amountStepContracts ?? NaN)
      const notional = contracts * Number(market.contractSize) * price
      const quoteVolume = Number(ticker?.quoteVolume)
      return Number.isFinite(notional) && notional > 0 && Number.isFinite(quoteVolume)
        ? [{ symbol: market.symbol, contracts, contractSize: market.contractSize, price, notional, quoteVolume,
          conservativeLossUsd: notional * 1.02, fitsTwoPercent: notional * 1.02 <= equity * 0.02 }] : []
    }).sort((a, b) => b.quoteVolume - a.quoteVolume)
  write('htx-market-scan.json', { equity, maxLossUsd: equity * 0.02, candidates })
  report.phases.marketScan = { symbols: candidates.length, candidatesWithinTwoPercent: candidates.filter((row) => row.fitsTwoPercent).slice(0, 10) }
  event('exchange.readonly_ready', report.phases)
  const funding = await exchange.fetchFundingHistory('ADA/USDT:USDT', clock.now() - 86_400_000, 100, { until: clock.now() })
  write('htx-funding-history.json', funding)
  report.phases.fundingRead = { endpointSupported: true, rows: funding.length, nonempty: funding.length > 0 }

  if (executeModels) {
    db = new Database(statePath)
    chmodSync(statePath, 0o600)
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const prices = new Map()
    const symbols = ['ADA/USDT:USDT', 'DOGE/USDT:USDT']
    const allSymbols = [...symbols, 'BTC/USDT:USDT']
    const timeframes = ['15m', '1h', '4h']
    const riskLimits = { perOrderCapUsd: equity * 0.2, maxExposureUsd: equity * 0.25, maxLeverage: 0.25,
      dailyLossLimitUsd: equity * 0.01, maxDrawdownUsd: equity * 0.02, maxConsecutiveLosses: 2, maxSpreadBps: 10, maxOpenOrders: 2 }
    runtime = await createExecRuntime({ mode: 'paper', liveArmed: false, riskPct: 0.001, symbols, timeframes,
      benchmark: 'BTC/USDT:USDT', venue: 'htx', accountType: 'swap', limits: riskLimits,
      paperInitialEquityQuote: equity, reconcileMs: 60_000, settleMs: 60_000, priceOf: (symbol) => prices.get(symbol) }, { db, clock })
    const ports = runtime.getPorts()
    const observations = new MarketObservationStore(db)
    const source = createCcxtSource(exchange)
    const seriesStates = new Map()
    let lastMarketRefresh = 0
    const refreshMarket = async () => {
      const counts = []
      for (const symbol of allSymbols) {
        const ticker = await exchange.fetchTicker(symbol)
        prices.set(symbol, Number(ticker.last))
        const at = clock.now()
        observations.record({ kind: 'spec', symbol, timeframe: '', eventTime: at, availableAt: at, source: 'real htx loadMarkets', value: marketSpecification(symbol, exchange.markets[symbol], exchange.precisionMode) })
        for (const timeframe of timeframes) {
          const rows = await source.fetchOHLCV(symbol, timeframe, undefined, 160)
          const availableAt = clock.now()
          const candles = normalizeCandles(rows, symbol, timeframe, availableAt).candles.filter((candle) => candle.closed)
          event('market.series', { symbol, timeframe, received: rows.length, closed: candles.length })
          assert.ok(candles.length >= 64, 'real series must contain nonempty warmup')
          const key = `${symbol}:${timeframe}`
          const state = seriesStates.get(key) ?? { engine: new FeatureEngine(), known: new Map(), lastOpenTime: -1 }
          for (const candle of candles) {
            const previous = state.known.get(candle.openTime)
            assert.ok(previous === undefined || previous === fingerprint(candle), 'closed bar revision requires explicit recovery; stop sampling')
          }
          ports.bars.upsertClosed(candles, { source: 'real htx OHLCV', fetchedAt: availableAt })
          for (const candle of candles) {
            if (candle.openTime <= state.lastOpenTime) continue
            ports.features.upsert(state.engine.onClosedCandle(candle), availableAt)
            ports.bars.markProcessed(candle, availableAt)
            state.known.set(candle.openTime, fingerprint(candle))
            state.lastOpenTime = candle.openTime
          }
          seriesStates.set(key, state)
          counts.push({ symbol, timeframe, bars: candles.length })
        }
        const derivatives = await createCcxtDerivativesSource(exchange).fetch(symbol, clock.now(), symbol.replace(':USDT', ''))
        const availableAt = clock.now()
        observations.record({ kind: 'derivatives', symbol, timeframe: '', eventTime: derivatives.timestamp, availableAt,
          source: 'real htx derivative public endpoints', value: derivatives })
        write(`derivatives-${symbol.split('/')[0]}.json`, derivatives)
      }
      lastMarketRefresh = clock.now()
      report.phases.realMarket = { refreshedAt: lastMarketRefresh, series: counts, bars: counts.reduce((sum, row) => sum + row.bars, 0) }
    }
    await refreshMarket()
    await runtime.reconcileOnce()
    const ctx = new Context()
    llmFiber = await ctx.plugin(LlmRuntime)
    const connection = api === 'responses'
      ? { providers: { 'deepseek-responses': {
          apiKeyEnv: 'DEEPSEEK_API_KEY', api: 'openai-responses', baseURL: 'https://api.deepseek.com',
          reasoning: 'high', transport: 'sse', retryPolicy: { mode: 'normal', maxRetries: 0 },
          models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1_048_576, maxTokens,
            reasoningEfforts: { high: 'high' }, compat: { supportsStrictMode: false } }],
        } } }
      : { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', thinking: policy.thinking,
          reasoningEffort: policy.reasoningEffort, maxTokens, streamIdleTimeoutMs: 120_000 }
    const module = api === 'responses' ? PiAi : DeepSeek
    providerFiber = await ctx.plugin({ apply: module.apply, inject: module.inject }, connection)
    await ctx.llm.listModels(provider)
    const model = { stream: (options) => { modelInvocations += 1; return ctx.llm.stream(options) } }
    for (let index = 0; index < sampleCount; index += 1) {
      if (clock.now() - lastMarketRefresh >= 5 * 60_000) await refreshMarket()
      const spent = db.prepare("SELECT COALESCE(SUM(est_usd), 0) AS usd FROM budget_ledger WHERE scope = 'global'").get().usd
      assert.ok(spent < totalBudgetUsd, 'integration total budget exhausted')
      const day = new Date(clock.now()).toISOString().slice(0, 10)
      const spentToday = db.prepare("SELECT COALESCE(SUM(est_usd), 0) AS usd FROM budget_ledger WHERE scope = 'global' AND day = ?").get(day).usd
      const trigger = { source: ['W1', 'W2', 'W3'][index % 3], id: `connection-${policy.id}-${index}`, at: clock.now(), attempt: 1 }
      const symbol = symbols[index % symbols.length]
      const config = { strategy: 'critique', route: { provider, model: 'deepseek-flash', maxTokens, maxChars: 180_000 },
        // BudgetGuard 接受当日绝对上限，会再次扣除当日已花金额；不能把剩余额度直接当上限。
        dailyBudgetUsd: Math.min(dailyBudgetUsd, spentToday + totalBudgetUsd - spent), dailyTokenCap, planWindowMs: 14_400_000 }
      const result = await runDecisionRuntime({ ports, model, config, trigger, symbol, timeframe: '1h', signal: AbortSignal.timeout(300_000) })
      report.samples.push({ index, source: trigger.source, symbol, runId: result.runId, status: result.status,
        replayed: result.replayed, outcome: result.envelope?.outcome, eligibility: result.eligibility, reason: result.reason ?? null })
      event('model.sample_finished', report.samples.at(-1))
      write('report.json', report)
      const run = db.prepare('SELECT cost_known, final_json FROM decision_runs WHERE run_id = ?').get(result.runId)
      assert.equal(run.cost_known, 1, 'provider usage/cost unresolved; stop new calls')
      assert.equal(JSON.parse(run.final_json).failure, undefined, 'model workflow failed; inspect persisted trace')
      const beforeRepeat = modelInvocations
      const repeated = await runDecisionRuntime({ ports, model, config, trigger, symbol, timeframe: '1h' })
      assert.equal(repeated.replayed, true)
      assert.equal(modelInvocations, beforeRepeat, 'terminal run retry must not invoke provider')
      await runtime.reconcileOnce()
    }
    report.phases.model = { samples: report.samples.length, providerInvocations: modelInvocations, providerHttpCalls: modelHttpCalls,
      statuses: report.samples.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {}) }
    report.phases.cost = db.prepare("SELECT * FROM budget_ledger WHERE scope = 'global'").all()
    report.phases.paperOrders = db.prepare('SELECT state, COUNT(*) AS count FROM order_intents GROUP BY state').all()
  }
  report.status = 'passed'
} catch (error) {
  failed = error
  report.status = 'failed'
  report.error = String(error)
  event('validation.failed', { error: String(error) })
} finally {
  report.finishedAt = clock.now()
  report.httpCalls = httpCalls
  report.modelHttpCalls = modelHttpCalls
  report.modelInvocations = modelInvocations
  if (db) report.phases.cost = db.prepare("SELECT * FROM budget_ledger WHERE scope = 'global'").all()
  write('report.json', report)
  write(`attempt-${report.startedAt}.json`, report)
  await runtime?.dispose()
  await providerFiber?.dispose()
  await llmFiber?.dispose()
  await exchange.close()
  db?.close()
  globalThis.fetch = realFetch
}
console.log(JSON.stringify(redact({ status: report.status, output, phases: report.phases, samples: report.samples.length, error: report.error ?? null }), null, 2))
if (failed) process.exitCode = 1
