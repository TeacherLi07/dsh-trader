#!/usr/bin/env node
/**
 * R4 可复现工程验收：持久 W2/W3 worker、预算拒绝、退避重试、重启恢复与事件过期。
 * 用法：pnpm build && node scripts/r4-acceptance.mjs [output.json]
 * 使用内存 SQLite 与决策回调 stub；不访问网络，也不代表真实模型/经济表现。
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  BudgetLedger,
  DecisionJournal,
  ReplayClock,
  SCHEMA_VERSION,
  TriggerQueue,
  dispatchNextTrigger,
  migrate,
} from '../lib/internal-api.js'

const OUT = process.argv[2]
const NOW = Date.UTC(2026, 8, 20, 12)
const SYMBOL = 'ADA/USDT:USDT'
const HOUR = 3_600_000

const db = new Database(':memory:')
try {
  migrate(db)
  const clock = new ReplayClock(NOW)
  const queue = new TriggerQueue(db)
  const journal = new DecisionJournal(db)
  const budget = new BudgetLedger(db)
  const base = {
    symbol: SYMBOL, ruleId: 'r4-fixture', barTs: NOW,
    payload: { wake: 'W2', timeframe: '1h' },
    purpose: 'commitment', disposition: 'judgment', state: 'queued', createdAt: NOW, expiresAt: NOW + HOUR,
  }
  assert.equal(queue.enqueue({ ...base, triggerId: 'w2-retry', dedupKey: 'w2-retry' }), true)
  let attempts = 0
  const shared = {
    queue, journal, clock, budget, symbols: [SYMBOL], timeframes: ['1h'], dailyBudgetUsd: 1,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 },
  }
  const retry = await dispatchNextTrigger({
    ...shared,
    run: async ({ source, symbol, timeframe }) => {
      assert.deepEqual({ source, symbol, timeframe }, { source: 'W2', symbol: SYMBOL, timeframe: '1h' })
      attempts += 1
      return { retryable: true, reason: 'stub transient provider timeout' }
    },
  })
  assert.equal(retry.kind, 'retry')
  assert.equal(queue.get('w2-retry')?.nextAttemptAt, NOW + 1_000)
  const notDue = await dispatchNextTrigger({
    ...shared,
    run: async () => { throw new Error('backoff event was claimed early') },
  })
  assert.equal(notDue.kind, 'idle')

  clock.advanceTo(NOW + 1_000)
  const completed = await dispatchNextTrigger({
    ...shared,
    run: async () => { attempts += 1; return { runId: 'r4-stub-run', status: 'review' } },
  })
  assert.equal(completed.kind, 'processed')
  assert.equal(queue.get('w2-retry')?.state, 'done')
  assert.equal(attempts, 2)

  assert.equal(queue.enqueue({
    ...base, triggerId: 'w2-budget-denied', dedupKey: 'w2-budget-denied', createdAt: NOW + 1_000,
  }), true)
  let budgetDeniedCalls = 0
  const denied = await dispatchNextTrigger({
    ...shared,
    dailyBudgetUsd: undefined,
    run: async () => { budgetDeniedCalls += 1; return { status: 'completed' } },
  })
  assert.equal(denied.kind, 'failed')
  assert.equal(budgetDeniedCalls, 0)
  assert.equal(queue.get('w2-budget-denied')?.state, 'failed')

  assert.equal(queue.enqueue({
    ...base, triggerId: 'w3-expired', dedupKey: 'w3-expired', purpose: 'novelty', disposition: 'novelty',
    createdAt: NOW + 1_000, expiresAt: NOW + 2_000,
  }), true)
  const claimed = queue.claim(NOW + 1_000, 1)[0]
  assert.ok(claimed)
  const recovered = queue.recoverClaims(NOW + 1_100)
  assert.equal(recovered.some((item) => item.triggerId === 'w3-expired' && item.state === 'queued'), true)
  clock.advanceTo(NOW + 2_100)
  const expired = await dispatchNextTrigger({
    ...shared,
    run: async () => ({ status: 'completed' }),
  })
  assert.equal(expired.kind, 'idle')
  assert.equal(queue.get('w3-expired')?.state, 'expired')

  const output = {
    schemaVersion: SCHEMA_VERSION,
    externalModelCalls: 0,
    stubDecisionCallbacks: attempts,
    triggerRows: queue.count(),
    states: Object.fromEntries(['done', 'failed', 'expired', 'queued', 'claimed'].map((state) => [state, queue.count(state)])),
    retriedSameTrigger: retry.triggerId === completed.triggerId,
    budgetDeniedBeforeCallback: budgetDeniedCalls === 0,
    restartRecoveryPreserved: recovered.some((item) => item.triggerId === 'w3-expired' && item.attempts === 1),
    auditEvents: db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
  }
  assert.ok(output.triggerRows > 0)
  assert.ok(output.auditEvents > 0)
  if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`)
  console.log(JSON.stringify(output, null, 2))
} finally {
  db.close()
}
