import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReplayClock } from '../src/clock.js'
import { EXAMPLE_LIMITS } from '../src/config.js'
import { DEEPSEEK_PRICE_SEED } from '../src/cost.js'
import { BudgetLedger, PriceTableStore } from '../src/cost-ledger.js'
import { migrate } from '../src/db/schema.js'
import type { AccountSnapshot, Broker } from '../src/exec/broker.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { PaperBroker } from '../src/exec/paper.js'
import type { TradePorts } from '../src/exec/ports.js'
import { BarArchive } from '../src/market/archive.js'
import { FeatureArchive } from '../src/market/feature-archive.js'
import { FeatureEngine } from '../src/market/features.js'
import { MarketObservationStore } from '../src/market/observations.js'
import { normalizeCandles, timeframeMs } from '../src/market/normalize.js'
import { PlanStore } from '../src/plan/store.js'
import { decisionRunId, runDecisionRuntime } from '../src/agents/decision-runtime.js'
import { DECISION_ENVELOPE_SCHEMA_VERSION } from '../src/agents/decision-envelope.js'
import { DecisionRunStore } from '../src/agents/decision-run-store.js'
import { DECISION_WORKFLOW_PROMPT_VERSION, type DecisionModel } from '../src/agents/decision-workflow.js'
import { raw } from './helpers/market.js'

const AS_OF = Date.UTC(2026, 8, 20, 12)
const SYMBOL = 'BTC/USDT:USDT'

class FakeDecisionModel implements DecisionModel {
  calls = 0
  constructor(
    private readonly output: unknown,
    private readonly onStream?: () => void,
    private readonly includeUsage = true,
  ) {}
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    this.onStream?.()
    if (this.includeUsage) yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 80, totalTokens: 380 } } as StreamChunk
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'r3-call', name: String(options.tools?.[0]?.name), arguments: JSON.stringify(this.output) },
    } as unknown as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk
  }
}

class SequencedDecisionModel implements DecisionModel {
  calls = 0
  constructor(private readonly outputs: readonly unknown[]) {}
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const output = this.outputs[this.calls]
    this.calls += 1
    const tool = options.tools?.[0]
    yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 60, totalTokens: 260 } } as StreamChunk
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: `sequence-${this.calls}`, name: String(tool?.name), arguments: JSON.stringify(output) },
    } as unknown as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk
  }
}

function makeRuntime(db: Database.Database, brokerOverride?: Broker, clockOverride?: ReplayClock) {
  const clock = clockOverride ?? new ReplayClock(AS_OF)
  const journal = new DecisionJournal(db)
  const bars = new BarArchive(db)
  const features = new FeatureArchive(db)
  const plans = new PlanStore(db)
  const account: AccountSnapshot = {
    venue: 'paper', equityQuote: 1_000, freeMarginQuote: 900, totalExposureUsd: 0,
    pendingExposureUsd: 0, openOrders: 0, leverage: 0, dailyLossUsd: 0, drawdownUsd: 0,
    consecutiveLosses: 0, spreadBps: 1, observedAt: AS_OF,
  }
  const broker = brokerOverride ?? {
    venue: 'paper' as const,
    getAccount: async () => account,
    getPositions: async () => [],
    getOpenOrders: async () => [],
  } as unknown as Broker
  const ports: TradePorts = {
    db, bars, features, plans, journal, broker, clock,
    limits: EXAMPLE_LIMITS, mode: 'paper', liveArmed: false, waiver: false, riskPct: 0.002,
    symbols: [SYMBOL], timeframes: ['15m', '1h', '4h'], benchmark: SYMBOL,
    frozenSymbols: () => new Set(),
  }
  return { ports, clock, journal, plans }
}

function seedExecutableContext(db: Database.Database, runtime: ReturnType<typeof makeRuntime>): void {
  const { bars, features, journal } = runtime.ports
  const observations = new MarketObservationStore(db)
  for (const timeframe of ['15m', '1h', '4h']) {
    const engine = new FeatureEngine()
    const step = timeframeMs(timeframe)
    const start = AS_OF - 64 * step
    const candles = normalizeCandles(Array.from({ length: 64 }, (_, index) => {
      const openTime = start + index * step
      const close = 100 + index * 0.03 + (index % 5) * 0.01
      return raw(openTime, close, { open: close, high: close + 0.2, low: close - 0.2 })
    }), SYMBOL, timeframe, AS_OF).candles
    for (const candle of candles) {
      bars.upsertClosed([candle], { source: 'decision-runtime-test', fetchedAt: candle.closeTime })
      features.upsert(engine.onClosedCandle(candle), candle.closeTime)
    }
  }
  observations.record({
    kind: 'spec', symbol: SYMBOL, timeframe: '', eventTime: AS_OF - 100, availableAt: AS_OF - 100,
    source: 'decision-runtime-test', value: {
      symbol: SYMBOL, linear: true, contractSize: 1, amountStepContracts: 0.001,
      priceStep: 0.01, minAmountContracts: 0.001, minNotionalQuote: 1,
      makerFeeRate: 0.0002, takerFeeRate: 0.0005,
    },
  })
  db.prepare('INSERT INTO config_versions (ts, author, params_json) VALUES (?, ?, ?)')
    .run(AS_OF - 100, 'test', JSON.stringify({ mode: 'paper' }))
  db.prepare('INSERT INTO heartbeat (id, beat_at, halted) VALUES (1, ?, 0)').run(AS_OF)
  journal.appendAudit({
    actor: 'system', kind: 'reconcile_report',
    payload: { acknowledgeOrphans: false, result: { actions: [], consistent: true, freezeTrading: false }, applied: [] },
    ts: AS_OF,
  })
}

const noTrade = {
  outcome: 'no_trade',
  thesis: '固定 fixture 未观察到可执行优势',
  rejectedAlternatives: ['开仓'],
  claims: [],
  uncertainties: ['样本不足'],
  confidence: 0.2,
  riskFraction: 1,
}

const trigger = { source: 'W1' as const, id: 'w1-12', at: AS_OF, attempt: 0 }
const config = {
  strategy: 'single' as const,
  route: { provider: 'test-provider', model: 'deepseek-flash', maxTokens: 256, maxChars: 180_000 },
  dailyBudgetUsd: 1,
  planWindowMs: 4 * 3_600_000,
}

describe('R3 decision runtime', () => {
  it('binds prompt/schema versions, route and output budgets while keeping retries on the same identity', () => {
    const identity = {
      trigger,
      symbol: SYMBOL,
      strategy: 'single' as const,
      route: config.route,
      promptVersion: `${DECISION_WORKFLOW_PROMPT_VERSION}:single:schema-${DECISION_ENVELOPE_SCHEMA_VERSION}`,
      schemaVersion: DECISION_ENVELOPE_SCHEMA_VERSION,
      planWindowMs: config.planWindowMs,
    }
    const base = decisionRunId(identity)
    expect(decisionRunId({ ...identity, promptVersion: 'next-prompt' })).not.toBe(base)
    expect(decisionRunId({ ...identity, schemaVersion: 'next-schema' })).not.toBe(base)
    expect(decisionRunId({ ...identity, route: { ...config.route, maxTokens: config.route.maxTokens + 1 } })).not.toBe(base)
    expect(decisionRunId({ ...identity, route: { ...config.route, maxChars: config.route.maxChars + 1 } })).not.toBe(base)
    expect(decisionRunId({ ...identity, route: { ...config.route, provider: 'other-provider' } })).not.toBe(base)
    expect(decisionRunId({
      ...identity, trigger: { ...trigger, attempt: trigger.attempt + 1 },
    })).toBe(base)
  })

  it('persists the exact R2 context/run, accounts real usage, and idempotently avoids a second model call', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    db.prepare('INSERT INTO config_versions (ts, author, params_json) VALUES (?, ?, ?)')
      .run(AS_OF - 1, 'test', JSON.stringify({ apiSecret: 'MODEL-TRACE-MUST-REDACT' }))
    const runtime = makeRuntime(db)
    const model = new FakeDecisionModel(noTrade)
    try {
      const first = await runDecisionRuntime({
        ...runtime, model, config, trigger, symbol: SYMBOL, timeframe: '1h',
      })
      expect(first.status).toBe('completed')
      expect(first.replayed).toBe(false)
      expect(first.envelope).toMatchObject({ outcome: 'no_trade', runId: first.runId, contextHash: first.contextHash })
      expect(new DecisionRunStore(db).get(first.runId)).toMatchObject({
        status: 'completed', costKnown: true, tokensIn: 300, tokensOut: 80,
      })
      const traceRows = db.prepare("SELECT payload_json FROM audit_events WHERE kind = 'model_call_accounted'").all() as { payload_json: string }[]
      expect(traceRows).toHaveLength(1)
      const trace = JSON.parse(traceRows[0]!.payload_json) as {
        runId: string; durationMs: number | null; request: { requestHash: string; messages: readonly unknown[] }; responseHash: string
      }
      expect(trace.runId).toBe(first.runId)
      expect(trace.request.requestHash).toMatch(/^sha256:/)
      expect(trace.request.messages.length).toBeGreaterThan(0)
      expect(trace.responseHash).toMatch(/^sha256:/)
      expect(trace.durationMs).not.toBeNull()
      expect(traceRows[0]?.payload_json).not.toContain('MODEL-TRACE-MUST-REDACT')
      const attemptRows = db.prepare("SELECT payload_json FROM audit_events WHERE kind = 'decision_run_attempt_started'").all() as { payload_json: string }[]
      expect(attemptRows).toHaveLength(1)
      expect(JSON.parse(attemptRows[0]!.payload_json)).toMatchObject({
        runId: first.runId,
        provider: config.route.provider,
        model: config.route.model,
        dailyBudgetUsd: config.dailyBudgetUsd,
        dailyTokenCap: null,
        trigger: { source: trigger.source, id: trigger.id, attempt: trigger.attempt },
        contextHash: first.contextHash,
      })
      expect(attemptRows[0]?.payload_json).not.toContain('MODEL-TRACE-MUST-REDACT')
      expect(runtime.journal.recentDecisions().map((item) => item.action)).toContain('no_trade')
      expect(new BudgetLedger(db).dashboard({ day: '2026-09-20' }).some((row) => row.costKnown && row.estUsd > 0)).toBe(true)

      const replayed = await runDecisionRuntime({
        ...runtime, model, config, trigger, symbol: SYMBOL, timeframe: '1h',
      })
      expect(replayed.replayed).toBe(true)
      expect(model.calls).toBe(1)
    } finally {
      db.close()
    }
  })

  it('uses a new run instead of replaying a terminal result after route/output budget changes', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const runtime = makeRuntime(db)
    const model = new FakeDecisionModel(noTrade)
    try {
      const first = await runDecisionRuntime({
        ...runtime, model, config,
        trigger: { ...trigger, id: 'w1-route-version' }, symbol: SYMBOL, timeframe: '1h',
      })
      const changed = await runDecisionRuntime({
        ...runtime, model,
        config: { ...config, route: { ...config.route, maxTokens: config.route.maxTokens + 1, maxChars: config.route.maxChars + 1 } },
        trigger: { ...trigger, id: 'w1-route-version' }, symbol: SYMBOL, timeframe: '1h',
      })
      expect(first.status).toBe('completed')
      expect(changed.status).toBe('completed')
      expect(changed.replayed).toBe(false)
      expect(changed.runId).not.toBe(first.runId)
      expect(model.calls).toBe(2)
      expect(db.prepare('SELECT COUNT(*) AS n FROM decision_runs').get()).toMatchObject({ n: 2 })
    } finally {
      db.close()
    }
  })

  it('missing explicit model budget fails closed before any provider call', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const runtime = makeRuntime(db)
    const model = new FakeDecisionModel(noTrade)
    try {
      const result = await runDecisionRuntime({
        ...runtime,
        model,
        config: { ...config, dailyBudgetUsd: undefined },
        trigger: { ...trigger, id: 'w1-budget-missing' },
        symbol: SYMBOL,
        timeframe: '1h',
      })
      expect(result.status).toBe('review')
      expect(result.reason).toContain('未配置正数日预算')
      expect(model.calls).toBe(0)
      expect(new DecisionRunStore(db).get(result.runId)?.status).toBe('review')
    } finally {
      db.close()
    }
  })

  it('persists sanitized request/partial response traces and unknown cost on provider failure', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const runtime = makeRuntime(db)
    const rawSecret = 'MODEL-TRACE-SECRET-DO-NOT-PERSIST'
    const model: DecisionModel & { calls: number } = {
      calls: 0,
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.calls += 1
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ apiSecret: rawSecret }) } as StreamChunk
        throw new Error(`upstream apiKey=${rawSecret}`)
      },
    }
    try {
      const result = await runDecisionRuntime({
        ...runtime, model, config,
        trigger: { ...trigger, id: 'w1-provider-failure' },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(result).toMatchObject({ status: 'review', retryable: true })
      expect(model.calls).toBe(1)
      expect(new DecisionRunStore(db).get(result.runId)).toMatchObject({ status: 'running', costKnown: false })
      const rows = db.prepare("SELECT payload_json FROM audit_events WHERE kind = 'model_call_failed'").all() as { payload_json: string }[]
      expect(rows).toHaveLength(1)
      const trace = JSON.parse(rows[0]!.payload_json) as { request?: unknown; response?: unknown; error?: string; durationMs?: number }
      expect(trace.request).toBeDefined()
      expect(trace.response).toBeDefined()
      expect(trace.error).toContain('apiKey=[REDACTED]')
      expect(trace.durationMs).toBeGreaterThanOrEqual(0)
      expect(rows[0]?.payload_json).not.toContain(rawSecret)
    } finally {
      db.close()
    }
  })

  it('retains each repair request/response and cost trace while redacting model-emitted secret-shaped fields', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const runtime = makeRuntime(db)
    const secret = 'MODEL-OUTPUT-SECRET-DO-NOT-STORE'
    const model = new SequencedDecisionModel([{ ...noTrade, apiSecret: secret }, noTrade])
    try {
      const result = await runDecisionRuntime({
        ...runtime, model, config,
        trigger: { ...trigger, id: 'w1-repair-audit' },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(result.status).toBe('completed')
      expect(model.calls).toBe(2)
      expect(new DecisionRunStore(db).get(result.runId)?.final).toMatchObject({ workflow: { repairCalls: 1 } })
      const rows = db.prepare("SELECT payload_json FROM audit_events WHERE kind = 'model_call_accounted' ORDER BY seq").all() as { payload_json: string }[]
      expect(rows).toHaveLength(2)
      const traces = rows.map((row) => JSON.parse(row.payload_json) as {
        requestHash: string; responseHash: string; durationMs: number | null; costKnown: boolean; response: unknown
      })
      expect(traces.every((trace) => trace.requestHash.startsWith('sha256:') && trace.responseHash.startsWith('sha256:'))).toBe(true)
      expect(traces.every((trace) => trace.durationMs !== null && trace.costKnown)).toBe(true)
      expect(rows.map((row) => row.payload_json).join('\n')).not.toContain(secret)
      expect(rows[0]?.payload_json).toContain('[REDACTED]')
    } finally {
      db.close()
    }
  })

  it('decision_only refuses protection edits and cancel_all based on action name alone', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const runtime = makeRuntime(db)
    seedExecutableContext(db, runtime)
    try {
      for (const [index, action] of [
        { action: 'set_target', price: 120 },
        { action: 'set_trailing', percent: 0.5 },
        { action: 'cancel_all', scope: 'all' },
      ].entries()) {
        const model = new FakeDecisionModel({
          outcome: 'act', thesis: '状态不足时不改变保护与挂单', rejectedAlternatives: [],
          claims: [], uncertainties: ['仅凭动作名无法证明风险下降'], confidence: 0.4, riskFraction: 1,
          immediateAction: action,
        })
        const result = await runDecisionRuntime({
          ...runtime, model, config,
          trigger: { ...trigger, id: `w1-decision-only-action-${index}` },
          symbol: SYMBOL, timeframe: '1h',
        })
        expect(result).toMatchObject({ status: 'review', eligibility: { state: 'decision_only' } })
        const decisions = db.prepare('SELECT action, executed FROM decisions WHERE run_id = ?').all(result.runId) as { action: string; executed: number }[]
        if (action.action === 'set_target' || action.action === 'set_trailing') {
          expect(decisions).toMatchObject([{ action: action.action, executed: 0 }])
        }
        else expect(decisions).toEqual([])
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM order_intents WHERE type = 'protective'").get()).toMatchObject({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('decision_only may add an initial remote stop, but cannot replace an existing algorithm stop', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const clock = new ReplayClock(AS_OF)
    const paper = new PaperBroker({ clock, book: { price: () => 102 }, initialEquityQuote: 1_000, slippageBps: 0, feeBps: 0 })
    await paper.placeOrder({
      intentId: 'seed-open', clientOrderId: 'seed-open', decisionId: 'seed-open',
      symbol: SYMBOL, type: 'market', side: 'buy', qty: 1, notionalUsd: 100,
    })
    const runtime = makeRuntime(db, paper, clock)
    seedExecutableContext(db, runtime)
    const model = new FakeDecisionModel({
      outcome: 'act', thesis: '只收紧已有保护', rejectedAlternatives: [], claims: [], uncertainties: [],
      confidence: 0.5, riskFraction: 1, immediateAction: { action: 'set_stop', price: 98 },
    })
    try {
      const result = await runDecisionRuntime({
        ...runtime, model, config,
        trigger: { ...trigger, id: 'w2-tighten-existing-stop', source: 'W2' },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(result).toMatchObject({ status: 'completed', eligibility: { state: 'decision_only' } })
      expect((await paper.getPositions()).find((position) => position.symbol === SYMBOL)?.protectedStopPrice).toBe(98)
      expect(db.prepare('SELECT action, executed FROM decisions WHERE run_id = ?').get(result.runId)).toMatchObject({ action: 'set_stop', executed: 1 })

      const target = await runDecisionRuntime({
        ...runtime,
        model: new FakeDecisionModel({
          outcome: 'act', thesis: '已有有效 stop 限制下行，添加盈利方向目标', rejectedAlternatives: [], claims: [], uncertainties: [],
          confidence: 0.5, riskFraction: 1, immediateAction: { action: 'set_target', price: 110 },
        }),
        config,
        trigger: { ...trigger, id: 'w2-set-target-with-stop', source: 'W2' },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(target).toMatchObject({ status: 'completed', eligibility: { state: 'decision_only' } })
      expect(db.prepare('SELECT action, executed FROM decisions WHERE run_id = ?').get(target.runId)).toMatchObject({ action: 'set_target', executed: 1 })

      const trailing = await runDecisionRuntime({
        ...runtime,
        model: new FakeDecisionModel({
          outcome: 'act', thesis: '在现有硬 stop 上添加 reduce-only trailing', rejectedAlternatives: [], claims: [], uncertainties: [],
          confidence: 0.5, riskFraction: 1, immediateAction: { action: 'set_trailing', percent: 0.5 },
        }),
        config,
        trigger: { ...trigger, id: 'w2-set-trailing-with-stop', source: 'W2' },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(trailing).toMatchObject({ status: 'completed', eligibility: { state: 'decision_only' } })
      expect(db.prepare('SELECT action, executed FROM decisions WHERE run_id = ?').get(trailing.runId)).toMatchObject({ action: 'set_trailing', executed: 1 })

      const loosen = await runDecisionRuntime({
        ...runtime,
        model: new FakeDecisionModel({
          outcome: 'act', thesis: '已有远端止损不可在非原子路径重复替换', rejectedAlternatives: [], claims: [], uncertainties: [],
          confidence: 0.5, riskFraction: 1, immediateAction: { action: 'set_stop', price: 99 },
        }),
        config,
        trigger: { ...trigger, id: 'w2-loosen-existing-stop', source: 'W2' },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(loosen).toMatchObject({ status: 'review', reason: expect.stringContaining('不支持原子替换') })
      expect((await paper.getPositions()).find((position) => position.symbol === SYMBOL)?.protectedStopPrice).toBe(98)
    } finally {
      db.close()
    }
  })

  it('fresh eligible open executes through the shared hard-gated action path and protects the position', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const clock = new ReplayClock(AS_OF)
    const paper = new PaperBroker({
      clock,
      book: { price: () => 102 },
      initialEquityQuote: 1_000,
      slippageBps: 0,
      feeBps: 0,
    })
    const runtime = makeRuntime(db, paper, clock)
    seedExecutableContext(db, runtime)
    const latestClose = runtime.ports.bars.recentClosedBars(SYMBOL, '1h', 1)[0]!.close
    const model = new FakeDecisionModel({
      outcome: 'act',
      thesis: '测试条件满足',
      rejectedAlternatives: ['等待'],
      claims: [{
        kind: 'observation', statement: '1h close 可用',
        evidencePaths: ['/sections/market/value/timeframes/1h/features/close/value'],
      }],
      uncertainties: [], confidence: 0.6, riskFraction: 0.5,
      immediateAction: {
        action: 'open', side: 'long', method: 'market',
        stop: { method: 'structure', level: latestClose - 5 },
      },
    })
    try {
      const result = await runDecisionRuntime({
        ...runtime, model, config, trigger: { ...trigger, id: 'w1-eligible-open' }, symbol: SYMBOL, timeframe: '1h',
      })

      expect(result).toMatchObject({ status: 'completed', eligibility: { state: 'risk_gate_required' } })
      expect((await paper.getPositions()).some((position) => position.qty > 0 && position.protectedStopPrice !== undefined)).toBe(true)
      const decision = db.prepare('SELECT action, executed, size_qty FROM decisions WHERE run_id = ?').get(result.runId) as {
        action: string; executed: number; size_qty: number
      }
      expect(decision).toMatchObject({ action: 'open', executed: 1 })
      expect(decision.size_qty * 5).toBeCloseTo(1, 6) // equity 1000 × configured 0.2% × envelope riskFraction 0.5
    } finally {
      db.close()
    }
  })

  it('unknown model cost downgrades valid immediate and planned opens without saving or placing orders', async () => {
    const base = {
      outcome: 'act', thesis: '有效开仓候选', rejectedAlternatives: ['等待'],
      claims: [], uncertainties: [], confidence: 0.6, riskFraction: 0.5,
    }
    const open = { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 95 } }
    const scenarios = [
      { name: 'immediate', output: { ...base, immediateAction: open } },
      { name: 'plan commitment', output: {
        ...base,
        plan: {
          thesis: '开仓承诺', confidence: 0.6, keyLevels: [], forbidden: [], noTrade: false,
          invalidation: [{ id: 'inv', tf: '1h', when: 'bar.close < 90', then: { action: 'close' } }],
          commitments: [{ id: 'entry', seq: 1, tf: '1h', when: 'position.qty == 0 and bar.close > 0', then: open }],
        },
      } },
    ]
    expect(scenarios).toHaveLength(2)

    for (const scenario of scenarios) {
      const db = new Database(':memory:')
      migrate(db)
      new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
      const clock = new ReplayClock(AS_OF)
      const paper = new PaperBroker({ clock, book: { price: () => 102 }, initialEquityQuote: 1_000, slippageBps: 0, feeBps: 0 })
      const runtime = makeRuntime(db, paper, clock)
      seedExecutableContext(db, runtime)
      const model = new FakeDecisionModel(scenario.output, undefined, false)
      try {
        const result = await runDecisionRuntime({
          ...runtime, model, config,
          trigger: { ...trigger, id: `w1-unknown-cost-${scenario.name}` },
          symbol: SYMBOL, timeframe: '1h',
        })
        expect(result).toMatchObject({ status: 'review', eligibility: { state: 'decision_only' } })
        expect(result.eligibility?.reasons).toContain('model call cost or usage is unknown')
        expect(new DecisionRunStore(db).get(result.runId)).toMatchObject({ status: 'review', costKnown: false })
        expect(runtime.plans.count(SYMBOL)).toBe(0)
        expect(runtime.journal.intentIds()).toEqual([])
        expect(await paper.getPositions()).toEqual([])
      } finally {
        db.close()
      }
    }
  })

  it('eligible DecisionEnvelope.plan binds identity in code and saves exactly one active card', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const runtime = makeRuntime(db)
    seedExecutableContext(db, runtime)
    const model = new FakeDecisionModel({
      outcome: 'act', thesis: '冻结市场证据满足执行前提', rejectedAlternatives: ['等待'],
      claims: [{ kind: 'observation', statement: '1h close 可用', evidencePaths: ['/sections/market/value/timeframes/1h/features/close/value'] }],
      uncertainties: [], confidence: 0.6, riskFraction: 0.5,
      plan: {
        thesis: '价格维持在失效位上方才允许持仓', confidence: 0.6, keyLevels: [], forbidden: [], noTrade: false,
        invalidation: [{ id: 'inv-close', tf: '1h', when: 'bar.close < 90', then: { action: 'close' } }],
        commitments: [{ id: 'open-long', seq: 1, tf: '1h', when: 'position.qty == 0 and bar.close > 0', then: {
          action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 90 },
        } }],
      },
    })
    try {
      const result = await runDecisionRuntime({
        ...runtime, model, config,
        trigger: { ...trigger, id: 'w1-plan-materialization' },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(result).toMatchObject({ status: 'completed', eligibility: { state: 'risk_gate_required' } })
      const card = runtime.plans.active(SYMBOL)
      expect(card).toMatchObject({ planId: result.planId, runId: result.runId, symbol: SYMBOL })
      expect(card?.commitments[0]?.then).toMatchObject({ action: 'open', riskFraction: 0.5 })
      expect(runtime.plans.count(SYMBOL)).toBe(1)
      expect(runtime.journal.intentIds()).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('queued decision that expires during generation is REVIEW-only and cannot save or execute the stale action', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const clock = new ReplayClock(AS_OF)
    const paper = new PaperBroker({ clock, book: { price: () => 102 }, initialEquityQuote: 1_000, slippageBps: 0, feeBps: 0 })
    const runtime = makeRuntime(db, paper, clock)
    seedExecutableContext(db, runtime)
    const deadline = AS_OF + 1_000
    const model = new FakeDecisionModel({
      outcome: 'act', thesis: '到期后不执行', rejectedAlternatives: [], claims: [], uncertainties: [],
      confidence: 0.6, riskFraction: 1,
      immediateAction: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 95 } },
    }, () => runtime.clock.advanceTo(deadline))
    try {
      const result = await runDecisionRuntime({
        ...runtime, model, config,
        trigger: { ...trigger, id: 'w2-expired-generation', source: 'W2', expiresAt: deadline },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(result).toMatchObject({ status: 'review', reason: expect.stringContaining('过期') })
      expect(await paper.getPositions()).toEqual([])
      expect(runtime.journal.intentIds()).toEqual([])
      expect(new DecisionRunStore(db).get(result.runId)?.status).toBe('review')
    } finally {
      db.close()
    }
  })

  it('rechecks trigger expiry after fresh private reads inside executeAction lock', async () => {
    const db = new Database(':memory:')
    migrate(db)
    new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
    const clock = new ReplayClock(AS_OF)
    const deadline = AS_OF + 1_000
    class ExpiringPaperBroker extends PaperBroker {
      #positionReads = 0
      override async getPositions() {
        const positions = await super.getPositions()
        this.#positionReads += 1
        if (this.#positionReads === 2) clock.advanceTo(deadline)
        return positions
      }
    }
    const paper = new ExpiringPaperBroker({ clock, book: { price: () => 102 }, initialEquityQuote: 1_000, slippageBps: 0, feeBps: 0 })
    const runtime = makeRuntime(db, paper, clock)
    seedExecutableContext(db, runtime)
    const model = new FakeDecisionModel({
      outcome: 'act', thesis: '执行锁内过期保护', rejectedAlternatives: [], claims: [], uncertainties: [],
      confidence: 0.6, riskFraction: 1,
      immediateAction: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 95 } },
    })
    try {
      const result = await runDecisionRuntime({
        ...runtime, model, config,
        trigger: { ...trigger, id: 'w2-expired-in-lock', source: 'W2', expiresAt: deadline },
        symbol: SYMBOL, timeframe: '1h',
      })
      expect(result).toMatchObject({ status: 'review', reason: expect.stringContaining('过期') })
      expect(runtime.journal.intentIds()).toEqual([])
      expect(await paper.getPositions()).toEqual([])
    } finally {
      db.close()
    }
  })
})
