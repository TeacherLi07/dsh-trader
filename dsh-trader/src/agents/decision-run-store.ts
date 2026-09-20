/**
 * 一轮判断的持久根（plan.md §4.1 / §6）。
 *
 * 原 workflow token 只能证明“某个短期授权存在”，不能重建草案、批评、最终裁决和成本。
 * run 改为可查询、可更新但不可换绑 context 的单行根；执行与计划卡只引用 runId。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import { canonicalJson } from '../util/canonical.js'

export type DecisionRunStatus = 'running' | 'completed' | 'review' | 'failed'

export interface DecisionRunInput {
  readonly runId: string
  readonly contextId: string
  readonly contextHash: string
  readonly symbol: string
  readonly primaryTimeframe: '1h'
  readonly triggerSource: string
  readonly modelVersion?: string
  readonly promptVersion?: string
  readonly createdAt: number
}
export interface DecisionRunPatch {
  readonly status?: DecisionRunStatus
  readonly draft?: unknown
  readonly critique?: unknown
  readonly final?: unknown
  readonly eligibility?: unknown
  readonly modelVersion?: string
  readonly promptVersion?: string
  readonly tokensIn?: number | null
  readonly tokensOut?: number | null
  readonly tokensCached?: number | null
  readonly costUsd?: number | null
  readonly costKnown?: boolean | null
  readonly durationMs?: number | null
  readonly finishedAt?: number | null
}

export interface DecisionRunRecord {
  readonly runId: string
  readonly contextId: string
  readonly contextHash: string
  readonly symbol: string
  readonly primaryTimeframe: '1h'
  readonly triggerSource: string
  readonly status: DecisionRunStatus
  readonly draft: unknown | null
  readonly critique: unknown | null
  readonly final: unknown | null
  readonly eligibility: unknown | null
  readonly modelVersion: string | null
  readonly promptVersion: string | null
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  readonly tokensCached: number | null
  readonly costUsd: number | null
  readonly costKnown: boolean | null
  readonly durationMs: number | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly finishedAt: number | null
}

interface RunRow {
  run_id: string
  context_id: string
  context_hash: string
  symbol: string
  primary_timeframe: '1h'
  trigger_source: string
  status: DecisionRunStatus
  draft_json: string | null
  critique_json: string | null
  final_json: string | null
  eligibility_json: string | null
  model_version: string | null
  prompt_version: string | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cached: number | null
  cost_usd: number | null
  cost_known: number | null
  duration_ms: number | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

export class DecisionRunStore {
  readonly #statements: Statements

  constructor(private readonly db: Database.Database) {
    this.#statements = new Statements(db)
  }

  start(input: DecisionRunInput): DecisionRunRecord {
    if (input.runId.trim() === '') throw new Error('runId 不能为空')
    if (input.contextId.trim() === '' || input.contextHash.trim() === '') throw new Error('run 必须绑定 context')
    if (input.symbol.trim() === '' || input.triggerSource.trim() === '') throw new Error('run 的 symbol/triggerSource 不能为空')
    if (!Number.isFinite(input.createdAt) || input.createdAt < 0) throw new Error('run.createdAt 必须是非负有限毫秒时间戳')
    const result = this.#statements
      .get(
        `INSERT INTO decision_runs
           (run_id, context_id, context_hash, symbol, primary_timeframe, trigger_source, status,
            model_version, prompt_version, created_at, updated_at)
         VALUES (@runId, @contextId, @contextHash, @symbol, @primaryTimeframe, @triggerSource, 'running',
                 @modelVersion, @promptVersion, @createdAt, @createdAt)
         ON CONFLICT (run_id) DO NOTHING`,
      )
      .run({
        runId: input.runId,
        contextId: input.contextId,
        contextHash: input.contextHash,
        symbol: input.symbol,
        primaryTimeframe: input.primaryTimeframe,
        triggerSource: input.triggerSource,
        modelVersion: input.modelVersion ?? null,
        promptVersion: input.promptVersion ?? null,
        createdAt: input.createdAt,
      })
    const record = this.get(input.runId)
    if (record === undefined) throw new Error(`decision run 写入后无法读回：${input.runId}`)
    if (Number(result.changes) === 0 && (record.contextHash !== input.contextHash || record.contextId !== input.contextId)) {
      throw new Error(`runId 已绑定另一份 context：${input.runId}`)
    }
    return record
  }

  update(runId: string, patch: DecisionRunPatch, now: number): DecisionRunRecord {
    const current = this.get(runId)
    if (current === undefined) throw new Error(`不存在的 decision run：${runId}`)
    if (current.status !== 'running') {
      throw new Error(`decision run 已终结（${current.status}），工件不可改写：${runId}`)
    }
    if (!Number.isFinite(now) || now < 0) throw new Error('run.updatedAt 必须是非负有限毫秒时间戳')
    const nextStatus = patch.status ?? current.status
    const result = this.#statements
      .get(
        `UPDATE decision_runs SET
           status = @status,
           draft_json = @draftJson,
           critique_json = @critiqueJson,
           final_json = @finalJson,
           eligibility_json = @eligibilityJson,
           model_version = @modelVersion,
           prompt_version = @promptVersion,
           tokens_in = @tokensIn,
           tokens_out = @tokensOut,
           tokens_cached = @tokensCached,
           cost_usd = @costUsd,
           cost_known = @costKnown,
           duration_ms = @durationMs,
           updated_at = @updatedAt,
           finished_at = @finishedAt
         WHERE run_id = @runId AND status = 'running'`,
      )
      .run({
        runId,
        status: nextStatus,
        draftJson: patch.draft === undefined ? jsonOrNull(current.draft) : canonicalJson(patch.draft),
        critiqueJson: patch.critique === undefined ? jsonOrNull(current.critique) : canonicalJson(patch.critique),
        finalJson: patch.final === undefined ? jsonOrNull(current.final) : canonicalJson(patch.final),
        eligibilityJson: patch.eligibility === undefined ? jsonOrNull(current.eligibility) : canonicalJson(patch.eligibility),
        modelVersion: patch.modelVersion ?? current.modelVersion,
        promptVersion: patch.promptVersion ?? current.promptVersion,
        tokensIn: patch.tokensIn === undefined ? current.tokensIn : patch.tokensIn,
        tokensOut: patch.tokensOut === undefined ? current.tokensOut : patch.tokensOut,
        tokensCached: patch.tokensCached === undefined ? current.tokensCached : patch.tokensCached,
        costUsd: patch.costUsd === undefined ? current.costUsd : patch.costUsd,
        costKnown: patch.costKnown === undefined ? boolOrNull(current.costKnown) : boolOrNull(patch.costKnown),
        durationMs: patch.durationMs === undefined ? current.durationMs : patch.durationMs,
        updatedAt: now,
        finishedAt: patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt,
      })
    if (Number(result.changes) !== 1) throw new Error(`decision run 更新失败：${runId}`)
    const next = this.get(runId)
    if (next === undefined) throw new Error(`decision run 更新后无法读回：${runId}`)
    return next
  }

  get(runId: string): DecisionRunRecord | undefined {
    const row = this.#statements.get('SELECT * FROM decision_runs WHERE run_id = ?').get(runId) as RunRow | undefined
    return row === undefined ? undefined : toRecord(row)
  }

  require(runId: string, binding?: { readonly symbol?: string; readonly timeframe?: string; readonly contextHash?: string }): DecisionRunRecord {
    const record = this.get(runId)
    if (record === undefined) throw new Error(`不存在的 decision run：${runId}`)
    if (binding?.symbol !== undefined && record.symbol !== binding.symbol) throw new Error('run 与 symbol 不匹配')
    if (binding?.timeframe !== undefined && record.primaryTimeframe !== binding.timeframe) throw new Error('run 与 timeframe 不匹配')
    if (binding?.contextHash !== undefined && record.contextHash !== binding.contextHash) throw new Error('run 与 contextHash 不匹配')
    return record
  }
}

function jsonOrNull(value: unknown): string | null {
  return value === null ? null : canonicalJson(value)
}

function boolOrNull(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0
}

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value) as unknown
}

function toRecord(row: RunRow): DecisionRunRecord {
  return {
    runId: row.run_id,
    contextId: row.context_id,
    contextHash: row.context_hash,
    symbol: row.symbol,
    primaryTimeframe: row.primary_timeframe,
    triggerSource: row.trigger_source,
    status: row.status,
    draft: parseJson(row.draft_json),
    critique: parseJson(row.critique_json),
    final: parseJson(row.final_json),
    eligibility: parseJson(row.eligibility_json),
    modelVersion: row.model_version,
    promptVersion: row.prompt_version,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCached: row.tokens_cached,
    costUsd: row.cost_usd,
    costKnown: row.cost_known === null ? null : row.cost_known === 1,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  }
}
