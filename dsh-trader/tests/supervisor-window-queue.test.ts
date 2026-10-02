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

  it('已经退回 pending 的旧处理回调不能推进窗口游标', () => {
    const spec = { id: 'w1', everyMs: 100 } as const
    const queue = new SupervisorWindowQueue(db)
    queue.ensure([spec], 1_000)
    expect(queue.enqueueDue([spec], 1_100)).toBe(1)
    const claimed = queue.claimOne(1_100)
    if (claimed === undefined) throw new Error('非空窗口未被领取')
    queue.fail(claimed, 'retry', 1_101)
    queue.complete(claimed, 1_102)
    expect(db.prepare('SELECT cursor_ts FROM supervisor_window_cursors WHERE window_id = ?').get(spec.id)).toEqual({ cursor_ts: 1_000 })
    expect(queue.pendingCount()).toBe(1)
  })

  it('恢复后已重新领取的窗口不能被旧 attempt 完成，当前 attempt 完成仍幂等', () => {
    const spec = { id: 'w1', everyMs: 100 } as const
    const oldWorker = new SupervisorWindowQueue(db)
    oldWorker.ensure([spec], 1_000)
    expect(oldWorker.enqueueDue([spec], 1_100)).toBe(1)
    const oldClaim = oldWorker.claimOne(1_100)
    if (oldClaim === undefined) throw new Error('非空窗口未被领取')
    const restarted = new SupervisorWindowQueue(db)
    expect(restarted.recover(1_101)).toBe(1)
    const currentClaim = restarted.claimOne(1_102)
    if (currentClaim === undefined) throw new Error('恢复后的窗口未被领取')
    expect(currentClaim.attempts).toBe(2)
    oldWorker.complete(oldClaim, 1_103)
    expect(db.prepare('SELECT state, attempts FROM supervisor_windows').get()).toEqual({ state: 'running', attempts: 2 })
    expect(db.prepare('SELECT cursor_ts FROM supervisor_window_cursors').get()).toEqual({ cursor_ts: 1_000 })
    restarted.complete(currentClaim, 1_104)
    restarted.complete(currentClaim, 1_105)
    expect(db.prepare('SELECT state, attempts FROM supervisor_windows').get()).toEqual({ state: 'done', attempts: 2 })
    expect(db.prepare('SELECT cursor_ts FROM supervisor_window_cursors').get()).toEqual({ cursor_ts: 1_100 })
  })

  it('旧 attempt 的迟到失败不能释放新 attempt 的领取或覆盖其错误', () => {
    const spec = { id: 'w1', everyMs: 100 } as const
    const queue = new SupervisorWindowQueue(db)
    queue.ensure([spec], 1_000)
    expect(queue.enqueueDue([spec], 1_100)).toBe(1)
    const oldClaim = queue.claimOne(1_100)
    if (oldClaim === undefined) throw new Error('非空窗口未被领取')
    queue.fail(oldClaim, 'first failure', 1_101)
    const currentClaim = queue.claimOne(1_102)
    if (currentClaim === undefined) throw new Error('重试窗口未被领取')
    queue.fail(oldClaim, 'late failure', 1_103)
    expect(db.prepare('SELECT state, attempts, last_error FROM supervisor_windows').get()).toEqual({ state: 'running', attempts: 2, last_error: 'first failure' })
    queue.fail(currentClaim, 'current failure', 1_104)
    expect(queue.pendingCount()).toBe(1)
    expect(queue.claimOne(1_105)).toMatchObject({ attempts: 3, lastError: 'current failure' })
  })
})
