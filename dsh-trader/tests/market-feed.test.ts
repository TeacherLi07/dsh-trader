import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { canonicalDecisionContext, freezeDecisionContext } from '../src/agents/decision-context.js'
import { DecisionContextStore } from '../src/agents/decision-context-store.js'
import { DEFAULT_DECISION_CONTEXT_CONFIG } from '../src/agents/context-config.js'
import { marketSlice } from '../src/agents/context-market.js'
import { BarArchive } from '../src/market/archive.js'
import { FeatureArchive } from '../src/market/feature-archive.js'
import {
  DEFAULT_BACKOFF,
  MarketFeed,
  computeBackoff,
  type FeedErrorInfo,
  type MarketFeedOptions,
} from '../src/market/feed.js'
import { FEATURE_WARMUP_BARS, FeaturePipeline } from '../src/market/features.js'
import { MarketObservationStore } from '../src/market/observations.js'
import { MarketSourceError, type MarketDataSource } from '../src/market/types.js'
import { TokenBucket } from '../src/market/ratelimit.js'
import { FakeSource, randomSeries, series } from './helpers/market.js'

const TF = '1h'
const HOUR = 3_600_000
const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'

let db: Database.Database
let archive: BarArchive

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  archive = new BarArchive(db)
})

afterEach(() => {
  db.close()
})

function makeFeed(
  source: MarketDataSource,
  clock: ReplayClock,
  over: Partial<MarketFeedOptions> = {},
): MarketFeed {
  return new MarketFeed({
    source,
    archive,
    clock,
    symbols: [SYMBOL],
    timeframes: [TF],
    pollMs: 60_000,
    ...over,
  })
}

describe('computeBackoff', () => {
  it('grows exponentially and caps at maxMs', () => {
    expect(computeBackoff(0)).toBe(1_000)
    expect(computeBackoff(1)).toBe(2_000)
    expect(computeBackoff(2)).toBe(4_000)
    expect(computeBackoff(6)).toBe(60_000)
    expect(computeBackoff(50)).toBe(60_000)
    expect(DEFAULT_BACKOFF.maxMs).toBe(60_000)
  })

  it('rejects invalid attempts and configurations', () => {
    expect(() => computeBackoff(-1)).toThrow()
    expect(() => computeBackoff(1.5)).toThrow()
    expect(() => computeBackoff(0, { baseMs: 0, maxMs: 10, factor: 2 })).toThrow()
    expect(() => computeBackoff(0, { baseMs: 10, maxMs: 5, factor: 2 })).toThrow()
  })
})

describe('MarketFeed', () => {
  it('stores and emits only newly closed candles', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [series(NOW - 3 * HOUR, 3), series(NOW - 3 * HOUR, 4)] })
    const emitted: { readonly openTime: number; readonly availableAt: number }[] = []
    const feed = makeFeed(source, clock, {
      onClosedCandle: (candle, availableAt) => {
        emitted.push({ openTime: candle.openTime, availableAt })
      },
    })

    const first = await feed.pollOnce()
    expect(first).toEqual({ fetched: 3, written: 3, emitted: 3, failures: 0 })

    // 第 4 根（openTime = NOW）此刻才收盘
    clock.advanceTo(NOW + HOUR)
    const second = await feed.pollOnce()
    expect(second.written).toBe(4)
    expect(second.emitted).toBe(1)

    expect(emitted).toEqual([
      { openTime: NOW - 3 * HOUR, availableAt: NOW },
      { openTime: NOW - 2 * HOUR, availableAt: NOW },
      { openTime: NOW - HOUR, availableAt: NOW },
      { openTime: NOW, availableAt: NOW + HOUR },
    ])
    expect(archive.count(SYMBOL, TF)).toBe(4)
    expect(feed.attempts(SYMBOL, TF)).toBe(0)
  })

  it('回调失败时保留处理游标，批内后续 bar 下一轮仍会按序重试', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [series(NOW - 3 * HOUR, 2), series(NOW - 3 * HOUR, 2)] })
    let first = true
    const seen: number[] = []
    const feed = makeFeed(source, clock, {
      onClosedCandle: (candle) => {
        seen.push(candle.openTime)
        if (first) {
          first = false
          throw new Error('downstream unavailable')
        }
      },
    })

    const failed = await feed.pollOnce()
    expect(failed.failures).toBe(1)
    expect(archive.count(SYMBOL, TF)).toBe(2) // 归档成功不等于处理成功

    const retried = await feed.pollOnce()
    expect(retried.failures).toBe(0)
    expect(retried.emitted).toBe(2)
    // 第 1 根被重试，第 2 根没有被首轮失败吞掉
    expect(seen).toEqual([NOW - 3 * HOUR, NOW - 3 * HOUR, NOW - 2 * HOUR])
    expect(archive.unprocessedClosedBars(SYMBOL, TF)).toEqual([])
  })

  it('已处理历史发生修订时撤销游标并封锁陈旧特征，旧 PIT context 保持原样', async () => {
    const history = randomSeries(NOW - 70 * HOUR, 70)
    const firstAvailableAt = NOW + 100
    const correctionAvailableAt = firstAvailableAt + 5_000
    const clock = new ReplayClock(firstAvailableAt)
    const featureArchive = new FeatureArchive(db)
    const observations = new MarketObservationStore(db)
    const pipeline = new FeaturePipeline(featureArchive)
    const ruleSnapshots: { readonly openTime: number; readonly close: number }[] = []
    const correctedRaw = {
      ...history[10]!,
      open: history[10]!.open + 0.5,
      high: history[10]!.high + 1,
      close: history[10]!.close + 0.75,
    }
    const source = new FakeSource({ pages: [history, [correctedRaw]] })
    const feed = makeFeed(source, clock, {
      onClosedCandle: (candle, availableAt) => {
        const snapshot = pipeline.onClosedCandle(candle, undefined, availableAt)
        ruleSnapshots.push({ openTime: snapshot.openTime, close: snapshot.values.close })
      },
    })

    const first = await feed.pollOnce()
    expect(first).toEqual({ fetched: history.length, written: history.length, emitted: history.length, failures: 0 })
    expect(ruleSnapshots.length).toBeGreaterThan(0)
    expect(archive.unprocessedClosedBars(SYMBOL, TF)).toEqual([])

    const oldMarket = marketSlice(observations, SYMBOL, TF, firstAvailableAt, DEFAULT_DECISION_CONTEXT_CONFIG)
    expect(oldMarket.features['close']?.status).toBe('ok')
    expect(oldMarket.features['close']?.value).not.toBeNull()
    const section = (value: unknown) => ({ asOf: firstAvailableAt, source: 'market-test', missing: [], value })
    const context = freezeDecisionContext({
      symbol: SYMBOL,
      primaryTimeframe: '1h',
      asOf: firstAvailableAt,
      sections: {
        mandate: section({ mode: 'paper' }),
        market: section({ timeframes: { [TF]: oldMarket } }),
        derivatives: section({}),
        benchmark: section({}),
        portfolio: section({}),
        activePlan: section({}),
        history: section({}),
        lessons: section({}),
        predictions: section({}),
      },
    })
    const contexts = new DecisionContextStore(db)
    const storedContext = contexts.record(context, { createdAt: firstAvailableAt }).record
    const frozenCanonical = canonicalDecisionContext(context)
    const beforeRules = ruleSnapshots.length

    clock.advanceTo(correctionAvailableAt)
    const revised = await feed.pollOnce()

    expect(revised).toEqual({ fetched: 1, written: 1, emitted: 0, failures: 1 })
    expect(ruleSnapshots).toHaveLength(beforeRules) // 修订 bar 失败，后续规则/执行回调没有被调用
    const pending = archive.unprocessedClosedBars(SYMBOL, TF)
    expect(pending.length).toBeGreaterThan(0)
    expect(pending[0]?.openTime).toBe(history[10]!.openTime)
    expect(featureArchive.latest(SYMBOL, TF)?.openTime).toBe(history[9]!.openTime)

    const stillHistorical = marketSlice(observations, SYMBOL, TF, firstAvailableAt, DEFAULT_DECISION_CONTEXT_CONFIG)
    expect(stillHistorical).toEqual(oldMarket)
    expect(contexts.get(storedContext.contextId)?.canonicalJson).toBe(frozenCanonical)

    const currentMarket = marketSlice(observations, SYMBOL, TF, correctionAvailableAt, DEFAULT_DECISION_CONTEXT_CONFIG)
    expect(currentMarket.features['close']?.value).toBeNull()
    expect(currentMarket.features['close']?.status).not.toBe('ok')
    expect(currentMarket.missing).toContain('1h.close:invalid')

    // 模拟插件重启：从剩余 processed 历史 warm-up 后，Feed 仍必须在统一 callback 前拦截。
    const restartedArchive = new BarArchive(db)
    const restartedFeatureArchive = new FeatureArchive(db)
    const restartedPipeline = new FeaturePipeline(restartedFeatureArchive)
    restartedPipeline.warmUp(
      restartedArchive.recentProcessedClosedBars(SYMBOL, TF, FEATURE_WARMUP_BARS),
      restartedFeatureArchive.recent(SYMBOL, TF, FEATURE_WARMUP_BARS),
    )
    const replayedRules: number[] = []
    const replayedPlanOrders: number[] = []
    const restartedFeed = new MarketFeed({
      source: new FakeSource({ pages: [[correctedRaw]] }),
      archive: restartedArchive,
      clock,
      symbols: [SYMBOL],
      timeframes: [TF],
      pollMs: 60_000,
      onClosedCandle: (candle, availableAt) => {
        const snapshot = restartedPipeline.onClosedCandle(candle, undefined, availableAt)
        replayedRules.push(snapshot.openTime)
        replayedPlanOrders.push(snapshot.openTime) // 对应插件同一回调尾部的 liveEngine/计划执行段
      },
    })
    const afterRestart = await restartedFeed.pollOnce()
    expect(afterRestart).toEqual({ fetched: 1, written: 1, emitted: 0, failures: 1 })
    expect(replayedRules).toEqual([])
    expect(replayedPlanOrders).toEqual([])
    expect(restartedArchive.unprocessedClosedBars(SYMBOL, TF)[0]?.openTime).toBe(history[10]!.openTime)
  })

  it('never lets a failing source break the loop; it counts and backs off', async () => {
    const clock = new ReplayClock(NOW)
    const error = Object.assign(new Error('rate limit exceeded'), { name: 'RateLimitExceeded' })
    const source = new FakeSource({ error })
    const seen: FeedErrorInfo[] = []
    const feed = makeFeed(source, clock, {
      onError: (_error, info) => {
        seen.push(info)
      },
    })

    await expect(feed.pollOnce()).resolves.toEqual({
      fetched: 0,
      written: 0,
      emitted: 0,
      failures: 1,
    })
    expect(seen[0]).toMatchObject({ symbol: SYMBOL, timeframe: TF, kind: 'rate_limit', attempt: 1 })
    expect(feed.attempts(SYMBOL, TF)).toBe(1)
    expect(feed.backoffFor(SYMBOL, TF)).toBe(1_000)

    await feed.pollOnce()
    expect(feed.attempts(SYMBOL, TF)).toBe(2)
    expect(feed.backoffFor(SYMBOL, TF)).toBe(2_000)
  })

  it('resets the failure counter after a successful poll', async () => {
    const clock = new ReplayClock(NOW)
    let calls = 0
    const flaky: MarketDataSource = {
      id: 'flaky',
      capabilities: { watchOHLCV: false },
      async fetchOHLCV() {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('socket hang up'), { name: 'NetworkError' })
        return series(NOW - HOUR, 1)
      },
    }
    const feed = makeFeed(flaky, clock)

    await feed.pollOnce()
    expect(feed.attempts(SYMBOL, TF)).toBe(1)
    await feed.pollOnce()
    expect(feed.attempts(SYMBOL, TF)).toBe(0)
  })

  it('refuses to store an in-progress bar even if the source returns one', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [series(NOW, 2)] }) // closeTime 分别为 NOW+1h、NOW+2h
    const feed = makeFeed(source, clock)

    const result = await feed.pollOnce()
    expect(result.written).toBe(0)
    expect(result.emitted).toBe(0)
    expect(archive.count()).toBe(0)
  })

  it('start() registers a clock-driven timer, and the disposer removes it', () => {
    const clock = new ReplayClock(NOW)
    const feed = makeFeed(new FakeSource({ pages: [] }), clock)

    const stop = feed.start()
    expect(clock.pendingTimers()).toBe(1)
    stop()
    expect(clock.pendingTimers()).toBe(0)
  })

  it('does not overlap periodic polls while the source is slow', async () => {
    const clock = new ReplayClock(NOW)
    let release: (() => void) | undefined
    let fetchCalls = 0
    const source: MarketDataSource = {
      id: 'slow-source',
      capabilities: { watchOHLCV: false },
      async fetchOHLCV() {
        fetchCalls += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return series(NOW - HOUR, 1)
      },
    }
    const feed = makeFeed(source, clock)
    const stop = feed.start()

    clock.advanceTo(NOW + 60_000)
    clock.advanceTo(NOW + 3 * 60_000)
    expect(fetchCalls).toBe(1)
    expect(release).toBeDefined()

    release?.()
    await feed.pollOnce()
    stop()
  })

  it('does not overlap periodic polls while a closed-candle callback is slow', async () => {
    const clock = new ReplayClock(NOW)
    let callbackRelease: (() => void) | undefined
    let callbackCalls = 0
    const source = new FakeSource({ pages: [series(NOW - HOUR, 1), series(NOW, 1)] })
    const feed = makeFeed(source, clock, {
      onClosedCandle: async () => {
        callbackCalls += 1
        await new Promise<void>((resolve) => {
          callbackRelease = resolve
        })
      },
    })
    const stop = feed.start()

    clock.advanceTo(NOW + 60_000)
    await Promise.resolve()
    expect(callbackCalls).toBe(1)
    clock.advanceTo(NOW + 3 * 60_000)
    expect(source.calls).toHaveLength(1)

    callbackRelease?.()
    await feed.pollOnce()
    stop()
  })

  it('clears the single-flight guard when an unexpected poll error rejects', async () => {
    const clock = new ReplayClock(NOW)
    let calls = 0
    const source: MarketDataSource = {
      id: 'rejecting-source',
      capabilities: { watchOHLCV: false },
      async fetchOHLCV() {
        calls += 1
        if (calls === 1) throw new Error('unexpected poll failure')
        return []
      },
    }
    const feed = makeFeed(source, clock, {
      onError: () => {
        throw new Error('unexpected onError failure')
      },
    })

    await expect(feed.pollOnce()).rejects.toThrow('unexpected onError failure')
    await expect(feed.pollOnce()).resolves.toEqual({ fetched: 0, written: 0, emitted: 0, failures: 0 })
    expect(calls).toBe(2)
  })

  it('reports an unsupported timeframe instead of silently skipping', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [] })
    const feed = makeFeed(source, clock, { timeframes: ['3m'] })

    const result = await feed.pollOnce()
    expect(result.failures).toBe(1)
    expect(source.calls).toHaveLength(0) // 归一化先失败，根本不打数据源
  })
})

describe('MarketSourceError', () => {
  it('carries a behavioural kind', () => {
    const error = new MarketSourceError('no_data', 'nothing here')
    expect(error.kind).toBe('no_data')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('限流耗尽必须 fail-closed（审计修复）', () => {
  it('★ 令牌耗尽且 sleep 不推进时钟时，不得"照样发请求"', async () => {
    const clock = new ReplayClock(NOW)
    const source = new FakeSource({ pages: [series(NOW - HOUR, 1)] })
    const limiter = new TokenBucket(clock, { capacity: 1, refillTokens: 1, refillMs: 1e12 })
    const seen: FeedErrorInfo[] = []
    const feed = makeFeed(source, clock, {
      limiter,
      sleep: () => Promise.resolve(),
      onError: (_error, info) => {
        seen.push(info)
      },
    })

    const first = await feed.pollOnce()
    expect(first.failures).toBe(0)
    expect(source.calls).toHaveLength(1)

    const second = await feed.pollOnce()
    expect(second.failures).toBe(1)
    // 关键：没有第二次请求打出去（旧实现会 fail-open 继续请求）
    expect(source.calls).toHaveLength(1)
    expect(seen.at(-1)?.kind).toBe('rate_limit')
  })
})
