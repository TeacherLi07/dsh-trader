import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { DecisionContextStore } from '../src/agents/decision-context-store.js'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import { DecisionRunStore } from '../src/agents/decision-run-store.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

afterEach(() => db.close())

function context(asOf = 1_000) {
  return freezeDecisionContext({
    symbol: 'BTC/USDT:USDT',
    primaryTimeframe: '1h',
    asOf,
    sections: {
      mandate: { asOf, source: 'test', missing: [], value: { mode: 'paper' } },
      market: { asOf, source: 'test', missing: [], value: { close: 100 } },
      derivatives: { asOf, source: 'test', missing: [], value: { funding: 0 } },
      benchmark: { asOf, source: 'test', missing: [], value: { symbol: 'BTC/USDT:USDT' } },
      portfolio: { asOf, source: 'test', missing: [], value: { equityQuote: 10_000 } },
      activePlan: { asOf, source: 'test', missing: ['activePlan'], value: null },
      history: { asOf, source: 'test', missing: [], value: { decisions: [] } },
      lessons: { asOf, source: 'test', missing: [], value: [] },
      predictions: { asOf: null, source: 'predictions.disabled', missing: ['predictions.disabled'], value: null },
    },
  })
}

describe('DecisionRunStore', () => {
  it('把一轮 run 绑定到完整 context，并持久化三步工件与成本', () => {
    const savedContext = new DecisionContextStore(db).record(context()).record
    const store = new DecisionRunStore(db)
    const started = store.start({
      runId: 'run-1',
      contextId: savedContext.contextId,
      contextHash: savedContext.contextHash,
      symbol: savedContext.symbol,
      primaryTimeframe: '1h',
      triggerSource: 'W1',
      modelVersion: 'model-v1',
      promptVersion: 'prompt-v1',
      createdAt: 1_000,
    })
    expect(started.status).toBe('running')

    const finished = store.update('run-1', {
      status: 'completed',
      draft: { thesis: 'x' },
      critique: { failureModes: [] },
      final: { outcome: 'no_trade' },
      eligibility: { state: 'decision_only' },
      tokensIn: 10,
      tokensOut: 20,
      tokensCached: 3,
      costUsd: 0.12,
      costKnown: true,
      durationMs: 900,
      finishedAt: 1_900,
    }, 1_900)
    expect(finished).toMatchObject({
      contextHash: savedContext.contextHash,
      status: 'completed',
      draft: { thesis: 'x' },
      critique: { failureModes: [] },
      final: { outcome: 'no_trade' },
      eligibility: { state: 'decision_only' },
      tokensIn: 10,
      costKnown: true,
    })
    expect(store.require('run-1', { symbol: savedContext.symbol }).runId).toBe('run-1')
  })

  it('同一 runId 不可换绑 context，且错误 context 会被拒绝', () => {
    const first = new DecisionContextStore(db).record(context()).record
    const second = new DecisionContextStore(db).record(context(2_000)).record
    const store = new DecisionRunStore(db)
    store.start({
      runId: 'run-once',
      contextId: first.contextId,
      contextHash: first.contextHash,
      symbol: first.symbol,
      primaryTimeframe: '1h',
      triggerSource: 'W2',
      createdAt: first.asOf,
    })
    expect(() => store.start({
      runId: 'run-once',
      contextId: second.contextId,
      contextHash: second.contextHash,
      symbol: second.symbol,
      primaryTimeframe: '1h',
      triggerSource: 'W2',
      createdAt: second.asOf,
    })).toThrow(/绑定另一份 context/)
    expect(() => store.require('run-once', { contextHash: second.contextHash })).toThrow(/contextHash 不匹配/)
  })
})
