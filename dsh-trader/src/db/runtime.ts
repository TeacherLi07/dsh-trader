/**
 * SQLite 连接的生命周期（单一连接，进程内共享）。
 *
 * 单进程 Docker 下插件共享模块级连接，WAL 保证崩溃恢复时的持久性与读取一致性。
 * 连接由 trade-db 插件拥有，卸载时关闭，避免每个插件另开连接和重复迁移。
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
