/**
 * SQLite 连接的生命周期（单一连接，进程内共享）。
 *
 * 多进程约束：主进程与外部 watchdog 会同时读 `heartbeat`/`halted`，因此必须 WAL（`migrate` 已设置）。
 * T0.2 会把这里收敛成正式的 Cordis 服务；当前先用模块级单例，避免依赖尚未核对的 service API。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './schema.js'

let current: Database.Database | undefined

export function openDatabase(path: string): Database.Database {
  if (current !== undefined) return current
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  migrate(db)
  current = db
  return db
}

export function getDatabase(): Database.Database {
  if (current === undefined) {
    throw new Error('trade-db 尚未初始化：请确认 cordis.patch.yml 里 trade-db 行在其它行之前')
  }
  return current
}

export function hasDatabase(): boolean {
  return current !== undefined
}

export function closeDatabase(): void {
  current?.close()
  current = undefined
}
