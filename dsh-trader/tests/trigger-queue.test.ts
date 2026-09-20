import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { TriggerQueue, type NewTrigger } from '../src/trigger/queue.js'

let db: Database.Database
let queue: TriggerQueue

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  queue = new TriggerQueue(db)
})

afterEach(() => {
  db.close()
})

const trigger = (over: Partial<NewTrigger> = {}): NewTrigger => ({
  triggerId: 't1',
  dedupKey: 'rule|BTC/USDT|1000',
  symbol: 'BTC/USDT',
  ruleId: 'rule',
  purpose: 'info',
  barTs: 1000,
  payload: { a: 1 },
  disposition: 'info',
  state: 'done',
  createdAt: 1000,
  ...over,
})

describe('TriggerQueue', () => {
  it('enqueues idempotently by dedup key', () => {
    expect(queue.enqueue(trigger())).toBe(true)
    expect(queue.enqueue(trigger({ triggerId: 't2' }))).toBe(false)
    expect(queue.count()).toBe(1)
    expect(queue.has('rule|BTC/USDT|1000')).toBe(true)
    expect(queue.has('nope')).toBe(false)
  })

  it('never rewrites an existing trigger', () => {
    queue.enqueue(trigger({ payload: { first: true } }))
    queue.enqueue(trigger({ payload: { second: true } }))
    expect(queue.get('t1')?.payload).toEqual({ first: true })
  })

  it('tracks the latest fire time per (rule, symbol)', () => {
    queue.enqueue(trigger({ createdAt: 500 }))
    queue.enqueue(trigger({ triggerId: 't2', dedupKey: 'k2', createdAt: 900 }))
    expect(queue.latestFireAt('rule', 'BTC/USDT')).toBe(900)
    expect(queue.latestFireAt('other', 'BTC/USDT')).toBeUndefined()
  })

  it('counts only budget-consuming dispositions as fired', () => {
    queue.enqueue(
      trigger({ triggerId: 'a', dedupKey: 'a', purpose: 'novelty', disposition: 'novelty', state: 'queued', createdAt: 1000 }),
    )
    queue.enqueue(
      trigger({ triggerId: 'b', dedupKey: 'b', purpose: 'novelty', disposition: 'rate_limited', createdAt: 1100 }),
    )
    queue.enqueue(
      trigger({ triggerId: 'c', dedupKey: 'c', purpose: 'novelty', disposition: 'cooldown', createdAt: 1200 }),
    )
    expect(queue.countSince(['novelty'], 0)).toBe(3)
    // 被冷却/限流压掉的尝试不占预算，否则它们会自己把窗口占满
    expect(queue.countFiredSince(['novelty'], 0)).toBe(1)
    expect(queue.countFiredSince(['novelty'], 950)).toBe(1)
    expect(queue.countFiredSince(['novelty'], 1050)).toBe(0)
    expect(queue.countFiredSince(['info'], 0)).toBe(0)
  })

  it('claims atomically and marks done', () => {
    queue.enqueue(
      trigger({ triggerId: 'q1', dedupKey: 'q1', purpose: 'novelty', disposition: 'novelty', state: 'queued' }),
    )
    queue.enqueue(
      trigger({
        triggerId: 'q2',
        dedupKey: 'q2',
        purpose: 'commitment',
        disposition: 'judgment',
        state: 'queued',
        createdAt: 1001,
      }),
    )

    const claimed = queue.claim(1000, 1)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.triggerId).toBe('q1')
    expect(queue.queuedCount()).toBe(1)
    expect(queue.count('claimed')).toBe(1)

    queue.markDone('q1')
    expect(queue.get('q1')?.state).toBe('done')
    expect(queue.get('q2')?.state).toBe('queued')
  })

  it('expires stale queued/claimed triggers only', () => {
    queue.enqueue(
      trigger({ triggerId: 'e1', dedupKey: 'e1', disposition: 'novelty', state: 'queued', expiresAt: 2000 }),
    )
    queue.enqueue(trigger({ triggerId: 'e2', dedupKey: 'e2', disposition: 'info', state: 'done', expiresAt: 2000 }))

    expect(queue.expire(1999)).toHaveLength(0)
    expect(queue.expire(2001)).toHaveLength(1)
    expect(queue.get('e1')?.state).toBe('expired')
    expect(queue.get('e2')?.state).toBe('done')
  })

  it('uses persistent exponential backoff, bounds retries, and redacts secrets in failure history', () => {
    queue.enqueue(trigger({ state: 'queued', createdAt: 1000, expiresAt: 5000 }))

    const first = queue.claim(1000)[0]
    expect(first).toMatchObject({ state: 'claimed', attempts: 1, claimedAt: 1000 })
    const retry = queue.fail('t1', 1000, 'network token=secret-value', { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 })
    expect(retry).toMatchObject({ state: 'queued', attempts: 1, nextAttemptAt: 1100 })
    expect(retry.lastError).toContain('token=[REDACTED]')
    expect(retry.lastError).not.toContain('secret-value')
    expect(queue.claim(1099)).toHaveLength(0)

    const second = queue.claim(1100)[0]
    expect(second?.attempts).toBe(2)
    const retryAgain = queue.fail('t1', 1100, 'temporary error', { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 })
    expect(retryAgain).toMatchObject({ state: 'queued', attempts: 2, nextAttemptAt: 1300 })

    expect(queue.claim(1300)[0]?.attempts).toBe(3)
    const exhausted = queue.fail('t1', 1300, 'still failing', { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500 })
    expect(exhausted.state).toBe('failed')
    expect(exhausted.lastError).toContain('[attempt 3] still failing')
  })

  it('recovers claimed rows after restart and expires queued rows with durable reasons', () => {
    queue.enqueue(trigger({ triggerId: 'recover', dedupKey: 'recover', state: 'queued', createdAt: 1000, expiresAt: 5000 }))
    queue.enqueue(trigger({ triggerId: 'expired', dedupKey: 'expired', state: 'queued', createdAt: 1100, expiresAt: 1500 }))
    expect(queue.claim(1000).map((item) => item.triggerId)).toEqual(['recover'])

    const recovered = queue.recoverClaims(1200)
    expect(recovered).toMatchObject([{ triggerId: 'recover', state: 'queued', nextAttemptAt: 1200 }])
    expect(recovered[0]?.lastError).toContain('进程在触发处理期间退出')
    const expired = queue.expire(1500)
    expect(expired).toHaveLength(1)
    expect(expired[0]).toMatchObject({ triggerId: 'expired', state: 'expired' })
    expect(expired[0]?.lastError).toContain('触发器在处理前过期')
    expect(queue.get('recover')?.state).toBe('queued')
  })

  it('does not schedule a retry beyond the event TTL', () => {
    queue.enqueue(trigger({ state: 'queued', createdAt: 1000, expiresAt: 1050 }))
    expect(queue.claim(1000)[0]?.attempts).toBe(1)
    const expired = queue.fail('t1', 1000, 'temporary outage', { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 500 })
    expect(expired.state).toBe('expired')
    expect(expired.lastError).toContain('重试退避超出事件 TTL')
  })

  it('restart recovery exhausts repeated crashes at the configured attempt ceiling', () => {
    queue.enqueue(trigger({ state: 'queued', createdAt: 1000 }))
    expect(queue.claim(1000, 1, 2)[0]?.attempts).toBe(1)
    expect(queue.recoverClaims(1100, 2)[0]?.state).toBe('queued')
    expect(queue.claim(1100, 1, 2)[0]?.attempts).toBe(2)

    const recovered = queue.recoverClaims(1200, 2)[0]
    expect(recovered).toMatchObject({ state: 'failed', attempts: 2 })
    expect(recovered?.lastError).toContain('最大尝试次数')
    expect(queue.claim(1201, 1, 2)).toHaveLength(0)
  })

  it('rejects an unknown disposition value at the schema level', () => {
    expect(() => queue.enqueue(trigger({ disposition: 'teleport' as never }))).toThrow()
  })
})
