import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { BudgetLedger } from '../src/cost-ledger.js'
import { migrate } from '../src/db/schema.js'
import { DecisionContextStore } from '../src/agents/decision-context-store.js'
import { DecisionRunStore } from '../src/agents/decision-run-store.js'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { PlanStore } from '../src/plan/store.js'
import type { PmStore } from '../src/predictions/store.js'
import { TriggerQueue, type NewTrigger } from '../src/trigger/queue.js'
import { dispatchNextTrigger, resolvePredictionTriggerTarget } from '../src/supervisor/trigger-dispatcher.js'
import { makeCard } from './helpers/plan.js'

const NOW = Date.UTC(2026, 8, 20, 12)
const SYMBOL = 'BTC/USDT:USDT'
const HOUR = 3_600_000

let db: Database.Database
let clock: ReplayClock
let queue: TriggerQueue
let journal: DecisionJournal
let budget: BudgetLedger

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  clock = new ReplayClock(NOW)
  queue = new TriggerQueue(db)
  journal = new DecisionJournal(db)
  budget = new BudgetLedger(db)
})

afterEach(() => db.close())

function trigger(over: Partial<NewTrigger> = {}): NewTrigger {
  return {
    triggerId: 'w2-1', dedupKey: 'w2-1', symbol: SYMBOL, ruleId: 'test-rule',
    purpose: 'commitment', barTs: NOW, payload: { timeframe: '1h', wake: 'W2' },
    disposition: 'judgment', state: 'queued', createdAt: NOW, expiresAt: NOW + HOUR,
    ...over,
  }
}

function dispatch(run: Parameters<typeof dispatchNextTrigger>[0]['run'], extra: Partial<Parameters<typeof dispatchNextTrigger>[0]> = {}) {
  return dispatchNextTrigger({
    queue, journal, clock, budget, symbols: [SYMBOL], timeframes: ['15m', '1h', '4h'],
    dailyBudgetUsd: 1, run, ...extra,
  })
}

function startDecisionRun(triggerId: string, source: 'W2' | 'W3'): string {
  const context = freezeDecisionContext({
    symbol: SYMBOL, primaryTimeframe: '1h', asOf: NOW,
    sections: {
      mandate: { asOf: NOW, source: 'test', missing: [], value: {} },
      market: { asOf: NOW, source: 'test', missing: [], value: {} },
      derivatives: { asOf: NOW, source: 'test', missing: [], value: {} },
      benchmark: { asOf: NOW, source: 'test', missing: [], value: {} },
      portfolio: { asOf: NOW, source: 'test', missing: [], value: {} },
      activePlan: { asOf: NOW, source: 'test', missing: [], value: null },
      history: { asOf: NOW, source: 'test', missing: [], value: {} },
      lessons: { asOf: NOW, source: 'test', missing: [], value: [] },
      predictions: { asOf: null, source: 'test', missing: ['disabled'], value: null },
    },
  })
  const stored = new DecisionContextStore(db).record(context).record
  const runId = `run-${triggerId}`
  new DecisionRunStore(db).start({
    runId, contextId: stored.contextId, contextHash: stored.contextHash,
    symbol: SYMBOL, primaryTimeframe: '1h', triggerSource: `${source}:${triggerId}`, createdAt: NOW,
  })
  return runId
}

describe('durable W2/W3 trigger dispatcher', () => {
  it('dispatches eligible W2 exactly once through the shared decision callback', async () => {
    queue.enqueue(trigger())
    const seen: string[] = []
    const result = await dispatch(async ({ source, symbol, timeframe, trigger: item }) => {
      seen.push(`${source}|${symbol}|${timeframe}|${item.triggerId}`)
      return { runId: 'run-w2', status: 'completed' }
    })

    expect(result).toMatchObject({ kind: 'processed', source: 'W2', runId: 'run-w2' })
    expect(seen).toEqual([`W2|${SYMBOL}|1h|w2-1`])
    expect(queue.get('w2-1')).toMatchObject({ state: 'done', attempts: 1 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'trigger.processed'").get()).toMatchObject({ n: 1 })
    expect((await dispatch(async () => ({ runId: 'unexpected' }))).kind).toBe('idle')
  })

  it('routes novelty to W3, but missing budget suppresses the provider callback and terminally audits it', async () => {
    queue.enqueue(trigger({ triggerId: 'w3-1', dedupKey: 'w3-1', purpose: 'novelty', disposition: 'novelty', payload: { timeframe: '15m' } }))
    let source = ''
    const allowed = await dispatch(async (args) => {
      source = args.source
      return { status: 'completed' }
    })
    expect(allowed).toMatchObject({ kind: 'processed', source: 'W3' })
    expect(source).toBe('W3')

    queue.enqueue(trigger({ triggerId: 'w2-no-budget', dedupKey: 'w2-no-budget' }))
    let calls = 0
    const denied = await dispatch(async () => { calls += 1; return { status: 'completed' } }, { dailyBudgetUsd: undefined })
    expect(denied).toMatchObject({ kind: 'failed', triggerId: 'w2-no-budget' })
    expect(calls).toBe(0)
    expect(queue.get('w2-no-budget')?.state).toBe('failed')
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'trigger.wake_suppressed'").get()).toMatchObject({ n: 1 })
  })

  it('retries transient failures with durable backoff and completes after the next attempt', async () => {
    queue.enqueue(trigger({ triggerId: 'retry-me', dedupKey: 'retry-me' }))
    const retry = await dispatch(async () => ({ retryable: true, reason: 'provider timeout' }), {
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 },
    })
    expect(retry.kind).toBe('retry')
    expect(queue.get('retry-me')).toMatchObject({ state: 'queued', attempts: 1, nextAttemptAt: NOW + 100 })

    expect((await dispatch(async () => ({ status: 'completed' }))).kind).toBe('idle')
    clock.advanceTo(NOW + 100)
    const completed = await dispatch(async ({ trigger: item }) => ({ runId: `run-${item.attempts}`, status: 'review' }))
    expect(completed).toMatchObject({ kind: 'processed', runId: 'run-2' })
    expect(queue.get('retry-me')?.state).toBe('done')
  })

  it.each([
    { source: 'W2' as const, purpose: 'commitment' as const, disposition: 'judgment' as const },
    { source: 'W3' as const, purpose: 'novelty' as const, disposition: 'novelty' as const },
  ])('$source retries exhausted terminally fail the associated running decision run', async ({ source, purpose, disposition }) => {
    const triggerId = `retry-exhausted-${source.toLowerCase()}`
    const runId = startDecisionRun(triggerId, source)
    queue.enqueue(trigger({ triggerId, dedupKey: triggerId, purpose, disposition }))
    const retryPolicy = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 }

    const first = await dispatch(async () => ({ runId, retryable: true, reason: 'provider timeout first' }), { retryPolicy })
    expect(first.kind).toBe('retry')
    expect(new DecisionRunStore(db).get(runId)?.status).toBe('running')

    clock.advanceTo(NOW + 1)
    const last = await dispatch(async () => ({ runId, retryable: true, reason: 'provider timeout exhausted' }), { retryPolicy })
    expect(last).toMatchObject({ kind: 'failed', runId })
    expect(queue.get(triggerId)).toMatchObject({ state: 'failed', attempts: 2 })
    const failedRun = new DecisionRunStore(db).get(runId)
    expect(failedRun).toMatchObject({ status: 'failed', finishedAt: NOW + 1 })
    expect(failedRun?.final).toMatchObject({
      workerFailure: { triggerId, reason: expect.stringContaining('provider timeout exhausted') },
    })
  })

  it('restart recovery at the retry ceiling also terminally fails its running decision run', () => {
    const triggerId = 'retry-exhausted-on-restart'
    const runId = startDecisionRun(triggerId, 'W2')
    queue.enqueue(trigger({ triggerId, dedupKey: triggerId }))
    expect(queue.claim(NOW, 1, 1)).toHaveLength(1)

    const recovered = queue.recoverClaims(NOW + 1, 1)
    expect(recovered).toMatchObject([{ state: 'failed', attempts: 1 }])
    expect(new DecisionRunStore(db).get(runId)).toMatchObject({
      status: 'failed', finishedAt: NOW + 1,
      final: { workerFailure: { triggerId, reason: expect.stringContaining('最大尝试次数') } },
    })
  })

  it('expires events and rejects PM-only aliases without guessing a tradable symbol', async () => {
    queue.enqueue(trigger({ triggerId: 'expired', dedupKey: 'expired', expiresAt: NOW }))
    let calls = 0
    const expired = await dispatch(async () => { calls += 1; return { status: 'completed' } })
    expect(expired.kind).toBe('idle')
    expect(queue.get('expired')?.state).toBe('expired')

    queue.enqueue(trigger({
      triggerId: 'pm-event', dedupKey: 'pm-event', symbol: 'pm:fed_sep_cut',
      purpose: 'novelty', disposition: 'novelty', payload: { timeframe: 'pm' },
    }))
    const unmapped = await dispatch(async () => { calls += 1; return { status: 'completed' } })
    expect(unmapped.kind).toBe('failed')
    expect(queue.get('pm-event')?.lastError).toContain('缺少仍 active 的 planId 映射')
    expect(calls).toBe(0)
  })

  it('maps a PM novelty only through its current planId and current qualified snapshot', async () => {
    const plans = new PlanStore(db)
    plans.save(makeCard({
      planId: 'pc-pm-bound', symbol: SYMBOL, createdAt: NOW - 100, windowEndsAt: NOW + HOUR,
    }), NOW)
    const predictions = {
      snapshotAt: (at: number) => at === NOW ? [{
        alias: 'fed_sep_cut', probability: { ok: true, value: 0.62, estimator: 'mid' }, liquidity: { pass: true },
        ageMs: 1_000,
      }] : [],
    } as unknown as PmStore
    const event = trigger({
      triggerId: 'pm-bound', dedupKey: 'pm-bound', symbol: 'pm:fed_sep_cut',
      purpose: 'novelty', disposition: 'novelty', payload: {
        timeframe: 'pm', detail: { alias: 'fed_sep_cut', planId: 'pc-pm-bound' },
      },
    })
    queue.enqueue(event)
    const resolve = (stored: Parameters<typeof resolvePredictionTriggerTarget>[0]['trigger']) =>
      resolvePredictionTriggerTarget({ trigger: stored, plans, predictions, symbols: [SYMBOL], now: clock.now() })
    expect(resolve(queue.get('pm-bound')!)).toEqual({
      symbol: SYMBOL, timeframe: '1h', predictionAlias: 'fed_sep_cut',
    })

    const result = await dispatch(async ({ predictionAlias, source, symbol }) => {
      expect(predictionAlias).toBe('fed_sep_cut')
      expect(source).toBe('W3')
      expect(symbol).toBe(SYMBOL)
      return { status: 'completed' }
    }, { resolvePredictionTrigger: resolve })
    expect(result).toMatchObject({ kind: 'processed', source: 'W3' })
  })

  it('handles queued invalidation as P0 freeze without falling back to the model', async () => {
    queue.enqueue(trigger({
      triggerId: 'p0-invalidation', dedupKey: 'p0-invalidation', purpose: 'invalidation',
      disposition: 'judgment', payload: { timeframe: '1h', reason: 'invalidation condition hit' },
    }))
    const frozen: string[] = []
    let modelCallbacks = 0
    const result = await dispatch(async () => { modelCallbacks += 1; return { status: 'completed' } }, {
      freezeSymbol: (symbol) => { frozen.push(symbol) },
    })
    expect(result).toMatchObject({ kind: 'frozen', source: 'W2', triggerId: 'p0-invalidation' })
    expect(frozen).toEqual([SYMBOL])
    expect(modelCallbacks).toBe(0)
    expect(queue.get('p0-invalidation')?.state).toBe('done')
  })
})
