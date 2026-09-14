/**
 * bar 归档（plan §4.3）：唯一键 `(symbol, timeframe, open_time)` + **upsert**，
 * 只接受已收盘 bar，绝不 append。
 *
 * 权威数据只在这里；预测市场/成交等其它表由各自的 store 负责。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import type { Candle } from './types.js'

export interface UpsertMeta {
  readonly source: string
  /** 取数时刻，来自注入的 Clock。 */
  readonly fetchedAt: number
}

export interface UpsertResult {
  readonly written: number
  /** 因为**未收盘**而被拒绝的 bar 数 —— 只落已收盘 bar，且拒绝要可见。 */
  readonly rejectedOpen: number
}

export interface BarQuery {
  readonly since?: number
  readonly until?: number
  readonly limit?: number
}

interface BarRow {
  symbol: string
  timeframe: string
  open_time: number
  close_time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  closed: number
}

function toCandle(row: BarRow): Candle {
  return {
    symbol: row.symbol,
    timeframe: row.timeframe,
    openTime: row.open_time,
    closeTime: row.close_time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    closed: row.closed === 1,
  }
}

export class BarArchive {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  /** 已收盘 bar 写入/更新；未收盘一律拒绝。整个批次一个事务。 */
  upsertClosed(candles: readonly Candle[], meta: UpsertMeta): UpsertResult {
    const statement = this.#statements.get(`
      INSERT INTO bars (
        symbol, timeframe, open_time, close_time, open, high, low, close, volume, closed, source, fetched_at
      ) VALUES (
        @symbol, @timeframe, @openTime, @closeTime, @open, @high, @low, @close, @volume, 1, @source, @fetchedAt
      )
      ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
        close_time = excluded.close_time,
        open = excluded.open, high = excluded.high, low = excluded.low,
        close = excluded.close, volume = excluded.volume,
        closed = 1, source = excluded.source, fetched_at = excluded.fetched_at
    `)

    let written = 0
    let rejectedOpen = 0

    const run = this.db.transaction((rows: readonly Candle[]) => {
      for (const candle of rows) {
        if (!candle.closed) {
          rejectedOpen += 1
          continue
        }
        statement.run({
          symbol: candle.symbol,
          timeframe: candle.timeframe,
          openTime: candle.openTime,
          closeTime: candle.closeTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          source: meta.source,
          fetchedAt: meta.fetchedAt,
        })
        written += 1
      }
    })
    run(candles)

    return { written, rejectedOpen }
  }

  /** 该 (symbol, timeframe) 已收盘 bar 的最大 `open_time`，用于"只发新增"。 */
  lastOpenTime(symbol: string, timeframe: string): number | undefined {
    const row = this.#statements.get(
        'SELECT MAX(open_time) AS last FROM bars WHERE symbol = ? AND timeframe = ? AND closed = 1',
      )
      .get(symbol, timeframe) as { last: number | null } | undefined
    return row?.last ?? undefined
  }

  /** 已收盘 bar，按 `open_time` 升序；`[since, until)` 半开区间。 */
  closedBars(symbol: string, timeframe: string, query: BarQuery = {}): readonly Candle[] {
    const rows = this.#statements.get(
        `SELECT symbol, timeframe, open_time, close_time, open, high, low, close, volume, closed
         FROM bars
         WHERE symbol = ? AND timeframe = ? AND closed = 1
           AND open_time >= ? AND open_time < ?
         ORDER BY open_time ASC
         LIMIT ?`,
      )
      .all(
        symbol,
        timeframe,
        query.since ?? 0,
        query.until ?? Number.MAX_SAFE_INTEGER,
        query.limit ?? 1000,
      ) as BarRow[]
    return rows.map(toCandle)
  }

  /** **最近** `limit` 根已收盘 bar（按 `open_time` 升序返回）—— 用于进程重启后回灌特征。 */
  recentClosedBars(symbol: string, timeframe: string, limit: number): readonly Candle[] {
    const rows = this.#statements.get(
        `SELECT symbol, timeframe, open_time, close_time, open, high, low, close, volume, closed
         FROM bars
         WHERE symbol = ? AND timeframe = ? AND closed = 1
         ORDER BY open_time DESC
         LIMIT ?`,
      )
      .all(symbol, timeframe, limit) as BarRow[]
    return rows.map(toCandle).reverse()
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
    const row = this.#statements.get(`SELECT COUNT(*) AS n FROM bars ${where}`).get(...params) as {
      n: number
    }
    return row.n
  }
}
