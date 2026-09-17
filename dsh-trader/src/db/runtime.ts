/**
 * SQLite 连接的生命周期（单一连接，进程内共享）。
 *
 * 单进程 Docker 约束：SQLite 仍启用 WAL 以保证崩溃恢复时的持久性与读取一致性；不再有外部
 * watchdog 与主进程并行读写 `heartbeat`/`halted`。T0.2 会把这里收敛成正式的 Cordis 服务；
 * 当前先用模块级单例，避免依赖尚未核对的 service API。
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
