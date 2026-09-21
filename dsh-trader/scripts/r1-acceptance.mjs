/**
 * R1 可复现验收：schema v5 起的 R1 合同在当前 schema 中仍成立。
 *
 * 该脚本只使用内存 SQLite 和固定时刻，不访问网络；输出即为 docs 中的原始证据。
 */

import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  DecisionContextStore,
  DecisionRunStore,
  SCHEMA_VERSION,
  freezeDecisionContext,
  migrate,
} from '../lib/internal-api.js'

const AS_OF = 1_700_000_000_000
const db = new Database(':memory:')

try {
  migrate(db)
  assert.ok(SCHEMA_VERSION >= 5)
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name)
  for (const table of ['decision_contexts', 'decision_runs', 'decisions', 'plan_cards']) {
    assert.ok(tables.includes(table), `missing table: ${table}`)
  }
  for (const table of ['context_snapshots', 'workflow_contexts']) {
    assert.ok(!tables.includes(table), `obsolete table remains: ${table}`)
  }

  const context = freezeDecisionContext({
    symbol: 'BTC/USDT:USDT',
    primaryTimeframe: '1h',
    asOf: AS_OF,
    sections: {
      mandate: { asOf: AS_OF, source: 'r1.test.config', missing: [], value: { mode: 'paper', riskPct: 0.002 } },
      market: { asOf: AS_OF, source: 'r1.test.market', missing: [], value: { close: 70_000 } },
      derivatives: { asOf: AS_OF, source: 'r1.test.derivatives', missing: ['oi.changePct'], value: { funding: 0.001 } },
      benchmark: { asOf: AS_OF, source: 'r1.test.benchmark', missing: [], value: { symbol: 'BTC/USDT:USDT' } },
      portfolio: { asOf: AS_OF, source: 'r1.test.portfolio', missing: [], value: { equityQuote: 10_000, positions: [] } },
      activePlan: { asOf: AS_OF, source: 'r1.test.plan', missing: ['activePlan'], value: null },
      history: { asOf: AS_OF, source: 'r1.test.history', missing: [], value: { decisions: [] } },
      lessons: { asOf: AS_OF, source: 'r1.test.lessons', missing: [], value: [] },
      predictions: { asOf: null, source: 'predictions.disabled', missing: ['predictions.disabled'], value: null },
    },
  })
  const contexts = new DecisionContextStore(db)
  const first = contexts.record(context)
  const second = contexts.record(context)
  assert.equal(first.inserted, true)
  assert.equal(second.inserted, false)
  assert.deepEqual(contexts.getByHash(context.contextHash)?.context, context)

  const runs = new DecisionRunStore(db)
  runs.start({
    runId: 'run-r1',
    contextId: context.contextId,
    contextHash: context.contextHash,
    symbol: context.symbol,
    primaryTimeframe: '1h',
    triggerSource: 'R1',
    modelVersion: 'test-model',
    promptVersion: 'test-prompt',
    createdAt: AS_OF,
  })
  const completed = runs.update('run-r1', {
    status: 'completed',
    draft: { thesis: 'test' },
    critique: { failureModes: [] },
    final: { outcome: 'no_trade' },
    eligibility: { state: 'decision_only' },
    tokensIn: 12,
    tokensOut: 8,
    tokensCached: 2,
    costKnown: false,
    durationMs: 42,
    finishedAt: AS_OF + 42,
  }, AS_OF + 42)
  assert.deepEqual(completed.final, { outcome: 'no_trade' })
  assert.equal(completed.costKnown, false)
  assert.equal(runs.require('run-r1', { contextHash: context.contextHash }).runId, 'run-r1')

  let foreignKeyRejected = false
  try {
    db.prepare(
      `INSERT INTO decisions (decision_id, content_hash, run_id, symbol, decided_at, context_hash, action)
       VALUES ('bad', 'bad', 'missing-run', 'BTC/USDT:USDT', ?, ?, 'no_trade')`,
    ).run(AS_OF, context.contextHash)
  } catch {
    foreignKeyRejected = true
  }
  assert.equal(foreignKeyRejected, true)

  console.log(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    userVersion: db.pragma('user_version', { simple: true }),
    obsoleteTables: ['context_snapshots', 'workflow_contexts'].filter((table) => tables.includes(table)),
    authoritativeTables: ['decision_contexts', 'decision_runs', 'decisions', 'plan_cards'].filter((table) => tables.includes(table)),
    context: {
      contextId: context.contextId,
      contextHash: context.contextHash,
      canonicalRoundTrip: contexts.getByHash(context.contextHash)?.context !== null,
      idempotentSecondWrite: second.inserted === false,
    },
    run: {
      runId: completed.runId,
      status: completed.status,
      hasDraft: completed.draft !== null,
      hasCritique: completed.critique !== null,
      hasFinal: completed.final !== null,
      hasEligibility: completed.eligibility !== null,
      costKnown: completed.costKnown,
    },
    foreignKeyRejected,
  }, null, 2))
} finally {
  db.close()
}
