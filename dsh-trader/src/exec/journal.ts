/**
 * 决策与订单日志（plan §5.3 M2 / §7.5）。
 *
 * 幂等根落在**数据库约束**上，而不是调用方的自觉：
 *   · `decisions.decision_id` 主键 + `content_hash` 唯一 ⇒ 同一根 bar 重放不会写出第二条决策；
 *   · `order_intents.client_order_id` 唯一 ⇒ 重放不会重复下单；
 *   · `fills.fill_id` 主键 + `(order_id, ts, qty)` 唯一 ⇒ 交易所重复推送也不会重复计账。
 *
 * 统一用 `ON CONFLICT DO NOTHING`（**不是** `INSERT OR IGNORE`）：前者只吞指定的冲突，
 * 后者会把 CHECK/NOT NULL 违反一起静默吞掉。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { canonicalJson, fingerprint } from '../util/canonical.js'
import type { DecisionAction } from '../plan/schema.js'

export interface DecisionRecord {
  readonly decisionId: string
  readonly symbol: string
  readonly planId?: string
  readonly decidedAt: number
  readonly contextHash: string
  readonly action: DecisionAction
  readonly sizeQty?: number
  readonly stopPrice?: number
  readonly takeProfit?: number
  readonly rationale?: string
  readonly modelRoute?: string
  readonly executed: boolean
  /** 结算到期时刻（plan §7.9）：到期后由独立结算任务处理，与"何时重跑该标的"无关。 */
  readonly reflectionDueAt?: number
}

/** 在途意图（崩溃恢复的输入）。 */
export interface InFlightIntent {
  readonly clientOrderId: string
  readonly intentId: string
  readonly decisionId: string | null
  readonly symbol: string
  readonly venue: string
  readonly state: 'created' | 'unknown'
  readonly type: string | null
  readonly side: string | null
  readonly qty: number | null
  readonly price: number | null
  readonly reduceOnly: boolean
  readonly createdAt: number
}

export interface OrderIntentRecord {
  readonly intentId: string
  readonly clientOrderId: string
  readonly decisionId: string
  readonly venue: string
  readonly symbol: string
  readonly state: 'created' | 'acked' | 'rejected' | 'unknown' | 'canceled' | 'filled'
  readonly type: string
  readonly side: string
  readonly qty: number
  readonly price?: number
  readonly notionalUsd?: number
  readonly reduceOnly: boolean
  readonly createdAt: number
  readonly exchangeOrderId?: string
}

export interface OrderRecord {
  readonly orderId: string
  readonly venue: string
  readonly exchangeOrderId?: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly status: string
  readonly qty: number
  readonly filledQty: number
  readonly avgPrice?: number
  readonly updatedAt: number
}

export interface FillRecord {
  readonly fillId: string
  readonly orderId: string
  readonly qty: number
  readonly price: number
  readonly fee: number
  readonly feeCurrency: string
  readonly ts: number
}

/** 结算视角的成交（`fillsForDecision` 的返回形状）。 */
export interface FillView {
  readonly fillId: string
  readonly qty: number
  readonly price: number
  readonly fee: number
  readonly side: string
  readonly ts: number
}

export interface DecisionSummary {
  readonly decisionId: string
  readonly symbol: string
  readonly decidedAt: number
  readonly action: string
  readonly sizeQty: number | null
  readonly stopPrice: number | null
  readonly confidence: number | null
  readonly rationale: string | null
  /** 决策时的上下文指纹（plan §5.1「绝不可丢」）—— 审计与对拍的锚点。 */
  readonly contextHash: string
  readonly outcomeId: string | null
  /** 成本（plan §8）：缺价目时 `costKnown = false`，此时 `costUsd` 不可信。 */
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly tokensCached: number | null
  readonly costUsd: number | null
  readonly costKnown: boolean | null
  readonly durationMs: number | null
  readonly triggerSource: string | null
}

/** 一次模型调用的实际开销，回填到产生它的决策上（plan §8）。 */
export interface DecisionCost {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly tokensCached: number
  readonly costUsd: number
  /** false = 价目表缺行，`costUsd` 不可信（已记 0，但**不是**零成本）。 */
  readonly costKnown: boolean
  readonly durationMs: number
  readonly triggerSource: string
}

export interface LessonSummary {
  readonly lessonId: string
  readonly decisionId: string
  /** 解析后的证据指针（写入时是 JSON）。 */
  readonly evidenceRefs: readonly string[]
  readonly symbol: string | null
  readonly text: string
  readonly regimeBucket: string | null
  readonly createdAt: number
  /** 反思 TTL；`null` 表示未设过期（不推荐）。 */
  readonly expiresAt: number | null
}

interface DecisionRow {
  decision_id: string
  symbol: string
  decided_at: number
  action: string
  size_qty: number | null
  stop_price: number | null
  confidence: number | null
  rationale: string | null
  context_hash: string
  outcome_id: string | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cached: number | null
  cost_usd: number | null
  cost_known: number | null
  duration_ms: number | null
  trigger_source: string | null
}

interface LessonRow {
  lesson_id: string
  decision_id: string
  symbol: string | null
  text: string
  evidence_refs_json: string
  regime_bucket: string | null
  created_at: number
  expires_at: number | null
}

export interface PendingSettlement {
  readonly decisionId: string
  readonly symbol: string
  readonly action: string
  readonly decidedAt: number
  readonly sizeQty: number | null
  readonly stopPrice: number | null
  readonly takeProfit: number | null
  readonly confidence: number | null
  readonly rationale: string | null
}

/** 交易级结算结果（plan §7.9）：净额含手续费/滑点，基准用 BTC/ETH，**不是 SPY**。 */
export interface OutcomeRecord {
  readonly outcomeId: string
  readonly decisionId: string
  readonly symbol: string
  readonly settledAt: number
  readonly horizonMs: number
  readonly entryPrice: number
  readonly exitPrice: number
  readonly realizedGrossPct: number
  readonly realizedNetPct: number
  readonly benchmarkPct: number
  readonly alphaPct: number
  readonly mfePct: number
  readonly maePct: number
  readonly stopHit: boolean
  readonly feesQuote: number
  /** 证据指针：结算用到的订单/成交/行情指纹 —— 让反思**可以被推翻**。 */
  readonly evidenceRefs: readonly string[]
}

interface PendingRow {
  decision_id: string
  symbol: string
  action: string
  decided_at: number
  size_qty: number | null
  stop_price: number | null
  take_profit: number | null
  confidence: number | null
  rationale: string | null
}

interface OutcomeRow {
  outcome_id: string
  decision_id: string
  symbol: string
  settled_at: number
  horizon_ms: number
  entry_price: number
  exit_price: number
  realized_gross_pct: number
  realized_net_pct: number
  benchmark_pct: number
  alpha_pct: number
  mfe_pct: number
  mae_pct: number
  stop_hit: number
  fees_quote: number
  evidence_refs_json: string
}

function toOutcome(row: OutcomeRow): OutcomeRecord {
  return {
    outcomeId: row.outcome_id,
    decisionId: row.decision_id,
    symbol: row.symbol,
    settledAt: row.settled_at,
    horizonMs: row.horizon_ms,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    realizedGrossPct: row.realized_gross_pct,
    realizedNetPct: row.realized_net_pct,
    benchmarkPct: row.benchmark_pct,
    alphaPct: row.alpha_pct,
    mfePct: row.mfe_pct,
    maePct: row.mae_pct,
    stopHit: row.stop_hit === 1,
    feesQuote: row.fees_quote,
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
  }
}

/** 证据指针是写入时序列化的 JSON 数组；坏数据不应当让读取方崩溃，退化为空数组。 */
function parseJsonArray(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export class DecisionJournal {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  /** 决策幂等根：内容哈希（不含"是否已执行"，那是结果而非内容）。 */
  static contentHash(record: DecisionRecord): string {
    return fingerprint({
      decisionId: record.decisionId,
      symbol: record.symbol,
      planId: record.planId ?? null,
      decidedAt: record.decidedAt,
      contextHash: record.contextHash,
      action: record.action,
      sizeQty: record.sizeQty ?? null,
      stopPrice: record.stopPrice ?? null,
      takeProfit: record.takeProfit ?? null,
    })
  }

  recordDecision(record: DecisionRecord): boolean {
    const result = this.#statements.get(
        `INSERT INTO decisions
           (decision_id, content_hash, symbol, plan_id, decided_at, context_hash, action,
            size_qty, stop_price, take_profit, rationale, model_route, executed, reflection_due_at)
         VALUES
           (@decisionId, @contentHash, @symbol, @planId, @decidedAt, @contextHash, @action,
            @sizeQty, @stopPrice, @takeProfit, @rationale, @modelRoute, @executed, @reflectionDueAt)
         -- 只兜 content_hash：同一 decision_id 改内容 = 事后改写，必须抛（有测试锁）。
         -- 程序化的"重跑同一 bar"在 execute-action 层用 hasDecision 提前短路，不依赖这里。
         ON CONFLICT (content_hash) DO NOTHING`,
      )
      .run({
        decisionId: record.decisionId,
        contentHash: DecisionJournal.contentHash(record),
        symbol: record.symbol,
        planId: record.planId ?? null,
        decidedAt: record.decidedAt,
        contextHash: record.contextHash,
        action: record.action,
        sizeQty: record.sizeQty ?? null,
        stopPrice: record.stopPrice ?? null,
        takeProfit: record.takeProfit ?? null,
        rationale: record.rationale ?? null,
        modelRoute: record.modelRoute ?? null,
        executed: record.executed ? 1 : 0,
        reflectionDueAt: record.reflectionDueAt ?? null,
      })
    return Number(result.changes) > 0
  }

  // ── 结算（plan §7.9）─────────────────────────────────────────────────────────

  /**
   * 到期待结算的决策 —— **扫描全部标的**，而不是"只结算当前正在分析的标的"
   * （TradingAgents 的 `_resolve_pending_entries` 因此让一次性标的的条目永远悬空）。
   */
  pendingSettlements(now: number, limit = 20): readonly PendingSettlement[] {
    const rows = this.#statements
      .get(
        `SELECT decision_id, symbol, action, decided_at, size_qty, stop_price, take_profit, confidence, rationale
         FROM decisions
         WHERE outcome_id IS NULL AND reflection_due_at IS NOT NULL AND reflection_due_at <= ?
         ORDER BY reflection_due_at ASC LIMIT ?`,
      )
      .all(now, limit) as PendingRow[]
    return rows.map((row) => ({
      decisionId: row.decision_id,
      symbol: row.symbol,
      action: row.action,
      decidedAt: row.decided_at,
      sizeQty: row.size_qty,
      stopPrice: row.stop_price,
      takeProfit: row.take_profit,
      confidence: row.confidence,
      rationale: row.rationale,
    }))
  }

  /** 写入结算结果。`decision_id` 唯一 ⇒ 重跑不会追加第二条（结算幂等根）。 */
  recordOutcome(outcome: OutcomeRecord): boolean {
    const result = this.#statements
      .get(
        `INSERT INTO outcomes
           (outcome_id, decision_id, symbol, settled_at, horizon_ms, entry_price, exit_price,
            realized_gross_pct, realized_net_pct, benchmark_pct, alpha_pct, mfe_pct, mae_pct,
            stop_hit, fees_quote, evidence_refs_json)
         VALUES
           (@outcomeId, @decisionId, @symbol, @settledAt, @horizonMs, @entryPrice, @exitPrice,
            @realizedGrossPct, @realizedNetPct, @benchmarkPct, @alphaPct, @mfePct, @maePct,
            @stopHit, @feesQuote, @evidenceRefsJson)
         ON CONFLICT (decision_id) DO NOTHING`,
      )
      .run({
        outcomeId: outcome.outcomeId,
        decisionId: outcome.decisionId,
        symbol: outcome.symbol,
        settledAt: outcome.settledAt,
        horizonMs: outcome.horizonMs,
        entryPrice: outcome.entryPrice,
        exitPrice: outcome.exitPrice,
        realizedGrossPct: outcome.realizedGrossPct,
        realizedNetPct: outcome.realizedNetPct,
        benchmarkPct: outcome.benchmarkPct,
        alphaPct: outcome.alphaPct,
        mfePct: outcome.mfePct,
        maePct: outcome.maePct,
        stopHit: outcome.stopHit ? 1 : 0,
        feesQuote: outcome.feesQuote,
        evidenceRefsJson: canonicalJson(outcome.evidenceRefs),
      })
    return Number(result.changes) > 0
  }

  markDecisionOutcome(decisionId: string, outcomeId: string): void {
    this.#statements
      .get('UPDATE decisions SET outcome_id = ? WHERE decision_id = ?')
      .run(outcomeId, decisionId)
  }

  outcomeFor(decisionId: string): OutcomeRecord | undefined {
    const row = this.#statements
      .get('SELECT * FROM outcomes WHERE decision_id = ?')
      .get(decisionId) as OutcomeRow | undefined
    return row === undefined ? undefined : toOutcome(row)
  }

  /** 写入反思。`decision_id` 唯一 ⇒ **一条决策至多一条反思**（plan §10 P1 验收）。 */
  recordLesson(lesson: {
    readonly lessonId: string
    readonly decisionId: string
    readonly text: string
    readonly evidenceRefs: readonly string[]
    readonly regimeBucket?: string
    readonly createdAt: number
    readonly expiresAt?: number
  }): boolean {
    const result = this.#statements
      .get(
        `INSERT INTO lessons (lesson_id, decision_id, text, evidence_refs_json, regime_bucket, created_at, expires_at)
         VALUES (@lessonId, @decisionId, @text, @evidenceRefsJson, @regimeBucket, @createdAt, @expiresAt)
         ON CONFLICT (decision_id) DO NOTHING`,
      )
      .run({
        lessonId: lesson.lessonId,
        decisionId: lesson.decisionId,
        text: lesson.text,
        evidenceRefsJson: canonicalJson(lesson.evidenceRefs),
        regimeBucket: lesson.regimeBucket ?? null,
        createdAt: lesson.createdAt,
        expiresAt: lesson.expiresAt ?? null,
      })
    return Number(result.changes) > 0
  }

  recordIntent(intent: OrderIntentRecord): boolean {
    const result = this.#statements.get(
        `INSERT INTO order_intents
           (intent_id, client_order_id, decision_id, venue, symbol, state, type, side, qty,
            price, notional_usd, reduce_only, created_at, exchange_order_id)
         VALUES
           (@intentId, @clientOrderId, @decisionId, @venue, @symbol, @state, @type, @side, @qty,
            @price, @notionalUsd, @reduceOnly, @createdAt, @exchangeOrderId)
         ON CONFLICT (client_order_id) DO NOTHING`,
      )
      .run({
        intentId: intent.intentId,
        clientOrderId: intent.clientOrderId,
        decisionId: intent.decisionId,
        venue: intent.venue,
        symbol: intent.symbol,
        state: intent.state,
        type: intent.type,
        side: intent.side,
        qty: intent.qty,
        price: intent.price ?? null,
        notionalUsd: intent.notionalUsd ?? null,
        reduceOnly: intent.reduceOnly ? 1 : 0,
        createdAt: intent.createdAt,
        exchangeOrderId: intent.exchangeOrderId ?? null,
      })
    return Number(result.changes) > 0
  }

  recordOrder(order: OrderRecord): boolean {
    const result = this.#statements.get(
        `INSERT INTO orders
           (order_id, venue, exchange_order_id, client_order_id, symbol, status, qty, filled_qty, avg_price, updated_at)
         VALUES
           (@orderId, @venue, @exchangeOrderId, @clientOrderId, @symbol, @status, @qty, @filledQty, @avgPrice, @updatedAt)
         -- 两个唯一键分别兜底（不用裸 DO NOTHING，也不用 INSERT OR IGNORE：
         -- 后两者语义更宽，容易把 CHECK/NOT NULL 违反一起吞掉）
         ON CONFLICT (order_id) DO NOTHING
         ON CONFLICT (venue, exchange_order_id) DO NOTHING`,
      )
      .run({
        orderId: order.orderId,
        venue: order.venue,
        exchangeOrderId: order.exchangeOrderId ?? null,
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        status: order.status,
        qty: order.qty,
        filledQty: order.filledQty,
        avgPrice: order.avgPrice ?? null,
        updatedAt: order.updatedAt,
      })
    return Number(result.changes) > 0
  }

  recordFill(fill: FillRecord): boolean {
    const result = this.#statements.get(
        `INSERT INTO fills (fill_id, order_id, qty, price, fee, fee_ccy, ts)
         VALUES (@fillId, @orderId, @qty, @price, @fee, @feeCurrency, @ts)
         -- fill_id 主键与 UNIQUE(order_id, ts, qty)（交易所重复推送）分别兜底
         ON CONFLICT (fill_id) DO NOTHING
         ON CONFLICT (order_id, ts, qty) DO NOTHING`,
      )
      .run({
        fillId: fill.fillId,
        orderId: fill.orderId,
        qty: fill.qty,
        price: fill.price,
        fee: fill.fee,
        feeCurrency: fill.feeCurrency,
        ts: fill.ts,
      })
    return Number(result.changes) > 0
  }

  // ── 审计读取（回放对拍用）─────────────────────────────────────────────────

  decisionIds(): readonly string[] {
    return (this.#statements.get('SELECT decision_id AS id FROM decisions ORDER BY decision_id').all() as {
      id: string
    }[]).map((row) => row.id)
  }

  intentIds(): readonly string[] {
    return (this.#statements.get('SELECT intent_id AS id FROM order_intents ORDER BY intent_id').all() as {
      id: string
    }[]).map((row) => row.id)
  }

  clientOrderIds(): readonly string[] {
    return (
      this.#statements.get('SELECT client_order_id AS id FROM order_intents ORDER BY client_order_id')
        .all() as { id: string }[]
    ).map((row) => row.id)
  }

  fillIds(): readonly string[] {
    return (this.#statements.get('SELECT fill_id AS id FROM fills ORDER BY fill_id').all() as {
      id: string
    }[]).map((row) => row.id)
  }

  /**
   * 某条决策实际产生的成交（按时间升序）。
   * 走 `fills → orders → order_intents → decisions` —— 结算用**真实成交价**而非 bar 收盘价。
   */
  fillsForDecision(decisionId: string): readonly FillView[] {
    const rows = this.#statements
      .get(
        `SELECT f.fill_id, f.qty, f.price, f.fee, f.ts, COALESCE(oi.side, 'buy') AS side
         FROM fills f
         JOIN orders o ON o.order_id = f.order_id
         JOIN order_intents oi ON oi.client_order_id = o.client_order_id
         WHERE oi.decision_id = ?
         ORDER BY f.ts ASC, f.fill_id ASC`,
      )
      .all(decisionId) as {
      fill_id: string
      qty: number
      price: number
      fee: number | null
      ts: number
      side: string
    }[]
    return rows.map((row) => ({
      fillId: row.fill_id,
      qty: row.qty,
      price: row.price,
      fee: row.fee ?? 0,
      side: row.side,
      ts: row.ts,
    }))
  }

  /**
   * 某标的在 `beforeTs` 之前的**全部成交**（按时间升序）。
   * 用途：结算 `reduce`/`close` 决策时重建当时的持仓与**真实入场均价** ——
   * 否则会把"平仓成交"当成新入场，把一笔 +20% 的回合记成 ~0%（实测）。
   */
  fillsForSymbolBefore(symbol: string, beforeTs: number): readonly FillView[] {
    const rows = this.#statements
      .get(
        `SELECT f.fill_id, f.qty, f.price, f.fee, f.ts, COALESCE(oi.side, 'buy') AS side
         FROM fills f
         JOIN orders o ON o.order_id = f.order_id
         JOIN order_intents oi ON oi.client_order_id = o.client_order_id
         WHERE oi.symbol = ? AND f.ts < ?
         ORDER BY f.ts ASC, f.fill_id ASC`,
      )
      .all(symbol, beforeTs) as {
      fill_id: string
      qty: number
      price: number
      fee: number | null
      ts: number
      side: string
    }[]
    return rows.map((row) => ({
      fillId: row.fill_id,
      qty: row.qty,
      price: row.price,
      fee: row.fee ?? 0,
      side: row.side,
      ts: row.ts,
    }))
  }

  /** 按 client_order_id 取意图的最小视图 —— 成交回报用它补 qty/decisionId。 */
  intentByClientOrderId(clientOrderId: string):
    | {
        readonly intentId: string
        readonly decisionId: string | null
        readonly symbol: string
        readonly side: string | null
        readonly qty: number | null
        readonly price: number | null
      }
    | undefined {
    const row = this.#statements
      .get('SELECT intent_id, decision_id, symbol, side, qty, price FROM order_intents WHERE client_order_id = ?')
      .get(clientOrderId) as
      | {
          intent_id: string
          decision_id: string | null
          symbol: string
          side: string | null
          qty: number | null
          price: number | null
        }
      | undefined
    if (row === undefined) return undefined
    return {
      intentId: row.intent_id,
      decisionId: row.decision_id,
      symbol: row.symbol,
      side: row.side,
      qty: row.qty,
      price: row.price,
    }
  }

  triggerKeys(): readonly string[] {
    return (
      this.#statements.get('SELECT dedup_key AS id FROM triggers ORDER BY dedup_key').all() as {
        id: string
      }[]
    ).map((row) => row.id)
  }

  /** 重复的 `client_order_id` 数（唯一约束下应恒为 0）—— 回放验收的一条硬指标。 */
  duplicateClientOrderIds(): number {
    const row = this.#statements.get(
        `SELECT COUNT(*) AS n FROM (
           SELECT client_order_id FROM order_intents GROUP BY client_order_id HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n: number }
    return row.n
  }

  /** 该 `client_order_id` 是否已经下过单 —— 硬闸幂等检查的依据。 */
  hasClientOrderId(clientOrderId: string): boolean {
    return (
      this.#statements.get('SELECT 1 AS x FROM order_intents WHERE client_order_id = ?').get(clientOrderId) !==
      undefined
    )
  }

  // ── 状态迁移（plan §8.2："意图先落库，收到 ack 再置 acked"）──────────────────

  /** 该决策 id 是否已经存在（避免"拒绝记录"与既有决策撞主键）。 */
  hasDecision(decisionId: string): boolean {
    return (
      this.#statements.get('SELECT 1 AS x FROM decisions WHERE decision_id = ?').get(decisionId) !==
      undefined
    )
  }

  /**
   * 追加一条审计事件（append-only，带哈希链）。
   *
   * 用途是"被拒绝的尝试"：它不该写进 `decisions`（同一 decision_id 再写一行会撞主键），
   * 但**必须留痕**（plan §9.1 审计优先）。
   */
  appendAudit(event: {
    readonly actor: 'model' | 'human' | 'system'
    readonly kind: string
    readonly payload: unknown
    readonly ts: number
  }): string {
    const last = this.#statements
      .get('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1')
      .get() as { hash: string } | undefined
    const prevHash = last?.hash ?? null
    const hash = fingerprint({
      prevHash,
      ts: event.ts,
      actor: event.actor,
      kind: event.kind,
      payload: event.payload,
    })
    this.#statements
      .get(
        `INSERT INTO audit_events (ts, actor, kind, payload_json, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.ts, event.actor, event.kind, canonicalJson(event.payload), prevHash, hash)
    return hash
  }

  /**
   * 标记决策已执行。`executed` **不参与** contentHash（它是结果不是内容），
   * 因此这个 UPDATE 不会破坏幂等根。
   */
  markDecisionExecuted(decisionId: string): void {
    this.#statements.get('UPDATE decisions SET executed = 1 WHERE decision_id = ?').run(decisionId)
  }

  /**
   * 登记结算到期时刻。**只有真正成交**的决策才登记 ——
   * 被拒/未成交的决策没有仓位，不产生 outcome，也不应堵塞结算队列。
   */
  markDecisionReflectionDue(decisionId: string, dueAt: number): void {
    this.#statements
      .get('UPDATE decisions SET reflection_due_at = ? WHERE decision_id = ? AND reflection_due_at IS NULL')
      .run(dueAt, decisionId)
  }

  /**
   * 回填一次模型调用的开销（plan §8）。
   * 调用方先记账（`BudgetLedger.record`）再回填；两者都写 —— 看板聚合与单条审计互为依据。
   */
  markDecisionCost(decisionId: string, cost: DecisionCost): boolean {
    const result = this.#statements
      .get(
        `UPDATE decisions
         SET tokens_in = @tokensIn, tokens_out = @tokensOut, tokens_cached = @tokensCached,
             cost_usd = @costUsd, cost_known = @costKnown,
             duration_ms = @durationMs, trigger_source = @triggerSource
         WHERE decision_id = @decisionId`,
      )
      .run({
        decisionId,
        tokensIn: cost.tokensIn,
        tokensOut: cost.tokensOut,
        tokensCached: cost.tokensCached,
        costUsd: cost.costUsd,
        costKnown: cost.costKnown ? 1 : 0,
        durationMs: cost.durationMs,
        triggerSource: cost.triggerSource,
      })
    return Number(result.changes) > 0
  }

  /** 收到交易所 ack 后推进意图状态；`created` 且无 ack 的记录是崩溃恢复的查询线索。 */
  markIntentAcked(
    clientOrderId: string,
    state: 'acked' | 'filled' | 'rejected' | 'canceled',
    exchangeOrderId: string | undefined,
    ackedAt: number,
  ): void {
    this.#statements
      .get(
        'UPDATE order_intents SET state = ?, acked_at = ?, exchange_order_id = ? WHERE client_order_id = ?',
      )
      .run(state, ackedAt, exchangeOrderId ?? null, clientOrderId)
  }

  /**
   * **在途意图**（plan §4.2 崩溃恢复）：`created` 且没有 ack 的记录 ——
   * 我们不知道交易所到底有没有收到它。这是崩溃恢复唯一可靠的查询线索。
   */
  inFlightIntents(): readonly InFlightIntent[] {
    const rows = this.#statements
      .get(
        `SELECT client_order_id, intent_id, decision_id, symbol, venue, state, type, side, qty,
                price, reduce_only, created_at
         FROM order_intents
         WHERE acked_at IS NULL AND state IN ('created', 'unknown')
         ORDER BY created_at ASC, client_order_id ASC`,
      )
      .all() as {
      client_order_id: string
      intent_id: string
      decision_id: string | null
      symbol: string
      venue: string
      state: string
      type: string | null
      side: string | null
      qty: number | null
      price: number | null
      reduce_only: number
      created_at: number
    }[]
    return rows.map((row) => ({
      clientOrderId: row.client_order_id,
      intentId: row.intent_id,
      decisionId: row.decision_id,
      symbol: row.symbol,
      venue: row.venue,
      state: row.state as 'created' | 'unknown',
      type: row.type,
      side: row.side,
      qty: row.qty,
      price: row.price,
      reduceOnly: row.reduce_only === 1,
      createdAt: row.created_at,
    }))
  }

  /** 无法判定交易所状态 ⇒ 标 `unknown`（绝不猜：由恢复流程告警并冻结该标的）。 */
  markIntentUnknown(clientOrderId: string, at: number): boolean {
    const result = this.#statements
      .get("UPDATE order_intents SET state = 'unknown' WHERE client_order_id = ? AND acked_at IS NULL")
      .run(clientOrderId)
    void at
    return Number(result.changes) > 0
  }

  // ── 检索（供 `trade_recall` 使用）────────────────────────────────────────────

  /** 最近的决策（可按标的过滤）—— 判断前的 just-in-time 检索。 */
  recentDecisions(
    options: { readonly symbol?: string; readonly limit?: number } = {},
  ): readonly DecisionSummary[] {
    const limit = options.limit ?? 20
    const sql =
      'SELECT decision_id, symbol, decided_at, action, size_qty, stop_price, confidence, rationale, context_hash, outcome_id, tokens_in, tokens_out, tokens_cached, cost_usd, cost_known, duration_ms, trigger_source FROM decisions'
    const rows = (
      options.symbol === undefined
        ? this.#statements.get(`${sql} ORDER BY decided_at DESC LIMIT ?`).all(limit)
        : this.#statements
            .get(`${sql} WHERE symbol = ? ORDER BY decided_at DESC LIMIT ?`)
            .all(options.symbol, limit)
    ) as DecisionRow[]
    return rows.map((row) => ({
      decisionId: row.decision_id,
      symbol: row.symbol,
      decidedAt: row.decided_at,
      action: row.action,
      sizeQty: row.size_qty,
      stopPrice: row.stop_price,
      confidence: row.confidence,
      rationale: row.rationale,
      contextHash: row.context_hash,
      outcomeId: row.outcome_id,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      tokensCached: row.tokens_cached,
      costUsd: row.cost_usd,
      costKnown: row.cost_known === null ? null : row.cost_known === 1,
      durationMs: row.duration_ms,
      triggerSource: row.trigger_source,
    }))
  }

  /**
   * 已结算决策的反思（"教训"），连同证据指针与 TTL。
   * **是否过期由调用方（`memory/recall`）判定** —— SQL 层不做政策。
   */
  recentLessons(
    options: { readonly symbol?: string; readonly limit?: number } = {},
  ): readonly LessonSummary[] {
    const limit = options.limit ?? 20
    const base =
      'SELECT l.lesson_id, l.decision_id, l.text, l.evidence_refs_json, l.regime_bucket, l.created_at, l.expires_at, d.symbol FROM lessons l LEFT JOIN decisions d ON d.decision_id = l.decision_id'
    const rows = (
      options.symbol === undefined
        ? this.#statements.get(`${base} ORDER BY l.created_at DESC LIMIT ?`).all(limit)
        : this.#statements
            .get(`${base} WHERE d.symbol = ? ORDER BY l.created_at DESC LIMIT ?`)
            .all(options.symbol, limit)
    ) as LessonRow[]
    return rows.map((row) => ({
      lessonId: row.lesson_id,
      decisionId: row.decision_id,
      symbol: row.symbol,
      text: row.text,
      evidenceRefs: parseJsonArray(row.evidence_refs_json),
      regimeBucket: row.regime_bucket,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }))
  }
}
