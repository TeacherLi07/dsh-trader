#!/usr/bin/env node
/**
 * R3 可复现工程验收：single 结构化裁决、生产 DecisionRuntime、成本记账与 run 幂等。
 * 用法：pnpm build && node scripts/r3-acceptance.mjs [output.json]
 * 使用内存 SQLite 与 stub provider；不访问网络，不代表真实模型质量或经济效果。
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  BarArchive,
  BudgetLedger,
  DEEPSEEK_PRICE_SEED,
  DecisionContextStore,
  DecisionJournal,
  DecisionRunStore,
  FeatureArchive,
  PaperBroker,
  PlanStore,
  PriceTableStore,
  ReplayClock,
  SCHEMA_VERSION,
  migrate,
  runDecisionRuntime,
} from '../lib/internal-api.js'

const OUT = process.argv[2]
const AS_OF = Date.UTC(2026, 8, 20, 12)
const SYMBOL = 'ADA/USDT:USDT'

class StubDecisionModel {
  calls = 0
  constructor(output) { this.output = output }
  async *stream(options) {
    this.calls += 1
    const tool = options.tools?.[0]
    assert.equal(tool?.name, 'submit_decision_envelope')
    yield { type: 'usage', usage: { inputTokens: 256, outputTokens: 48, totalTokens: 304 } }
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: `stub-r3-${this.calls}`, name: tool.name, arguments: JSON.stringify(this.output) },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

const db = new Database(':memory:')
const clock = new ReplayClock(AS_OF)
try {
  migrate(db)
  new PriceTableStore(db).seed(DEEPSEEK_PRICE_SEED)
  db.prepare('INSERT INTO config_versions (ts, author, params_json) VALUES (?, ?, ?)')
    .run(AS_OF - 1, 'fixture', JSON.stringify({ apiSecret: 'R3-SECRET-MUST-NOT-ENTER-CONTEXT' }))

  const broker = new PaperBroker({ clock, book: { price: () => 0.5 }, initialEquityQuote: 100, slippageBps: 0, feeBps: 0 })
  const ports = {
    db,
    bars: new BarArchive(db),
    features: new FeatureArchive(db),
    plans: new PlanStore(db),
    journal: new DecisionJournal(db),
    broker,
    clock,
    limits: null,
    mode: 'paper',
    liveArmed: false,
    waiver: true,
    riskPct: 0.002,
    symbols: [SYMBOL],
    timeframes: ['15m', '1h', '4h'],
    benchmark: 'BTC/USDT:USDT',
    frozenSymbols: () => new Set(),
  }
  const model = new StubDecisionModel({
    outcome: 'no_trade',
    thesis: 'stub 工程样本：本轮不产生新敞口',
    rejectedAlternatives: ['开仓'],
    claims: [],
    uncertainties: ['R3 acceptance 使用 stub，不证明预测质量'],
    confidence: 0.2,
    riskFraction: 1,
  })
  const config = {
    strategy: 'single',
    route: { provider: 'fixture', model: 'deepseek-flash', maxTokens: 256, maxChars: 180_000 },
    dailyBudgetUsd: 1,
    planWindowMs: 4 * 3_600_000,
  }
  const trigger = { source: 'W1', id: 'r3-acceptance-w1', at: AS_OF, attempt: 1 }
  const first = await runDecisionRuntime({ ports, model, config, trigger, symbol: SYMBOL, timeframe: '1h' })
  const replayed = await runDecisionRuntime({ ports, model, config, trigger, symbol: SYMBOL, timeframe: '1h' })
  const run = new DecisionRunStore(db).get(first.runId)
  const context = new DecisionContextStore(db).get(run.contextId)?.context
  const ledger = new BudgetLedger(db).dashboard({ day: '2026-09-20' }).find((row) => row.scope === 'global')

  assert.equal(first.status, 'completed')
  assert.equal(first.envelope?.outcome, 'no_trade')
  assert.equal(replayed.replayed, true)
  assert.equal(model.calls, 1)
  assert.ok(run.tokensIn > 0 && run.tokensOut > 0)
  assert.equal(run.costKnown, true)
  assert.ok(ledger?.estUsd > 0)
  assert.ok(!JSON.stringify(context).includes('R3-SECRET-MUST-NOT-ENTER-CONTEXT'))
  assert.equal(ports.journal.intentIds().length, 0)

  const output = {
    schemaVersion: SCHEMA_VERSION,
    asOf: AS_OF,
    externalModelCalls: 0,
    stubProviderCalls: model.calls,
    runId: first.runId,
    contextHash: first.contextHash,
    status: first.status,
    outcome: first.envelope?.outcome,
    replayWasIdempotent: replayed.replayed,
    usage: { inputTokens: run.tokensIn, outputTokens: run.tokensOut, costKnown: run.costKnown, costUsd: run.costUsd },
    noOrderIntent: ports.journal.intentIds().length === 0,
    secretAbsentFromFrozenContext: !JSON.stringify(context).includes('R3-SECRET-MUST-NOT-ENTER-CONTEXT'),
  }
  if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`)
  console.log(JSON.stringify(output, null, 2))
} finally {
  db.close()
}
