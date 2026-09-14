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
import { fingerprint } from '../util/canonical.js'
import type { ActionKind } from '../plan/schema.js'

export interface DecisionRecord {
  readonly decisionId: string
  readonly symbol: string
  readonly planId?: string
  readonly decidedAt: number
  readonly contextHash: string
  readonly action: ActionKind
  readonly sizeQty?: number
  readonly stopPrice?: number
  readonly takeProfit?: number
  readonly rationale?: string
  readonly modelRoute?: string
  readonly executed: boolean
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

export class DecisionJournal {
  constructor(private readonly db: Database.Database) {}

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
    const result = this.db
      .prepare(
        `INSERT INTO decisions
           (decision_id, content_hash, symbol, plan_id, decided_at, context_hash, action,
            size_qty, stop_price, take_profit, rationale, model_route, executed)
         VALUES
           (@decisionId, @contentHash, @symbol, @planId, @decidedAt, @contextHash, @action,
            @sizeQty, @stopPrice, @takeProfit, @rationale, @modelRoute, @executed)
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
      })
    return Number(result.changes) > 0
  }

  recordIntent(intent: OrderIntentRecord): boolean {
    const result = this.db
      .prepare(
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
    const result = this.db
      .prepare(
        `INSERT INTO orders
           (order_id, venue, exchange_order_id, client_order_id, symbol, status, qty, filled_qty, avg_price, updated_at)
         VALUES
           (@orderId, @venue, @exchangeOrderId, @clientOrderId, @symbol, @status, @qty, @filledQty, @avgPrice, @updatedAt)
         ON CONFLICT (order_id) DO NOTHING`,
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
    const result = this.db
      .prepare(
        `INSERT INTO fills (fill_id, order_id, qty, price, fee, fee_ccy, ts)
         VALUES (@fillId, @orderId, @qty, @price, @fee, @feeCurrency, @ts)
         ON CONFLICT (fill_id) DO NOTHING`,
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
    return (this.db.prepare('SELECT decision_id AS id FROM decisions ORDER BY decision_id').all() as {
      id: string
    }[]).map((row) => row.id)
  }

  intentIds(): readonly string[] {
    return (this.db.prepare('SELECT intent_id AS id FROM order_intents ORDER BY intent_id').all() as {
      id: string
    }[]).map((row) => row.id)
  }

  clientOrderIds(): readonly string[] {
    return (
      this.db
        .prepare('SELECT client_order_id AS id FROM order_intents ORDER BY client_order_id')
        .all() as { id: string }[]
    ).map((row) => row.id)
  }

  fillIds(): readonly string[] {
    return (this.db.prepare('SELECT fill_id AS id FROM fills ORDER BY fill_id').all() as {
      id: string
    }[]).map((row) => row.id)
  }

  triggerKeys(): readonly string[] {
    return (
      this.db.prepare('SELECT dedup_key AS id FROM triggers ORDER BY dedup_key').all() as {
        id: string
      }[]
    ).map((row) => row.id)
  }

  /** 重复的 `client_order_id` 数（唯一约束下应恒为 0）—— 回放验收的一条硬指标。 */
  duplicateClientOrderIds(): number {
    const row = this.db
      .prepare(
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
      this.db.prepare('SELECT 1 AS x FROM order_intents WHERE client_order_id = ?').get(clientOrderId) !==
      undefined
    )
  }
}
