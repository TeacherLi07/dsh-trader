/**
 * DecisionContext 的唯一持久化入口。
 *
 * DB 保存完整 canonical context，而不是只存 hash。hash 是索引和审计锚点，全文才足以在
 * 未来复算模型实际看到的事实；重复写入由 context_hash 唯一键幂等处理。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import {
  assertDecisionContext,
  canonicalDecisionContext,
  freezeDecisionContext,
  type DecisionContext,
  type DecisionContextInput,
} from './decision-context.js'

export interface DecisionContextRecord {
  readonly contextId: string
  readonly contextHash: string
  readonly symbol: string
  readonly primaryTimeframe: '1h'
  readonly asOf: number
  readonly createdAt: number
  readonly canonicalJson: string | null
  readonly contentRef: string | null
  readonly context: DecisionContext | null
}

interface ContextRow {
  context_id: string
  context_hash: string
  symbol: string
  primary_timeframe: '1h'
  as_of: number
  canonical_json: string | null
  content_ref: string | null
  created_at: number
}

export interface RecordContextOptions {
  readonly createdAt?: number
  /** 大对象可改存外部不可变内容指针；本地判断默认必须保存全文。 */
  readonly contentRef?: string
}

export interface RecordContextResult {
  readonly inserted: boolean
  readonly record: DecisionContextRecord
}

export class DecisionContextStore {
  readonly #statements: Statements

  constructor(db: Database.Database) {
    this.#statements = new Statements(db)
  }

  record(input: DecisionContext | DecisionContextInput, options: RecordContextOptions = {}): RecordContextResult {
    const context = 'contextHash' in input ? input : freezeDecisionContext(input)
    assertDecisionContext(context)
    const contentRef = options.contentRef ?? null
    const canonical = contentRef === null ? canonicalDecisionContext(context) : null
    if (canonical === null && (contentRef === null || contentRef.trim() === '')) throw new Error('contentRef 不能为空')
    const createdAt = options.createdAt ?? context.asOf
    if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error('createdAt 必须是非负有限毫秒时间戳')

    const result = this.#statements
      .get(
        `INSERT INTO decision_contexts
           (context_id, context_hash, symbol, primary_timeframe, as_of, canonical_json, content_ref, created_at)
         VALUES (@contextId, @contextHash, @symbol, @primaryTimeframe, @asOf, @canonicalJson, @contentRef, @createdAt)
         ON CONFLICT (context_hash) DO NOTHING`,
      )
      .run({
        contextId: context.contextId,
        contextHash: context.contextHash,
        symbol: context.symbol,
        primaryTimeframe: context.primaryTimeframe,
        asOf: context.asOf,
        canonicalJson: canonical,
        contentRef,
        createdAt,
      })
    const record = this.getByHash(context.contextHash)
    if (record === undefined) throw new Error(`DecisionContext 写入后无法读回：${context.contextHash}`)
    return { inserted: Number(result.changes) > 0, record }
  }

  get(contextId: string): DecisionContextRecord | undefined {
    const row = this.#statements.get('SELECT * FROM decision_contexts WHERE context_id = ?').get(contextId) as
      | ContextRow
      | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  getByHash(contextHash: string): DecisionContextRecord | undefined {
    const row = this.#statements.get('SELECT * FROM decision_contexts WHERE context_hash = ?').get(contextHash) as
      | ContextRow
      | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  latest(symbol: string): DecisionContextRecord | undefined {
    const row = this.#statements
      .get('SELECT * FROM decision_contexts WHERE symbol = ? ORDER BY created_at DESC, context_id DESC LIMIT 1')
      .get(symbol) as ContextRow | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  count(): number {
    return (this.#statements.get('SELECT COUNT(*) AS n FROM decision_contexts').get() as { n: number }).n
  }
}

function toRecord(row: ContextRow): DecisionContextRecord {
  let context: DecisionContext | null = null
  if (row.canonical_json !== null) {
    const parsed = JSON.parse(row.canonical_json) as DecisionContext
    assertDecisionContext(parsed)
    context = parsed
  }
  return {
    contextId: row.context_id,
    contextHash: row.context_hash,
    symbol: row.symbol,
    primaryTimeframe: row.primary_timeframe,
    asOf: row.as_of,
    createdAt: row.created_at,
    canonicalJson: row.canonical_json,
    contentRef: row.content_ref,
    context,
  }
}
