/**
 * 每日运营指标（plan §10 P1 ③：日输出计划覆盖率、W2/W3 频次、每窗口成本）。
 *
 * 为什么要有这个：P1 ③ 的判据里有三项，之前只有成本看板（按日/按 scope 聚合）能算出来，
 * "计划覆盖率"根本没有落点 —— 只能人工翻日志。指标必须**可自动判定**，否则阶段验收只能靠感觉。
 *
 * 三个口径都写死在这里，避免"看板一个数、脚本另一个数"：
 *   · 覆盖率 = 有 active 计划卡的标的数 / 标的池大小（分子只算 `status='active'` 且未过期）；
 *   · W2/W3 频次按 `triggers.purpose` 当日聚合（`judgment` ≈ W2、`novelty` ≈ W3）；
 *   · 每窗口成本 = `budget_ledger` 当日该窗口 scope 的 `est_usd` 之和（`cost_known` 取逻辑与）。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { dayKey } from '../cost-ledger.js'

/** 一天的 UTC 边界 `[start, end)`。 */
export function dayBounds(day: string): { readonly start: number; readonly end: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`day 必须是 YYYY-MM-DD，收到 ${day}`)
  const start = Date.parse(`${day}T00:00:00.000Z`)
  if (!Number.isFinite(start)) throw new Error(`day 无法解析：${day}`)
  return { start, end: start + 86_400_000 }
}

export interface CoverageMetric {
  readonly symbols: readonly string[]
  readonly withActivePlan: readonly string[]
  readonly ratio: number
}

export interface FrequencyMetric {
  /** `triggers.purpose` 当日的命中数（含被限流/冷却压掉的，因为"超限一律落库"）。 */
  readonly byPurpose: Readonly<Record<string, number>>
  /** 实际消耗唤醒预算的去向数（`novelty` / `judgment`）。 */
  readonly budgetConsuming: Readonly<Record<string, number>>
  /** 按去向拆分（fired 与被压掉可区分）。 */
  readonly byDisposition: Readonly<Record<string, number>>
}

export interface WindowCost {
  readonly scope: string
  readonly usd: number
  readonly tokens: number
  readonly costKnown: boolean
}

export interface DailyMetrics {
  readonly day: string
  /** 覆盖率是在**哪个时刻**评估的（同一份数据在不同时刻看覆盖率不同）。 */
  readonly asOf: number
  readonly coverage: CoverageMetric
  readonly frequency: FrequencyMetric
  readonly cost: { readonly totalUsd: number; readonly windows: readonly WindowCost[]; readonly costKnown: boolean }
  readonly decisions: { readonly total: number; readonly executed: number; readonly settled: number }
  /** 超出配置上限时的可读告警（不抛错：指标是只读观测，越限要报告而不是中断）。 */
  readonly warnings: readonly string[]
}

export interface DailyMetricsOptions {
  readonly day: string
  readonly symbols: readonly string[]
  /**
   * 覆盖率评估时刻，**必须在当天之内**；默认取当日 23:59:59.999。
   *
   * 为什么必须显式：计划卡有窗口期，"今天覆盖率是多少"离开时刻就没有意义。
   * 传日末 ⇒ 回答"这一天结束时的覆盖"；传 `now` ⇒ 回答"此刻的覆盖"。
   */
  readonly asOf?: number
  /** W2/W3 当日上限（plan §10 P3：W2 ≤ 8/天、W3 ≤ 6/天）。 */
  readonly caps?: { readonly judgmentPerDay?: number; readonly noveltyPerDay?: number }
}

interface CountRow {
  key: string
  n: number
}

export class MetricsStore {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  compute(options: DailyMetricsOptions): DailyMetrics {
    const { start, end } = dayBounds(options.day)
    const asOf = options.asOf ?? end - 1
    if (asOf < start || asOf >= end) {
      throw new Error(`asOf ${asOf} 不在 ${options.day} 之内（[${start}, ${end})）`)
    }

    // ① 覆盖率：分子只算"此刻仍是 active"的计划卡（过期卡不算覆盖）
    const activeSymbols = (
      this.#statements
        .get(
          `SELECT DISTINCT symbol AS key FROM plan_cards
           WHERE status = 'active' AND (window_ends_at IS NULL OR window_ends_at > ?)`,
        )
        .all(asOf) as { key: string }[]
    ).map((row) => row.key)
    const pool = [...new Set(options.symbols)]
    const covered = pool.filter((symbol) => activeSymbols.includes(symbol))
    const coverage: CoverageMetric = {
      symbols: pool,
      withActivePlan: covered,
      ratio: pool.length === 0 ? 0 : covered.length / pool.length,
    }

    // ② 频次：按 purpose / disposition 聚合当日触发
    const byPurpose: Record<string, number> = {}
    for (const row of this.#statements
      .get('SELECT purpose AS key, COUNT(*) AS n FROM triggers WHERE created_at >= ? AND created_at < ? GROUP BY purpose ORDER BY purpose')
      .all(start, end) as CountRow[]) {
      byPurpose[row.key] = row.n
    }
    const byDisposition: Record<string, number> = {}
    for (const row of this.#statements
      .get(
        'SELECT disposition AS key, COUNT(*) AS n FROM triggers WHERE created_at >= ? AND created_at < ? GROUP BY disposition ORDER BY disposition',
      )
      .all(start, end) as CountRow[]) {
      byDisposition[row.key] = row.n
    }
    const frequency: FrequencyMetric = {
      byPurpose,
      byDisposition,
      // 只有这两个去向消耗唤醒预算（与 `BUDGET_DISPOSITIONS` 同口径）
      budgetConsuming: {
        judgment: byDisposition.judgment ?? 0,
        novelty: byDisposition.novelty ?? 0,
      },
    }

    // ③ 成本：按 scope 汇总当日
    const costRows = this.#statements
      .get('SELECT * FROM budget_ledger WHERE day = ? ORDER BY scope')
      .all(options.day) as {
      scope: string
      tokens_in: number
      tokens_out: number
      est_usd: number
      cost_known: number
    }[]
    const windows: WindowCost[] = costRows.map((row) => ({
      scope: row.scope,
      usd: row.est_usd,
      tokens: row.tokens_in + row.tokens_out,
      costKnown: row.cost_known === 1,
    }))
    const totalUsd = windows.filter((window) => window.scope === 'global').reduce((sum, w) => sum + w.usd, 0)

    // ④ 决策：当日产出 / 已执行 / 已结算
    const decisionRow = this.#statements
      .get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN executed = 1 THEN 1 ELSE 0 END) AS executed,
                SUM(CASE WHEN outcome_id IS NOT NULL THEN 1 ELSE 0 END) AS settled
         FROM decisions WHERE decided_at >= ? AND decided_at < ?`,
      )
      .get(start, end) as { total: number; executed: number | null; settled: number | null }

    const warnings: string[] = []
    const judgmentCap = options.caps?.judgmentPerDay
    if (judgmentCap !== undefined && (frequency.budgetConsuming.judgment ?? 0) > judgmentCap) {
      warnings.push(`W2（judgment）${frequency.budgetConsuming.judgment} 超过日上限 ${judgmentCap}`)
    }
    const noveltyCap = options.caps?.noveltyPerDay
    if (noveltyCap !== undefined && (frequency.budgetConsuming.novelty ?? 0) > noveltyCap) {
      warnings.push(`W3（novelty）${frequency.budgetConsuming.novelty} 超过日上限 ${noveltyCap}`)
    }
    if (!windows.every((window) => window.costKnown)) {
      warnings.push('当日存在成本未知的调用（price_table 缺价目）⇒ 预算退化为 token 上限')
    }

    return {
      day: options.day,
      asOf,
      coverage,
      frequency,
      cost: {
        totalUsd,
        windows,
        costKnown: windows.length === 0 ? true : windows.every((window) => window.costKnown),
      },
      decisions: {
        total: decisionRow.total,
        executed: decisionRow.executed ?? 0,
        settled: decisionRow.settled ?? 0,
      },
      warnings,
    }
  }
}

/** 便捷入口：给定时间戳算出它所属的 UTC 日键，并以该时刻为覆盖率评估点。 */
export function dailyMetricsAt(
  store: MetricsStore,
  at: number,
  options: Omit<DailyMetricsOptions, 'day' | 'asOf'>,
): DailyMetrics {
  return store.compute({ ...options, day: dayKey(at), asOf: at })
}
