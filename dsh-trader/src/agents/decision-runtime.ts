/** R3 生产边界：冻结 R2 context、限预算调用模型、资格检查后才落卡/执行。 */

import { BudgetLedger, GLOBAL_SCOPE, PriceTableStore, dayKey, symbolScope } from '../cost-ledger.js'
import { DecisionJournal } from '../exec/journal.js'
import { executeAction } from '../exec/execute-action.js'
import type { PlanAction, PlanValidation } from '../plan/schema.js'
import { fingerprint } from '../util/canonical.js'
import type { TradePorts } from '../exec/ports.js'
import { buildDecisionContext } from './decision-context-builder.js'
import { DecisionContextStore } from './decision-context-store.js'
import { DecisionRunStore, type DecisionRunRecord } from './decision-run-store.js'
import {
  bindDecisionEnvelope,
  DECISION_ENVELOPE_SCHEMA_VERSION,
  evaluateDecisionEligibility,
  materializeDecisionPlan,
  type DecisionEnvelope,
  type EligibilityResult,
} from './decision-envelope.js'
import {
  decisionWorkflowSummary,
  DECISION_WORKFLOW_PROMPT_VERSION,
  DecisionBudgetDenied,
  runDecisionWorkflowStages,
  toLedgerUsage,
  type DecisionModel,
  type DecisionModelCall,
  type DecisionModelRoute,
  type DecisionStrategy,
  type DecisionWorkflowResume,
  type DecisionWorkflowStages,
} from './decision-workflow.js'
import type { DecisionContext } from './decision-context.js'

export interface DecisionTriggerIdentity {
  readonly source: 'W1' | 'W2' | 'W3'
  readonly id: string
  readonly at: number
  readonly attempt: number
  readonly expiresAt?: number
  readonly predictionAlias?: string
}

export interface DecisionRuntimeConfig {
  readonly strategy: DecisionStrategy
  readonly route: DecisionModelRoute
  /** Must be explicitly configured; missing/zero disables model calls. */
  readonly dailyBudgetUsd?: number
  readonly dailyTokenCap?: number
  readonly planWindowMs: number
}

export interface DecisionRuntimeResult {
  readonly runId: string
  readonly status: 'completed' | 'review' | 'failed'
  readonly replayed: boolean
  readonly retryable?: boolean
  readonly contextHash: string
  readonly envelope?: DecisionEnvelope
  readonly eligibility?: EligibilityResult
  readonly planId?: string
  readonly execution?: unknown
  readonly reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return raw.replace(/(api[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 1_000)
}

const SENSITIVE_TRACE_KEYS = new Set(['apikey', 'apisecret', 'secret', 'secretkey', 'token', 'accesstoken', 'refreshtoken', 'authorization', 'privatekey'])

/** 原始调用工件保留在 append-only 审计中，但敏感字段在持久化前递归脱敏。 */
export function sanitizeModelTrace(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[DEPTH_LIMIT]'
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(sanitizeModelTrace(JSON.parse(trimmed) as unknown, depth + 1))
      } catch { /* 原文可能是部分流片段，继续按 key/value 形式脱敏。 */ }
    }
    const jsonFieldsRedacted = value.replace(
      /((?:["']?)(?:api[_-]?key|api[_-]?secret|secret[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key)(?:["']?)\s*:\s*)"[^"\\]*(?:\\.[^"\\]*)*"/gi,
      '$1"[REDACTED]"',
    )
    return jsonFieldsRedacted
      .replace(/((?:api[_-]?key|api[_-]?secret|secret[_-]?key|secret|token|access[_-]?token|refresh[_-]?token|authorization|private[_-]?key)\s*[:=]\s*)[^\s,;}\]]+/gi, '$1[REDACTED]')
      .slice(0, 200_000)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map((item) => sanitizeModelTrace(item, depth + 1))
  if (isRecord(value)) {
    const safe: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      const normalized = key.toLowerCase().replaceAll('-', '').replaceAll('_', '')
      safe[key] = SENSITIVE_TRACE_KEYS.has(normalized) ? '[REDACTED]' : sanitizeModelTrace(item, depth + 1)
    }
    return safe
  }
  return String(value).slice(0, 1_000)
}

export function decisionRunId(input: {
  readonly trigger: DecisionTriggerIdentity
  readonly symbol: string
  readonly strategy: DecisionStrategy
  readonly route: DecisionModelRoute
  readonly promptVersion: string
  readonly schemaVersion: string
  readonly planWindowMs: number
}): string {
  return `run-${fingerprint({
    // attempt 只用于审计，不能进入身份；否则 W2/W3 的持久重试会误成新 run 而无法恢复阶段。
    trigger: {
      source: input.trigger.source,
      id: input.trigger.id,
      at: input.trigger.at,
      expiresAt: input.trigger.expiresAt ?? null,
      predictionAlias: input.trigger.predictionAlias ?? null,
    },
    symbol: input.symbol,
    strategy: input.strategy,
    promptVersion: input.promptVersion,
    schemaVersion: input.schemaVersion,
    route: { provider: input.route.provider, model: input.route.model },
    outputBudget: { maxTokens: input.route.maxTokens, maxChars: input.route.maxChars },
    planWindowMs: input.planWindowMs,
  }).slice(7)}`
}

function resumeStages(record: DecisionRunRecord): DecisionWorkflowResume {
  const draft = isRecord(record.draft) && isRecord(record.draft['candidate'])
    ? record.draft as unknown as NonNullable<DecisionWorkflowResume['draft']>
    : undefined
  const critique = isRecord(record.critique) && Array.isArray(record.critique['issues'])
    ? record.critique as unknown as NonNullable<DecisionWorkflowResume['critique']>
    : undefined
  const final = isRecord(record.final) && isRecord(record.final['candidate'])
    ? record.final as unknown as NonNullable<DecisionWorkflowResume['final']>
    : undefined
  return {
    ...(draft === undefined ? {} : { draft }),
    ...(critique === undefined ? {} : { critique }),
    ...(final === undefined ? {} : { final }),
  }
}

function failureEnvelope(context: DecisionContext, runId: string, reason: string): DecisionEnvelope {
  return {
    runId,
    contextHash: context.contextHash,
    symbol: context.symbol,
    primaryTimeframe: context.primaryTimeframe,
    outcome: 'review',
    thesis: '没有得到通过结构与证据校验的最终裁决。',
    rejectedAlternatives: [],
    claims: [],
    uncertainties: [reason],
    confidence: 0,
    riskFraction: 1,
  }
}

function latestMarketFacts(context: DecisionContext, timeframe: string): { readonly price: number; readonly atr: number | null; readonly barTs: number } | undefined {
  const market = context.sections.market.value
  if (!isRecord(market) || !isRecord(market['timeframes'])) return undefined
  const slice = market['timeframes'][timeframe]
  if (!isRecord(slice) || !Array.isArray(slice['bars']) || slice['bars'].length === 0) return undefined
  const latest = slice['bars'].at(-1)
  if (!isRecord(latest) || typeof latest['close'] !== 'number' || !Number.isFinite(latest['close']) || latest['close'] <= 0 ||
      typeof latest['openTime'] !== 'number' || !Number.isFinite(latest['openTime'])) return undefined
  const features = isRecord(slice['features']) ? slice['features'] : undefined
  const atrFact = features !== undefined && isRecord(features['atr14']) ? features['atr14'] : undefined
  const atr = atrFact?.['status'] === 'ok' && typeof atrFact['value'] === 'number' && Number.isFinite(atrFact['value'])
    ? atrFact['value']
    : null
  return { price: latest['close'], atr, barTs: latest['openTime'] }
}

function planHasOpen(envelope: DecisionEnvelope): boolean {
  return envelope.plan?.commitments.some((item) => item.then.action === 'open') === true ||
    envelope.plan?.invalidation.some((item) => item.then.action === 'open') === true
}

function isRiskReducing(action: PlanAction): boolean {
  // 保护修改是否减险仍由 executeAction 锁内的远端持仓/价格检查证明。
  if (['reduce', 'close', 'set_stop', 'set_target', 'set_trailing', 'halt', 'noop', 'escalate'].includes(action.action)) return true
  return action.action === 'cancel_all' && action.scope === 'symbol'
}

function stageArtifact(stages: DecisionWorkflowStages, stage: 'draft' | 'critique' | 'final'): unknown {
  if (stage === 'draft' && stages.draft !== undefined) return { candidate: stages.draft }
  if (stage === 'critique' && stages.critique !== undefined) return stages.critique
  if (stage === 'final' && stages.final !== undefined) return { candidate: stages.final, evidenceIssues: stages.evidenceIssues }
  return null
}

/**
 * 按 W1/W2/W3 的持久身份幂等执行。模型请求只有通过调用前预算预留才会发出。
 */
export async function runDecisionRuntime(input: {
  readonly ports: TradePorts
  readonly model: DecisionModel
  readonly config: DecisionRuntimeConfig
  readonly trigger: DecisionTriggerIdentity
  readonly symbol: string
  readonly timeframe: string
  readonly signal?: AbortSignal
}): Promise<DecisionRuntimeResult> {
  const { ports, config, trigger, symbol, timeframe, model } = input
  if (!Number.isFinite(config.planWindowMs) || config.planWindowMs <= 0) throw new Error('planWindowMs 必须为正数')
  const contextStore = new DecisionContextStore(ports.db)
  const runStore = new DecisionRunStore(ports.db)
  const journal = ports.journal
  const promptVersion = `${DECISION_WORKFLOW_PROMPT_VERSION}:${config.strategy}:schema-${DECISION_ENVELOPE_SCHEMA_VERSION}`
  const runId = decisionRunId({
    trigger, symbol, strategy: config.strategy, route: config.route,
    promptVersion, schemaVersion: DECISION_ENVELOPE_SCHEMA_VERSION, planWindowMs: config.planWindowMs,
  })
  let prior = runStore.get(runId)
  if (prior !== undefined && prior.status !== 'running') {
    return {
      runId,
      status: prior.status,
      replayed: true,
      contextHash: prior.contextHash,
      ...(isRecord(prior.final) && isRecord(prior.final['envelope']) ? { envelope: prior.final['envelope'] as unknown as DecisionEnvelope } : {}),
      ...(isRecord(prior.eligibility) && typeof prior.eligibility['state'] === 'string' ? { eligibility: prior.eligibility as unknown as EligibilityResult } : {}),
    }
  }

  let context: DecisionContext
  if (prior !== undefined) {
    const saved = contextStore.get(prior.contextId)?.context
    if (saved === null || saved === undefined) throw new Error(`running decision run 缺少冻结 context：${runId}`)
    context = saved
  } else {
    context = await buildDecisionContext(ports, symbol, timeframe, {
      ...(trigger.predictionAlias === undefined ? {} : { predictionAlias: trigger.predictionAlias }),
    })
    contextStore.record(context, { createdAt: context.asOf })
    prior = runStore.start({
      runId,
      contextId: context.contextId,
      contextHash: context.contextHash,
      symbol,
      primaryTimeframe: '1h',
      triggerSource: `${trigger.source}:${trigger.id}`,
      modelVersion: `${config.route.provider}/${config.route.model}`,
      promptVersion,
      createdAt: context.asOf,
    })
  }

  journal.appendAudit({
    actor: 'system', kind: 'decision_run_attempt_started',
    payload: {
      runId,
      trigger: {
        source: trigger.source, id: trigger.id, at: trigger.at, attempt: trigger.attempt,
        expiresAt: trigger.expiresAt ?? null, predictionAlias: trigger.predictionAlias ?? null,
      },
      strategy: config.strategy,
      provider: config.route.provider,
      model: config.route.model,
      maxOutputTokens: config.route.maxTokens,
      maxRequestChars: config.route.maxChars,
      dailyBudgetUsd: config.dailyBudgetUsd ?? null,
      dailyTokenCap: config.dailyTokenCap ?? null,
      planWindowMs: config.planWindowMs,
      contextHash: context.contextHash,
    },
    ts: ports.clock.now(),
  })

  const ledger = new BudgetLedger(ports.db)
  const prices = new PriceTableStore(ports.db)
  const reservations = new Map<string, { readonly tokens: number; readonly usd: number | null }>()
  const callStartedAt = new Map<string, number>()
  const runStartedAt = ports.clock.now()
  const priorDurationMs = prior?.durationMs ?? 0
  let cumulativeCostKnown = prior?.costKnown === false ? false : true

  const addLedgerEntry = (call: DecisionModelCall): void => {
    const reserve = reservations.get(call.requestHash) ?? { tokens: call.estimatedInputTokens + config.route.maxTokens, usd: null }
    const startedAt = callStartedAt.get(call.requestHash)
    callStartedAt.delete(call.requestHash)
    const callDurationMs = startedAt === undefined ? null : Math.max(0, ports.clock.now() - startedAt)
    const usage = call.failure === undefined ? toLedgerUsage(call.usage) : null
    const ledgerResult = ledger.record({
      at: ports.clock.now(),
      scopes: [GLOBAL_SCOPE, symbolScope(symbol)],
      model: config.route.model,
      usage,
      estimatedTokens: reserve.tokens,
      reservedUsd: reserve.usd,
    }, prices.isStale(ports.clock.now()) ? [] : prices.all())
    const actualTokens = usage ?? { tokensIn: reserve.tokens, tokensOut: 0, tokensCached: 0 }
    cumulativeCostKnown = cumulativeCostKnown && ledgerResult.costKnown
    const current = runStore.get(runId)
    if (current?.status === 'running') {
      runStore.update(runId, {
        tokensIn: (current.tokensIn ?? 0) + actualTokens.tokensIn,
        tokensOut: (current.tokensOut ?? 0) + actualTokens.tokensOut,
        tokensCached: (current.tokensCached ?? 0) + actualTokens.tokensCached,
        costUsd: (current.costUsd ?? 0) + ledgerResult.estUsd,
        costKnown: cumulativeCostKnown,
        modelVersion: `${config.route.provider}/${config.route.model}`,
        promptVersion,
        durationMs: priorDurationMs + ports.clock.now() - runStartedAt,
      }, ports.clock.now())
    }
    journal.appendAudit({
      actor: 'system', kind: call.failure === undefined ? 'model_call_accounted' : 'model_call_failed',
      payload: {
        runId, trigger: trigger.id, stage: call.stage, promptVersion: call.promptVersion,
        requestHash: call.requestHash, requestChars: call.requestChars,
        estimatedInputTokens: call.estimatedInputTokens,
        durationMs: callDurationMs,
        request: sanitizeModelTrace(call.request),
        responseHash: fingerprint(call.response),
        response: sanitizeModelTrace({
          response: call.response,
          ...(call.output === undefined ? {} : { structuredOutput: call.output }),
        }),
        tokens: actualTokens, estUsd: ledgerResult.estUsd, costKnown: ledgerResult.costKnown,
        ...(call.failure === undefined ? {} : { error: sanitizeModelTrace(call.failure) }),
        warnings: ledgerResult.warnings,
      },
      ts: ports.clock.now(),
    })
  }

  let budgetDenied: string | undefined
  const beforeCall = async (request: { readonly requestHash: string; readonly requestChars: number; readonly estimatedInputTokens: number }, stage: string): Promise<void> => {
    if (trigger.expiresAt !== undefined && ports.clock.now() >= trigger.expiresAt) {
      throw new Error('触发器在模型调用前已过期，拒绝使用陈旧事件判断')
    }
    const estimatedUsage = { tokensIn: request.estimatedInputTokens, tokensOut: config.route.maxTokens, tokensCached: 0 }
    const result = ledger.preflight({
      at: ports.clock.now(),
      model: config.route.model,
      estimatedUsage,
      dailyBudgetUsd: config.dailyBudgetUsd ?? 0,
      ...(config.dailyTokenCap === undefined ? {} : { tokenCap: config.dailyTokenCap }),
      scope: GLOBAL_SCOPE,
      wake: trigger.source,
    })
    if (!result.decision.allow) {
      budgetDenied = result.decision.reason
      journal.appendAudit({
        actor: 'system', kind: 'model_budget_denied',
        payload: { runId, trigger: trigger.id, stage, requestHash: request.requestHash, requestChars: request.requestChars, estimatedInputTokens: request.estimatedInputTokens, reason: result.decision.reason },
        ts: ports.clock.now(),
      })
      throw new DecisionBudgetDenied(`模型预算准入拒绝：${result.decision.reason}`)
    }
    reservations.set(request.requestHash, { tokens: result.estimatedTokens, usd: result.estimateUsd })
    callStartedAt.set(request.requestHash, ports.clock.now())
  }

  const stages = await runDecisionWorkflowStages({
    strategy: config.strategy,
    context,
    model,
    route: config.route,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    resume: resumeStages(prior as DecisionRunRecord),
    beforeCall: (request, stage) => beforeCall(request, stage),
    onModelCall: async (call) => addLedgerEntry(call),
    onModelFailure: async (call) => addLedgerEntry(call),
    onStage: async (stage, artifact) => {
      const current = runStore.get(runId)
      if (current?.status !== 'running') throw new Error(`decision run 在 stage 写入前已终结：${runId}`)
      const patch = stage === 'draft' ? { draft: artifact } : stage === 'critique' ? { critique: artifact } : { final: artifact }
      runStore.update(runId, patch, ports.clock.now())
    },
  })

  if (stages.failure !== undefined || stages.final === undefined) {
    const reason = budgetDenied ?? stages.failure ?? '模型 workflow 没有 final 工件'
    const envelope = failureEnvelope(context, runId, reason)
    const eligibility: EligibilityResult = { state: 'decision_only', reasons: [reason], validatedEvidencePaths: [] }
    const retryable = stages.failureKind === 'model'
    const current = runStore.get(runId)
    if (current?.status === 'running') {
      if (retryable) {
        runStore.update(runId, {
          draft: stages.draft === undefined ? undefined : stageArtifact(stages, 'draft'),
          critique: stages.critique === undefined ? undefined : stageArtifact(stages, 'critique'),
          costKnown: cumulativeCostKnown,
          durationMs: priorDurationMs + ports.clock.now() - runStartedAt,
        }, ports.clock.now())
      } else {
        runStore.update(runId, {
          status: 'review',
          draft: stages.draft === undefined ? undefined : stageArtifact(stages, 'draft'),
          critique: stages.critique === undefined ? undefined : stageArtifact(stages, 'critique'),
          final: { envelope, workflow: decisionWorkflowSummary(stages), failure: reason },
          eligibility,
          costKnown: cumulativeCostKnown,
          durationMs: priorDurationMs + ports.clock.now() - runStartedAt,
          finishedAt: ports.clock.now(),
        }, ports.clock.now())
      }
    }
    if (!retryable && !journal.hasDecision(`decision:${runId}`)) {
      journal.recordDecision({
        decisionId: `decision:${runId}`,
        runId,
        symbol,
        timeframe,
        decidedAt: context.asOf,
        contextHash: context.contextHash,
        action: 'review',
        executed: false,
        rationale: reason,
      })
    }
    journal.appendAudit({
      actor: 'system', kind: retryable ? 'decision_attempt_retryable' : 'decision_review',
      payload: { runId, contextHash: context.contextHash, reason, strategy: config.strategy, retryable },
      ts: ports.clock.now(),
    })
    return { runId, status: 'review', replayed: false, retryable, contextHash: context.contextHash, envelope, eligibility, reason }
  }

  const envelope = bindDecisionEnvelope(stages.final, { runId, context })
  let eligibility = evaluateDecisionEligibility(context, stages.final, stages.evidenceIssues, {
    predictionEvent: trigger.predictionAlias !== undefined,
  })
  const currentAfterCalls = runStore.get(runId)
  if (!cumulativeCostKnown || currentAfterCalls?.costKnown === false) {
    eligibility = {
      state: 'decision_only',
      reasons: [...eligibility.reasons, 'model call cost or usage is unknown'],
      validatedEvidencePaths: eligibility.validatedEvidencePaths,
    }
  }

  const current = runStore.get(runId)
  if (current?.status !== 'running') throw new Error(`decision run 在 final 前已终结：${runId}`)
  runStore.update(runId, {
    final: {
      candidate: stages.final,
      evidenceIssues: stages.evidenceIssues,
      envelope,
      workflow: decisionWorkflowSummary(stages),
    },
    eligibility,
    durationMs: priorDurationMs + ports.clock.now() - runStartedAt,
  }, ports.clock.now())

  const timeFacts = latestMarketFacts(context, timeframe)
  let planId: string | undefined
  let actionExecution: unknown
  let finalStatus: 'completed' | 'review' = envelope.outcome === 'review' ? 'review' : 'completed'
  let finalizeReason: string | undefined = trigger.expiresAt !== undefined && ports.clock.now() >= trigger.expiresAt
    ? '触发器在最终裁决后已过期，禁止保存计划或执行动作'
    : undefined
  let materializedPlan: PlanValidation | undefined

  const planContainsOpen = planHasOpen(envelope)
  const canStorePlan = envelope.plan !== undefined && (!planContainsOpen || eligibility.state === 'risk_gate_required')
  if (finalizeReason !== undefined) {
    finalStatus = 'review'
  } else if (envelope.plan !== undefined && !canStorePlan) {
    finalStatus = 'review'
    finalizeReason = 'eligibility 未授权包含 open commitment 的计划卡'
  } else if (envelope.plan !== undefined) {
    const now = ports.clock.now()
    const candidatePlanId = `pc-${fingerprint({ runId, contextHash: context.contextHash, plan: envelope.plan }).slice(7, 31)}`
    const materialized = materializeDecisionPlan(envelope, {
      planId: candidatePlanId,
      createdAt: context.asOf,
      windowEndsAt: context.asOf + config.planWindowMs,
    })
    if (materialized === undefined || !materialized.ok) {
      finalStatus = 'review'
      finalizeReason = materialized === undefined ? 'plan materialization returned no card' : materialized.errors.join('; ')
    } else {
      materializedPlan = materialized
      planId = materialized.card.planId
    }
  }

  if (finalizeReason === undefined && envelope.immediateAction !== undefined) {
    const riskReducing = isRiskReducing(envelope.immediateAction)
    if (envelope.immediateAction.action === 'open' && eligibility.state !== 'risk_gate_required') {
      finalStatus = 'review'
      finalizeReason = 'eligibility 未授权即时开仓'
    } else if (eligibility.state === 'decision_only' && !riskReducing) {
      finalStatus = 'review'
      finalizeReason = 'decision_only 只允许无交易或经校验的减险动作'
    } else {
      const latestFeature = ports.features.latest(symbol, timeframe)
      const contextConfig = isRecord(context.sections.mandate.value) && isRecord(context.sections.mandate.value['contextConfig'])
        ? context.sections.mandate.value['contextConfig']
        : undefined
      const marketGraceMs = contextConfig !== undefined && typeof contextConfig['marketGraceMs'] === 'number'
        ? contextConfig['marketGraceMs']
        : 0
      const portfolio = isRecord(context.sections.portfolio.value) ? context.sections.portfolio.value : undefined
      const positionRows = portfolio !== undefined && Array.isArray(portfolio['positions']) ? portfolio['positions'] : []
      const priorPosition = positionRows.find((item) => isRecord(item) && item['symbol'] === symbol)
      const portfolioAvgPrice = isRecord(priorPosition) && typeof priorPosition['avgPrice'] === 'number'
        ? priorPosition['avgPrice']
        : undefined
      const featurePrice = latestFeature !== undefined && Number.isFinite(latestFeature.values.close) && latestFeature.values.close > 0
        ? latestFeature.values.close
        : undefined
      let referencePrice = featurePrice ?? timeFacts?.price ?? portfolioAvgPrice
      let atr = latestFeature?.values.atr14 ?? timeFacts?.atr ?? null
      const barTs = timeFacts?.barTs ?? context.asOf
      if (['open', 'set_stop', 'set_target', 'set_trailing'].includes(envelope.immediateAction.action)) {
        const atrRequired = envelope.immediateAction.action === 'open' && envelope.immediateAction.stop.method === 'atr'
        const freshSnapshot = latestFeature !== undefined && timeFacts !== undefined &&
          latestFeature.openTime === timeFacts.barTs && latestFeature.values.close === timeFacts.price &&
          ports.clock.now() >= latestFeature.closeTime && ports.clock.now() - latestFeature.closeTime <= marketGraceMs &&
          (!atrRequired || latestFeature.values.atr14 === timeFacts.atr)
        if (!freshSnapshot) {
          finalStatus = 'review'
          finalizeReason = '模型返回期间保护/执行价格已过期或与冻结 context 不一致'
        } else {
          referencePrice = latestFeature.values.close
          atr = latestFeature.values.atr14
        }
      }
      const requiresPrice = ['open', 'reduce', 'close', 'set_stop', 'set_target', 'set_trailing'].includes(envelope.immediateAction.action)
      if (finalizeReason !== undefined) {
        // 成交前的价格新鲜度闸拒绝即时动作；终态 run 仍保留模型工件与原因。
      } else if (requiresPrice && (referencePrice === undefined || !Number.isFinite(referencePrice) || referencePrice <= 0)) {
        finalStatus = 'review'
        finalizeReason = '没有可用的正数减险估值价格'
      } else {
      const syntheticPlanId = planId ?? `decision-${fingerprint(runId).slice(7, 23)}`
      const action = envelope.immediateAction.action === 'open'
        ? { ...envelope.immediateAction, riskFraction: envelope.riskFraction }
        : envelope.immediateAction
      actionExecution = await executeAction({
        journal,
        broker: ports.broker,
        clock: ports.clock,
        plan: { planId: syntheticPlanId, runId },
        conditionId: 'decision-envelope-immediate',
        action,
        symbol,
        timeframe,
        barTs,
        ...(referencePrice === undefined ? {} : { referencePrice }),
        ...(trigger.expiresAt === undefined ? {} : { actionDeadlineAt: trigger.expiresAt }),
        atr,
        riskPct: ports.riskPct,
        mode: ports.mode,
        liveArmed: ports.liveArmed,
        limits: ports.limits,
        waiver: ports.waiver,
        reflectionHorizonMs: ports.reflectionHorizonMs ?? 4 * 3_600_000,
        alreadyIntended: (clientOrderId) => journal.hasClientOrderId(clientOrderId),
        ...(ports.frozenSymbols === undefined ? {} : { frozenSymbols: ports.frozenSymbols }),
        ...(ports.freezeSymbol === undefined ? {} : { freezeSymbol: ports.freezeSymbol }),
        ...(ports.halt === undefined ? {} : { halt: ports.halt }),
      })
      if (isRecord(actionExecution) && actionExecution['denied'] === true) {
        finalStatus = 'review'
        finalizeReason = typeof actionExecution['reason'] === 'string' ? actionExecution['reason'] : 'immediate action denied by hard gate'
      }
      }
    }
  }

  if (finalizeReason === undefined && envelope.outcome !== 'act' && envelope.immediateAction === undefined) {
    const action = envelope.outcome === 'no_trade' ? 'no_trade' : 'review'
    const decisionId = `decision:${runId}`
    if (!journal.hasDecision(decisionId)) journal.recordDecision({
      decisionId, runId, symbol, timeframe, decidedAt: context.asOf, contextHash: context.contextHash,
      action, executed: false, rationale: envelope.thesis,
    })
  }

  if (finalizeReason === undefined && materializedPlan?.ok === true) {
    try {
      const saved = ports.plans.save(materializedPlan.card, ports.clock.now())
      planId = saved.planId
    } catch (error) {
      finalStatus = 'review'
      finalizeReason = `plan 落库失败：${safeReason(error)}`
    }
  }

  const terminal = runStore.get(runId)
  if (terminal?.status === 'running') {
    runStore.update(runId, {
      status: finalStatus,
      eligibility,
      ...(finalizeReason === undefined ? {} : { final: { envelope, workflow: decisionWorkflowSummary(stages), reason: finalizeReason } }),
      costKnown: cumulativeCostKnown,
      durationMs: priorDurationMs + ports.clock.now() - runStartedAt,
      finishedAt: ports.clock.now(),
    }, ports.clock.now())
  }
  journal.appendAudit({
    actor: 'system', kind: 'decision_envelope_finalized',
    payload: {
      runId, contextHash: context.contextHash, outcome: envelope.outcome, eligibility,
      planId: planId ?? null, actionExecution: actionExecution ?? null,
      status: finalStatus, reason: finalizeReason ?? null,
    },
    ts: ports.clock.now(),
  })
  return {
    runId,
    status: finalStatus,
    replayed: false,
    contextHash: context.contextHash,
    envelope,
    eligibility,
    ...(planId === undefined ? {} : { planId }),
    ...(actionExecution === undefined ? {} : { execution: actionExecution }),
    ...(finalizeReason === undefined ? {} : { reason: finalizeReason }),
  }
}
