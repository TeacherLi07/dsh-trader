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

    const claimed = queue.claim(1)
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

    expect(queue.expire(1999)).toBe(0)
    expect(queue.expire(2001)).toBe(1)
    expect(queue.get('e1')?.state).toBe('expired')
    expect(queue.get('e2')?.state).toBe('done')
  })

  it('rejects an unknown disposition value at the schema level', () => {
    expect(() => queue.enqueue(trigger({ disposition: 'teleport' as never }))).toThrow()
  })
})
