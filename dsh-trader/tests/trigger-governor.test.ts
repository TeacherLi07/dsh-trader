import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { createFeatureContext } from '../src/market/context.js'
import { FeatureEngine } from '../src/market/features.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { createDslContext } from '../src/plan/evaluate.js'
import {
  DEFAULT_TRIGGER_LIMITS,
  RuleWatch,
  TriggerGovernor,
  buildRules,
  type RuleSpec,
  type TriggerLimits,
} from '../src/trigger/engine.js'
import { TriggerQueue } from '../src/trigger/queue.js'
import { randomSeries } from './helpers/market.js'

const SYMBOL = 'BTC/USDT'
const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000

let db: Database.Database
let queue: TriggerQueue
let clock: ReplayClock

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  queue = new TriggerQueue(db)
  clock = new ReplayClock(START)
})

afterEach(() => {
  db.close()
})

function makeWatch(rules: readonly RuleSpec[], limits: TriggerLimits = DEFAULT_TRIGGER_LIMITS): RuleWatch {
  return new RuleWatch(rules, new TriggerGovernor(queue, clock, limits))
}

describe('TriggerGovernor', () => {
  it('persists info as done, novelty as queued, and assigns severity', () => {
    const watch = makeWatch([
      { id: 'i', purpose: 'info', when: 'rsi14 > 70', cooldownMs: 0 },
      { id: 'n', purpose: 'novelty', when: 'abs(zscore20) > 2', cooldownMs: 0 },
    ])

    const outcome = watch.onBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
      context: createDslContext({ rsi14: 75, zscore20: 2.5 }),
    })

    expect(outcome.decisions.map((decision) => decision.disposition.kind)).toEqual(['info', 'novelty'])
    expect(outcome.decisions.map((decision) => decision.severity)).toEqual(['P2', 'P1'])
    expect(queue.get(`${'i'}|${SYMBOL}|${START}`)?.state).toBe('done')
    expect(queue.get(`${'n'}|${SYMBOL}|${START}`)?.state).toBe('queued')
    expect(queue.queuedCount()).toBe(1)
  })

  it('suppresses within the cooldown window but still records why', () => {
    const watch = makeWatch([{ id: 'n', purpose: 'novelty', when: 'abs(zscore20) > 2', cooldownMs: 10 * 60_000 }])
    const ctx = createDslContext({ zscore20: 2.5 })

    const first = watch.onBar({ symbol: SYMBOL, timeframe: TF, barTs: START, context: ctx })
    expect(first.decisions[0]?.disposition.kind).toBe('novelty')

    clock.advanceTo(START + 60_000)
    const second = watch.onBar({ symbol: SYMBOL, timeframe: TF, barTs: START + HOUR, context: ctx })
    expect(second.decisions[0]?.disposition).toEqual({ kind: 'cooldown', until: START + 10 * 60_000 })
    expect(second.decisions[0]?.persisted).toBe(true)
    expect(queue.get(`n|${SYMBOL}|${START + HOUR}`)?.state).toBe('done')
  })

  it('enforces the W3 hourly cap and does not let suppressed attempts consume the budget', () => {
    const watch = makeWatch(
      [{ id: 'n', purpose: 'novelty', when: 'abs(zscore20) > 2', cooldownMs: 0 }],
      { ...DEFAULT_TRIGGER_LIMITS, noveltyPerHour: 2, noveltyPerDay: 100 },
    )
    const ctx = createDslContext({ zscore20: 2.5 })

    const kinds: string[] = []
    for (let i = 0; i < 5; i += 1) {
      const outcome = watch.onBar({ symbol: SYMBOL, timeframe: TF, barTs: START + i * HOUR, context: ctx })
      kinds.push(outcome.decisions[0]?.disposition.kind ?? '?')
    }

    expect(kinds).toEqual(['novelty', 'novelty', 'rate_limited', 'rate_limited', 'rate_limited'])
    // 5 根 bar 全部落库（含被限流的），但只有 2 条消耗预算
    expect(queue.count()).toBe(5)
    expect(queue.countFiredSince(['novelty'], 0)).toBe(2)
  })

  it('routes commitment/invalidation rule hits to judgment (plan did not cover them)', () => {
    const watch = makeWatch([
      { id: 'c', purpose: 'commitment', when: 'rsi14 > 70', cooldownMs: 0 },
      { id: 'v', purpose: 'invalidation', when: 'rsi14 > 70', cooldownMs: 0 },
    ])
    const outcome = watch.onBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
      context: createDslContext({ rsi14: 75 }),
    })
    expect(outcome.decisions.map((decision) => decision.disposition.kind)).toEqual([
      'judgment',
      'judgment',
    ])
    expect(outcome.decisions.map((decision) => decision.severity)).toEqual(['P1', 'P0'])
  })

  it('never reports a hit as a failure — unevaluable rules are reported separately', () => {
    const watch = makeWatch([{ id: 'warmup', purpose: 'info', when: 'rsi14 > 70', cooldownMs: 0 }])
    const outcome = watch.onBar({
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
      context: createDslContext({}),
    })
    expect(outcome.hits).toEqual([])
    expect(outcome.decisions).toEqual([])
    expect(outcome.failures).toHaveLength(1)
  })
})

describe('T0.7 acceptance: replaying the same bar twice produces zero duplicate triggers', () => {
  it('dedupes the second pass entirely, without touching the database', () => {
    const watch = makeWatch([
      { id: 'i', purpose: 'info', when: 'rsi14 > 70', cooldownMs: 0 },
      { id: 'n', purpose: 'novelty', when: 'abs(zscore20) > 2', cooldownMs: 0 },
    ])
    const bar = {
      symbol: SYMBOL,
      timeframe: TF,
      barTs: START,
      context: createDslContext({ rsi14: 75, zscore20: 2.5 }),
    }

    const first = watch.onBar(bar)
    expect(first.decisions).toHaveLength(2)
    expect(queue.count()).toBe(2)

    const second = watch.onBar(bar)
    expect(second.decisions.every((decision) => decision.disposition.kind === 'duplicate')).toBe(true)
    expect(second.decisions.every((decision) => decision.persisted === false)).toBe(true)
    expect(queue.count()).toBe(2)
  })

  it('two independent replays of the same 120-bar series produce identical trigger sets', () => {
    const runReplay = (): { keys: string[]; count: number } => {
      const replayDb = new Database(':memory:')
      migrate(replayDb)
      const replayQueue = new TriggerQueue(replayDb)
      const replayClock = new ReplayClock(START)
      const rules = buildRules(['mean_reversion_v1', 'breakout_v1'], { cooldownMs: 0 }).rules
      const watch = new RuleWatch(rules, new TriggerGovernor(replayQueue, replayClock))
      const engine = new FeatureEngine()
      const bars = normalizeCandles(randomSeries(START, 120), SYMBOL, TF, START + 120 * HOUR).candles

      for (const bar of bars) {
        const snapshot = engine.onClosedCandle(bar)
        replayClock.advanceTo(bar.closeTime)
        watch.onBar({
          symbol: SYMBOL,
          timeframe: TF,
          barTs: bar.openTime,
          context: createFeatureContext(snapshot),
        })
      }

      const rows = replayDb
        .prepare('SELECT dedup_key FROM triggers ORDER BY dedup_key')
        .all() as { dedup_key: string }[]
      replayDb.close()
      return { keys: rows.map((row) => row.dedup_key), count: rows.length }
    }

    const first = runReplay()
    const second = runReplay()

    expect(first.count).toBeGreaterThan(0)
    expect(first.keys).toEqual(second.keys)
  })
})
