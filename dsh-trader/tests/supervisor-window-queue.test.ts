import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { SupervisorWindowQueue } from '../src/supervisor/window-queue.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

afterEach(() => db.close())

describe('SupervisorWindowQueue', () => {
  it('keeps everyMs anchored across restart and retries failed/unfinished fires', () => {
    const spec = { id: 'midday', everyMs: 100 } as const
    const first = new SupervisorWindowQueue(db)
    first.ensure([spec], 1_000)
    expect(first.enqueueDue([spec], 1_099)).toBe(0)
    expect(first.enqueueDue([spec], 1_100)).toBe(1)

    const claimed = first.claimOne(1_100)
    expect(claimed).toMatchObject({ id: 'midday', fireTs: 1_100, attempts: 1 })
    if (claimed === undefined) return
    first.fail(claimed, 'agent busy', 1_101)

    const retried = first.claimOne(1_102)
    expect(retried).toMatchObject({ id: 'midday', fireTs: 1_100, attempts: 2, lastError: 'agent busy' })
    if (retried === undefined) return
    first.complete(retried, 1_103)

    // 新 queue 实例只能沿用 1_000 的 anchor，不能把下一发重锚到 5_000。
    const afterRestart = new SupervisorWindowQueue(db)
    afterRestart.ensure([spec], 5_000)
    expect(afterRestart.enqueueDue([spec], 1_199)).toBe(0)
    expect(afterRestart.enqueueDue([spec], 1_200)).toBe(1)
    expect(afterRestart.claimOne(1_200)?.fireTs).toBe(1_200)
  })

  it('does not execute pending fires from window ids removed by a config change', () => {
    const queue = new SupervisorWindowQueue(db)
    const oldSpec = { id: 'midday', everyMs: 100 } as const
    queue.ensure([oldSpec], 1_000)
    expect(queue.enqueueDue([oldSpec], 1_100)).toBe(1)

    expect(queue.claimOne(1_100, ['w1-00', 'w1-04'])).toBeUndefined()
    expect(queue.pendingCount()).toBe(1)
  })

  it('recovers a running fire after process restart', () => {
    const spec = { id: 'pre', everyMs: 100 } as const
    const queue = new SupervisorWindowQueue(db)
    queue.ensure([spec], 1_000)
    queue.enqueueDue([spec], 1_100)
    expect(queue.claimOne(1_100)).toBeDefined()

    const restarted = new SupervisorWindowQueue(db)
    expect(restarted.recover(1_200)).toBe(1)
    expect(restarted.claimOne(1_201)?.fireTs).toBe(1_100)
  })
})
