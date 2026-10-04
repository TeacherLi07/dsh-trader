/** 停止 profile 后的费用核销；人工账单只证明费用，不能恢复模型输出或交易授权。 */
import type Database from 'better-sqlite3'
import type { Clock } from '../clock.js'
import { dayKey, type LedgerEntry } from '../cost-ledger.js'
import { Statements } from '../db/statements.js'
import { DecisionJournal } from '../exec/journal.js'
import { canonicalJson, fingerprint } from '../util/canonical.js'
import { redactDecisionErrorText } from './decision-redaction.js'

export interface ModelBillingReceipt {
  readonly version: 1
  readonly callAttemptId: string
  readonly runId: string
  readonly requestHash: string
  readonly provider: string
  readonly model: string
  readonly clientRequestId: string
  readonly providerResponseId: string | null
  readonly outcome: 'charged' | 'not_accepted'
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number; readonly tokensCached: number }
  readonly costUsd: number
  readonly evidence: { readonly receiptId: string; readonly source: string; readonly sha256: string; readonly observedAt: number }
}

export interface ModelReconciliationPlan {
  readonly callAttemptId: string
  readonly runId: string
  readonly requestHash: string
  readonly stage: string
  readonly receiptHash: string
  readonly planHash: string
  readonly auditTail: string | null
  readonly originalEntries: readonly LedgerEntry[]
  readonly replacementEntries: readonly LedgerEntry[]
  readonly before: readonly LedgerEntry[]
  readonly after: readonly LedgerEntry[]
  readonly alreadyApplied: boolean
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function requireKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) {
    throw new Error('账单凭据字段不完整或包含未知字段')
  }
}
function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function amount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value)
}
function positiveUsage(value: unknown): boolean {
  return record(value) && Object.values(value).some(count => typeof count === 'number' && Number.isFinite(count) && count > 0)
}

/** 严格白名单避免把原始 provider 导出中的凭据混入审计。 */
export function parseModelBillingReceipt(value: unknown): ModelBillingReceipt {
  requireKeys(value, ['version', 'callAttemptId', 'runId', 'requestHash', 'provider', 'model',
    'clientRequestId', 'providerResponseId', 'outcome', 'usage', 'costUsd', 'evidence'])
  if (value['version'] !== 1 || !['callAttemptId', 'runId', 'provider', 'model', 'clientRequestId'].every(key => identifier(value[key])) ||
      typeof value['requestHash'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value['requestHash']) ||
      (value['providerResponseId'] !== null && !identifier(value['providerResponseId'])) ||
      (value['outcome'] !== 'charged' && value['outcome'] !== 'not_accepted') || !amount(value['costUsd'])) {
    throw new Error('账单身份、结论或 USD 金额无效')
  }
  const usage = value['usage']
  requireKeys(usage, ['tokensIn', 'tokensOut', 'tokensCached'])
  if (!tokenCount(usage['tokensIn']) || !tokenCount(usage['tokensOut']) || !tokenCount(usage['tokensCached']) ||
      usage['tokensCached'] > usage['tokensIn'] || !Number.isSafeInteger(usage['tokensIn'] + usage['tokensOut'])) {
    throw new Error('账单 usage 无效')
  }
  const total = usage['tokensIn'] + usage['tokensOut']
  if ((value['outcome'] === 'not_accepted' && (total !== 0 || value['costUsd'] !== 0)) ||
      (value['outcome'] === 'charged' && total === 0)) throw new Error('账单结论与费用或非空 usage 不一致')
  const evidence = value['evidence']
  requireKeys(evidence, ['receiptId', 'source', 'sha256', 'observedAt'])
  if (!identifier(evidence['receiptId']) || typeof evidence['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(evidence['sha256']) ||
      !tokenCount(evidence['observedAt']) || typeof evidence['source'] !== 'string' || evidence['source'].length > 2_000) {
    throw new Error('账单证据元数据无效')
  }
  let source: URL
  try { source = new URL(evidence['source']) } catch { throw new Error('账单来源必须是 HTTPS URL') }
  if (source.protocol !== 'https:' || source.username || source.password || source.search || source.hash) {
    throw new Error('账单来源必须是无凭据和查询参数的 HTTPS URL')
  }
  return value as unknown as ModelBillingReceipt
}

interface AuditRow { seq: number; ts: number; actor: string; kind: string; payload_json: string; prev_hash: string | null; hash: string }
function auditRows(statements: Statements): readonly (AuditRow & { payload: Record<string, unknown> })[] {
  // 冷路径先核验完整链，避免根据局部、被换绑的账单记录释放全局阻塞。
  const rows = statements.get('SELECT * FROM audit_events ORDER BY seq LIMIT 50001').all() as AuditRow[]
  if (rows.length > 50_000) throw new Error('审计链超过核销检查上限，拒绝截断后核销')
  let prior: string | null = null
  return rows.map(row => {
    const payload: unknown = JSON.parse(row.payload_json)
    if (row.prev_hash !== prior || fingerprint({ prevHash: prior, ts: row.ts, actor: row.actor, kind: row.kind, payload }) !== row.hash) {
      throw new Error('审计哈希链损坏，不能核销模型费用')
    }
    prior = row.hash
    return { ...row, payload: record(payload) ? payload : {} }
  })
}
function entries(value: unknown): readonly LedgerEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('费用审计缺少账本归因条目')
  const seen = new Set<string>()
  for (const item of value) {
    if (!record(item) || typeof item['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item['day']) ||
        typeof item['scope'] !== 'string' || !tokenCount(item['tokensIn']) || !tokenCount(item['tokensOut']) ||
        !tokenCount(item['tokensCached']) || item['tokensCached'] > item['tokensIn'] ||
        !amount(item['estUsd']) || typeof item['costKnown'] !== 'boolean') throw new Error('费用账本归因无效')
    const key = item['day'] + '/' + item['scope']
    if (seen.has(key)) throw new Error('费用账本归因重复')
    seen.add(key)
  }
  return value as LedgerEntry[]
}
function aggregate(calls: ReadonlyMap<string, readonly LedgerEntry[]>, day: string, scopes: readonly string[]): LedgerEntry[] {
  return scopes.map(scope => {
    const selected = [...calls.values()].flatMap(items => items.filter(item => item.day === day && item.scope === scope))
    return { day, scope, tokensIn: selected.reduce((n, e) => n + e.tokensIn, 0),
      tokensOut: selected.reduce((n, e) => n + e.tokensOut, 0),
      tokensCached: selected.reduce((n, e) => n + e.tokensCached, 0),
      estUsd: selected.reduce((n, e) => n + e.estUsd, 0), costKnown: selected.every(e => e.costKnown) }
  })
}
function sameLedger(actual: LedgerEntry, expected: LedgerEntry): boolean {
  return actual.tokensIn === expected.tokensIn && actual.tokensOut === expected.tokensOut &&
    actual.tokensCached === expected.tokensCached && actual.costKnown === expected.costKnown &&
    Math.abs(actual.estUsd - expected.estUsd) <= 1e-12 * Math.max(1, actual.estUsd, expected.estUsd)
}

function savedReconciliation(statements: Statements, row: { payload: Record<string, unknown> }): ModelReconciliationPlan {
  const stored = statements.get('SELECT receipt_hash, receipt_json, plan_json FROM model_call_reconciliations WHERE call_attempt_id = ?')
    .get(row.payload['callAttemptId']) as { receipt_hash: string; receipt_json: string; plan_json: string } | undefined
  if (stored === undefined) throw new Error('核销审计没有匹配的不可变账单记录')
  const receipt = parseModelBillingReceipt(JSON.parse(stored.receipt_json) as unknown)
  const saved = JSON.parse(stored.plan_json) as ModelReconciliationPlan
  const { planHash, alreadyApplied: _alreadyApplied, ...hashInput } = saved
  if (fingerprint(receipt) !== stored.receipt_hash || row.payload['receiptHash'] !== stored.receipt_hash ||
      saved.receiptHash !== stored.receipt_hash || fingerprint(hashInput) !== planHash ||
      row.payload['planHash'] !== planHash ||
      ['callAttemptId', 'runId', 'requestHash', 'stage'].some(key => row.payload[key] !== (saved as unknown as Record<string, unknown>)[key]) ||
      fingerprint(row.payload['ledgerEntries']) !== fingerprint(saved.replacementEntries)) {
    throw new Error('核销审计、预览与账单记录不匹配')
  }
  return saved
}

/** 查看不写库；完整聚合对不上或历史缺少原子记账凭据时不猜测差额。 */
export function inspectModelReconciliation(db: Database.Database, receiptValue: unknown, now: number): ModelReconciliationPlan {
  const receipt = parseModelBillingReceipt(receiptValue)
  if (!tokenCount(now) || receipt.evidence.observedAt > now) throw new Error('账单证据时间不可用或晚于核销时刻')
  const statements = new Statements(db)
  const rows = auditRows(statements)
  const prior = statements.get('SELECT receipt_hash, plan_json FROM model_call_reconciliations WHERE call_attempt_id = ?')
    .get(receipt.callAttemptId) as { receipt_hash: string; plan_json: string } | undefined
  const receiptHash = fingerprint(receipt)
  if (prior !== undefined) {
    if (prior.receipt_hash !== receiptHash) throw new Error('该调用已核销，拒绝不同账单覆盖')
    const events = rows.filter(row => row.kind === 'model_call_reconciled' && row.payload['callAttemptId'] === receipt.callAttemptId)
    if (events.length !== 1) throw new Error('已核销账单缺少唯一核销审计')
    const saved = savedReconciliation(statements, events[0]!)
    return { ...saved, alreadyApplied: true }
  }
  const reserved = rows.filter(row => row.kind === 'model_call_reserved' && row.payload['callAttemptId'] === receipt.callAttemptId)
  if (reserved.length !== 1) throw new Error('账单无法唯一对应持久 reservation')
  const original = reserved[0]!.payload
  if (receipt.evidence.observedAt < reserved[0]!.ts) throw new Error('账单证据早于模型请求，保留未决')
  if (original['accountingVersion'] !== 1 || original['clientRequestId'] !== receipt.callAttemptId ||
      receipt.clientRequestId !== receipt.callAttemptId) throw new Error('历史调用缺少单次请求关联或原子记账凭据，保留未决')
  if (!['strategist', 'risk-critic'].includes(String(original['stage'])) ||
      original['reservedDay'] !== dayKey(reserved[0]!.ts)) throw new Error('reservation 阶段或归属日无效')
  for (const key of ['runId', 'requestHash', 'provider', 'model', 'clientRequestId'] as const) {
    if (receipt[key] !== original[key]) throw new Error('账单与 reservation 身份不匹配')
  }
  const run = statements.get('SELECT status, symbol, final_json FROM decision_runs WHERE run_id = ?').get(receipt.runId) as
    { status: string; symbol: string; final_json: string | null } | undefined
  if (run === undefined || run.status === 'running') throw new Error('只有已终结的 run 才能核销，禁止处理仍在运行的请求')
  const scopes = ['global', 'symbol:' + run.symbol]
  if (fingerprint(original['scopes']) !== fingerprint(scopes)) throw new Error('reservation 账本 scopes 不完整')
  const accounting = rows.filter(row => ['model_call_accounted', 'model_call_unresolved', 'model_call_failed'].includes(row.kind) &&
    row.payload['callAttemptId'] === receipt.callAttemptId)
  if (accounting.length > 1 || accounting.some(row => row.kind !== 'model_call_unresolved')) {
    throw new Error('只允许核销尚未确认费用的调用，不能替代 stage 恢复')
  }
  const call = accounting[0]?.payload
  if (call !== undefined && (call['accountingVersion'] !== 1 || call['clientRequestId'] !== receipt.clientRequestId ||
      call['ledgerDay'] !== dayKey(accounting[0]!.ts) ||
      ['runId', 'requestHash', 'provider', 'model', 'stage'].some(key => call[key] !== original[key]))) throw new Error('模型费用凭据与 reservation 不匹配')
  if (call?.['providerResponseId'] != null && call['providerResponseId'] !== receipt.providerResponseId) throw new Error('上游 response ID 不匹配')
  const trace = call?.['response']
  const response = record(trace) ? trace['response'] : undefined
  const final: unknown = run.final_json === null ? null : JSON.parse(run.final_json)
  const workflow = record(final) ? final['workflow'] : undefined
  const savedCalls = record(workflow) && Array.isArray(workflow['calls']) ? workflow['calls'] : []
  const generated = call?.['providerResponseId'] != null || (record(trace) && 'structuredOutput' in trace) ||
    (record(response) && ((Array.isArray(response['parts']) && response['parts'].length > 0) || positiveUsage(response['reportedUsage']))) ||
    savedCalls.some(item => record(item) && item['requestHash'] === receipt.requestHash && positiveUsage(item['usage']))
  if (receipt.outcome === 'not_accepted' && generated) throw new Error('未受理账单与已观察到的模型生成或 usage 矛盾，保留未决')
  const originalEntries = call === undefined ? [] : entries(call['ledgerEntries'])
  const day = call?.['ledgerDay'] ?? original['reservedDay']
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      (call !== undefined && fingerprint(originalEntries.map(e => e.scope)) !== fingerprint(scopes)) ||
      originalEntries.some(e => e.day !== day)) throw new Error('费用归属日或 scopes 不匹配')
  const calls = new Map<string, readonly LedgerEntry[]>()
  for (const row of rows) {
    if (!['model_call_accounted', 'model_call_unresolved', 'model_call_failed', 'model_call_reconciled'].includes(row.kind)) continue
    const payload = row.payload
    const relevant = payload['ledgerDay'] === day || dayKey(row.ts) === day
    if (!relevant) continue
    if (payload['accountingVersion'] !== 1 || typeof payload['callAttemptId'] !== 'string') {
      throw new Error('该日存在无法归因的历史模型费用，不能核销聚合账本')
    }
    const attributed = entries(payload['ledgerEntries'])
    const id = payload['callAttemptId']
    if (row.kind !== 'model_call_reconciled' && calls.has(id)) throw new Error('同一调用出现重复费用归因')
    if (row.kind === 'model_call_reconciled') savedReconciliation(statements, row)
    calls.set(id, attributed)
  }
  const before = aggregate(calls, day, scopes)
  for (const expected of before) {
    const stored = statements.get('SELECT * FROM budget_ledger WHERE day = ? AND scope = ?').get(day, expected.scope) as
      { tokens_in: number; tokens_out: number; tokens_cached: number; est_usd: number; cost_known: number } | undefined
    const actual = stored === undefined ? { ...expected, tokensIn: 0, tokensOut: 0, tokensCached: 0, estUsd: 0, costKnown: true } :
      { day, scope: expected.scope, tokensIn: stored.tokens_in, tokensOut: stored.tokens_out, tokensCached: stored.tokens_cached,
        estUsd: stored.est_usd, costKnown: stored.cost_known === 1 }
    if (!sameLedger(actual, expected)) throw new Error('完整模型费用审计与聚合账本不一致，保留未决')
  }
  const replacementEntries = scopes.map(scope => ({ day, scope, ...receipt.usage, estUsd: receipt.costUsd, costKnown: true }))
  calls.set(receipt.callAttemptId, replacementEntries)
  const after = aggregate(calls, day, scopes)
  if (after.some(e => !tokenCount(e.tokensIn) || !tokenCount(e.tokensOut) || !tokenCount(e.tokensCached) || !amount(e.estUsd))) {
    throw new Error('核销后账本总额越界')
  }
  const plan = { callAttemptId: receipt.callAttemptId, runId: receipt.runId, requestHash: receipt.requestHash,
    stage: String(original['stage']), receiptHash, auditTail: rows.at(-1)?.hash ?? null, originalEntries,
    replacementEntries, before, after }
  return { ...plan, planHash: fingerprint(plan), alreadyApplied: false }
}

/** 单事务提交外部凭据、聚合费用和核销审计；原 run/输出/订单不更新。 */
export function reconcileModelCall(input: {
  readonly db: Database.Database; readonly clock: Clock; readonly receipt: unknown; readonly expectedPlanHash: string; readonly reason: string
}): ModelReconciliationPlan {
  const journal = new DecisionJournal(input.db)
  try {
    const receipt = parseModelBillingReceipt(input.receipt)
    const reason = redactDecisionErrorText(input.reason).trim()
    if (reason.length === 0 || reason.length > 2_000) throw new Error('核销必须提供非空且有界的人工原因')
    return input.db.transaction(() => {
      const plan = inspectModelReconciliation(input.db, receipt, input.clock.now())
      if (plan.planHash !== input.expectedPlanHash) throw new Error('核销预览已变化，必须重新查看计划')
      if (plan.alreadyApplied) return plan
      const statements = new Statements(input.db)
      const inserted = statements.get('INSERT INTO model_call_reconciliations (call_attempt_id, provider, receipt_id, receipt_hash, receipt_json, plan_json, reason, reconciled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (call_attempt_id) DO NOTHING')
        .run(receipt.callAttemptId, receipt.provider, receipt.evidence.receiptId, plan.receiptHash, canonicalJson(receipt),
          canonicalJson(plan), reason, input.clock.now())
      if (inserted.changes !== 1) throw new Error('核销调用身份已存在，拒绝重复更新账本')
      for (const entry of plan.after) {
        statements.get('INSERT INTO budget_ledger (day, scope, tokens_in, tokens_out, tokens_cached, est_usd, cost_known) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, scope) DO UPDATE SET tokens_in=excluded.tokens_in, tokens_out=excluded.tokens_out, tokens_cached=excluded.tokens_cached, est_usd=excluded.est_usd, cost_known=excluded.cost_known')
          .run(entry.day, entry.scope, entry.tokensIn, entry.tokensOut, entry.tokensCached, entry.estUsd, entry.costKnown ? 1 : 0)
      }
      journal.appendAudit({ actor: 'human', kind: 'model_call_reconciled', ts: input.clock.now(),
        payload: { runId: receipt.runId, requestHash: receipt.requestHash, callAttemptId: receipt.callAttemptId,
          stage: plan.stage, accountingVersion: 1, ledgerDay: plan.replacementEntries[0]!.day,
          ledgerEntries: plan.replacementEntries, receiptHash: plan.receiptHash, planHash: plan.planHash,
          receiptId: receipt.evidence.receiptId, evidence: receipt.evidence, reason, originalEntries: plan.originalEntries } })
      return plan
    }).immediate()
  } catch (error) {
    // 拒绝也留证据，且审计失败不能遮盖原始核销失败。
    try { journal.appendAudit({ actor: 'human', kind: 'model_call_reconciliation_rejected', ts: input.clock.now(),
      payload: { error: redactDecisionErrorText(error instanceof Error ? error.message : String(error)).slice(0, 1_000) } }) } catch { /* 原错误继续抛出。 */ }
    throw error
  }
}
