/**
 * 预测市场存储与别名映射（plan §4.1 / §4.4 / T1.9）。
 *
 * 这一层是 PIT 三闸门**唯一**的读取出口：任何想引用 pm 数据的代码都必须经过这里，
 * 因为闸门只有落在读取侧才真正生效（写入侧无从知道"当时能看到什么"）。
 *
 * 别名机制：DSH 的 `when` DSL 没有字符串，所以预测市场以别名进入词汇表：
 *   `trade_prediction_watch` 注册 `alias`（如 `fed_sep_cut`）→ 存 alias↔token 映射 →
 *   轮询刷新 → 特征快照暴露 `pm.<alias>.prob|mid|spread|volume24h|change1h|change24h|ageMs`。
 *   未注册 alias ⇒ 取值不存在 ⇒ 求值 UNCOVERED，**零静默 false**（§10 专项 ⑧）。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { canonicalJson, fingerprint, sha256Hex } from '../util/canonical.js'
import type { PmGammaMarket } from './client.js'
import {
  estimateProbability,
  liquidityGate,
  marketAsOf,
  seriesAsOf,
  type LiquidityGateConfig,
  type LiquidityVerdict,
  type MarketView,
  type PmQuoteLike,
  type PmSeriesPoint,
  type ProbabilityEstimate,
} from './pit.js'

// ── 记录形状 ─────────────────────────────────────────────────────────────────

export interface PmMarketRow {
  readonly conditionId: string
  readonly marketId: string | null
  readonly slug: string
  readonly question: string
  readonly outcomes: readonly string[]
  readonly tokenIds: readonly string[]
  /** 所属事件（Gamma 把 tags 挂在事件上；`/markets` 不返回顶层 tags）。 */
  readonly events: readonly { readonly id: string; readonly slug: string; readonly title: string }[]
  readonly negRisk: boolean
  readonly createdAt: number
  readonly endDate: number | null
  readonly closed: boolean
  readonly resolvedAt: number | null
  readonly winningOutcome: string | null
  readonly liquidity: number | null
  readonly volume24h: number | null
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly observedAt: number
}

export interface PmQuoteRow {
  readonly tokenId: string
  readonly observedAt: number
  readonly bestBid?: number
  readonly bestAsk?: number
  readonly mid?: number
  readonly spread?: number
  readonly lastTradePrice?: number
  readonly volume24h?: number
  readonly liquidity?: number
}

export const WATCH_KINDS = ['threshold', 'topic', 'resolution', 'liquidity'] as const
export type WatchKind = (typeof WATCH_KINDS)[number]

/** 只有 `info`/`novelty` 进 W3 唤醒；`commitment` 需 A/B 闸门判定（plan §12 #11）。 */
export const WATCH_PURPOSES = ['novelty', 'info', 'commitment'] as const
export type WatchPurpose = (typeof WATCH_PURPOSES)[number]

export interface WatchSpec {
  readonly alias: string
  readonly kind: WatchKind
  readonly purpose: WatchPurpose
  readonly tokenIds: readonly string[]
  readonly expr?: string
  readonly tags?: readonly string[]
  readonly query?: string
  readonly planId?: string
  readonly cooldownMs?: number
  readonly maxTriggers?: number
  /** **必填**：不允许无期限关注（plan §4.1）。 */
  readonly expiresAt: number
  readonly createdBy: 'model' | 'human'
}

export interface WatchRow extends WatchSpec {
  readonly watchId: string
  readonly contentHash: string
  readonly cooldownMs: number
  readonly maxTriggers: number
  readonly triggerCount: number
  readonly state: 'active' | 'expired' | 'disabled'
  readonly createdAt: number
  readonly lastFiredAt: number | null
}

export class WatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WatchError'
  }
}

/** 别名必须能用在小写路径里：`pm.<alias>.prob`。 */
const ALIAS_PATTERN = /^[a-z][a-z0-9_]{0,40}$/

/**
 * 关注规格指纹（identity）。**不含 `expiresAt`**：续期只是把同一个关注延长，不是新规格 ——
 * 若把它算进去，`UNIQUE(alias)` 会让"续期"变成一条撞唯一键的崩溃（实测）。
 * 也**不含 `createdBy`**（谁登记的不改变规格）。
 *
 * `cooldownMs` / `maxTriggers` 取**生效值**（含默认）后参与指纹：改了冷却就是改了规格，
 * 不能被静默当成"重复登记 → no-op"（旧实现忽略它们，改了冷却却毫无效果）。
 */
function watchContentHash(spec: WatchSpec, cooldownMs: number, maxTriggers: number): string {
  return `sha256:${sha256Hex(
    canonicalJson({
      alias: spec.alias,
      kind: spec.kind,
      purpose: spec.purpose,
      tokenIds: [...spec.tokenIds].sort(),
      expr: spec.expr ?? null,
      tags: [...(spec.tags ?? [])].sort(),
      query: spec.query ?? null,
      planId: spec.planId ?? null,
      cooldownMs,
      maxTriggers,
    }),
  )}`
}

// ── 存储 ─────────────────────────────────────────────────────────────────────

export interface PmStoreOptions {
  readonly liquidity: LiquidityGateConfig
  /** 同时 active 的关注上限（plan §4.4：默认 30）。 */
  readonly maxActiveWatches?: number
}

export class PmStore {
  readonly #statements: Statements

  constructor(
    private readonly db: Database.Database,
    private readonly options: PmStoreOptions,
  ) {
    this.#statements = new Statements(db)
  }

  // ── 市场（存在门控 / 结算门控在读取侧执行）─────────────────────────────────

  /**
   * 写入/更新市场元数据。
   *
   * **结算门控的关键取舍**：第一次观测到"已结算"时，我们只知道结算**不晚于此刻**，
   * 并不知道确切时刻。取 `resolved_at = 观测时刻` 是**保守方向** ——
   * 回放在该时刻之前看不到结果，绝不会把未来写进过去。
   * 一旦写下就不再回退成 NULL（历史不可改写）。
   */
  upsertMarket(market: PmGammaMarket, now: number): void {
    const existing = this.marketByConditionId(market.conditionId)
    const resolvedAt =
      market.lifecycle.resolved && market.lifecycle.winningOutcome !== null ? now : existing?.resolvedAt ?? null
    this.#statements
      .get(
        `INSERT INTO pm_markets
           (condition_id, market_id, slug, question, event_id, event_slug, tags_json,
            outcomes_json, token_ids_json, neg_risk,
            created_at, end_date, closed, resolved_at, winning_outcome, liquidity_num, volume24h,
            first_seen_at, last_seen_at, observed_at)
         VALUES
           (@conditionId, @marketId, @slug, @question, @eventId, @eventSlug, @tagsJson,
            @outcomesJson, @tokenIdsJson, @negRisk,
            @createdAt, @endDate, @closed, @resolvedAt, @winningOutcome, @liquidity, @volume24h,
            @firstSeenAt, @lastSeenAt, @observedAt)
         ON CONFLICT (condition_id) DO UPDATE SET
           slug = excluded.slug, question = excluded.question, closed = excluded.closed,
           end_date = excluded.end_date, liquidity_num = excluded.liquidity_num,
           volume24h = excluded.volume24h, last_seen_at = excluded.last_seen_at,
           observed_at = excluded.observed_at,
           -- 结算信息一旦写下就不再回退成 NULL（历史不可改写）
           resolved_at = COALESCE(excluded.resolved_at, pm_markets.resolved_at),
           winning_outcome = COALESCE(excluded.winning_outcome, pm_markets.winning_outcome)`,
      )
      .run({
        conditionId: market.conditionId,
        marketId: market.id,
        slug: market.slug,
        question: market.question,
        eventId: market.events[0]?.id ?? null,
        eventSlug: market.events[0]?.slug ?? null,
        tagsJson: canonicalJson(market.events.map((event) => event.slug).filter((slug) => slug !== '')),
        outcomesJson: canonicalJson(market.outcomes),
        tokenIdsJson: canonicalJson(market.clobTokenIds),
        negRisk: market.negRisk ? 1 : 0,
        createdAt: market.createdAt,
        endDate: market.endDate,
        closed: market.closed ? 1 : 0,
        resolvedAt,
        winningOutcome: market.lifecycle.resolved ? market.lifecycle.winningOutcome : null,
        liquidity: market.liquidity,
        volume24h: market.volume24hr,
        firstSeenAt: existing?.firstSeenAt ?? now,
        lastSeenAt: now,
        observedAt: now,
      })
  }

  marketByConditionId(conditionId: string): PmMarketRow | undefined {
    const row = this.#statements
      .get('SELECT * FROM pm_markets WHERE condition_id = ?')
      .get(conditionId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toMarketRow(row)
  }

  marketBySlug(slug: string): PmMarketRow | undefined {
    const row = this.#statements
      .get('SELECT * FROM pm_markets WHERE slug = ?')
      .get(slug) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toMarketRow(row)
  }

  /**
   * 市场清单：**只返回 `0 < created_at <= now` 的市场**（存在门控）。
   * `created_at = 0` 是"源没给创建时间"的退化值，不能当成"远古就存在"（fail-closed）。
   */
  marketsVisibleAt(now: number, limit = 200): readonly PmMarketRow[] {
    const rows = this.#statements
      .get('SELECT * FROM pm_markets WHERE created_at > 0 AND created_at <= ? ORDER BY created_at DESC LIMIT ?')
      .all(now, limit) as Record<string, unknown>[]
    return rows.map(toMarketRow)
  }

  /** 存在 + 结算门控的对外视图。 */
  marketViewAt(conditionId: string, now: number): MarketView {
    const market = this.marketByConditionId(conditionId)
    if (market === undefined) return { visible: false, reason: 'not_created_yet' }
    return marketAsOf(
      {
        conditionId: market.conditionId,
        createdAt: market.createdAt,
        closed: market.closed,
        ...(market.resolvedAt === null ? {} : { resolvedAt: market.resolvedAt }),
        ...(market.winningOutcome === null ? {} : { winningOutcome: market.winningOutcome }),
      },
      now,
    )
  }

  /** 在 `since` 之后**首次被我们见到**的市场（`pm_new_market` 用）。 */
  marketsFirstSeenSince(since: number, limit = 100): readonly PmMarketRow[] {
    const rows = this.#statements
      .get('SELECT * FROM pm_markets WHERE first_seen_at >= ? ORDER BY first_seen_at DESC LIMIT ?')
      .all(since, limit) as Record<string, unknown>[]
    return rows.map(toMarketRow)
  }

  // ── 序列（序列门控）────────────────────────────────────────────────────────

  /** 写入概率序列；`ts` 必须是**毫秒整数**（源为秒时由调用方先过 `normalizeSourceSeconds`）。 */
  recordSeries(
    tokenId: string,
    points: readonly PmSeriesPoint[],
    meta: { readonly source: string; readonly observedAt: number; readonly resolutionSeconds?: number },
  ): number {
    const resolutionSeconds = meta.resolutionSeconds ?? 0
    const insert = this.db.transaction(() => {
      let written = 0
      for (const point of points) {
        if (!Number.isSafeInteger(point.ts)) {
          throw new Error(`pm_series.ts 必须是毫秒整数，收到 ${String(point.ts)}`)
        }
        const result = this.#statements
          .get(
            `INSERT INTO pm_series (token_id, ts, price, resolution_seconds, source, observed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (token_id, ts, resolution_seconds) DO NOTHING`,
          )
          .run(tokenId, point.ts, point.price, resolutionSeconds, meta.source, meta.observedAt)
        written += Number(result.changes)
      }
      return written
    })
    return insert()
  }

  /** 全量序列（升序）。热路径读完后必须过 `seriesUpTo`。 */
  series(tokenId: string): readonly PmSeriesPoint[] {
    return (
      this.#statements
        .get('SELECT ts, price FROM pm_series WHERE token_id = ? ORDER BY ts ASC')
        .all(tokenId) as { ts: number; price: number }[]
    ).map((row) => ({ ts: row.ts, price: row.price }))
  }

  /** PIT 序列：`ts <= now` —— 回放**不得**看到未来点。 */
  seriesAsOf(tokenId: string, now: number): readonly PmSeriesPoint[] {
    return seriesAsOf(this.series(tokenId), now)
  }

  // ── 盘口 ───────────────────────────────────────────────────────────────────

  recordQuote(quote: PmQuoteRow): boolean {
    const result = this.#statements
      .get(
        `INSERT INTO pm_quotes
           (token_id, observed_at, best_bid, best_ask, mid, spread, last_trade_price, volume24h, liquidity)
         VALUES (@tokenId, @observedAt, @bestBid, @bestAsk, @mid, @spread, @lastTradePrice, @volume24h, @liquidity)
         ON CONFLICT (token_id, observed_at) DO NOTHING`,
      )
      .run({
        tokenId: quote.tokenId,
        observedAt: quote.observedAt,
        bestBid: quote.bestBid ?? null,
        bestAsk: quote.bestAsk ?? null,
        mid: quote.mid ?? null,
        spread: quote.spread ?? null,
        lastTradePrice: quote.lastTradePrice ?? null,
        volume24h: quote.volume24h ?? null,
        liquidity: quote.liquidity ?? null,
      })
    return Number(result.changes) > 0
  }

  /** 最近一条 `observed_at <= now` 的盘口（PIT：不返回未来的盘口）。 */
  latestQuoteAsOf(tokenId: string, now: number): PmQuoteRow | undefined {
    const row = this.#statements
      .get(
        'SELECT * FROM pm_quotes WHERE token_id = ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT 1',
      )
      .get(tokenId, now) as Record<string, unknown> | undefined
    return row === undefined ? undefined : toQuoteRow(row)
  }

  // ── 关注（watch）──────────────────────────────────────────────────────────

  /**
   * 登记关注。同一内容 ⇒ 幂等 no-op（返回既有行）。
   * `expiresAt` 必填且必须在未来 —— **不允许无期限关注**。
   */
  registerWatch(spec: WatchSpec, now: number): { readonly watch: WatchRow; readonly created: boolean } {
    if (!ALIAS_PATTERN.test(spec.alias)) {
      throw new WatchError(
        `alias 必须匹配 ${ALIAS_PATTERN.source}（要能写进 pm.<alias>.prob），收到 ${JSON.stringify(spec.alias)}`,
      )
    }
    if (!(spec.expiresAt > now)) {
      throw new WatchError(`expires_at 必须在未来：${spec.expiresAt} <= now ${now}（不允许无期限关注）`)
    }
    if (spec.kind === 'threshold' && (spec.expr === undefined || spec.expr.trim() === '')) {
      throw new WatchError('kind=threshold 必须给出 expr')
    }
    if (spec.kind !== 'threshold' && spec.tokenIds.length === 0 && (spec.tags ?? []).length === 0 && spec.query === undefined) {
      throw new WatchError('kind≠threshold 至少要给出 tokenIds / tags / query 之一')
    }
    const cooldownMs = spec.cooldownMs ?? 15 * 60_000
    const maxTriggers = spec.maxTriggers ?? 10
    if (!(cooldownMs > 0)) throw new WatchError(`cooldown_ms 必须是正数：${cooldownMs}`)
    if (!(maxTriggers > 0)) throw new WatchError(`max_triggers 必须是正数：${maxTriggers}`)

    const contentHash = watchContentHash(spec, cooldownMs, maxTriggers)
    const existing = this.watchByContentHash(contentHash)
    if (existing !== undefined) {
      // 曾被 cancel 的同一规格：原地重新激活（否则"cancel 后再登记同一规格"会静默无效）
      if (existing.state === 'disabled') {
        this.#statements
          .get(
            `UPDATE pm_watches
             SET state = 'active', trigger_count = 0, last_fired_at = NULL,
                 expires_at = @expiresAt, created_at = @createdAt
             WHERE watch_id = @watchId`,
          )
          .run({ watchId: existing.watchId, expiresAt: spec.expiresAt, createdAt: now })
        const revived = this.watchById(existing.watchId)
        if (revived === undefined) throw new WatchError('重新激活关注失败')
        return { watch: revived, created: true }
      }
      // 同一规格：幂等 no-op；若给了更长的期限则顺带续期（续期不是新规格）
      if (spec.expiresAt > existing.expiresAt) {
        this.#statements
          .get('UPDATE pm_watches SET expires_at = ? WHERE watch_id = ?')
          .run(spec.expiresAt, existing.watchId)
        return { watch: { ...existing, expiresAt: spec.expiresAt }, created: false }
      }
      return { watch: existing, created: false }
    }

    const row = {
      alias: spec.alias,
      contentHash,
      kind: spec.kind,
      expr: spec.expr ?? null,
      tokenIdsJson: canonicalJson(spec.tokenIds),
      tagsJson: canonicalJson(spec.tags ?? []),
      query: spec.query ?? null,
      purpose: spec.purpose,
      planId: spec.planId ?? null,
      cooldownMs,
      maxTriggers,
      expiresAt: spec.expiresAt,
      createdBy: spec.createdBy,
      createdAt: now,
    }

    // `alias` 有 UNIQUE 约束：同一 alias 只能有一行。若不先处理别名冲突，
    // 插入会抛出原始 `SqliteError: UNIQUE constraint failed`（实测），既不是幂等也不是
    // 可读的领域错误 —— 工具层只把 WatchError 转成 ToolArgumentError。
    const aliasOwner = this.watchByAlias(spec.alias)
    if (aliasOwner !== undefined) {
      if (aliasOwner.state !== 'disabled') {
        throw new WatchError(
          `alias ${spec.alias} 已被一个规格不同的关注占用（kind/purpose/expr/冷却等不一致）；先 cancel 再重新登记`,
        )
      }
      // 已取消的 alias 原地复用（不能另起一行，UNIQUE(alias) 不允许）
      this.#statements
        .get(
          `UPDATE pm_watches
           SET content_hash = @contentHash, kind = @kind, expr = @expr, token_ids_json = @tokenIdsJson,
               tags_json = @tagsJson, query = @query, purpose = @purpose, plan_id = @planId,
               cooldown_ms = @cooldownMs, max_triggers = @maxTriggers, trigger_count = 0,
               expires_at = @expiresAt, state = 'active', created_by = @createdBy,
               created_at = @createdAt, last_fired_at = NULL
           WHERE watch_id = @watchId`,
        )
        .run({ ...row, watchId: aliasOwner.watchId })
      const reused = this.watchById(aliasOwner.watchId)
      if (reused === undefined) throw new WatchError('复用关注失败')
      return { watch: reused, created: true }
    }

    // 上限（plan §4.4：默认 30 个 active）—— 无限登记会让轮询 token 与 novelty 面无限膨胀。
    const cap = this.options.maxActiveWatches ?? 30
    if (this.activeWatches(now).length >= cap) {
      throw new WatchError(`active 关注已达上限 ${cap}（plan §4.4）；先 cancel 一些再登记`)
    }

    const watchId = `pmw-${fingerprint({ alias: spec.alias, contentHash }).slice(7, 23)}`
    this.#statements
      .get(
        `INSERT INTO pm_watches
           (watch_id, alias, content_hash, kind, expr, token_ids_json, tags_json, query, purpose, plan_id,
            cooldown_ms, max_triggers, trigger_count, expires_at, state, created_by, created_at)
         VALUES
           (@watchId, @alias, @contentHash, @kind, @expr, @tokenIdsJson, @tagsJson, @query, @purpose, @planId,
            @cooldownMs, @maxTriggers, 0, @expiresAt, 'active', @createdBy, @createdAt)`,
      )
      .run({ ...row, watchId })
    const created = this.watchById(watchId)
    if (created === undefined) throw new WatchError('写入关注失败')
    return { watch: created, created: true }
  }

  watchById(watchId: string): WatchRow | undefined {
    const row = this.#statements.get('SELECT * FROM pm_watches WHERE watch_id = ?').get(watchId) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : toWatchRow(row)
  }

  watchByAlias(alias: string): WatchRow | undefined {
    const row = this.#statements.get('SELECT * FROM pm_watches WHERE alias = ?').get(alias) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : toWatchRow(row)
  }

  watchByContentHash(contentHash: string): WatchRow | undefined {
    const row = this.#statements.get('SELECT * FROM pm_watches WHERE content_hash = ?').get(contentHash) as
      | Record<string, unknown>
      | undefined
    return row === undefined ? undefined : toWatchRow(row)
  }

  /** 仍有效的关注：`state='active'` 且未过期、未用尽触发额度。 */
  activeWatches(now: number): readonly WatchRow[] {
    const rows = this.#statements
      .get(
        `SELECT * FROM pm_watches
         WHERE state = 'active' AND expires_at > ? AND trigger_count < max_triggers
         ORDER BY created_at ASC`,
      )
      .all(now) as Record<string, unknown>[]
    return rows.map(toWatchRow)
  }

  /** 过期扫描（由轮询器按注入时钟调用，不在读取时隐式改状态）。 */
  expireWatches(now: number): number {
    const result = this.#statements
      .get("UPDATE pm_watches SET state = 'expired' WHERE state = 'active' AND expires_at <= ?")
      .run(now)
    return Number(result.changes)
  }

  cancelWatch(alias: string): boolean {
    const result = this.#statements
      .get("UPDATE pm_watches SET state = 'disabled' WHERE alias = ? AND state = 'active'")
      .run(alias)
    return Number(result.changes) > 0
  }

  /**
   * 记录一次触发；**同时执行冷却与额度**。
   * 返回 false 表示本次不应触发（冷却中或额度用尽）—— 由调用方决定是否落库为 `suppressed`。
   */
  recordWatchFire(alias: string, now: number): boolean {
    const watch = this.watchByAlias(alias)
    if (watch === undefined || watch.state !== 'active') return false
    if (watch.lastFiredAt !== null && now - watch.lastFiredAt < watch.cooldownMs) return false
    if (watch.triggerCount >= watch.maxTriggers) return false
    this.#statements
      .get('UPDATE pm_watches SET trigger_count = trigger_count + 1, last_fired_at = ? WHERE watch_id = ?')
      .run(now, watch.watchId)
    return true
  }

  // ── 别名映射与快照 ─────────────────────────────────────────────────────────

  /** alias → token 列表（只含仍有效的关注）。 */
  aliasTokenMap(now: number): Readonly<Record<string, readonly string[]>> {
    const map: Record<string, readonly string[]> = {}
    for (const watch of this.activeWatches(now)) map[watch.alias] = watch.tokenIds
    return map
  }

  /**
   * 别名快照：**工具返回与告警 payload 都调用这一个函数**，
   * 因此 `prob` 的估计量不可能在两处漂移（§10 专项 ③）。
   */
  snapshotAt(now: number): readonly PmAliasSnapshot[] {
    const snapshots: PmAliasSnapshot[] = []
    for (const watch of this.activeWatches(now)) {
      for (const tokenId of watch.tokenIds) {
        snapshots.push(this.aliasSnapshot(watch, tokenId, now))
      }
    }
    return snapshots
  }

  aliasSnapshot(watch: WatchRow, tokenId: string, now: number): PmAliasSnapshot {
    const quote = this.latestQuoteAsOf(tokenId, now)
    const probability: ProbabilityEstimate =
      quote === undefined
        ? { ok: false, reason: '没有可见的盘口快照' }
        : estimateProbability({
            ...(quote.mid === undefined ? {} : { mid: quote.mid }),
            ...(quote.lastTradePrice === undefined ? {} : { lastTradePrice: quote.lastTradePrice }),
          })
    const series = this.seriesAsOf(tokenId, now)

    const market = this.marketsVisibleAt(now).find((row) => row.tokenIds.includes(tokenId))
    const marketView =
      market === undefined ? undefined : this.marketViewAt(market.conditionId, now)

    /**
     * 流动性来自 **盘口快照或 Gamma 元数据**，两者取其一。
     * 盘口端点不返回 liquidity；元数据页只覆盖"最新 N 个市场"，
     * 因此一个早已存在、但不在最新页里的关注市场会拿不到流动性 ⇒ 门槛永远"缺少流动性数据"。
     * 这是实测过的空跑风险：novelty 会**因为错的理由**一条都不发（专项 ④ 假通过）。
     * 价差仍**只**认盘口（元数据没有可信价差）；缺价差即 fail-closed。
     */
    const liquidityValue = quote?.liquidity ?? market?.liquidity ?? undefined
    const liquidity: LiquidityVerdict =
      quote === undefined && liquidityValue === undefined
        ? { pass: false, reason: '没有可见的盘口快照' }
        : liquidityGate(
            {
              ...(liquidityValue === undefined ? {} : { liquidity: liquidityValue }),
              ...(quote?.spread === undefined ? {} : { spread: quote.spread }),
            },
            this.options.liquidity,
          )

    return {
      alias: watch.alias,
      tokenId,
      watchId: watch.watchId,
      purpose: watch.purpose,
      kind: watch.kind,
      asOf: now,
      probability,
      liquidity,
      mid: quote?.mid ?? null,
      spread: quote?.spread ?? null,
      volume24h: quote?.volume24h ?? market?.volume24h ?? null,
      liquidityQuote: liquidityValue ?? null,
      ageMs: quote === undefined ? null : now - quote.observedAt,
      change1h: priceChange(series, now, 3_600_000),
      change24h: priceChange(series, now, 24 * 3_600_000),
      /** 序列已实现波动（相邻点绝对变化的均值）—— `pm_prob_jump` 的相对阈值基准。 */
      absChangeMean: meanAbsChange(series),
      /** 关注的近 7 日 volume24h 中位数 —— `pm_volume_spike` 的基准。 */
      volumeMedian: this.#volumeMedian(tokenId, now),
      quoteObservedAt: quote?.observedAt ?? null,
      questions: market?.question ?? null,
      resolved: marketView?.visible === true ? marketView.resolved : false,
      winningOutcome: marketView?.visible === true ? marketView.winningOutcome ?? null : null,
      /** 市场文本是**不可信输入**（§4.4 红线 3）。 */
      untrustedText: market?.question ?? null,
    }
  }

  /** 近 7 日 volume24h 中位数；样本不足（<3）返回 null 而不是 0。 */
  #volumeMedian(tokenId: string, now: number): number | null {
    const rows = this.#statements
      .get(
        `SELECT volume24h FROM pm_quotes
         WHERE token_id = ? AND observed_at <= ? AND observed_at >= ? AND volume24h IS NOT NULL
         ORDER BY volume24h ASC`,
      )
      .all(tokenId, now, now - 7 * 24 * 3_600_000) as { volume24h: number }[]
    if (rows.length < 3) return null
    const middle = Math.floor(rows.length / 2)
    const value =
      rows.length % 2 === 1
        ? (rows[middle] as { volume24h: number }).volume24h
        : ((rows[middle - 1] as { volume24h: number }).volume24h +
            (rows[middle] as { volume24h: number }).volume24h) /
          2
    return value
  }
}

export interface PmAliasSnapshot {
  readonly alias: string
  readonly tokenId: string
  readonly watchId: string
  readonly purpose: WatchPurpose
  readonly kind: WatchKind
  readonly asOf: number
  readonly probability: ProbabilityEstimate
  readonly liquidity: LiquidityVerdict
  readonly mid: number | null
  readonly spread: number | null
  readonly volume24h: number | null
  readonly liquidityQuote: number | null
  readonly ageMs: number | null
  readonly change1h: number | null
  readonly change24h: number | null
  readonly absChangeMean: number | null
  readonly volumeMedian: number | null
  readonly quoteObservedAt: number | null
  readonly questions: string | null
  readonly resolved: boolean
  readonly winningOutcome: string | null
  readonly untrustedText: string | null
}

/**
 * 相对 `now - lookback` 的**绝对**变化（概率单位，不是百分比）。
 *
 * 三种情况返回 `null`（**绝不返回 0** —— 0 是"没变化"，与"没数据"必须区分）：
 *   · 没有可见点；
 *   · 最近一次的可见观测本身早于回看窗口（窗口内没有新数据，谈不上"变化"）；
 *   · 窗口起点之前没有可比点。
 */
export function priceChange(
  series: readonly PmSeriesPoint[],
  now: number,
  lookbackMs: number,
): number | null {
  const current = series[series.length - 1]
  if (current === undefined) return null
  const cutoff = now - lookbackMs
  // 窗口内没有比 cutoff 更新的观测 ⇒ 变化未知
  if (current.ts <= cutoff) return null
  let past: PmSeriesPoint | undefined
  for (const point of series) {
    if (point.ts <= cutoff) past = point
    else break
  }
  if (past === undefined) return null
  return current.price - past.price
}

/** 相邻点绝对变化的均值（已实现波动的粗代理）；少于 2 个点返回 null。 */
export function meanAbsChange(series: readonly PmSeriesPoint[]): number | null {
  if (series.length < 2) return null
  let sum = 0
  for (let index = 1; index < series.length; index += 1) {
    sum += Math.abs((series[index] as PmSeriesPoint).price - (series[index - 1] as PmSeriesPoint).price)
  }
  return sum / (series.length - 1)
}

/**
 * 把别名快照摊平成 DSL 取值表：`pm.<alias>.prob|mid|spread|volume24h|change1h|change24h|ageMs`。
 *
 * **未注册的 alias 不会出现在这里** ⇒ `when` 求值失败 ⇒ UNCOVERED（§10 专项 ⑧）。
 * 这里绝不填 0 兜底：0 是一个**有效概率**，会把"没数据"伪装成"概率为零"。
 */
export function pmFeatureValues(
  snapshots: readonly PmAliasSnapshot[],
): Readonly<Record<string, number>> {
  const values: Record<string, number> = {}
  for (const snapshot of snapshots) {
    const prefix = `pm.${snapshot.alias}`
    if (snapshot.probability.ok) {
      values[`${prefix}.prob`] = snapshot.probability.value
      values[`${prefix}.estimator_is_mid`] = snapshot.probability.estimator === 'mid' ? 1 : 0
    }
    if (snapshot.mid !== null) values[`${prefix}.mid`] = snapshot.mid
    if (snapshot.spread !== null) values[`${prefix}.spread`] = snapshot.spread
    if (snapshot.volume24h !== null) values[`${prefix}.volume24h`] = snapshot.volume24h
    if (snapshot.change1h !== null) values[`${prefix}.change1h`] = snapshot.change1h
    if (snapshot.change24h !== null) values[`${prefix}.change24h`] = snapshot.change24h
    if (snapshot.ageMs !== null) values[`${prefix}.ageMs`] = snapshot.ageMs
  }
  return values
}

/** DSL 里允许出现的 pm 路径全集（用于校验计划卡引用的别名已注册）。 */
export function pmAllowedPaths(snapshots: readonly PmAliasSnapshot[]): readonly string[] {
  const paths: string[] = []
  for (const alias of new Set(snapshots.map((snapshot) => snapshot.alias))) {
    for (const suffix of ['prob', 'mid', 'spread', 'volume24h', 'change1h', 'change24h', 'ageMs']) {
      paths.push(`pm.${alias}.${suffix}`)
    }
  }
  return paths
}

// ── 行映射 ───────────────────────────────────────────────────────────────────

function toMarketRow(row: Record<string, unknown>): PmMarketRow {
  return {
    conditionId: String(row.condition_id),
    marketId: row.market_id === null ? null : String(row.market_id),
    slug: String(row.slug),
    question: String(row.question),
    outcomes: JSON.parse(String(row.outcomes_json)) as string[],
    tokenIds: JSON.parse(String(row.token_ids_json)) as string[],
    events: (JSON.parse(String(row.tags_json ?? '[]')) as string[]).map((slug) => ({
      id: '',
      slug,
      title: slug,
    })),
    negRisk: row.neg_risk === 1,
    createdAt: Number(row.created_at),
    endDate: row.end_date === null ? null : Number(row.end_date),
    closed: row.closed === 1,
    resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    winningOutcome: row.winning_outcome === null ? null : String(row.winning_outcome),
    liquidity: row.liquidity_num === null ? null : Number(row.liquidity_num),
    volume24h: row.volume24h === null ? null : Number(row.volume24h),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    observedAt: Number(row.observed_at),
  }
}

function toQuoteRow(row: Record<string, unknown>): PmQuoteRow {
  const numeric = (value: unknown): number | undefined =>
    value === null || value === undefined ? undefined : Number(value)
  return {
    tokenId: String(row.token_id),
    observedAt: Number(row.observed_at),
    ...(numeric(row.best_bid) === undefined ? {} : { bestBid: numeric(row.best_bid) }),
    ...(numeric(row.best_ask) === undefined ? {} : { bestAsk: numeric(row.best_ask) }),
    ...(numeric(row.mid) === undefined ? {} : { mid: numeric(row.mid) }),
    ...(numeric(row.spread) === undefined ? {} : { spread: numeric(row.spread) }),
    ...(numeric(row.last_trade_price) === undefined ? {} : { lastTradePrice: numeric(row.last_trade_price) }),
    ...(numeric(row.volume24h) === undefined ? {} : { volume24h: numeric(row.volume24h) }),
    ...(numeric(row.liquidity) === undefined ? {} : { liquidity: numeric(row.liquidity) }),
  }
}

function toWatchRow(row: Record<string, unknown>): WatchRow {
  return {
    watchId: String(row.watch_id),
    alias: String(row.alias),
    contentHash: String(row.content_hash),
    kind: String(row.kind) as WatchKind,
    purpose: String(row.purpose) as WatchPurpose,
    tokenIds: JSON.parse(String(row.token_ids_json)) as string[],
    tags: JSON.parse(String(row.tags_json)) as string[],
    ...(row.expr === null ? {} : { expr: String(row.expr) }),
    ...(row.query === null ? {} : { query: String(row.query) }),
    ...(row.plan_id === null ? {} : { planId: String(row.plan_id) }),
    cooldownMs: Number(row.cooldown_ms),
    maxTriggers: Number(row.max_triggers),
    triggerCount: Number(row.trigger_count),
    expiresAt: Number(row.expires_at),
    state: String(row.state) as 'active' | 'expired' | 'disabled',
    createdBy: String(row.created_by) as 'model' | 'human',
    createdAt: Number(row.created_at),
    lastFiredAt: row.last_fired_at === null ? null : Number(row.last_fired_at),
  }
}
