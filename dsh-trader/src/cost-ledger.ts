/**
 * 预算账本与成本看板（plan §8 / T1.6）。
 *
 * 三条要点：
 *   1. **价目表是我们自己维护的、版本化的**（`effective_from` 选行）——运行时没有外部价格源；
 *   2. **缺价目绝不静默计 0**：那次调用记 `cost_known = 0`，预算退化为 token 上限并**告警**；
 *   3. 超预算停止所有新增模型判断；已存在的持仓仍由 P0 机械保护和 reduce-only 执行管理。
 */

import type Database from 'better-sqlite3'
import { Statements } from './db/statements.js'
import { canonicalJson, sha256Hex } from './util/canonical.js'
import {
  budgetAllows,
  estimateCost,
  selectPrice,
  type BudgetDecision,
  type BudgetState,
  type ModelPrice,
  type PriceTier,
  type TokenUsage,
} from './cost.js'

/** UTC 日键 `YYYY-MM-DD`：账本按它聚合，且必须与 Clock 一致（不用 `Date.now()`）。 */
export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

export type BudgetScope = string

export const GLOBAL_SCOPE: BudgetScope = 'global'
export function symbolScope(symbol: string): BudgetScope {
  return `symbol:${symbol}`
}
export function roleScope(role: string): BudgetScope {
  return `role:${role}`
}

// ── 价目表 ───────────────────────────────────────────────────────────────────

export class PriceTableStore {
  readonly #statements: Statements

  constructor(db: Database.Database) {
    this.#statements = new Statements(db)
  }

  /** 人工种子/版本化写入：同一 `(model, effectiveFrom, tier)` 不重复插入。 */
  add(price: ModelPrice): boolean {
    const result = this.#statements
      .get(
        `INSERT INTO price_table (model, effective_from, tier, in_per_mtok, out_per_mtok, cached_in_per_mtok, source)
         VALUES (@model, @effectiveFrom, @tier, @inPerMtok, @outPerMtok, @cachedInPerMtok, @source)
         ON CONFLICT (model, effective_from, tier) DO NOTHING`,
      )
      .run({
        model: price.model,
        effectiveFrom: price.effectiveFrom,
        tier: price.tier ?? 'any',
        inPerMtok: price.inPerMtok,
        outPerMtok: price.outPerMtok,
        cachedInPerMtok: price.cachedInPerMtok ?? null,
        source: price.source ?? null,
      })
    return Number(result.changes) > 0
  }

  /** 写入种子价目，返回真正新增的行数（幂等）。 */
  seed(prices: readonly ModelPrice[]): number {
    let added = 0
    for (const price of prices) {
      if (this.add(price)) added += 1
    }
    return added
  }

  all(): readonly ModelPrice[] {
    const rows = this.#statements
      .get('SELECT * FROM price_table ORDER BY model, effective_from, tier')
      .all() as {
      model: string
      effective_from: number
      tier: PriceTier
      in_per_mtok: number
      out_per_mtok: number
      cached_in_per_mtok: number | null
      source: string | null
    }[]
    return rows.map((row) => ({
      model: row.model,
      effectiveFrom: row.effective_from,
      tier: row.tier,
      inPerMtok: row.in_per_mtok,
      outPerMtok: row.out_per_mtok,
      ...(row.cached_in_per_mtok === null ? {} : { cachedInPerMtok: row.cached_in_per_mtok }),
      ...(row.source === null ? {} : { source: row.source }),
    }))
  }

  /** 当前生效价目（版本化：取 `effectiveFrom` 最大且不晚于 `at` 的一条）。 */
  select(model: string, at: number): ModelPrice | undefined {
    return selectPrice(this.all(), model, at)
  }

  /** 价目表版本指纹 —— 写进审计，便于事后解释"为什么当时这么算"。 */
  version(): string {
    return `sha256:${sha256Hex(canonicalJson(this.all()))}`
  }

  count(): number {
    return (this.#statements.get('SELECT COUNT(*) AS n FROM price_table').get() as { n: number }).n
  }

  /** 所有模型中最近一版价目的生效时刻；没有价目时返回 null，不能伪装成刚更新。 */
  newestEffectiveFrom(): number | null {
    const row = this.#statements
      .get('SELECT MAX(effective_from) AS effective_from FROM price_table')
      .get() as { effective_from: number | null }
    return row.effective_from === null || !Number.isFinite(row.effective_from) ? null : row.effective_from
  }

  /** 年龄由调用方提供的时刻计算，避免账本偷偷读取系统时钟而破坏回放一致性。 */
  ageDays(at: number): number | null {
    const newest = this.newestEffectiveFrom()
    if (newest === null || !Number.isFinite(at)) return null
    const age = (at - newest) / 86_400_000
    return Number.isFinite(age) ? age : null
  }

  /** 没有可用价目也视为过期，调用方必须显式处理而不能把未知当成新鲜。 */
  isStale(at: number, maxAgeDays = 90): boolean {
    const age = this.ageDays(at)
    return age === null || age > maxAgeDays
  }
}

/** 价目表过期是 P2 提醒，不阻塞交易；空表/无效年龄仍按 fail-closed 发出告警。 */
export function priceTableStaleAlert(
  ageDaysOrNull: number | null,
  at: number,
  maxAgeDays = 90,
): string | null {
  if (ageDaysOrNull === null || !Number.isFinite(ageDaysOrNull)) {
    return `P2：价目表年龄未知（${at} 时没有有效生效时间，阈值 ${maxAgeDays} 天）`
  }
  if (!(ageDaysOrNull > maxAgeDays)) return null
  return `P2：价目表已过期 ${ageDaysOrNull.toFixed(2)} 天（实际 ${ageDaysOrNull.toFixed(2)} 天，阈值 ${maxAgeDays} 天；at=${at}）`
}

// ── 账本 ─────────────────────────────────────────────────────────────────────

export interface LedgerCall {
  readonly at: number
  /** 至少包含 `global`；通常再带一个 `symbol:*`。 */
  readonly scopes: readonly BudgetScope[]
  readonly model: string
  /** 请求失败或 usage 未返回时为 null；不能把未知成本写成一次免费调用。 */
  readonly usage: TokenUsage | null
  /** usage 未知时按请求前的有界估算计入 token cap。 */
  readonly estimatedTokens?: number
  /** 预留的最大成本估值；只记金额估计，cost_known 仍为 false。 */
  readonly reservedUsd?: number | null
}

export interface LedgerEntry {
  readonly day: string
  readonly scope: BudgetScope
  readonly tokensIn: number
  readonly tokensOut: number
  readonly tokensCached: number
  readonly estUsd: number
  readonly costKnown: boolean
}

export interface LedgerResult {
  readonly costKnown: boolean
  readonly estUsd: number
  readonly warnings: readonly string[]
  readonly entries: readonly LedgerEntry[]
}

export interface BudgetPreflightResult {
  readonly decision: BudgetDecision
  readonly estimateUsd: number | null
  readonly estimatedTokens: number
  readonly reason?: string
}

export interface DashboardRow {
  readonly day: string
  readonly scope: BudgetScope
  readonly tokensIn: number
  readonly tokensOut: number
  readonly tokensCached: number
  readonly estUsd: number
  readonly costKnown: boolean
  readonly stale: boolean
}

export class BudgetLedger {
  readonly #statements: Statements
  readonly #prices: PriceTableStore

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
    this.#prices = new PriceTableStore(db)
  }

  /**
   * 记一次模型调用的用量与成本，按 `(day, scope)` 累加。
   * `cost_known` 取**逻辑与**：只要有一次调用缺价目，该格就永久标记为"成本不可信"。
   */
  record(call: LedgerCall, prices: readonly ModelPrice[]): LedgerResult {
    const day = dayKey(call.at)
    const usage = call.usage ?? {
      tokensIn: Math.max(0, call.estimatedTokens ?? 0),
      tokensOut: 0,
      tokensCached: 0,
    }
    const estimate = call.usage === null
      ? { known: false as const, reason: '模型未返回可核验 usage' }
      : estimateCost(usage, prices, call.model, call.at)
    const warnings: string[] = []
    if (!estimate.known) {
      warnings.push(`成本未知：${estimate.reason} —— cost_known=0，需 token cap 才能继续调用`)
    }
    const estUsd = estimate.known ? estimate.usd : Math.max(0, call.reservedUsd ?? 0)

    const insert = this.db.transaction(() => {
      const entries: LedgerEntry[] = []
      for (const scope of call.scopes) {
        this.#statements
          .get(
            `INSERT INTO budget_ledger (day, scope, tokens_in, tokens_out, tokens_cached, est_usd, cost_known)
             VALUES (@day, @scope, @tokensIn, @tokensOut, @tokensCached, @estUsd, @costKnown)
             ON CONFLICT (day, scope) DO UPDATE SET
               tokens_in = tokens_in + excluded.tokens_in,
               tokens_out = tokens_out + excluded.tokens_out,
               tokens_cached = tokens_cached + excluded.tokens_cached,
               est_usd = est_usd + excluded.est_usd,
               cost_known = MIN(cost_known, excluded.cost_known)`,
          )
          .run({
            day,
            scope,
            tokensIn: Math.max(usage.tokensIn, 0),
            tokensOut: Math.max(usage.tokensOut, 0),
            tokensCached: Math.max(usage.tokensCached, 0),
            estUsd,
            costKnown: estimate.known ? 1 : 0,
          })
        entries.push({
          day,
          scope,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          tokensCached: usage.tokensCached,
          estUsd,
          costKnown: estimate.known,
        })
      }
      return entries
    })

    return { costKnown: estimate.known, estUsd, warnings, entries: insert() }
  }

  /** 调用前用有界最大输入/输出估算做准入；W1 也不能绕过预算。 */
  preflight(options: {
    readonly at: number
    readonly model: string
    readonly estimatedUsage: TokenUsage
    readonly dailyBudgetUsd: number
    readonly tokenCap?: number | null
    readonly scope?: BudgetScope
    readonly wake: 'W1' | 'W2' | 'W3'
  }): BudgetPreflightResult {
    if (!Number.isFinite(options.dailyBudgetUsd) || options.dailyBudgetUsd <= 0) {
      return { decision: { allow: false, reason: '未配置正数日预算，停止模型调用' }, estimateUsd: null, estimatedTokens: 0 }
    }
    const estimatedTokens = Math.max(0, options.estimatedUsage.tokensIn) + Math.max(0, options.estimatedUsage.tokensOut)
    const stale = this.#prices.isStale(options.at)
    const estimate = stale
      ? { known: false as const, reason: '模型价目表缺失或过期' }
      : estimateCost(options.estimatedUsage, this.#prices.all(), options.model, options.at)
    const tokenCap = options.tokenCap ?? null
    const state = this.state(dayKey(options.at), options.scope ?? GLOBAL_SCOPE, tokenCap)
    const projected: BudgetState = {
      ...state,
      tokens: state.tokens + estimatedTokens,
      estimatedUsd: estimate.known ? estimate.usd : 0,
      unknownCostCalls: state.unknownCostCalls + (estimate.known ? 0 : 1),
    }
    const decision = budgetAllows(projected, options.dailyBudgetUsd, { wake: options.wake })
    return {
      decision,
      estimateUsd: estimate.known ? estimate.usd : null,
      estimatedTokens,
      ...(!estimate.known ? { reason: estimate.reason } : {}),
    }
  }

  /** 某日某 scope 的聚合状态。 */
  state(day: string, scope: BudgetScope, tokenCap: number | null = null): BudgetState {
    const row = this.#statements
      .get('SELECT * FROM budget_ledger WHERE day = ? AND scope = ?')
      .get(day, scope) as
      | {
          tokens_in: number
          tokens_out: number
          tokens_cached: number
          est_usd: number
          cost_known: number
        }
      | undefined
    const unknown = row !== undefined && row.cost_known === 0 ? 1 : 0
    return {
      spentUsd: row?.est_usd ?? 0,
      estimatedUsd: 0,
      unknownCostCalls: unknown,
      tokens: (row?.tokens_in ?? 0) + (row?.tokens_out ?? 0),
      tokenCap,
    }
  }

  /** 模型调用预算闸门：超预算停止 W1/W2/W3 的新增判断；机械减险不经此闸。 */
  gate(options: {
    readonly at: number
    readonly wake: 'W1' | 'W2' | 'W3'
    readonly dailyBudgetUsd: number
    readonly tokenCap?: number | null
    readonly scope?: BudgetScope
  }): BudgetDecision {
    const state = this.state(dayKey(options.at), options.scope ?? GLOBAL_SCOPE, options.tokenCap ?? null)
    return budgetAllows(state, options.dailyBudgetUsd, { wake: options.wake })
  }

  /**
   * 成本看板：按日、按 scope（`symbol:*` 即"按标的"）聚合。
   * `at` 必须由调用方传入；省略时取最新价目版本，避免看板读取系统时钟导致回放漂移。
   */
  dashboard(
    options: { readonly day?: string; readonly limit?: number; readonly at?: number } = {},
  ): readonly DashboardRow[] {
    const limit = Math.max(1, options.limit ?? 100)
    const newest = this.#priceTableAtForDashboard()
    const at = options.at ?? newest
    const stale = at === null ? true : this.#prices.isStale(at)
    const rows = (
      options.day === undefined
        ? this.#statements
            .get('SELECT * FROM budget_ledger ORDER BY day DESC, scope ASC LIMIT ?')
            .all(limit)
        : this.#statements
            .get('SELECT * FROM budget_ledger WHERE day = ? ORDER BY scope ASC LIMIT ?')
            .all(options.day, limit)
    ) as {
      day: string
      scope: string
      tokens_in: number
      tokens_out: number
      tokens_cached: number
      est_usd: number
      cost_known: number
    }[]
    return rows.map((row) => ({
      day: row.day,
      scope: row.scope,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      tokensCached: row.tokens_cached,
      estUsd: row.est_usd,
      costKnown: row.cost_known === 1,
      stale,
    }))
  }

  #priceTableAtForDashboard(): number | null {
    return this.#prices.newestEffectiveFrom()
  }
}
