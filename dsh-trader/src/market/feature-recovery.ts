/** 历史修订的人工恢复；只重建特征与确认历史游标，不持有下游回调或执行端口。 */
import type Database from 'better-sqlite3'
import type { Clock } from '../clock.js'
import { Statements } from '../db/statements.js'
import { DecisionJournal } from '../exec/journal.js'
import { fingerprint } from '../util/canonical.js'
import { FeatureArchive } from './feature-archive.js'
import { FeatureEngine, FEATURE_WARMUP_BARS, type FeatureDerivatives, type FeatureSnapshot } from './features.js'
import { timeframeMs } from './normalize.js'
import type { Candle } from './types.js'

interface InputRow { open_time: number; close_time: number; open: number; high: number; low: number; close: number; volume: number; fetched_at: number; processed: number; feature_json: string | null }
interface Input { candle: Candle; processed: boolean; derivatives?: FeatureDerivatives }
export interface FeatureRecoveryPlan { recoveryId: string; symbol: string; timeframe: string; markerSeq: number; throughCloseTime: number; firstPendingOpenTime: number; bars: number; affectedBars: number; missingDerivativeInputs: number }
export interface FeatureRecoveryReceipt { recovery_id: string; symbol: string; timeframe: string; result_hash: string; marker_seq: number; through_close_time: number; affected_bars: number; rebuilt_at: number; confirmed_at: number | null; rebuild_reason: string; confirm_reason: string | null }

export class FeatureRecovery {
  readonly #sql: Statements
  readonly #features: FeatureArchive
  readonly #journal: DecisionJournal
  constructor(private readonly db: Database.Database, private readonly clock: Clock, private readonly maximumBars = 200_000) {
    if (!Number.isSafeInteger(maximumBars) || maximumBars < FEATURE_WARMUP_BARS) throw Error('恢复读取上限必须覆盖特征暖机窗口')
    this.#sql = new Statements(db); this.#features = new FeatureArchive(db); this.#journal = new DecisionJournal(db)
  }
  isolationActive(symbol: string, timeframe: string): boolean {
    return this.#sql.get(`SELECT 1 FROM bars b LEFT JOIN bar_processing p
      ON p.symbol=b.symbol AND p.timeframe=b.timeframe AND p.open_time=b.open_time
      WHERE b.symbol=? AND b.timeframe=? AND b.closed=1 AND p.open_time IS NULL
      AND EXISTS (SELECT 1 FROM market_observations o WHERE o.kind='feature' AND o.symbol=b.symbol
        AND o.timeframe=b.timeframe AND o.source='feature-pipeline-invalidation' AND o.event_time>=b.close_time) LIMIT 1`)
      .get(symbol,timeframe) !== undefined
  }
  inspect(symbol: string, timeframe: string): FeatureRecoveryPlan { return this.#load(symbol, timeframe).plan }
  receipt(id: string): FeatureRecoveryReceipt | undefined {
    return this.#sql.get('SELECT * FROM market_feature_recoveries WHERE recovery_id = ?').get(id) as FeatureRecoveryReceipt | undefined
  }
  rebuild(symbol: string, timeframe: string, expectedId: string, reason: string): FeatureRecoveryReceipt {
    return this.#audited('rebuild', expectedId, () => this.db.transaction(() => {
      this.#reason(reason)
      const prior = this.receipt(expectedId)
      if (prior !== undefined) { this.#scope(prior, symbol, timeframe); return prior }
      const { plan, inputs } = this.#load(symbol, timeframe)
      if (plan.recoveryId !== expectedId) throw Error('归档或隔离状态已变化，必须重新查看恢复计划')
      const engine = new FeatureEngine(), rebuilt: FeatureSnapshot[] = [], at = this.clock.now()
      for (const input of inputs) {
        const snapshot = engine.onClosedCandle(input.candle, input.derivatives)
        if (!input.processed) { this.#features.upsert(snapshot, at); rebuilt.push(snapshot) }
      }
      const changed = this.#sql.get(`INSERT INTO market_feature_recoveries
        (recovery_id,symbol,timeframe,result_hash,marker_seq,through_close_time,affected_bars,rebuilt_at,rebuild_reason)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(recovery_id) DO NOTHING`).run(expectedId, symbol, timeframe,
        fingerprint(rebuilt), plan.markerSeq, plan.throughCloseTime, rebuilt.length, at, reason).changes
      if (changed !== 1) throw Error('恢复唯一键冲突，拒绝重复提交')
      this.#journal.appendAudit({ actor: 'human', kind: 'market.features_rebuilt', ts: at, payload: { ...plan, reason, executionCallbacks: 0 } })
      return this.receipt(expectedId)!
    }).immediate())
  }
  confirmCursor(symbol: string, timeframe: string, id: string, reason: string): FeatureRecoveryReceipt {
    return this.#audited('confirm', id, () => this.db.transaction(() => {
      this.#reason(reason)
      const receipt = this.receipt(id)
      if (receipt === undefined) throw Error('必须先完成特征重建，再确认处理游标')
      this.#scope(receipt, symbol, timeframe)
      if (receipt.confirmed_at !== null) return receipt
      const { plan, inputs } = this.#load(symbol, timeframe)
      if (plan.recoveryId !== receipt.recovery_id) throw Error('重建后输入或隔离状态已变化，拒绝旧游标确认')
      const pending = inputs.filter(input => !input.processed)
      const snapshots = pending.map(input => this.#features.get(symbol, timeframe, input.candle.openTime))
      if (snapshots.some(snapshot => snapshot === undefined) || fingerprint(snapshots) !== receipt.result_hash) throw Error('特征投影与重建凭据不一致，拒绝确认')
      const at = this.clock.now()
      if (at < receipt.rebuilt_at) throw Error('恢复确认时钟不能早于重建时刻')
      const mark = this.#sql.get(`INSERT INTO bar_processing(symbol,timeframe,open_time,processed_at)
        VALUES (?,?,?,?) ON CONFLICT(symbol,timeframe,open_time) DO NOTHING`)
      for (const input of pending) mark.run(symbol, timeframe, input.candle.openTime, at)
      this.#sql.get(`UPDATE market_feature_recoveries SET confirmed_at=?,confirm_reason=?
        WHERE recovery_id=? AND confirmed_at IS NULL`).run(at, reason, id)
      this.#journal.appendAudit({ actor: 'human', kind: 'market.feature_cursor_confirmed', ts: at,
        payload: { recoveryId: id, symbol, timeframe, skippedHistoricalCallbacks: pending.length, throughCloseTime: plan.throughCloseTime, reason } })
      return this.receipt(id)!
    }).immediate())
  }
  #load(symbol: string, timeframe: string): { plan: FeatureRecoveryPlan; inputs: Input[] } {
    if (symbol.trim() === '') throw Error('恢复标的不能为空')
    const step = timeframeMs(timeframe), at = this.clock.now()
    const marker = this.#sql.get(`SELECT MAX(seq) AS seq,MAX(event_time) AS through_time,MAX(available_at) AS available_at
      FROM market_observations WHERE kind='feature' AND symbol=? AND timeframe=? AND source='feature-pipeline-invalidation'`).get(symbol, timeframe) as { seq: number | null; through_time: number | null; available_at: number | null }
    if (marker.seq === null || marker.through_time === null) throw Error('没有持久特征恢复隔离标记')
    if (!Number.isSafeInteger(at) || at < (marker.available_at ?? 0)) throw Error('隔离记录尚未在当前时刻可见')
    // 取隔离之前的原始衍生品输入，重建不能把自己的新投影作为下一次输入或制造历史可见性。
    const rows = this.#sql.get(`SELECT b.open_time,b.close_time,b.open,b.high,b.low,b.close,b.volume,b.fetched_at,
      p.open_time IS NOT NULL AS processed,
      (SELECT payload_json FROM market_observations o WHERE o.kind='feature' AND o.symbol=b.symbol
        AND o.timeframe=b.timeframe AND o.event_time=b.close_time AND o.source='feature-pipeline'
        AND o.seq<? AND o.available_at<=? ORDER BY o.available_at DESC,o.seq DESC LIMIT 1) AS feature_json
      FROM bars b LEFT JOIN bar_processing p ON p.symbol=b.symbol AND p.timeframe=b.timeframe AND p.open_time=b.open_time
      WHERE b.symbol=? AND b.timeframe=? AND b.closed=1 AND b.close_time<=? ORDER BY b.open_time LIMIT ?`)
      .all(marker.seq, at, symbol, timeframe, marker.through_time, this.maximumBars + 1) as InputRow[]
    if (rows.length > this.maximumBars) throw Error('完整恢复历史超过读取上限；不能截断后继续重建')
    if (rows.length < FEATURE_WARMUP_BARS) throw Error('完整历史不足特征暖机窗口，拒绝恢复')
    const inputs: Input[] = rows.map((row, index) => {
      if (row.fetched_at > at || row.close_time > at || !Number.isSafeInteger(row.open_time) || row.open_time < 0 ||
        row.close_time !== row.open_time + step || (index > 0 && row.open_time !== rows[index - 1]!.close_time) ||
        ![row.open,row.high,row.low,row.close,row.volume].every(Number.isFinite) || row.volume < 0 || row.low <= 0 ||
        row.low > Math.min(row.open,row.close) || row.high < Math.max(row.open,row.close)) throw Error('归档存在缺口、未来数据或无效OHLCV，拒绝恢复')
      const historical = row.feature_json === null ? undefined : JSON.parse(row.feature_json) as FeatureSnapshot
      return { candle: { symbol,timeframe,openTime: row.open_time,closeTime: row.close_time,
        open: row.open,high: row.high,low: row.low,close: row.close,volume: row.volume,closed: true }, processed: row.processed === 1,
        ...(historical?.derivatives === undefined ? {} : { derivatives: historical.derivatives }) }
    })
    const pending = inputs.filter(input => !input.processed)
    if (pending.length === 0) throw Error('隔离区间没有未确认历史游标')
    const recoveryId = fingerprint({ symbol,timeframe,markerSeq: marker.seq,through: marker.through_time,inputs })
    return { inputs, plan: { recoveryId,symbol,timeframe,markerSeq: marker.seq,throughCloseTime: marker.through_time,
      firstPendingOpenTime: pending[0]!.candle.openTime,bars: inputs.length,affectedBars: pending.length,
      missingDerivativeInputs: inputs.filter(input => input.derivatives === undefined).length } }
  }
  #scope(receipt: FeatureRecoveryReceipt, symbol: string, timeframe: string): void {
    if (receipt.symbol !== symbol || receipt.timeframe !== timeframe) throw Error('恢复凭据属于其它标的或时间框')
  }
  #reason(reason: string): void { if (reason.trim() === '' || reason.length > 2048) throw Error('恢复原因必须为1..2048字符的非空文本') }
  #audited<T>(operation: string, id: string, work: () => T): T {
    try { return work() } catch (error) {
      try {
        this.db.transaction(() => this.#journal.appendAudit({ actor: 'human', kind: 'market.feature_recovery_rejected', ts: this.clock.now(),
          payload: { operation,recoveryId: id,reason: error instanceof Error ? error.message : String(error) } })).immediate()
      } catch (auditError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}；拒绝审计失败：${String(auditError)}`, { cause: error })
      }
      throw error
    }
  }
}
