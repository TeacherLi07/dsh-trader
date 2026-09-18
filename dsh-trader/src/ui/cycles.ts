/**
 * 周期台账的只读投影（docs/ui-design.md §3.1 / S3）。
 *
 * 当前数据库没有额外的 cycle 主表；v0 以一条 decisions 记录作为一个可追溯周期根，
 * 再通过 decision_id / plan_id / context_hash 连接已有计划、执行、结算与审计事实。
 * 这比按 agent 会话拼接更诚实：没有显式关联的事件不会被强行归入某个周期。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'

export type CycleSettlement = 'awaiting' | 'settled'

export interface CycleSummary {
  readonly cycleId: string
  readonly symbol: string
  readonly timeframe: string | null
  readonly decidedAt: number
  readonly action: string
  readonly triggerSource: string | null
  readonly planId: string | null
  readonly contextHash: string
  readonly executed: boolean
  readonly settlement: CycleSettlement
  readonly reflectionDueAt: number | null
}

export interface CycleContextSnapshot {
  readonly contextHash: string
  readonly createdAt: number
  readonly symbol: string | null
  readonly partHashes: unknown
  readonly changedParts: unknown
  readonly charCounts: unknown
  readonly overflow: unknown
}

export interface CycleOrderIntent {
  readonly intentId: string
  readonly clientOrderId: string
  readonly venue: string
  readonly symbol: string
  readonly state: string
  readonly type: string | null
  readonly side: string | null
  readonly qty: number | null
  readonly price: number | null
  readonly reduceOnly: boolean
  readonly createdAt: number
  readonly ackedAt: number | null
  readonly exchangeOrderId: string | null
  readonly orders: readonly CycleOrder[]
}

export interface CycleOrder {
  readonly orderId: string
  readonly status: string
  readonly qty: number | null
  readonly filledQty: number
  readonly avgPrice: number | null
  readonly updatedAt: number
}

export interface CycleFill {
  readonly fillId: string
  readonly orderId: string | null
  readonly qty: number
  readonly price: number
  readonly fee: number | null
  readonly feeCurrency: string | null
  readonly ts: number
}

export interface CycleOutcome {
  readonly outcomeId: string
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
  readonly evidenceRefs: unknown
}

export interface CycleLesson {
  readonly lessonId: string
  readonly text: string
  readonly evidenceRefs: unknown
  readonly regimeBucket: string | null
  readonly createdAt: number
  readonly expiresAt: number | null
}

export interface CycleAuditEvent {
  readonly seq: number
  readonly ts: number
  readonly actor: string
  readonly kind: string
  readonly payload: unknown
}

export interface CycleDetail extends CycleSummary {
  readonly sizeQty: number | null
  readonly stopPrice: number | null
  readonly takeProfit: number | null
  readonly confidence: number | null
  readonly rationale: string | null
  readonly modelRoute: string | null
  readonly context: CycleContextSnapshot | null
  readonly plan: unknown | null
  readonly orders: readonly CycleOrderIntent[]
  readonly fills: readonly CycleFill[]
  readonly outcome: CycleOutcome | null
  readonly lesson: CycleLesson | null
  readonly audit: readonly CycleAuditEvent[]
}

interface DecisionRow {
  decision_id: string
  symbol: string
  timeframe: string | null
  plan_id: string | null
  decided_at: number
  context_hash: string
  action: string
  size_qty: number | null
  stop_price: number | null
  take_profit: number | null
  confidence: number | null
  rationale: string | null
  model_route: string | null
  executed: number
  reflection_due_at: number | null
  outcome_id: string | null
  trigger_source: string | null
}

interface ContextRow {
  ctx_hash: string
  created_at: number
  symbol: string | null
  part_hashes_json: string
  changed_parts_json: string
  char_counts_json: string
  overflow_json: string
}

interface IntentRow {
  intent_id: string
  client_order_id: string
  venue: string
  symbol: string
  state: string
  type: string | null
  side: string | null
  qty: number | null
  price: number | null
  reduce_only: number
  created_at: number
  acked_at: number | null
  exchange_order_id: string | null
}

interface OrderRow {
  order_id: string
  client_order_id: string
  status: string
  qty: number | null
  filled_qty: number
  avg_price: number | null
  updated_at: number
}

interface FillRow {
  fill_id: string
  order_id: string | null
  qty: number
  price: number
  fee: number | null
  fee_ccy: string | null
  ts: number
}

interface OutcomeRow {
  outcome_id: string
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

interface LessonRow {
  lesson_id: string
  text: string
  evidence_refs_json: string
  regime_bucket: string | null
  created_at: number
  expires_at: number | null
}

interface AuditRow {
  seq: number
  ts: number
  actor: string
  kind: string
  payload_json: string
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function rowToSummary(row: DecisionRow): CycleSummary {
  return {
    cycleId: row.decision_id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    decidedAt: row.decided_at,
    action: row.action,
    triggerSource: row.trigger_source,
    planId: row.plan_id,
    contextHash: row.context_hash,
    executed: row.executed === 1,
    settlement: row.outcome_id === null ? 'awaiting' : 'settled',
    reflectionDueAt: row.reflection_due_at,
  }
}

function readDecision(statements: Statements, cycleId: string): DecisionRow | undefined {
  return statements
    .get(
      `SELECT decision_id, symbol, timeframe, plan_id, decided_at, context_hash, action,
              size_qty, stop_price, take_profit, confidence, rationale, model_route,
              executed, reflection_due_at, outcome_id, trigger_source
       FROM decisions WHERE decision_id = ?`,
    )
    .get(cycleId) as DecisionRow | undefined
}

function readContext(statements: Statements, contextHash: string): CycleContextSnapshot | null {
  const row = statements
    .get(
      `SELECT ctx_hash, created_at, symbol, part_hashes_json, changed_parts_json,
              char_counts_json, overflow_json
       FROM context_snapshots WHERE ctx_hash = ?`,
    )
    .get(contextHash) as ContextRow | undefined
  if (row === undefined) return null
  return {
    contextHash: row.ctx_hash,
    createdAt: row.created_at,
    symbol: row.symbol,
    partHashes: parseJson(row.part_hashes_json),
    changedParts: parseJson(row.changed_parts_json),
    charCounts: parseJson(row.char_counts_json),
    overflow: parseJson(row.overflow_json),
  }
}

function readPlan(statements: Statements, planId: string | null): unknown | null {
  if (planId === null) return null
  const row = statements.get('SELECT card_json FROM plan_cards WHERE plan_id = ?').get(planId) as
    | { card_json: string }
    | undefined
  return row === undefined ? null : parseJson(row.card_json)
}

function readOrders(statements: Statements, cycleId: string): readonly CycleOrderIntent[] {
  const intents = statements
    .get(
      `SELECT intent_id, client_order_id, venue, symbol, state, type, side, qty, price,
              reduce_only, created_at, acked_at, exchange_order_id
       FROM order_intents WHERE decision_id = ? ORDER BY created_at ASC, intent_id ASC`,
    )
    .all(cycleId) as IntentRow[]
  const orders = statements
    .get(
      `SELECT order_id, client_order_id, status, qty, filled_qty, avg_price, updated_at
       FROM orders WHERE client_order_id IN (
         SELECT client_order_id FROM order_intents WHERE decision_id = ?
       ) ORDER BY updated_at ASC, order_id ASC`,
    )
    .all(cycleId) as OrderRow[]
  const byClientId = new Map<string, CycleOrder[]>()
  for (const order of orders) {
    const list = byClientId.get(order.client_order_id) ?? []
    list.push({
      orderId: order.order_id,
      status: order.status,
      qty: order.qty,
      filledQty: order.filled_qty,
      avgPrice: order.avg_price,
      updatedAt: order.updated_at,
    })
    byClientId.set(order.client_order_id, list)
  }
  return intents.map((intent) => ({
    intentId: intent.intent_id,
    clientOrderId: intent.client_order_id,
    venue: intent.venue,
    symbol: intent.symbol,
    state: intent.state,
    type: intent.type,
    side: intent.side,
    qty: intent.qty,
    price: intent.price,
    reduceOnly: intent.reduce_only === 1,
    createdAt: intent.created_at,
    ackedAt: intent.acked_at,
    exchangeOrderId: intent.exchange_order_id,
    orders: byClientId.get(intent.client_order_id) ?? [],
  }))
}

function readFills(statements: Statements, cycleId: string): readonly CycleFill[] {
  const rows = statements
    .get(
      `SELECT f.fill_id, f.order_id, f.qty, f.price, f.fee, f.fee_ccy, f.ts
       FROM fills f
       JOIN orders o ON o.order_id = f.order_id
       JOIN order_intents i ON i.client_order_id = o.client_order_id
       WHERE i.decision_id = ? ORDER BY f.ts ASC, f.fill_id ASC`,
    )
    .all(cycleId) as FillRow[]
  return rows.map((row) => ({
    fillId: row.fill_id,
    orderId: row.order_id,
    qty: row.qty,
    price: row.price,
    fee: row.fee,
    feeCurrency: row.fee_ccy,
    ts: row.ts,
  }))
}

function readOutcome(statements: Statements, cycleId: string): CycleOutcome | null {
  const row = statements
    .get(
      `SELECT outcome_id, settled_at, horizon_ms, entry_price, exit_price, realized_gross_pct,
              realized_net_pct, benchmark_pct, alpha_pct, mfe_pct, mae_pct, stop_hit,
              fees_quote, evidence_refs_json
       FROM outcomes WHERE decision_id = ?`,
    )
    .get(cycleId) as OutcomeRow | undefined
  if (row === undefined) return null
  return {
    outcomeId: row.outcome_id,
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
    evidenceRefs: parseJson(row.evidence_refs_json),
  }
}

function readLesson(statements: Statements, cycleId: string): CycleLesson | null {
  const row = statements
    .get(
      `SELECT lesson_id, text, evidence_refs_json, regime_bucket, created_at, expires_at
       FROM lessons WHERE decision_id = ?`,
    )
    .get(cycleId) as LessonRow | undefined
  if (row === undefined) return null
  return {
    lessonId: row.lesson_id,
    text: row.text,
    evidenceRefs: parseJson(row.evidence_refs_json),
    regimeBucket: row.regime_bucket,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function containsReference(value: unknown, references: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return references.has(value)
  if (Array.isArray(value)) return value.some((item) => containsReference(item, references))
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) => containsReference(item, references))
  }
  return false
}

function readAudit(statements: Statements, summary: CycleSummary): readonly CycleAuditEvent[] {
  const references = new Set<string>([summary.cycleId, summary.contextHash])
  if (summary.planId !== null) references.add(summary.planId)
  const rows = statements
    .get('SELECT seq, ts, actor, kind, payload_json FROM audit_events ORDER BY seq DESC LIMIT 500')
    .all() as AuditRow[]
  return rows
    .map((row) => ({ ...row, payload: parseJson(row.payload_json) }))
    .filter((row) => containsReference(row.payload, references))
    .sort((left, right) => left.seq - right.seq)
    .map((row) => ({ seq: row.seq, ts: row.ts, actor: row.actor, kind: row.kind, payload: row.payload }))
}

/** 只返回 decisions 已落库的周期，空库返回空数组而不是伪造一条“当前周期”。 */
export function readCycleList(
  input: Statements | Database.Database,
  limit = 20,
): readonly CycleSummary[] {
  const statements = input instanceof Statements ? input : new Statements(input)
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 20
  const rows = statements
    .get(
      `SELECT decision_id, symbol, timeframe, plan_id, decided_at, context_hash, action,
              size_qty, stop_price, take_profit, confidence, rationale, model_route,
              executed, reflection_due_at, outcome_id, trigger_source
       FROM decisions ORDER BY decided_at DESC, decision_id DESC LIMIT ?`,
    )
    .all(safeLimit) as DecisionRow[]
  return rows.map(rowToSummary)
}

export function readCycleDetail(
  input: Statements | Database.Database,
  cycleId: string,
): CycleDetail | undefined {
  const statements = input instanceof Statements ? input : new Statements(input)
  const row = readDecision(statements, cycleId)
  if (row === undefined) return undefined
  const summary = rowToSummary(row)
  return {
    ...summary,
    sizeQty: row.size_qty,
    stopPrice: row.stop_price,
    takeProfit: row.take_profit,
    confidence: row.confidence,
    rationale: row.rationale,
    modelRoute: row.model_route,
    context: readContext(statements, row.context_hash),
    plan: readPlan(statements, row.plan_id),
    orders: readOrders(statements, row.decision_id),
    fills: readFills(statements, row.decision_id),
    outcome: readOutcome(statements, row.decision_id),
    lesson: readLesson(statements, row.decision_id),
    audit: readAudit(statements, summary),
  }
}
