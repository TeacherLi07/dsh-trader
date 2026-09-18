/**
 * workflow 成功后的不可伪造 context token。
 *
 * 明文 token 只在 workflow 返回值中出现；SQLite 只保留 hash 与冻结 pack/result 的
 * 指纹。后续 plan_card/record_decision 接线可以用 verify() 把模型提交绑定回同一份
 * pack，失败 workflow 没有 issue() 调用，因此不会产生有效裁决上下文。
 */

import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { sha256Hex } from '../util/canonical.js'

export interface WorkflowContextRecord {
  readonly tokenHash: string
  readonly packId: string
  readonly contextHash: string
  readonly resultHash: string
  readonly symbol: string
  readonly timeframe: string
  readonly scriptVersion: string
  readonly promptVersion: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly state: 'active' | 'consumed' | 'expired'
}

interface WorkflowContextRow {
  token_hash: string
  pack_id: string
  context_hash: string
  result_hash: string
  symbol: string
  timeframe: string
  script_version: string
  prompt_version: string
  created_at: number
  expires_at: number
  state: 'active' | 'consumed' | 'expired'
}

export interface IssueWorkflowContextInput {
  readonly packId: string
  readonly contextHash: string
  readonly resultHash: string
  readonly symbol: string
  readonly timeframe: string
  readonly scriptVersion: string
  readonly promptVersion: string
  readonly createdAt: number
  readonly ttlMs?: number
}

export interface IssuedWorkflowContext {
  readonly token: string
  readonly record: WorkflowContextRecord
}

export class WorkflowContextStore {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  issue(input: IssueWorkflowContextInput): IssuedWorkflowContext {
    if (!Number.isFinite(input.createdAt)) throw new Error('workflow context createdAt 必须是有限时间戳')
    const ttlMs = input.ttlMs ?? 15 * 60_000
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('workflow context ttlMs 必须是正有限数')

    const token = randomBytes(32).toString('hex')
    const tokenHash = `sha256:${sha256Hex(token)}`
    const expiresAt = input.createdAt + ttlMs
    this.#statements
      .get(
        `INSERT INTO workflow_contexts
           (token_hash, pack_id, context_hash, result_hash, symbol, timeframe,
            script_version, prompt_version, created_at, expires_at, state)
         VALUES
           (@tokenHash, @packId, @contextHash, @resultHash, @symbol, @timeframe,
            @scriptVersion, @promptVersion, @createdAt, @expiresAt, 'active')`,
      )
      .run({
        tokenHash,
        packId: input.packId,
        contextHash: input.contextHash,
        resultHash: input.resultHash,
        symbol: input.symbol,
        timeframe: input.timeframe,
        scriptVersion: input.scriptVersion,
        promptVersion: input.promptVersion,
        createdAt: input.createdAt,
        expiresAt,
      })
    const record: WorkflowContextRecord = {
      tokenHash,
      packId: input.packId,
      contextHash: input.contextHash,
      resultHash: input.resultHash,
      symbol: input.symbol,
      timeframe: input.timeframe,
      scriptVersion: input.scriptVersion,
      promptVersion: input.promptVersion,
      createdAt: input.createdAt,
      expiresAt,
      state: 'active',
    }
    return { token, record }
  }

  /** 校验 token 及其绑定上下文；过期/消费过的 token 一律返回 undefined。 */
  verify(
    token: string,
    now: number,
    expected?: { readonly symbol?: string; readonly timeframe?: string; readonly contextHash?: string },
  ): WorkflowContextRecord | undefined {
    this.#statements
      .get("UPDATE workflow_contexts SET state = 'expired' WHERE state = 'active' AND expires_at <= ?")
      .run(now)
    const row = this.#statements
      .get('SELECT * FROM workflow_contexts WHERE token_hash = ?')
      .get(`sha256:${sha256Hex(token)}`) as WorkflowContextRow | undefined
    if (row === undefined || row.state !== 'active' || row.expires_at <= now) return undefined
    if (expected?.symbol !== undefined && expected.symbol !== row.symbol) return undefined
    if (expected?.timeframe !== undefined && expected.timeframe !== row.timeframe) return undefined
    if (expected?.contextHash !== undefined && expected.contextHash !== row.context_hash) return undefined
    return toRecord(row)
  }

  /** 单次消费：只有仍 active 且未过期的 token 能从 active 原子推进为 consumed。 */
  consume(token: string, now: number): boolean {
    const tokenHash = `sha256:${sha256Hex(token)}`
    const result = this.#statements
      .get(
        `UPDATE workflow_contexts
         SET state = 'consumed'
         WHERE token_hash = ? AND state = 'active' AND expires_at > ?`,
      )
      .run(tokenHash, now)
    return Number(result.changes) === 1
  }

  expire(now: number): number {
    const result = this.#statements
      .get("UPDATE workflow_contexts SET state = 'expired' WHERE state = 'active' AND expires_at <= ?")
      .run(now)
    return Number(result.changes)
  }
}

function toRecord(row: WorkflowContextRow): WorkflowContextRecord {
  return {
    tokenHash: row.token_hash,
    packId: row.pack_id,
    contextHash: row.context_hash,
    resultHash: row.result_hash,
    symbol: row.symbol,
    timeframe: row.timeframe,
    scriptVersion: row.script_version,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    state: row.state,
  }
}
