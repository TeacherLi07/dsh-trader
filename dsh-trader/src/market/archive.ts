/**
 * bar 归档（plan §4.3）：唯一键 `(symbol, timeframe, open_time)` + **upsert**，
 * 只接受已收盘 bar，绝不 append。
 *
 * 权威数据只在这里；预测市场/成交等其它表由各自的 store 负责。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import type { Candle } from './types.js'
import { FeatureArchive } from './feature-archive.js'
import { MarketObservationStore } from './observations.js'

export interface UpsertMeta {
  readonly source: string
  /** 取数时刻，来自注入的 Clock。 */
  readonly fetchedAt: number
}

export interface UpsertResult {
  readonly written: number
  /** 未收盘或抓取时尚未发生的 bar 数；PIT 观测的 availableAt 不能早于 closeTime。 */
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

interface ExistingBarRow {
  close_time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
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
  readonly #observations: MarketObservationStore
  readonly #features: FeatureArchive

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
    this.#observations = new MarketObservationStore(db)
    this.#features = new FeatureArchive(db)
  }

  /** 已收盘且抓取时可见的 bar 才能写入；整个批次一个事务。晚到回补保留真实 availableAt。 */
  upsertClosed(candles: readonly Candle[], meta: UpsertMeta): UpsertResult {
    const existing = this.#statements.get(`
      SELECT close_time, open, high, low, close, volume
      FROM bars
      WHERE symbol = ? AND timeframe = ? AND open_time = ? AND closed = 1
    `)
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
      const invalidateProcessing = this.#statements.get(`
        DELETE FROM bar_processing
        WHERE symbol = ? AND timeframe = ? AND open_time >= ?
      `)
      for (const candle of rows) {
        if (!candle.closed || candle.closeTime > meta.fetchedAt) {
          rejectedOpen += 1
          continue
        }

        const previous = existing.get(candle.symbol, candle.timeframe, candle.openTime) as
          | ExistingBarRow
          | undefined
        const revised = previous !== undefined && (
          previous.close_time !== candle.closeTime ||
          previous.open !== candle.open ||
          previous.high !== candle.high ||
          previous.low !== candle.low ||
          previous.close !== candle.close ||
          previous.volume !== candle.volume
        )
        if (revised) {
          // 一个输入历史点变化会影响它之后的全部增量指标；先撤销整个受影响后缀，
          // 并在同一事务里遮蔽旧特征，避免进程在归档提交与回调失败之间崩溃时暴露旧投影。
          invalidateProcessing.run(candle.symbol, candle.timeframe, candle.openTime)
          const boundary = this.#statements
            .get(`SELECT MAX(close_time) AS last_close FROM bars
              WHERE symbol = ? AND timeframe = ? AND closed = 1 AND open_time >= ?`)
            .get(candle.symbol, candle.timeframe, candle.openTime) as { last_close: number | null }
          this.#features.invalidateFrom(
            candle.symbol,
            candle.timeframe,
            candle.openTime,
            meta.fetchedAt,
            boundary.last_close ?? candle.closeTime,
          )
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
        this.#observations.record({ kind: 'bar', symbol: candle.symbol, timeframe: candle.timeframe,
          eventTime: candle.closeTime, availableAt: meta.fetchedAt, source: meta.source, value: candle })
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

  /** 最近已**成功处理**的 bar；用于重启时恢复增量特征而不跳过待处理队列。 */
  recentProcessedClosedBars(symbol: string, timeframe: string, limit: number): readonly Candle[] {
    const rows = this.#statements
      .get(
        `SELECT b.symbol, b.timeframe, b.open_time, b.close_time, b.open, b.high, b.low, b.close, b.volume, b.closed
         FROM bars b
         JOIN bar_processing p
           ON p.symbol = b.symbol AND p.timeframe = b.timeframe AND p.open_time = b.open_time
         WHERE b.symbol = ? AND b.timeframe = ? AND b.closed = 1
         ORDER BY b.open_time DESC
         LIMIT ?`,
      )
      .all(symbol, timeframe, limit) as BarRow[]
    return rows.map(toCandle).reverse()
  }

  /** 处理游标之后的已收盘 bar，按时间升序返回；成功回调后才写入 bar_processing。 */
  unprocessedClosedBars(symbol: string, timeframe: string, limit = 1_000): readonly Candle[] {
    const rows = this.#statements
      .get(
        `SELECT b.symbol, b.timeframe, b.open_time, b.close_time, b.open, b.high, b.low, b.close, b.volume, b.closed
         FROM bars b
         LEFT JOIN bar_processing p
           ON p.symbol = b.symbol AND p.timeframe = b.timeframe AND p.open_time = b.open_time
         WHERE b.symbol = ? AND b.timeframe = ? AND b.closed = 1 AND p.open_time IS NULL
         ORDER BY b.open_time ASC
         LIMIT ?`,
      )
      .all(symbol, timeframe, limit) as BarRow[]
    return rows.map(toCandle)
  }

  /** 该待处理 bar 是否命中持久特征恢复标记；feed 必须在统一下游回调前检查。 */
  requiresFeatureRecovery(candle: Pick<Candle, 'symbol' | 'timeframe' | 'closeTime'>): boolean {
    return this.#features.hasRecoveryMarker(candle)
  }

  /** 标记一根 bar 的全部下游处理成功；重复标记幂等。 */
  markProcessed(candle: Pick<Candle, 'symbol' | 'timeframe' | 'openTime'>, processedAt: number): void {
    this.#statements
      .get(
        `INSERT INTO bar_processing (symbol, timeframe, open_time, processed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET processed_at = excluded.processed_at`,
      )
      .run(candle.symbol, candle.timeframe, candle.openTime, processedAt)
  }

  /** 归档中首个时间缺口；返回 undefined 表示当前序列连续或不足两根。 */
  firstGapOpenTime(symbol: string, timeframe: string, maxBars = 200_000): number | undefined {
    const bars = this.closedBars(symbol, timeframe, { limit: maxBars })
    // 这里不解析字符串时间框架，避免重复维护单位表；调用方只在已知框架上使用 gap 检测。
    const timeframeSteps: Readonly<Record<string, number>> = {
      '1m': 60_000,
      '15m': 900_000,
      '1h': 3_600_000,
      '4h': 14_400_000,
      '1d': 86_400_000,
    }
    const tfMs = timeframeSteps[timeframe]
    if (tfMs === undefined || bars.length < 2) return undefined
    for (let index = 1; index < bars.length; index += 1) {
      const previous = bars[index - 1] as Candle
      const current = bars[index] as Candle
      if (current.openTime - previous.openTime > tfMs) return previous.openTime + tfMs
    }
    return undefined
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
