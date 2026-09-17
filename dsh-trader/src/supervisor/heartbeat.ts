/**
 * 主进程持久化的心跳与组合级 halted 状态。
 *
 * 当前部署是 Docker 单进程；beat_at 只用于 liveness/启动恢复的可观测性，进程死亡后由
 * Docker 重启 dsh，不能把它解释成外部撤单触发器。
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
    // 保留 Database 兼容入口，便于恢复/测试复用；生产只有 dsh 主进程持有该连接。
    this.#statements = statements instanceof Statements ? statements : new Statements(statements)
  }

  /** 心跳只刷新 beat_at，不清除人工设置的 halted。 */
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

  /** resume 同时刷新心跳，便于重启后的状态面准确显示恢复时刻。 */
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

  /** 缺失行表示尚未初始化；启动恢复会补齐它，不能把缺失当成安全状态。 */
  isHalted(): boolean {
    return this.read()?.halted ?? false
  }
}
