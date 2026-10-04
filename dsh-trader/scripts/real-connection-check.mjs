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
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as WsProvider from '../lib/plugins/sub2api-responses-ws.js'
import { readLunaGatewayConfig, lunaProviderConfig, traceResponsesWs } from './model-connection-config.mjs'
import {
  applyProxyAwareFetch, createCcxtDerivativesSource, createCcxtSource, createExecRuntime, DEEPSEEK_PRICE_SEED,
  FeatureEngine, fingerprint, HtxBroker, MarketObservationStore, marketSpecification,
  BudgetLedger, dispatchNextTrigger, HeartbeatStore, lunaGatewayReferencePrice, TriggerQueue,
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
assert.ok(['responses', 'chat-completions', 'sub2api-ws'].includes(api), 'unsupported model API')
const gateway = api === 'sub2api-ws' ? readLunaGatewayConfig(value('--codex-config', undefined)) : undefined
const provider = gateway ? WsProvider.SUB2API_RESPONSES_WS_PROVIDER : api === 'responses' ? 'deepseek-responses' : 'deepseek-official'
const modelId = gateway?.model ?? 'deepseek-flash'
const persistentDispatch = gateway !== undefined
const sampleCount = Number(value('--samples', '2'))
const maxTokens = Number(value('--max-output-tokens', '32768'))
const decisionTimeoutMs = Number(value('--decision-timeout-ms', '300000'))
const dailyBudgetUsd = Number(value('--daily-budget-usd', '2'))
const totalBudgetUsd = Number(value('--total-budget-usd', '5'))
const dailyTokenCap = Number(value('--daily-token-cap', '20000000'))
assert.ok(Number.isSafeInteger(sampleCount) && sampleCount > 0 && sampleCount <= 100)
assert.ok(Number.isSafeInteger(decisionTimeoutMs) && decisionTimeoutMs > 0 && decisionTimeoutMs <= 1_800_000, 'decision timeout must be 1..1800000 ms')
assert.ok(Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= 65536)
assert.ok(dailyBudgetUsd > 0 && dailyBudgetUsd <= 5 && totalBudgetUsd > 0 && totalBudgetUsd <= 10)
assert.ok(Number.isSafeInteger(dailyTokenCap) && dailyTokenCap > 0 && dailyTokenCap <= 30_000_000)
const apiKey = process.env.TRADER_API_KEY?.trim()
const apiSecret = process.env.TRADER_API_SECRET?.trim()
assert.ok(apiKey && apiSecret, 'HTX credentials missing')
if (executeModels) assert.ok(process.env[gateway?.apiKeyEnv ?? 'DEEPSEEK_API_KEY']?.trim(), 'model credential missing')
mkdirSync(output, { recursive: true, mode: 0o700 })
assert.equal((statSync(output).mode & 0o077), 0, 'output directory must be private')
const statePath = join(output, 'paper.sqlite')
if (existsSync(statePath) && !resume) throw new Error('state DB exists; use --resume, do not overwrite evidence')
const policyPath = join(output, 'policy.json')
const clock = systemClock()
const buildManifest = JSON.parse(readFileSync(new URL('../lib/build-manifest.json', import.meta.url), 'utf8'))
const versions = { ...buildManifest, validationScriptHash: fingerprint(readFileSync(new URL(import.meta.url), 'utf8')),
  connectionConfigHash: fingerprint(readFileSync(new URL('./model-connection-config.mjs', import.meta.url), 'utf8')) }
const secrets = [apiKey, apiSecret, process.env.DEEPSEEK_API_KEY, process.env.SUB2API_KEY].filter(Boolean)
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
  dailyBudgetUsd, totalBudgetUsd, dailyTokenCap, maxTokens, decisionTimeoutMs,
  api, provider, model: modelId, gateway, persistentDispatch, thinking: 'enabled', reasoningEffort: gateway?.reasoningEffort ?? 'high',
  referencePriceOnly: gateway !== undefined, gatewayInvoiceVerified: false, credentialScope: 'authorized .env key; test state isolated, provider account isolation not asserted',
}
assert.equal(policy.dailyBudgetUsd, dailyBudgetUsd)
assert.equal(policy.totalBudgetUsd, totalBudgetUsd)
assert.equal(policy.dailyTokenCap, dailyTokenCap)
assert.equal(policy.maxTokens, maxTokens)
assert.equal(policy.decisionTimeoutMs, decisionTimeoutMs)
assert.equal(policy.api, api)
assert.equal(policy.model, modelId)
assert.deepEqual(policy.gateway, gateway)
assert.equal(policy.persistentDispatch, persistentDispatch)
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
let credentialsFiber
let restoreWs
let wsRequests = 0
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
    new PriceTableStore(db).seed(gateway ? [lunaGatewayReferencePrice(policy.createdAt)] : DEEPSEEK_PRICE_SEED)
    const heartbeat = new HeartbeatStore(db)
    heartbeat.beat(clock.now())
    const queue = new TriggerQueue(db)
    const budget = new BudgetLedger(db)
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
    if (gateway) {
      credentialsFiber = await ctx.plugin(CredentialsLocal, { dshHome: process.env.DSH_HOME ?? '/home/ubuntu/.dsh', watch: false })
      restoreWs = await traceResponsesWs((kind, detail) => {
        if (kind === 'ws.connect') {
          const requestId = detail.headers['x-client-request-id']
          const matching = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind='model_call_reserved' AND json_extract(payload_json, '$.callAttemptId')=?").get(requestId)
          assert.equal(matching.n, 1, 'WS header must match exactly one persisted reservation')
          report.phases.wsRequestCorrelation ??= { observed: 0, matched: 0 }
          report.phases.wsRequestCorrelation.observed += 1
          report.phases.wsRequestCorrelation.matched += matching.n
        }
        appendFileSync(join(output, 'ws.jsonl'), JSON.stringify(redact({ at: clock.now(), kind, detail })) + '\n', { mode: 0o600 })
      }, (request) => {
          wsRequests += 1
          assert.equal(request.model, gateway.wireModelId)
          assert.equal(request.reasoning?.effort, 'max')
          assert.equal(request.temperature, undefined)
        })
      providerFiber = await ctx.plugin({ apply: WsProvider.apply, inject: WsProvider.inject }, lunaProviderConfig(gateway, maxTokens))
    } else {
      const module = api === 'responses' ? PiAi : DeepSeek
      providerFiber = await ctx.plugin({ apply: module.apply, inject: module.inject }, connection)
    }
    await ctx.llm.listModels(provider)
    const model = { stream: (options) => { modelInvocations += 1; heartbeat.beat(clock.now()); return ctx.llm.stream(options) } }
    for (let index = 0; index < sampleCount; index += 1) {
      if (clock.now() - lastMarketRefresh >= 5 * 60_000) await refreshMarket()
      const spent = db.prepare("SELECT COALESCE(SUM(est_usd), 0) AS usd FROM budget_ledger WHERE scope = 'global'").get().usd
      assert.ok(spent < totalBudgetUsd, 'integration total budget exhausted')
      const day = new Date(clock.now()).toISOString().slice(0, 10)
      const spentToday = db.prepare("SELECT COALESCE(SUM(est_usd), 0) AS usd FROM budget_ledger WHERE scope = 'global' AND day = ?").get(day).usd
      // at 属于 run identity；重启重新取墙钟会让同一事件变成新付费请求。首次领取前持久化它。
      const triggerName = `trigger-${index}.json`
      const triggerPath = join(output, triggerName)
      const triggerAt = clock.now()
      const trigger = existsSync(triggerPath) ? JSON.parse(readFileSync(triggerPath, 'utf8')) : {
        source: ['W1', 'W2', 'W3'][index % 3], id: `connection-${policy.id}-${index}`, at: triggerAt, attempt: 1,
        ...(persistentDispatch && index % 3 !== 0 ? { expiresAt: triggerAt + Math.max(15 * 60_000, decisionTimeoutMs + 60_000) } : {}),
      }
      assert.equal(trigger.id, `connection-${policy.id}-${index}`)
      assert.equal(trigger.source, ['W1', 'W2', 'W3'][index % 3])
      assert.ok(Number.isSafeInteger(trigger.at) && trigger.at >= policy.createdAt)
      if (!existsSync(triggerPath)) write(triggerName, trigger)
      const symbol = symbols[index % symbols.length]
      const config = { strategy: 'critique', route: { provider, model: modelId, maxTokens, maxChars: 180_000 },
        // BudgetGuard 接受当日绝对上限，会再次扣除当日已花金额；不能把剩余额度直接当上限。
        dailyBudgetUsd: Math.min(dailyBudgetUsd, spentToday + totalBudgetUsd - spent), dailyTokenCap, planWindowMs: 14_400_000 }
      heartbeat.beat(clock.now())
      const run = () => runDecisionRuntime({ ports, model, config, trigger, symbol, timeframe: '1h', signal: AbortSignal.timeout(decisionTimeoutMs) })
      let result
      if (persistentDispatch && trigger.source !== 'W1') {
        queue.enqueue({ triggerId: trigger.id, dedupKey: trigger.id, symbol,
          purpose: trigger.source === 'W2' ? 'commitment' : 'novelty',
          disposition: trigger.source === 'W2' ? 'judgment' : 'novelty', state: 'queued',
          createdAt: trigger.at, expiresAt: trigger.expiresAt, payload: { timeframe: '1h', authorizedConnectionTest: true } })
        if (queue.get(trigger.id)?.state === 'done') result = await run()
        else {
          const dispatched = await dispatchNextTrigger({ queue, budget, journal: ports.journal, clock,
            symbols, timeframes, dailyBudgetUsd: config.dailyBudgetUsd, dailyTokenCap,
            retryPolicy: { maxAttempts: 1 },
            run: async ({ trigger: claimed, source, symbol: claimedSymbol, timeframe }) => {
              assert.equal(claimed.triggerId, trigger.id)
              assert.equal(source, trigger.source)
              assert.equal(claimedSymbol, symbol)
              assert.equal(timeframe, '1h')
              result = await run()
              return result
            } })
          event('trigger.dispatched', dispatched)
          assert.equal(dispatched.kind, 'processed', 'persistent wake must be claimed and consumed')
        }
        assert.equal(queue.get(trigger.id)?.state, 'done')
      } else result = await run()
      assert.ok(result, 'nonempty runtime result required')
      report.samples.push({ index, source: trigger.source, symbol, runId: result.runId, status: result.status,
        replayed: result.replayed, outcome: result.envelope?.outcome, eligibility: result.eligibility, reason: result.reason ?? null })
      event('model.sample_finished', report.samples.at(-1))
      write('report.json', report)
      const persistedRun = db.prepare('SELECT cost_known, final_json FROM decision_runs WHERE run_id = ?').get(result.runId)
      assert.equal(persistedRun.cost_known, 1, 'provider usage/cost unresolved; stop new calls')
      assert.equal(JSON.parse(persistedRun.final_json).failure, undefined, 'model workflow failed; inspect persisted trace')
      const beforeRepeat = modelInvocations
      const repeated = await runDecisionRuntime({ ports, model, config, trigger, symbol, timeframe: '1h' })
      assert.equal(repeated.replayed, true)
      assert.equal(modelInvocations, beforeRepeat, 'terminal run retry must not invoke provider')
      await runtime.reconcileOnce()
    }
    if (persistentDispatch) {
      const invokedBeforeGuards = modelInvocations
      let guardCallbacks = 0
      const guard = async (name, purpose, overrides = {}) => {
        const at = clock.now()
        const id = `guard-${policy.id}-${name}`
        const previous = queue.get(id)
        if (previous !== undefined) {
          const expectedKind = name === 'expired' ? 'trigger.expired' : name === 'no-budget' ? 'trigger.wake_suppressed' : 'trigger.p0_frozen'
          const audit = db.prepare("SELECT seq FROM audit_events WHERE kind = ? AND json_extract(payload_json, '$.triggerId') = ?").get(expectedKind, id)
          assert.ok(audit, 'guard replay requires original nonempty audit evidence')
          assert.ok(['expired', 'failed', 'done'].includes(previous.state), 'cannot silently repeat unresolved guard')
          return { name, state: previous.state, outcome: 'replayed', reason: previous.lastError, auditSeq: audit.seq }
        }
        queue.enqueue({ triggerId: id, dedupKey: id, symbol: symbols[0], purpose,
          disposition: purpose === 'novelty' ? 'novelty' : 'judgment', state: 'queued',
          createdAt: name === 'expired' ? at - 100 : at,
          ...(name === 'expired' ? { expiresAt: at - 1 } : {}), payload: { timeframe: '1h' } })
        const result = await dispatchNextTrigger({ queue, budget, journal: ports.journal, clock, symbols, timeframes,
          dailyBudgetUsd: name === 'no-budget' ? undefined : configBudget(), dailyTokenCap,
          retryPolicy: { maxAttempts: 1 }, freezeSymbol: ports.freezeSymbol, halt: ports.halt,
          run: async () => { guardCallbacks += 1; throw Error('guard incorrectly reached model callback') }, ...overrides })
        const row = queue.get(id)
        assert.ok(row, 'nonempty guard trigger required')
        return { name, state: row.state, outcome: result.kind, reason: row.lastError ?? result.reason }
      }
      const configBudget = () => dailyBudgetUsd
      const guards = [await guard('expired', 'commitment'), await guard('no-budget', 'commitment'),
        await guard('invalidation', 'invalidation')]
      assert.deepEqual(guards.map(row => row.state), ['expired', 'failed', 'done'])
      assert.ok(['frozen', 'replayed'].includes(guards[2].outcome))
      assert.ok(guards[1].reason.includes('未配置正数日预算'), 'budget guard must exercise missing budget')
      assert.equal(modelInvocations, invokedBeforeGuards, 'safety guards must not spend model tokens')
      assert.equal(guardCallbacks, 0, 'safety guards must not reach judgment callback')
      report.phases.triggerGuards = { samples: guards, providerInvocations: 0, passed: true }
      report.phases.persistentTriggers = db.prepare('SELECT trigger_id, purpose, state, attempts, last_error FROM triggers').all()
    }
    report.phases.model = { samples: report.samples.length, providerInvocations: modelInvocations, providerHttpCalls: modelHttpCalls, providerWsRequests: wsRequests,
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
  report.providerWsRequests = wsRequests
  if (db) report.phases.cost = db.prepare("SELECT * FROM budget_ledger WHERE scope = 'global'").all()
  write('report.json', report)
  write(`attempt-${report.startedAt}.json`, report)
  await runtime?.dispose()
  await providerFiber?.dispose()
  await llmFiber?.dispose()
  await credentialsFiber?.dispose()
  restoreWs?.()
  await exchange.close()
  db?.close()
  globalThis.fetch = realFetch
}
console.log(JSON.stringify(redact({ status: report.status, output, phases: report.phases, samples: report.samples.length, error: report.error ?? null }), null, 2))
if (failed) process.exitCode = 1
