/**
 * 持久触发队列（plan §2 / §4.1 的 `triggers` 表）。
 *
 * 核心不变量：**`dedup_key` 唯一** ⇒ 同一根 bar 重复回放**不会**产生第二条触发。
 * 这让"离线回放跑两遍、结果完全一致"成为数据库层面的性质，而不是靠内存去重。
 */

import type Database from 'better-sqlite3'
import { canonicalJson } from '../util/canonical.js'

export type TriggerPurpose = 'invalidation' | 'commitment' | 'novelty' | 'info'
export type TriggerState = 'queued' | 'claimed' | 'done' | 'expired'
/** 触发最终的去向。**只有 `novelty` / `judgment` 消耗唤醒预算**。 */
export type TriggerDisposition =
  | 'info'
  | 'novelty'
  | 'judgment'
  | 'cooldown'
  | 'rate_limited'
  /** 被计划卡覆盖并**确定性执行**（零 token）。 */
  | 'executed'

/** 消耗唤醒预算的去向 —— 冷却/限流压掉的不算（否则被压掉的重试会自我放大预算占用）。 */
export const BUDGET_DISPOSITIONS: readonly TriggerDisposition[] = ['novelty', 'judgment']

export interface NewTrigger {
  readonly triggerId: string
  readonly dedupKey: string
  readonly symbol?: string
  readonly ruleId?: string
  readonly purpose: TriggerPurpose
  readonly barTs?: number
  readonly payload: unknown
  readonly disposition: TriggerDisposition
  readonly state: TriggerState
  readonly createdAt: number
  readonly expiresAt?: number
}

export interface StoredTrigger {
  readonly triggerId: string
  readonly dedupKey: string
  readonly symbol?: string
  readonly ruleId?: string
  readonly purpose: TriggerPurpose
  readonly barTs?: number
  readonly state: TriggerState
  readonly disposition: TriggerDisposition
  readonly createdAt: number
  readonly expiresAt?: number
  readonly payload: unknown
}

interface TriggerRow {
  trigger_id: string
  dedup_key: string
  symbol: string | null
  rule_id: string | null
  purpose: TriggerPurpose
  bar_ts: number | null
  payload_json: string
  disposition: TriggerDisposition
  state: TriggerState
  created_at: number
  expires_at: number | null
}

function toTrigger(row: TriggerRow): StoredTrigger {
  return {
    triggerId: row.trigger_id,
    dedupKey: row.dedup_key,
    ...(row.symbol === null ? {} : { symbol: row.symbol }),
    ...(row.rule_id === null ? {} : { ruleId: row.rule_id }),
    purpose: row.purpose,
    ...(row.bar_ts === null ? {} : { barTs: row.bar_ts }),
    state: row.state,
    disposition: row.disposition,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    payload: JSON.parse(row.payload_json) as unknown,
  }
}

export class TriggerQueue {
  constructor(private readonly db: Database.Database) {}

  /**
   * 幂等入队。返回 true 表示真的插入了；false 表示 `dedup_key` 已存在。
   *
   * 用 `ON CONFLICT(dedup_key) DO NOTHING` 而**不是** `INSERT OR IGNORE`：
   * 后者会连 CHECK/NOT NULL 违反一起静默吞掉，而"不静默"是本项目的硬要求。
   */
  enqueue(trigger: NewTrigger): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO triggers
           (trigger_id, dedup_key, symbol, rule_id, purpose, bar_ts, payload_json, disposition, state, created_at, expires_at)
         VALUES
           (@triggerId, @dedupKey, @symbol, @ruleId, @purpose, @barTs, @payloadJson, @disposition, @state, @createdAt, @expiresAt)
         ON CONFLICT (dedup_key) DO NOTHING`,
      )
      .run({
        triggerId: trigger.triggerId,
        dedupKey: trigger.dedupKey,
        symbol: trigger.symbol ?? null,
        ruleId: trigger.ruleId ?? null,
        purpose: trigger.purpose,
        barTs: trigger.barTs ?? null,
        payloadJson: canonicalJson(trigger.payload),
        disposition: trigger.disposition,
        state: trigger.state,
        createdAt: trigger.createdAt,
        expiresAt: trigger.expiresAt ?? null,
      })
    return Number(result.changes) > 0
  }

  has(dedupKey: string): boolean {
    return this.db.prepare('SELECT 1 AS x FROM triggers WHERE dedup_key = ?').get(dedupKey) !== undefined
  }

  /** 该 (rule, symbol) 最近一次触发时间 —— 冷却窗口的依据。 */
  latestFireAt(ruleId: string, symbol: string): number | undefined {
    const row = this.db
      .prepare('SELECT MAX(created_at) AS t FROM triggers WHERE rule_id = ? AND symbol = ?')
      .get(ruleId, symbol) as { t: number | null }
    return row.t ?? undefined
  }

  /** 某类 purpose 在 `since` 之后的触发数（含被压掉的）—— 观测用。 */
  countSince(purposes: readonly TriggerPurpose[], since: number): number {
    return this.#count(purposes, since, undefined)
  }

  /**
   * **消耗唤醒预算**的触发数：只统计 `disposition ∈ {novelty, judgment}` 的行。
   * 被冷却/限流压掉的尝试不算预算 —— 否则它们自己会把窗口占满，形成自我放大的死锁。
   */
  countFiredSince(purposes: readonly TriggerPurpose[], since: number): number {
    return this.#count(purposes, since, BUDGET_DISPOSITIONS)
  }

  #count(
    purposes: readonly TriggerPurpose[],
    since: number,
    dispositions: readonly TriggerDisposition[] | undefined,
  ): number {
    if (purposes.length === 0) return 0
    const purposeSlots = purposes.map(() => '?').join(', ')
    const params: unknown[] = [...purposes]
    let sql = `SELECT COUNT(*) AS n FROM triggers WHERE purpose IN (${purposeSlots}) AND created_at >= ?`
    params.push(since)
    if (dispositions !== undefined) {
      if (dispositions.length === 0) return 0
      const dispositionSlots = dispositions.map(() => '?').join(', ')
      sql += ` AND disposition IN (${dispositionSlots})`
      params.push(...dispositions)
    }
    const row = this.db.prepare(sql).get(...params) as { n: number }
    return row.n
  }

  /** 原子领取：`queued → claimed`。返回本轮领取到的触发。 */
  claim(limit = 10): readonly StoredTrigger[] {
    const select = this.db.prepare(
      `SELECT * FROM triggers WHERE state = 'queued' ORDER BY created_at ASC, trigger_id ASC LIMIT ?`,
    )
    const update = this.db.prepare(`UPDATE triggers SET state = 'claimed' WHERE trigger_id = ?`)

    const claimAll = this.db.transaction((n: number) => {
      const rows = select.all(n) as TriggerRow[]
      for (const row of rows) update.run(row.trigger_id)
      return rows.map(toTrigger)
    })

    return claimAll(limit)
  }

  markDone(triggerId: string): void {
    this.db.prepare(`UPDATE triggers SET state = 'done' WHERE trigger_id = ?`).run(triggerId)
  }

  /** 过期的 queued/claimed 转为 expired；返回条数。 */
  expire(now: number): number {
    const result = this.db
      .prepare(
        `UPDATE triggers SET state = 'expired'
         WHERE state IN ('queued', 'claimed') AND expires_at IS NOT NULL AND expires_at < ?`,
      )
      .run(now)
    return Number(result.changes)
  }

  get(triggerId: string): StoredTrigger | undefined {
    const row = this.db.prepare('SELECT * FROM triggers WHERE trigger_id = ?').get(triggerId) as
      | TriggerRow
      | undefined
    return row === undefined ? undefined : toTrigger(row)
  }

  count(state?: TriggerState): number {
    const row =
      state === undefined
        ? (this.db.prepare('SELECT COUNT(*) AS n FROM triggers').get() as { n: number })
        : (this.db.prepare('SELECT COUNT(*) AS n FROM triggers WHERE state = ?').get(state) as {
            n: number
          })
    return row.n
  }

  queuedCount(): number {
    return this.count('queued')
  }
}
