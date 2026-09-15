/**
 * 特征快照归档（plan §4.1 的 `features` 表）。
 *
 * 唯一键 `(symbol, timeframe, open_time)` + upsert：同一根 bar 重跑得到同一行，
 * 不会因为重启/重复轮询而堆积。快照用 `canonicalJson` 存储，读回来逐字一致。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { canonicalJson } from '../util/canonical.js'
import type { FeatureSnapshot } from './features.js'

interface FeatureRow {
  symbol: string
  timeframe: string
  open_time: number
  snapshot_json: string
  fingerprint: string
}

export interface FeatureRangeOptions {
  readonly since?: number
  readonly until?: number
  readonly limit?: number
}

const DEFAULT_RANGE_LIMIT = 10_000
const MAX_RANGE_LIMIT = 200_000

function toSnapshot(row: FeatureRow): FeatureSnapshot {
  return JSON.parse(row.snapshot_json) as FeatureSnapshot
}

export class FeatureArchive {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  upsert(snapshot: FeatureSnapshot): void {
    this.#statements.get(
        `INSERT INTO features (symbol, timeframe, open_time, snapshot_json, fingerprint)
         VALUES (@symbol, @timeframe, @openTime, @json, @fingerprint)
         ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           fingerprint = excluded.fingerprint`,
      )
      .run({
        symbol: snapshot.symbol,
        timeframe: snapshot.timeframe,
        openTime: snapshot.openTime,
        json: canonicalJson(snapshot),
        fingerprint: snapshot.fingerprint,
      })
  }

  get(symbol: string, timeframe: string, openTime: number): FeatureSnapshot | undefined {
    const row = this.#statements.get(
        `SELECT symbol, timeframe, open_time, snapshot_json, fingerprint
         FROM features WHERE symbol = ? AND timeframe = ? AND open_time = ?`,
      )
      .get(symbol, timeframe, openTime) as FeatureRow | undefined
    return row === undefined ? undefined : toSnapshot(row)
  }

  latest(symbol: string, timeframe: string): FeatureSnapshot | undefined {
    const row = this.#statements.get(
        `SELECT symbol, timeframe, open_time, snapshot_json, fingerprint
         FROM features WHERE symbol = ? AND timeframe = ?
         ORDER BY open_time DESC LIMIT 1`,
      )
      .get(symbol, timeframe) as FeatureRow | undefined
    return row === undefined ? undefined : toSnapshot(row)
  }

  /**
   * 读取指定时间范围内的快照；查询仍走 Statements，避免轮询/工具调用不断 prepare 新语句。
   * limit 默认 1 万、上限 20 万：既限制一次读入的 JSON 规模，又覆盖 90 天 1m 的约 12.96 万根。
   * JSON 解析失败选择 fail-loud：坏行不能被静默当成缺数据，否则 regime 会在错误样本上继续运行。
   */
  range(
    symbol: string,
    timeframe: string,
    options: FeatureRangeOptions = {},
  ): readonly FeatureSnapshot[] {
    const clauses = ['symbol = ?', 'timeframe = ?']
    const params: unknown[] = [symbol, timeframe]
    if (options.since !== undefined) {
      clauses.push('open_time >= ?')
      params.push(options.since)
    }
    if (options.until !== undefined) {
      clauses.push('open_time <= ?')
      params.push(options.until)
    }

    const requestedLimit = options.limit ?? DEFAULT_RANGE_LIMIT
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.max(1, Math.min(Math.floor(requestedLimit), MAX_RANGE_LIMIT))
        : DEFAULT_RANGE_LIMIT
    const rows = this.#statements
      .get(
        `SELECT symbol, timeframe, open_time, snapshot_json, fingerprint
         FROM features WHERE ${clauses.join(' AND ')}
         ORDER BY open_time ASC LIMIT ?`,
      )
      .all(...params, limit) as FeatureRow[]
    return rows.map(toSnapshot)
  }

  count(symbol?: string, timeframe?: string): number {
    const clauses: string[] = []
    const params: unknown[] = []
    if (symbol !== undefined) {
      clauses.push('symbol = ?')
      params.push(symbol)
    }
    if (timeframe !== undefined) {
      clauses.push('timeframe = ?')
      params.push(timeframe)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const row = this.#statements.get(`SELECT COUNT(*) AS n FROM features ${where}`).get(...params) as {
      n: number
    }
    return row.n
  }
}
