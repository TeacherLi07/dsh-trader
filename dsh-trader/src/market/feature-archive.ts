/**
 * 特征快照归档（plan §4.1 的 `features` 表）。
 *
 * 唯一键 `(symbol, timeframe, open_time)` + upsert：同一根 bar 重跑得到同一行，
 * 不会因为重启/重复轮询而堆积。快照用 `canonicalJson` 存储，读回来逐字一致。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { canonicalJson, fingerprint } from '../util/canonical.js'
import type { FeatureSnapshot } from './features.js'
import { MarketObservationStore } from './observations.js'

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
const INVALIDATED_FEATURE_FIELDS = [
  'open', 'high', 'low', 'close', 'volume', 'ema20', 'ema50', 'rsi14', 'atr14', 'adx14',
  'vwap20', 'zscore20', 'volRealized20', 'fundingRate', 'oiChangePct', 'liqNotional', 'basisBps',
] as const

function toSnapshot(row: FeatureRow): FeatureSnapshot {
  return JSON.parse(row.snapshot_json) as FeatureSnapshot
}

export class FeatureArchive {
  readonly #statements: Statements
  readonly #observations: MarketObservationStore

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
    this.#observations = new MarketObservationStore(db)
  }

  upsert(snapshot: FeatureSnapshot, availableAt?: number): void {
    // 旧投影没有生成时刻；未显式提供时不伪造 PIT 历史，判断入口会如实报告缺失。
    if (availableAt !== undefined) this.#observations.record({
      kind: 'feature', symbol: snapshot.symbol, timeframe: snapshot.timeframe,
      eventTime: snapshot.closeTime, availableAt, source: 'feature-pipeline', value: snapshot,
    })
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

  /**
   * 历史输入修订后，旧增量状态无法安全续算：撤掉当前投影后缀，并在有真实可见时刻时
   * 追加空值 PIT 标记。旧 asOf 仍读旧快照；修订后的 context 只会看到缺失特征，不会
   * 把旧指标伪装成新结果。该标记不会因进程重启自动清除，必须由运维执行 feature-only 重建
   * 并显式确认处理游标；普通 feed 回调不能承担这项恢复，因为其中包含规则和订单副作用。
   */
  invalidateFrom(
    symbol: string,
    timeframe: string,
    openTime: number,
    availableAt?: number,
    recoveryThroughCloseTime?: number,
  ): number {
    if (!Number.isSafeInteger(openTime) || openTime < 0) throw new Error('特征失效 openTime 必须是非负安全整数')
    if (availableAt !== undefined && (!Number.isSafeInteger(availableAt) || availableAt < 0)) {
      throw new Error('特征失效 availableAt 必须是非负安全整数')
    }
    if (recoveryThroughCloseTime !== undefined &&
        (!Number.isSafeInteger(recoveryThroughCloseTime) || recoveryThroughCloseTime < openTime)) {
      throw new Error('特征恢复边界 closeTime 必须是不早于 openTime 的安全整数')
    }

    const removeProjection = this.#statements.get(
      'DELETE FROM features WHERE symbol = ? AND timeframe = ? AND open_time >= ?',
    )
    const invalidate = this.db.transaction(() => {
      let cursor = openTime
      let count = 0

      for (;;) {
        const snapshots = this.range(symbol, timeframe, { since: cursor, limit: MAX_RANGE_LIMIT })
        if (snapshots.length === 0) break

        if (availableAt !== undefined) {
          for (const snapshot of snapshots) {
            if (availableAt < snapshot.closeTime) {
              throw new Error('特征失效 availableAt 不能早于快照 closeTime')
            }
            const values = Object.fromEntries(Object.keys(snapshot.values).map((key) => [key, null]))
            const tombstone = {
              symbol: snapshot.symbol,
              timeframe: snapshot.timeframe,
              openTime: snapshot.openTime,
              closeTime: snapshot.closeTime,
              values,
              fingerprint: fingerprint({ invalidates: snapshot.fingerprint, availableAt }),
              invalidated: true,
              recoveryRequired: true,
            }
            this.#observations.record({
              kind: 'feature',
              symbol,
              timeframe,
              eventTime: snapshot.closeTime,
              availableAt,
              source: 'feature-pipeline-invalidation',
              value: tombstone,
            })
          }
        }

        count += snapshots.length
        if (snapshots.length < MAX_RANGE_LIMIT) break
        const lastOpenTime = snapshots[snapshots.length - 1]?.openTime
        if (lastOpenTime === undefined || lastOpenTime >= Number.MAX_SAFE_INTEGER) {
          throw new Error('特征失效分页游标无法安全前进')
        }
        cursor = lastOpenTime + 1
      }

      // 已处理游标原则上必有特征行；仍写独立标记，避免缺行/旧数据迁移时重启后
      // 把修订 bar 当作普通待处理输入，进而进入包含交易副作用的统一回调。
      if (availableAt !== undefined && recoveryThroughCloseTime !== undefined) {
        if (availableAt < recoveryThroughCloseTime) {
          throw new Error('特征恢复标记 availableAt 不能早于受影响后缀 closeTime')
        }
        const values = Object.fromEntries(INVALIDATED_FEATURE_FIELDS.map((key) => [key, null]))
        this.#observations.record({
          kind: 'feature',
          symbol,
          timeframe,
          eventTime: recoveryThroughCloseTime,
          availableAt,
          source: 'feature-pipeline-invalidation',
          value: {
            symbol, timeframe, openTime, closeTime: recoveryThroughCloseTime, values,
            fingerprint: fingerprint({ invalidatedOpenTime: openTime, recoveryThroughCloseTime, availableAt }),
            invalidated: true,
            recoveryRequired: true,
            recoveryBoundary: true,
          },
        })
      }

      removeProjection.run(symbol, timeframe, openTime)
      return count
    })

    return invalidate()
  }

  /** 持久恢复边界覆盖修订后缀；只有未处理游标仍落在边界内时才需要运维隔离。 */
  hasRecoveryMarker(candle: Pick<FeatureSnapshot, 'symbol' | 'timeframe' | 'closeTime'>): boolean {
    const row = this.#statements
      .get(`SELECT 1 AS present FROM market_observations
        WHERE kind = 'feature' AND symbol = ? AND timeframe = ?
          AND source = 'feature-pipeline-invalidation' AND event_time >= ?
        LIMIT 1`)
      .get(candle.symbol, candle.timeframe, candle.closeTime) as { present: number } | undefined
    return row !== undefined
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

  /** 最近快照按时间升序返回；重启恢复衍生品 tracker 时与 bar 游标对齐。 */
  recent(symbol: string, timeframe: string, limit: number): readonly FeatureSnapshot[] {
    const rows = this.#statements
      .get(
        `SELECT symbol, timeframe, open_time, snapshot_json, fingerprint
         FROM features WHERE symbol = ? AND timeframe = ?
         ORDER BY open_time DESC LIMIT ?`,
      )
      .all(symbol, timeframe, limit) as FeatureRow[]
    return rows.map(toSnapshot).reverse()
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
