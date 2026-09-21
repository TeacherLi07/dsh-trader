/**
 * 持久触发队列（plan §2 / §4.1 的 `triggers` 表）。
 *
 * 核心不变量：**`dedup_key` 唯一** ⇒ 同一根 bar 重复回放**不会**产生第二条触发。
 * 这让"离线回放跑两遍、结果完全一致"成为数据库层面的性质，而不是靠内存去重。
 */

import type Database from 'better-sqlite3'
import { DecisionRunStore } from '../agents/decision-run-store.js'
import { Statements } from '../db/statements.js'
import { canonicalJson } from '../util/canonical.js'

export type TriggerPurpose = 'invalidation' | 'commitment' | 'novelty' | 'info'
export type TriggerState = 'queued' | 'claimed' | 'done' | 'expired' | 'failed'
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
export const DEFAULT_TRIGGER_MAX_ATTEMPTS = 5

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
  readonly attempts: number
  readonly nextAttemptAt: number
  readonly claimedAt: number | null
  readonly lastError: string | null
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
  attempts: number
  next_attempt_at: number
  claimed_at: number | null
  last_error: string | null
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
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    claimedAt: row.claimed_at,
    lastError: row.last_error,
    payload: JSON.parse(row.payload_json) as unknown,
  }
}

export interface TriggerRetryPolicy {
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
}

export const DEFAULT_TRIGGER_RETRY_POLICY: Required<TriggerRetryPolicy> = {
  maxAttempts: DEFAULT_TRIGGER_MAX_ATTEMPTS,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
}

function safeErrorText(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return raw.replace(/(api[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 1_000)
}

function appendError(previous: string | null, reason: string, attempt?: number): string {
  const entry = attempt === undefined ? reason : `[attempt ${attempt}] ${reason}`
  return [previous, entry].filter((value): value is string => value !== null).join('\n').slice(-5_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class TriggerQueue {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  #failAssociatedDecisionRuns(trigger: Pick<StoredTrigger, 'triggerId' | 'purpose'>, reason: string, now: number): number {
    if (trigger.purpose !== 'commitment' && trigger.purpose !== 'novelty') return 0
    const source = trigger.purpose === 'novelty' ? 'W3' : 'W2'
    const triggerSource = `${source}:${trigger.triggerId}`
    const rows = this.#statements.get(
      `SELECT run_id FROM decision_runs WHERE trigger_source = ? AND status = 'running' ORDER BY created_at, run_id`,
    ).all(triggerSource) as { readonly run_id: string }[]
    const store = new DecisionRunStore(this.db)
    let failed = 0
    for (const row of rows) {
      const run = store.get(row.run_id)
      if (run?.status !== 'running') continue
      const final = isRecord(run.final) ? run.final : {}
      store.update(run.runId, {
        status: 'failed',
        final: { ...final, workerFailure: { triggerId: trigger.triggerId, reason } },
        ...(run.eligibility === null ? {
          eligibility: { state: 'decision_only', reasons: [reason], validatedEvidencePaths: [] },
        } : {}),
        finishedAt: now,
      }, now)
      failed += 1
    }
    return failed
  }

  /**
   * 幂等入队。返回 true 表示真的插入了；false 表示 `dedup_key` 已存在。
   *
   * 用 `ON CONFLICT(dedup_key) DO NOTHING` 而**不是** `INSERT OR IGNORE`：
   * 后者会连 CHECK/NOT NULL 违反一起静默吞掉，而"不静默"是本项目的硬要求。
   */
  enqueue(trigger: NewTrigger): boolean {
    const result = this.#statements.get(
        `INSERT INTO triggers
           (trigger_id, dedup_key, symbol, rule_id, purpose, bar_ts, payload_json, disposition, state,
            created_at, expires_at, attempts, next_attempt_at, claimed_at, last_error)
         VALUES
           (@triggerId, @dedupKey, @symbol, @ruleId, @purpose, @barTs, @payloadJson, @disposition, @state,
            @createdAt, @expiresAt, 0, @createdAt, NULL, NULL)
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
    return this.#statements.get('SELECT 1 AS x FROM triggers WHERE dedup_key = ?').get(dedupKey) !== undefined
  }

  /**
   * 该 (rule, symbol) **最近一次真正生效**的触发时间 —— 冷却窗口的依据。
   *
   * ⚠️ 必须排除被冷却/限流压掉的尝试：它们的 `created_at` 也不断刷新，
   * 若把它们算进来，冷却窗口会随着每次被压掉的命中一直往后滑，
   * 一条命中频率高于冷却的规则会**永远无法再次触发**（实测：31 次命中只发 1 次）。
   */
  latestFireAt(ruleId: string, symbol: string): number | undefined {
    const row = this.#statements
      .get(
        `SELECT MAX(created_at) AS t FROM triggers
         WHERE rule_id = ? AND symbol = ?
           AND disposition NOT IN ('cooldown', 'rate_limited')`,
      )
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
  countFiredSince(purposes: readonly TriggerPurpose[], since: number, excludingTriggerId?: string): number {
    return this.#count(purposes, since, BUDGET_DISPOSITIONS, excludingTriggerId)
  }

  #count(
    purposes: readonly TriggerPurpose[],
    since: number,
    dispositions: readonly TriggerDisposition[] | undefined,
    excludingTriggerId?: string,
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
    if (excludingTriggerId !== undefined) {
      sql += ' AND trigger_id <> ?'
      params.push(excludingTriggerId)
    }
    const row = this.#statements.get(sql).get(...params) as { n: number }
    return row.n
  }

  /** 原子领取到期时间以内可处理的触发；所有时间都由调用方的 Clock 提供。 */
  claim(now: number, limit = 1, maxAttempts = DEFAULT_TRIGGER_RETRY_POLICY.maxAttempts): readonly StoredTrigger[] {
    if (!Number.isFinite(now) || now < 0) throw new Error(`claim now 非法：${String(now)}`)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error(`claim limit 必须是 1..100 的整数：${String(limit)}`)
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('claim maxAttempts 必须是正整数')
    const select = this.#statements.get(
      `SELECT * FROM triggers
       WHERE state = 'queued' AND attempts < ? AND next_attempt_at <= ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY next_attempt_at ASC, created_at ASC, trigger_id ASC LIMIT ?`,
    )
    const update = this.#statements.get(`UPDATE triggers
      SET state = 'claimed', attempts = attempts + 1, claimed_at = ?
      WHERE trigger_id = ? AND state = 'queued'`)

    const claimAll = this.db.transaction(() => {
      const rows = select.all(maxAttempts, now, now, limit) as TriggerRow[]
      return rows.flatMap((row) => {
        const result = update.run(now, row.trigger_id)
        if (Number(result.changes) !== 1) return []
        return [{ ...toTrigger(row), state: 'claimed' as const, attempts: row.attempts + 1, claimedAt: now }]
      })
    })

    return claimAll()
  }

  markDone(triggerId: string): void {
    const result = this.#statements.get(
      `UPDATE triggers SET state = 'done', claimed_at = NULL
       WHERE trigger_id = ? AND state = 'claimed'`,
    ).run(triggerId)
    if (Number(result.changes) !== 1) throw new Error(`只能完成 claimed 触发：${triggerId}`)
  }

  /** 过期的 queued 触发逐条返回，调用方必须为每条写审计；claimed 由执行者检查截止时间。 */
  expire(now: number): readonly StoredTrigger[] {
    if (!Number.isFinite(now) || now < 0) throw new Error(`expire now 非法：${String(now)}`)
    const select = this.#statements.get(`SELECT * FROM triggers
      WHERE state = 'queued' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at ASC, trigger_id ASC`)
    const update = this.#statements.get(`UPDATE triggers
      SET state = 'expired', claimed_at = NULL,
          last_error = CASE WHEN last_error IS NULL THEN '触发器在处理前过期'
                            ELSE last_error || char(10) || '触发器在处理前过期' END
      WHERE trigger_id = ? AND state = 'queued'`)
    return this.db.transaction(() => {
      const rows = select.all(now) as TriggerRow[]
      const expired: StoredTrigger[] = []
      for (const row of rows) {
        const result = update.run(row.trigger_id)
        if (Number(result.changes) === 1) {
          const trigger = {
            ...toTrigger(row), state: 'expired' as const, claimedAt: null,
            lastError: appendError(row.last_error, '触发器在处理前过期'),
          }
          this.#failAssociatedDecisionRuns(trigger, trigger.lastError, now)
          expired.push(trigger)
        }
      }
      return expired
    })()
  }

  /** 执行期间到期的 claimed 项由 worker 显式终结，避免扫描器误杀仍在运行的回合。 */
  markExpired(triggerId: string, now: number, reason: string): StoredTrigger {
    if (!Number.isFinite(now) || now < 0) throw new Error(`markExpired now 非法：${String(now)}`)
    const row = this.#statements.get(`SELECT * FROM triggers WHERE trigger_id = ?`).get(triggerId) as TriggerRow | undefined
    if (row === undefined) throw new Error(`触发器不存在：${triggerId}`)
    if (row.state !== 'queued' && row.state !== 'claimed') throw new Error(`只能过期 queued/claimed 触发：${triggerId}`)
    return this.db.transaction(() => {
      const lastError = appendError(row.last_error, safeErrorText(reason))
      const result = this.#statements.get(`UPDATE triggers
        SET state = 'expired', claimed_at = NULL, last_error = ?
        WHERE trigger_id = ? AND state IN ('queued', 'claimed')`).run(lastError, triggerId)
      if (Number(result.changes) !== 1) throw new Error(`触发器过期状态竞争：${triggerId}`)
      const updated = this.get(triggerId)
      if (updated === undefined) throw new Error(`触发器过期后消失：${triggerId}`)
      this.#failAssociatedDecisionRuns(updated, updated.lastError ?? lastError, now)
      return updated
    })()
  }

  /** queued 行若已耗尽次数则不可再领取；调用方逐条审计这些终态。 */
  failExhausted(now: number, maxAttempts = DEFAULT_TRIGGER_RETRY_POLICY.maxAttempts): readonly StoredTrigger[] {
    if (!Number.isFinite(now) || now < 0) throw new Error(`failExhausted now 非法：${String(now)}`)
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts 必须是正整数')
    const select = this.#statements.get(`SELECT * FROM triggers
      WHERE state = 'queued' AND attempts >= ? ORDER BY created_at ASC, trigger_id ASC`)
    const update = this.#statements.get(`UPDATE triggers
      SET state = 'failed', claimed_at = NULL,
          last_error = CASE WHEN last_error IS NULL THEN '已达到最大触发尝试次数'
                            ELSE last_error || char(10) || '已达到最大触发尝试次数' END
      WHERE trigger_id = ? AND state = 'queued'`)
    return this.db.transaction(() => {
      const rows = select.all(maxAttempts) as TriggerRow[]
      const failed: StoredTrigger[] = []
      for (const row of rows) {
        const result = update.run(row.trigger_id)
        if (Number(result.changes) === 1) {
          const trigger = {
            ...toTrigger(row), state: 'failed' as const, claimedAt: null,
            lastError: appendError(row.last_error, '已达到最大触发尝试次数'),
          }
          this.#failAssociatedDecisionRuns(trigger, trigger.lastError, now)
          failed.push(trigger)
        }
      }
      return failed
    })()
  }

  /** 模型/依赖瞬时失败后退避重试；重试次数与错误原文均持久化，达到上限后转 failed。 */
  fail(triggerId: string, now: number, error: unknown, policy: TriggerRetryPolicy = {}): StoredTrigger {
    if (!Number.isFinite(now) || now < 0) throw new Error(`fail now 非法：${String(now)}`)
    const maxAttempts = policy.maxAttempts ?? DEFAULT_TRIGGER_RETRY_POLICY.maxAttempts
    const baseDelayMs = policy.baseDelayMs ?? DEFAULT_TRIGGER_RETRY_POLICY.baseDelayMs
    const maxDelayMs = policy.maxDelayMs ?? DEFAULT_TRIGGER_RETRY_POLICY.maxDelayMs
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts 必须是正整数')
    if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0 || !Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
      throw new Error('retry delay 配置非法')
    }
    return this.db.transaction(() => {
      const row = this.#statements.get(`SELECT * FROM triggers WHERE trigger_id = ? AND state = 'claimed'`).get(triggerId) as
        | TriggerRow
        | undefined
      if (row === undefined) throw new Error(`只能重试 claimed 触发：${triggerId}`)
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, row.attempts - 1))
      const nextAttemptAt = now + delay
      const expired = row.expires_at !== null && (row.expires_at <= now || row.expires_at <= nextAttemptAt)
      const exhausted = row.attempts >= maxAttempts
      const state: TriggerState = expired ? 'expired' : exhausted ? 'failed' : 'queued'
      const failureReason = safeErrorText(error)
      const reason = expired
        ? `${failureReason}；重试退避超出事件 TTL，触发器终止`
        : failureReason
      const lastError = appendError(row.last_error, reason, row.attempts)
      const result = this.#statements.get(`UPDATE triggers SET state = @state, next_attempt_at = @nextAttemptAt,
        claimed_at = NULL, last_error = @lastError WHERE trigger_id = @triggerId AND state = 'claimed'`)
        .run({ state, nextAttemptAt, lastError, triggerId })
      if (Number(result.changes) !== 1) throw new Error(`触发器失败状态竞争：${triggerId}`)
      const updated = this.get(triggerId)
      if (updated === undefined) throw new Error(`触发器更新后消失：${triggerId}`)
      if (state === 'failed' || state === 'expired') this.#failAssociatedDecisionRuns(updated, lastError, now)
      return updated
    })()
  }

  /** 启动恢复：进程上次持有的 claimed 行重新排队；过期项在同一操作中终结。 */
  recoverClaims(now: number, maxAttempts = DEFAULT_TRIGGER_RETRY_POLICY.maxAttempts): readonly StoredTrigger[] {
    if (!Number.isFinite(now) || now < 0) throw new Error(`recover now 非法：${String(now)}`)
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts 必须是正整数')
    const select = this.#statements.get(`SELECT * FROM triggers WHERE state = 'claimed' ORDER BY claimed_at ASC, trigger_id ASC`)
    return this.db.transaction(() => {
      const rows = select.all() as TriggerRow[]
      const recovered: StoredTrigger[] = []
      for (const row of rows) {
        const expired = row.expires_at !== null && row.expires_at <= now
        const exhausted = row.attempts >= maxAttempts
        const state: TriggerState = expired ? 'expired' : exhausted ? 'failed' : 'queued'
        const reason = expired
          ? '进程恢复时触发器已过期'
          : exhausted
            ? '进程恢复时触发器已达到最大尝试次数'
            : '进程在触发处理期间退出，恢复重试'
        const lastError = appendError(row.last_error, reason, row.attempts)
        const result = this.#statements.get(`UPDATE triggers
          SET state = @state, next_attempt_at = @nextAttemptAt, claimed_at = NULL, last_error = @lastError
          WHERE trigger_id = @triggerId AND state = 'claimed'`)
          .run({ state, nextAttemptAt: now, lastError, triggerId: row.trigger_id })
        if (Number(result.changes) === 1) {
          const trigger = { ...toTrigger(row), state, nextAttemptAt: now, claimedAt: null, lastError }
          if (state === 'failed' || state === 'expired') this.#failAssociatedDecisionRuns(trigger, lastError, now)
          recovered.push(trigger)
        }
      }
      return recovered
    })()
  }

  get(triggerId: string): StoredTrigger | undefined {
    const row = this.#statements.get('SELECT * FROM triggers WHERE trigger_id = ?').get(triggerId) as
      | TriggerRow
      | undefined
    return row === undefined ? undefined : toTrigger(row)
  }

  count(state?: TriggerState): number {
    const row =
      state === undefined
        ? (this.#statements.get('SELECT COUNT(*) AS n FROM triggers').get() as { n: number })
        : (this.#statements.get('SELECT COUNT(*) AS n FROM triggers WHERE state = ?').get(state) as {
            n: number
          })
    return row.n
  }

  queuedCount(): number {
    return this.count('queued')
  }
}
