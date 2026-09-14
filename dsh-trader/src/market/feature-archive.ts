/**
 * 特征快照归档（plan §4.1 的 `features` 表）。
 *
 * 唯一键 `(symbol, timeframe, open_time)` + upsert：同一根 bar 重跑得到同一行，
 * 不会因为重启/重复轮询而堆积。快照用 `canonicalJson` 存储，读回来逐字一致。
 */

import type Database from 'better-sqlite3'
import { canonicalJson } from '../util/canonical.js'
import type { FeatureSnapshot } from './features.js'

interface FeatureRow {
  symbol: string
  timeframe: string
  open_time: number
  snapshot_json: string
  fingerprint: string
}

function toSnapshot(row: FeatureRow): FeatureSnapshot {
  return JSON.parse(row.snapshot_json) as FeatureSnapshot
}

export class FeatureArchive {
  constructor(private readonly db: Database.Database) {}

  upsert(snapshot: FeatureSnapshot): void {
    this.db
      .prepare(
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
    const row = this.db
      .prepare(
        `SELECT symbol, timeframe, open_time, snapshot_json, fingerprint
         FROM features WHERE symbol = ? AND timeframe = ? AND open_time = ?`,
      )
      .get(symbol, timeframe, openTime) as FeatureRow | undefined
    return row === undefined ? undefined : toSnapshot(row)
  }

  latest(symbol: string, timeframe: string): FeatureSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT symbol, timeframe, open_time, snapshot_json, fingerprint
         FROM features WHERE symbol = ? AND timeframe = ?
         ORDER BY open_time DESC LIMIT 1`,
      )
      .get(symbol, timeframe) as FeatureRow | undefined
    return row === undefined ? undefined : toSnapshot(row)
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
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM features ${where}`).get(...params) as {
      n: number
    }
    return row.n
  }
}
