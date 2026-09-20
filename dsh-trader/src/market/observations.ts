import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { canonicalJson, fingerprint } from '../util/canonical.js'

export type ObservationKind = 'bar' | 'feature' | 'derivatives' | 'spec'

export interface MarketObservation<T = unknown> {
  readonly kind: ObservationKind
  readonly symbol: string
  readonly timeframe: string
  readonly eventTime: number
  readonly availableAt: number
  readonly source: string
  readonly value: T
  readonly fingerprint: string
}

interface Row {
  kind: ObservationKind; symbol: string; timeframe: string; event_time: number
  available_at: number; source: string; fingerprint: string; payload_json: string
}

/** 只追加的双时间归档：同一事件的晚到修订不能污染较早的 context。 */
export class MarketObservationStore {
  readonly #sql: Statements
  constructor(db: Database.Database) { this.#sql = new Statements(db) }

  record<T>(input: Omit<MarketObservation<T>, 'fingerprint'>): boolean {
    if (input.symbol.trim() === '' || input.source.trim() === '') throw new Error('观测 symbol/source 不能为空')
    if (input.kind !== 'derivatives' && input.kind !== 'spec' && input.timeframe.trim() === '') {
      throw new Error(`${input.kind} 观测必须提供 timeframe`)
    }
    if (!Number.isSafeInteger(input.eventTime) || input.eventTime < 0 ||
        !Number.isSafeInteger(input.availableAt) || input.availableAt < input.eventTime) {
      throw new Error('观测必须满足 0 <= eventTime <= availableAt，单位为整数毫秒')
    }
    const payload = canonicalJson(input.value)
    return this.#sql.get(`INSERT INTO market_observations
      (kind, symbol, timeframe, event_time, available_at, source, fingerprint, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, symbol, timeframe, event_time, available_at, fingerprint) DO NOTHING`)
      .run(input.kind, input.symbol, input.timeframe, input.eventTime, input.availableAt,
        input.source, fingerprint({ source: input.source, value: input.value }), payload).changes > 0
  }

  recent<T>(kind: ObservationKind, symbol: string, timeframe: string, asOf: number, limit: number): readonly MarketObservation<T>[] {
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('观测读取 asOf 必须是非负安全整数毫秒时间戳')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('观测读取上限必须在 1..10000')
    const rows = this.#sql.get(`SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY event_time ORDER BY available_at DESC, seq DESC) AS revision
      FROM market_observations WHERE kind = ? AND symbol = ? AND timeframe = ?
        AND event_time <= ? AND available_at <= ?
      ) WHERE revision = 1 ORDER BY event_time DESC LIMIT ?`).all(kind, symbol, timeframe, asOf, asOf, limit) as Row[]
    return rows.reverse().map(row => ({
      kind: row.kind, symbol: row.symbol, timeframe: row.timeframe, eventTime: row.event_time,
      availableAt: row.available_at, source: row.source, fingerprint: row.fingerprint,
      value: JSON.parse(row.payload_json) as T,
    }))
  }
}
