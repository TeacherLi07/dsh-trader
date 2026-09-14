/**
 * 令牌桶限流（plan §4.3：取官方限额的 ≤20%，用排队而不是撞限额）。
 *
 * `tryAcquire` **不阻塞**，只返回需要等待的毫秒数；时间来自注入的 `Clock`，
 * 因此限流行为可确定性单测、可回放。
 */

import type { Clock } from '../clock.js'

export interface RateLimitConfig {
  readonly capacity: number
  readonly refillTokens: number
  readonly refillMs: number
}

export type AcquireResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly waitMs: number }

export class TokenBucket {
  #tokens: number
  #lastRefill: number

  constructor(
    private readonly clock: Clock,
    private readonly config: RateLimitConfig,
  ) {
    if (!(config.capacity > 0) || !(config.refillTokens > 0) || !(config.refillMs > 0)) {
      throw new Error('令牌桶参数必须是正数')
    }
    this.#tokens = config.capacity
    this.#lastRefill = clock.now()
  }

  #refill(now: number): void {
    const elapsed = now - this.#lastRefill
    if (elapsed <= 0) return
    const gained = (elapsed / this.config.refillMs) * this.config.refillTokens
    this.#tokens = Math.min(this.config.capacity, this.#tokens + gained)
    this.#lastRefill = now
  }

  tryAcquire(cost = 1): AcquireResult {
    if (!(cost > 0)) throw new Error('cost 必须是正数')
    this.#refill(this.clock.now())
    if (this.#tokens >= cost) {
      this.#tokens -= cost
      return { ok: true }
    }
    const deficit = cost - this.#tokens
    const waitMs = Math.ceil((deficit / this.config.refillTokens) * this.config.refillMs)
    return { ok: false, waitMs: Math.max(waitMs, 1) }
  }

  tokens(): number {
    this.#refill(this.clock.now())
    return this.#tokens
  }
}

/** 按"官方限额/窗口"建桶，只用其中 `share`（默认 20%）。 */
export function bucketFromLimit(
  clock: Clock,
  limitPerWindow: number,
  share = 0.2,
  windowMs = 10_000,
): TokenBucket {
  const capacity = Math.max(1, Math.floor(limitPerWindow * share))
  return new TokenBucket(clock, { capacity, refillTokens: capacity, refillMs: windowMs })
}
