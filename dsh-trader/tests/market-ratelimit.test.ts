import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { TokenBucket, bucketFromLimit } from '../src/market/ratelimit.js'

describe('TokenBucket', () => {
  it('spends capacity then reports how long to wait (never blocks)', () => {
    const clock = new ReplayClock(0)
    const bucket = new TokenBucket(clock, { capacity: 2, refillTokens: 2, refillMs: 1_000 })

    expect(bucket.tryAcquire()).toEqual({ ok: true })
    expect(bucket.tryAcquire()).toEqual({ ok: true })
    const denied = bucket.tryAcquire()
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.waitMs).toBe(500)
  })

  it('refills proportionally as the injected clock advances', () => {
    const clock = new ReplayClock(0)
    const bucket = new TokenBucket(clock, { capacity: 4, refillTokens: 4, refillMs: 1_000 })
    for (let i = 0; i < 4; i += 1) bucket.tryAcquire()
    expect(bucket.tryAcquire().ok).toBe(false)

    clock.advanceTo(250)
    expect(bucket.tokens()).toBeCloseTo(1, 5)
    expect(bucket.tryAcquire()).toEqual({ ok: true })
  })

  it('caps refill at capacity', () => {
    const clock = new ReplayClock(0)
    const bucket = new TokenBucket(clock, { capacity: 3, refillTokens: 3, refillMs: 1_000 })
    bucket.tryAcquire()
    clock.advanceTo(60_000)
    expect(bucket.tokens()).toBe(3)
  })

  it('derives a bucket using only a share of the provider limit', () => {
    const clock = new ReplayClock(0)
    // CLOB /prices-history 官方 1000 req/10s；只用 20% ⇒ 容量 200
    const bucket = bucketFromLimit(clock, 1_000, 0.2, 10_000)
    expect(bucket.tokens()).toBe(200)
  })

  it('rejects invalid configuration and cost', () => {
    const clock = new ReplayClock(0)
    expect(() => new TokenBucket(clock, { capacity: 0, refillTokens: 1, refillMs: 1 })).toThrow()
    const bucket = new TokenBucket(clock, { capacity: 1, refillTokens: 1, refillMs: 1 })
    expect(() => bucket.tryAcquire(0)).toThrow()
  })
})
