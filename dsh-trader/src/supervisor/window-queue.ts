/**
 * W1 窗口的持久队列。
 *
 * 内存 cursor 会在进程重启/agent 忙时把窗口永久吞掉；这里把“已接受的 fire”和
 * “已完成的 fire”拆开：扫描只入 pending，只有 drive 成功后才推进 cursor。这样
 * everyMs 的首个锚点固定在首次初始化时刻，失败/忙/重启都能继续重试。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { dueWindows, type WindowFire, type WindowSpec } from './windows.js'

export interface WindowQueueItem extends WindowFire {
  readonly attempts: number
  readonly lastError: string | null
}

interface CursorRow {
  window_id: string
  cursor_ts: number
  anchor_ts: number
  updated_at: number
}

interface WindowRow {
  window_id: string
  fire_ts: number
  attempts: number
  last_error: string | null
}

export class SupervisorWindowQueue {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  /** 首次见到窗口时固定 anchor；重启不会把 everyMs 重新锚到新的 now。 */
  ensure(specs: readonly WindowSpec[], now: number): void {
    const insert = this.#statements.get(
      `INSERT INTO supervisor_window_cursors (window_id, cursor_ts, anchor_ts, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (window_id) DO NOTHING`,
    )
    for (const spec of specs) insert.run(spec.id, now, now, now)
  }

  /** 启动恢复：上次进程死在 running 的 fire 必须回到 pending。 */
  recover(now: number): number {
    const result = this.#statements
      .get(
        `UPDATE supervisor_windows
         SET state = 'pending', last_error = COALESCE(last_error, '进程在窗口处理期间退出'), updated_at = ?
         WHERE state = 'running'`,
      )
      .run(now)
    return Number(result.changes)
  }

  /** 扫描只接受 fire，不推进 cursor；唯一键保证重复扫描不会重复入队。 */
  enqueueDue(specs: readonly WindowSpec[], now: number): number {
    const insert = this.#statements.get(
      `INSERT INTO supervisor_windows
         (window_id, fire_ts, state, attempts, last_error, created_at, updated_at)
       VALUES (?, ?, 'pending', 0, NULL, ?, ?)
       ON CONFLICT (window_id, fire_ts) DO NOTHING`,
    )
    let accepted = 0
    for (const spec of specs) {
      const cursor = this.cursor(spec.id)
      if (cursor === undefined) {
        this.ensure([spec], now)
        continue
      }
      for (const fire of dueWindows([spec], cursor.cursor_ts, now)) {
        const result = insert.run(fire.id, fire.fireTs, now, now)
        accepted += Number(result.changes)
      }
    }
    return accepted
  }

  /** 原子领取一个最早 pending fire；busy 时调用方不领取，因此不会制造跳过。 */
  claimOne(now: number, activeWindowIds?: readonly string[]): WindowQueueItem | undefined {
    if (activeWindowIds !== undefined && activeWindowIds.length === 0) return undefined
    const activeFilter = activeWindowIds === undefined
      ? ''
      : ` AND window_id IN (${activeWindowIds.map(() => '?').join(', ')})`
    const select = this.#statements.get(
      `SELECT window_id, fire_ts, attempts, last_error
       FROM supervisor_windows
       WHERE state = 'pending'${activeFilter}
       ORDER BY fire_ts ASC, window_id ASC
       LIMIT 1`,
    )
    const update = this.#statements.get(
      `UPDATE supervisor_windows
       SET state = 'running', attempts = attempts + 1, updated_at = ?
       WHERE window_id = ? AND fire_ts = ? AND state = 'pending'`,
    )
    const claim = this.db.transaction(() => {
      const row = select.get(...(activeWindowIds ?? [])) as WindowRow | undefined
      if (row === undefined) return undefined
      const result = update.run(now, row.window_id, row.fire_ts)
      if (Number(result.changes) !== 1) return undefined
      return {
        id: row.window_id,
        fireTs: row.fire_ts,
        attempts: row.attempts + 1,
        lastError: row.last_error,
      } satisfies WindowQueueItem
    })
    return claim()
  }

  complete(item: WindowQueueItem, now: number): boolean {
    const mark = this.#statements.get(
      `UPDATE supervisor_windows SET state = 'done', updated_at = ?
       WHERE window_id = ? AND fire_ts = ? AND state = 'running' AND attempts = ?`,
    )
    const advance = this.#statements.get(
      `UPDATE supervisor_window_cursors SET cursor_ts = ?, updated_at = ?
       WHERE window_id = ? AND cursor_ts < ?`,
    )
    return this.db.transaction(() => {
      if (Number(mark.run(now, item.id, item.fireTs, item.attempts).changes) !== 1) return false
      // 恢复/重试会更换 attempt；旧回调既不能完成新领取，也不能跳过尚未完成的 fire。
      advance.run(item.fireTs, now, item.id, item.fireTs)
      return true
    })()
  }

  fail(item: WindowQueueItem, error: unknown, now: number): void {
    this.#statements
      .get(
        `UPDATE supervisor_windows SET state = 'pending', last_error = ?, updated_at = ?
         WHERE window_id = ? AND fire_ts = ? AND state = 'running' AND attempts = ?`,
      )
      .run(String(error), now, item.id, item.fireTs, item.attempts)
  }

  pendingCount(): number {
    return (this.#statements.get("SELECT COUNT(*) AS n FROM supervisor_windows WHERE state = 'pending'").get() as { n: number }).n
  }

  private cursor(windowId: string): CursorRow | undefined {
    return this.#statements
      .get('SELECT window_id, cursor_ts, anchor_ts, updated_at FROM supervisor_window_cursors WHERE window_id = ?')
      .get(windowId) as CursorRow | undefined
  }
}
