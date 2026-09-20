/**
 * 计划卡存储（plan §3.1 的四条性质：可判定 / 有期限 / 幂等根 / **不可事后改写**）。
 *
 * 不变量：
 *   · 每个 (symbol, timeframe) 的标的**至多一张 active**（由部分唯一索引 + 事务保证）；
 *   · 保存前必须通过 schema 校验，且 `contentHash` 必须与内容一致（幂等根不能是假的）；
 *   · 同一 `planId` **不允许**改内容 —— 修正只能产出新 `planId`（旧版留在审计链里）；
 *   · 内容相同的重复保存是幂等 no-op。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { canonicalJson } from '../util/canonical.js'
import { computeContentHash, validatePlanCard, type PlanCard } from './schema.js'

export class PlanStoreError extends Error {}
/** 试图改写已存在的计划卡内容。 */
export class ImmutablePlanError extends PlanStoreError {}

interface PlanRow {
  plan_id: string
  symbol: string
  version: number
  status: 'active' | 'expired' | 'superseded'
  window_ends_at: number
  created_at: number
  card_json: string
  content_hash: string
}

function toCard(row: PlanRow): PlanCard {
  return JSON.parse(row.card_json) as PlanCard
}

export type SaveStatus = 'inserted' | 'unchanged'

export interface SaveResult {
  readonly status: SaveStatus
  readonly planId: string
  readonly version: number
  /** 被本次保存取代/过期的旧卡 id。 */
  readonly replaced?: string
}

export class PlanStore {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  /**
   * 保存一张计划卡。
   * · 同 planId + 同内容 → `unchanged`
   * · 同 planId + 不同内容 → 抛 `ImmutablePlanError`
   * · 该标的有内容不同的 active 卡 → 旧卡转 `superseded`（已过期则转 `expired`），新卡 `version + 1`
   */
  save(card: PlanCard, now: number): SaveResult {
    const validation = validatePlanCard(card)
    if (!validation.ok) {
      throw new PlanStoreError(`计划卡未通过校验：\n- ${validation.errors.join('\n- ')}`)
    }
    const expected = computeContentHash(card)
    if (card.contentHash !== expected) {
      throw new PlanStoreError(`contentHash 与内容不一致：期望 ${expected}，收到 ${card.contentHash}`)
    }

    const sameId = this.#byId(card.planId)
    if (sameId !== undefined) {
      if (sameId.content_hash !== card.contentHash) {
        throw new ImmutablePlanError(
          `计划卡不可事后改写：${card.planId} 已存在且内容不同（请产出新 planId）`,
        )
      }
      return { status: 'unchanged', planId: card.planId, version: sameId.version }
    }

    const currentRow = this.#activeRow(card.symbol)
    if (currentRow !== undefined && currentRow.content_hash === card.contentHash) {
      return { status: 'unchanged', planId: currentRow.plan_id, version: currentRow.version }
    }

    const version = (this.#maxVersion(card.symbol) ?? 0) + 1
    const replaced = currentRow?.plan_id
    // 已经过期的前任记 `expired`，被新判断取代的才记 `superseded` —— 审计里含义不同
    const nextStatus: 'expired' | 'superseded' =
      currentRow !== undefined && now > currentRow.window_ends_at ? 'expired' : 'superseded'

    const insert = this.#statements.get(
      `INSERT INTO plan_cards
         (plan_id, run_id, symbol, version, status, window_ends_at, created_at, card_json, content_hash)
       VALUES (@planId, @runId, @symbol, @version, 'active', @windowEndsAt, @createdAt, @json, @contentHash)`,
    )
    const retire = this.#statements.get('UPDATE plan_cards SET status = ? WHERE plan_id = ?')

    const run = this.db.transaction(() => {
      if (replaced !== undefined) retire.run(nextStatus, replaced)
      insert.run({
        planId: card.planId,
        runId: card.runId ?? null,
        symbol: card.symbol,
        version,
        windowEndsAt: card.windowEndsAt,
        createdAt: card.createdAt,
        json: canonicalJson(card),
        contentHash: card.contentHash,
      })
    })
    run()

    return replaced === undefined
      ? { status: 'inserted', planId: card.planId, version }
      : { status: 'inserted', planId: card.planId, version, replaced }
  }

  active(symbol: string): PlanCard | undefined {
    const row = this.#activeRow(symbol)
    return row === undefined ? undefined : toCard(row)
  }

  /**
   * 还原给定时点可用的计划卡。status 是当前投影，会在后来被 expire/supersede 改写；PIT 判断按
   * 创建时刻与有效期限筛选不可变卡片正文，不能让今天的 status 污染历史 context。
   */
  activeAt(symbol: string, asOf: number): PlanCard | undefined {
    if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('plan.asOf 必须是非负安全整数毫秒时间戳')
    const row = this.#statements.get(`SELECT * FROM plan_cards
      WHERE symbol = ? AND created_at <= ? AND window_ends_at >= ?
      ORDER BY created_at DESC, version DESC LIMIT 1`).get(symbol, asOf, asOf) as PlanRow | undefined
    return row === undefined ? undefined : toCard(row)
  }

  get(planId: string): PlanCard | undefined {
    const row = this.#byId(planId)
    return row === undefined ? undefined : toCard(row)
  }

  /** 所有版本（含已失效），便于审计"当时用的是什么计划"。 */
  history(symbol: string, limit = 50): readonly PlanCard[] {
    const rows = this.#statements.get('SELECT * FROM plan_cards WHERE symbol = ? ORDER BY version DESC LIMIT ?')
      .all(symbol, limit) as PlanRow[]
    return rows.map(toCard)
  }

  /** 把已过期的 active 卡转为 `expired`（释放"每标的一张 active"的名额）。 */
  expire(now: number): number {
    const result = this.#statements.get(`UPDATE plan_cards SET status = 'expired' WHERE status = 'active' AND window_ends_at < ?`)
      .run(now)
    return Number(result.changes)
  }

  count(symbol?: string): number {
    const row =
      symbol === undefined
        ? (this.#statements.get('SELECT COUNT(*) AS n FROM plan_cards').get() as { n: number })
        : (this.#statements.get('SELECT COUNT(*) AS n FROM plan_cards WHERE symbol = ?').get(symbol) as {
            n: number
          })
    return row.n
  }

  #byId(planId: string): PlanRow | undefined {
    return this.#statements.get('SELECT * FROM plan_cards WHERE plan_id = ?').get(planId) as
      | PlanRow
      | undefined
  }

  #activeRow(symbol: string): PlanRow | undefined {
    return this.#statements.get(
        `SELECT * FROM plan_cards WHERE symbol = ? AND status = 'active' ORDER BY version DESC LIMIT 1`,
      )
      .get(symbol) as PlanRow | undefined
  }

  #maxVersion(symbol: string): number | undefined {
    const row = this.#statements.get('SELECT MAX(version) AS v FROM plan_cards WHERE symbol = ?')
      .get(symbol) as { v: number | null }
    return row.v ?? undefined
  }
}
