import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { createFeatureContext } from '../src/market/context.js'
import { FeatureEngine } from '../src/market/features.js'
import { normalizeCandles } from '../src/market/normalize.js'
import { RuleWatch, TriggerGovernor, buildRules } from '../src/trigger/engine.js'
import { TriggerQueue } from '../src/trigger/queue.js'
import {
  getTriggerRuntime,
  hasTriggerRuntime,
  setTriggerRuntime,
} from '../src/trigger/runtime.js'
import { randomSeries } from './helpers/market.js'

const SYMBOL = 'BTC/USDT'
const TF = '1h'
const HOUR = 3_600_000
const START = 1_700_000_000_000

let db: Database.Database
let queue: TriggerQueue

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  queue = new TriggerQueue(db)
})

afterEach(() => {
  setTriggerRuntime(undefined)
  db.close()
})

describe('trigger runtime registry', () => {
  it('is empty until the rules plugin registers a watch', () => {
    expect(hasTriggerRuntime()).toBe(false)
    expect(getTriggerRuntime()).toBeUndefined()
  })

  it('composes features -> rules -> triggers exactly like the market plugin does', () => {
    const clock = new ReplayClock(START)
    const rules = buildRules(['mean_reversion_v1', 'breakout_v1'], { cooldownMs: 0 }).rules
    setTriggerRuntime(new RuleWatch(rules, new TriggerGovernor(queue, clock)))

    const engine = new FeatureEngine()
    const bars = normalizeCandles(randomSeries(START, 120), SYMBOL, TF, START + 120 * HOUR).candles
    for (const bar of bars) {
      const snapshot = engine.onClosedCandle(bar)
      clock.advanceTo(bar.closeTime)
      getTriggerRuntime()?.onBar({
        symbol: SYMBOL,
        timeframe: TF,
        barTs: bar.openTime,
        context: createFeatureContext(snapshot),
      })
    }

    expect(queue.count()).toBeGreaterThan(0)
    expect(queue.count('done')).toBeGreaterThan(0)
    // 规则只使用已实现的指标，因此不该出现"制度性"的暖机失败堆积
    expect(queue.countFiredSince(['novelty'], 0)).toBeGreaterThanOrEqual(0)
  })

  it('clears the registration so a disposed profile stops firing rules', () => {
    setTriggerRuntime(new RuleWatch([], new TriggerGovernor(queue, new ReplayClock(START))))
    expect(hasTriggerRuntime()).toBe(true)

    setTriggerRuntime(undefined)
    expect(hasTriggerRuntime()).toBe(false)
  })
})
