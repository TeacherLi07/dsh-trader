/**
 * `trade-db` —— 权威状态（SQLite）。必须是 patch 里的第一行。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { closeDatabase, getDatabase, openDatabase } from '../db/runtime.js'

export const name = 'trade-db'

export const Config = z.object({
  path: z.string().required(),
})

export interface DbConfig {
  path: string
}

export function apply(ctx: Context, config: DbConfig): void {
  const db = openDatabase(config.path)
  // 用一句无害查询确认库真的可用（也避免"打开了但没建表"的静默失败）
  db.prepare('SELECT 1 AS ok').get()
  ctx.effect(() => () => closeDatabase(), 'trade.db.close')
}

export { getDatabase }
