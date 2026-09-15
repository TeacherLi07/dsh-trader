/**
 * 主进程与外部 watchdog 共用的心跳状态。
 *
 * 这里故意只依赖 Statements，不依赖 journal 或插件运行时：watchdog 可以在主进程
 * 已经停止后仍然打开同一个 SQLite 文件并完成熔断。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'

export interface HeartbeatAuditEvent {
  readonly actor: 'human' | 'system'
  readonly kind: string
  readonly payload: unknown
  readonly ts: number
}

export type HeartbeatAudit = (event: HeartbeatAuditEvent) => void

interface HeartbeatRow {
  beat_at: number
  halted: number
}

export interface HeartbeatSnapshot {
  readonly beatAt: number
  readonly halted: boolean
}

export interface HeartbeatPort {
  readonly read: () => HeartbeatSnapshot | undefined
  readonly halt: (at: number) => void
}

export class HeartbeatStore {
  readonly #statements: Statements

  constructor(statements: Statements | Database.Database, private readonly audit?: HeartbeatAudit) {
    // 兼容独立 watchdog 直接传入数据库连接的调用方，但所有 SQL 仍统一经过缓存。
    this.#statements = statements instanceof Statements ? statements : new Statements(statements)
  }

  /** 心跳只刷新 beat_at，不清除人工/ watchdog 设置的 halted。 */
  beat(at: number): void {
    this.#statements
      .get(
        'INSERT INTO heartbeat (id, beat_at) VALUES (1, ?) ' +
          'ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at',
      )
      .run(at)
  }

  read(): HeartbeatSnapshot | undefined {
    const row = this.#statements.get('SELECT beat_at, halted FROM heartbeat WHERE id = 1').get() as
      | HeartbeatRow
      | undefined
    if (row === undefined) return undefined
    return { beatAt: row.beat_at, halted: row.halted === 1 }
  }

  /** 没有记录时也建立 halted 行，避免熔断成功但状态没有落库。 */
  halt(at: number): void {
    this.#statements
      .get(
        'INSERT INTO heartbeat (id, beat_at, halted) VALUES (1, ?, 1) ' +
          'ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at, halted = 1',
      )
      .run(at)
    this.audit?.({
      actor: 'system',
      kind: 'heartbeat.halt',
      payload: { at },
      ts: at,
    })
  }

  /** resume 同时刷新心跳，否则刚人工恢复就会被旧 beat_at 立即判成 stale。 */
  resume(at: number): void {
    this.#statements
      .get(
        'INSERT INTO heartbeat (id, beat_at, halted) VALUES (1, ?, 0) ' +
          'ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at, halted = 0',
      )
      .run(at)
    this.audit?.({
      actor: 'system',
      kind: 'heartbeat.resume',
      payload: { at },
      ts: at,
    })
  }

  /** 缺失行不是未 halt，而是 watchdog 的 stale 输入；因此这里只返回 false。 */
  isHalted(): boolean {
    return this.read()?.halted ?? false
  }
}
