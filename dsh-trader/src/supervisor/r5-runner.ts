/** R5 真实模型静态对照执行器：预算、请求、响应与阶段工件都落在独立实验账本。 */

import type Database from 'better-sqlite3'
import { DecisionContextStore } from '../agents/decision-context-store.js'
import type { DecisionContext } from '../agents/decision-context.js'
import { DecisionRunStore, type DecisionRunPatch, type DecisionRunRecord } from '../agents/decision-run-store.js'
import {
  bindDecisionEnvelope,
  evaluateDecisionEligibility,
  type DecisionEnvelopeCandidate,
} from '../agents/decision-envelope.js'
import {
  decisionWorkflowSummary,
  DecisionBudgetDenied,
  runDecisionWorkflowStages,
  toLedgerUsage,
  type DecisionModel,
  type DecisionModelCall,
  type DecisionWorkflowResume,
} from '../agents/decision-workflow.js'
import { BudgetLedger, GLOBAL_SCOPE, PriceTableStore, symbolScope } from '../cost-ledger.js'
import type { TokenUsage } from '../cost.js'
import { DecisionJournal } from '../exec/journal.js'
import { Statements } from '../db/statements.js'
import type { Clock } from '../clock.js'
import { fingerprint } from '../util/canonical.js'
import {
  R5_STRATEGIES,
  assertNoCredentialValues,
  aggregateR5StaticResults,
  r5MaximumModelCalls,
  scoreR5StaticSample,
  validateR5Manifest,
  type R5BudgetAuthorization,
  type R5ExperimentManifest,
  type R5ManifestSample,
  type R5Strategy,
} from './r5.js'
import { sanitizeModelTrace } from '../agents/decision-runtime.js'
import { R5ControlRegistry, type R5ProcessIdentity } from './r5-registry.js'

interface R5AuditRow {
  readonly kind: string
  readonly payload_json: string
}

interface R5Reservation {
  readonly requestHash: string
  readonly estimatedTokens: number
  readonly reservedUsd: number
  readonly stage: DecisionModelCall['stage']
  readonly runId: string
  readonly sampleId: string
  readonly strategy: R5Strategy
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function auditPayload(row: R5AuditRow): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(row.payload_json) as unknown
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function r5RunId(experimentId: string, sample: R5ManifestSample, strategy: R5Strategy, route: R5ExperimentManifest['route']): string {
  return `run-r5-${fingerprint({ experimentId, sampleId: sample.sampleId, contextHash: sample.context.contextHash, strategy, provider: route.provider, model: route.model }).slice(7, 39)}`
}

function resumeFromRun(run: DecisionRunRecord): DecisionWorkflowResume | undefined {
  const resume: {
    draft?: DecisionWorkflowResume['draft']
    critique?: DecisionWorkflowResume['critique']
    final?: DecisionWorkflowResume['final']
  } = {}
  if (run.draft !== null && isRecord(run.draft) && isRecord(run.draft['candidate'])) {
    resume.draft = run.draft as unknown as NonNullable<DecisionWorkflowResume['draft']>
  }
  if (run.critique !== null && isRecord(run.critique)) {
    resume.critique = run.critique as unknown as NonNullable<DecisionWorkflowResume['critique']>
  }
  if (run.final !== null && isRecord(run.final) && isRecord(run.final['candidate'])) {
    resume.final = run.final as unknown as NonNullable<DecisionWorkflowResume['final']>
  }
  return Object.keys(resume).length === 0 ? undefined : resume
}

function terminalStaticResult(run: DecisionRunRecord): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(run.final) || !isRecord(run.final['r5Static'])) return undefined
  return run.final['r5Static']
}

function stagePatch(stage: 'draft' | 'critique' | 'final', artifact: unknown): DecisionRunPatch {
  if (stage === 'draft') return { draft: artifact }
  if (stage === 'critique') return { critique: artifact }
  return { final: artifact }
}

export interface R5StaticRunnerInput {
  readonly manifest: R5ExperimentManifest
  readonly db: Database.Database
  readonly clock: Clock
  readonly model: DecisionModel
  readonly budgets: R5BudgetAuthorization
  /** 仅用于在内存中阻止真实凭据进入 frozen context/prompt；不得写入审计。 */
  readonly credentialValues: readonly string[]
  readonly registry: R5ControlRegistry
  /** 隔离的 per-experiment state DB 规范路径 hash。 */
  readonly stateDbId: string
  readonly processIdentity: R5ProcessIdentity
  readonly isProcessIdentityAlive: (owner: R5ProcessIdentity) => boolean | undefined
  readonly keyIsolationAcknowledged: boolean
  readonly requireExistingControlExperiment?: boolean
  readonly maxModelCalls?: number
  /** 支持跨多日/多批次续跑；索引基于冻结 manifest 的 sample 顺序。 */
  readonly sampleStartIndex?: number
  readonly sampleCount?: number
}

export interface R5StaticRunnerResult {
  readonly experimentId: string
  readonly manifestHash: string
  readonly split: R5ExperimentManifest['split']
  readonly status: 'finished' | 'budget-stopped' | 'call-failed' | 'cost-unknown' | 'budget-overrun' | 'incomplete'
  readonly expectedRuns: number
  readonly terminalRuns: number
  readonly modelCalls: number
  readonly abandonedReservations: number
  readonly reservedUsd: number
  readonly controlBlocker: string | null
  readonly controlCostUnknownCalls: number
  readonly controlRecoveredAbandonedCalls: number
  readonly budgetStopReason?: string
  readonly staticAggregate?: ReturnType<typeof aggregateR5StaticResults>
  readonly staticByStrategy: Readonly<Record<R5Strategy, ReturnType<typeof aggregateR5StaticResults> | null>>
  /** 静态判断有效性不等于执行链覆盖，也不等于经济闸门。 */
  readonly executionChainSamples: 0
  readonly economicGate: 'not_run'
}

/**
 * 运行冻结上下文上的 single/critique 真实模型静态对照。
 * 预算拒绝发生在 provider I/O 前；模型调用已预留但无结算审计的 hash 永不自动重发。
 */
export async function runR5StaticExperiment(input: R5StaticRunnerInput): Promise<R5StaticRunnerResult> {
  const { manifest, db, clock, model, budgets, registry, stateDbId } = input
  const validated = validateR5Manifest(manifest)
  const { summary } = validated
  assertNoCredentialValues(manifest, input.credentialValues)
  const expectedRuns = manifest.samples.length * R5_STRATEGIES.length
  const maxModelCalls = input.maxModelCalls ?? r5MaximumModelCalls(manifest)
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 1) throw new Error('R5 maxModelCalls 非法')
  const sampleStartIndex = input.sampleStartIndex ?? 0
  const sampleCount = input.sampleCount ?? manifest.samples.length - sampleStartIndex
  if (!Number.isSafeInteger(sampleStartIndex) || sampleStartIndex < 0 || sampleStartIndex >= manifest.samples.length ||
      !Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleStartIndex + sampleCount > manifest.samples.length) {
    throw new Error('R5 sample batch range 超出 manifest')
  }
  const selectedSamples = manifest.samples.slice(sampleStartIndex, sampleStartIndex + sampleCount)

  const journal = new DecisionJournal(db)
  const contexts = new DecisionContextStore(db)
  const runs = new DecisionRunStore(db)
  const budgetLedger = new BudgetLedger(db)
  const priceTable = new PriceTableStore(db)
  const initialNow = clock.now()
  if (!Number.isSafeInteger(initialNow) || initialNow < 0) throw new Error('R5 Clock 必须返回非负毫秒整数')
  if (priceTable.isStale(initialNow)) throw new Error('R5 模型价目表缺失或过期，拒绝启动真实调用')
  const routePrice = priceTable.select(manifest.route.model, initialNow)
  if (routePrice === undefined) throw new Error(`R5 价目表没有 ${manifest.route.model} 的当前价格，拒绝启动`)
  if (manifest.versions.priceTableVersion !== priceTable.version()) {
    throw new Error('R5 manifest 的价目表版本与实验账本不一致；必须建立新 manifest/experimentId')
  }
  const recoveredAbandonedCalls = registry.recoverAbandonedCalls(input.isProcessIdentityAlive)

  registry.registerExperiment({
    experimentId: manifest.experimentId,
    manifestHash: summary.manifestHash,
    split: manifest.split,
    datasetId: manifest.dataset.id,
    datasetHash: manifest.dataset.contentHash,
    pitDataHash: summary.pitDataHash,
    pitWindowHashes: summary.pitWindowHashes,
    routeHash: fingerprint(manifest.route),
    stateDbId,
    credentialRef: 'TRADER_R5_API_KEY',
    keyIsolationAcknowledged: input.keyIsolationAcknowledged,
    budgets,
    priceTableVersion: priceTable.version(),
  }, { requireExisting: input.requireExistingControlExperiment === true })
  const statements = new Statements(db)
  const readR5Audit = (): readonly { readonly seq: number; readonly kind: string; readonly payload_json: string }[] =>
    statements.get("SELECT seq, kind, payload_json FROM audit_events WHERE kind GLOB 'r5_*' ORDER BY seq").all() as {
      seq: number; kind: string; payload_json: string
    }[]
  let events = readR5Audit()
  const experimentStarts = events
    .filter((row) => row.kind === 'r5_experiment_started')
    .map((row) => auditPayload(row))
    .filter((payload) => payload?.['experimentId'] === manifest.experimentId)
  for (const prior of experimentStarts) {
    if (prior?.['manifestHash'] !== summary.manifestHash || prior['routeHash'] !== fingerprint(manifest.route) ||
        prior['stateDbId'] !== stateDbId) {
      throw new Error('R5 experimentId 已绑定不同 manifest、model route 或 state DB；请建立新 experimentId')
    }
    if (prior['budgetHash'] !== fingerprint(budgets) || prior['priceTableVersion'] !== priceTable.version()) {
      throw new Error('R5 experiment 的预算上限或价目表版本已冻结且不可变；请建立新 experimentId')
    }
  }
  if (experimentStarts.length === 0) {
    journal.appendAudit({
      actor: 'human', kind: 'r5_experiment_started',
      payload: {
        experimentId: manifest.experimentId,
        manifestHash: summary.manifestHash,
        split: manifest.split,
        dataset: manifest.dataset,
        pitDataHash: summary.pitDataHash,
        pitWindowHashes: summary.pitWindowHashes,
        versions: manifest.versions,
        route: manifest.route,
        routeHash: fingerprint(manifest.route),
        stateDbId,
        budgets,
        budgetHash: fingerprint(budgets),
        priceTableVersion: priceTable.version(),
        contexts: summary.samples,
        independentWindows: summary.windows,
        preregistration: manifest.preregistration,
      },
      ts: clock.now(),
    })
    events = readR5Audit()
  }

  const reservations = new Map<string, R5Reservation>()
  const settledHashes = new Set<string>()
  for (const row of events) {
    const payload = auditPayload(row)
    if (payload?.['experimentId'] !== manifest.experimentId || typeof payload['requestHash'] !== 'string') continue
    if (row.kind === 'r5_model_call_reserved') {
      if (typeof payload['estimatedTokens'] === 'number' && typeof payload['stage'] === 'string' &&
          typeof payload['runId'] === 'string' && typeof payload['sampleId'] === 'string' &&
          (payload['strategy'] === 'single' || payload['strategy'] === 'critique')) {
        reservations.set(payload['requestHash'], {
          requestHash: payload['requestHash'],
          estimatedTokens: payload['estimatedTokens'],
          reservedUsd: Number(payload['reservedUsd'] ?? 0),
          stage: payload['stage'] as DecisionModelCall['stage'],
          runId: payload['runId'],
          sampleId: payload['sampleId'],
          strategy: payload['strategy'],
        })
      }
    }
    if (row.kind === 'r5_model_call_completed' || row.kind === 'r5_model_call_failed') {
      settledHashes.add(payload['requestHash'])
    }
  }

  let budgetStopReason: string | undefined
  let stopped = false
  let stopKind: R5StaticRunnerResult['status'] | undefined
  let callsThisInvocation = 0

  for (const sample of selectedSamples) {
    contexts.record(sample.context, { createdAt: sample.context.asOf })
    for (const strategy of R5_STRATEGIES) {
      if (callsThisInvocation >= maxModelCalls) {
        budgetStopReason = '达到本次调用数上限；剩余 run 保留待续'
        stopped = true
        stopKind = 'budget-stopped'
        break
      }
      const runId = r5RunId(manifest.experimentId, sample, strategy, manifest.route)
      const prior = runs.get(runId)
      if (prior !== undefined && prior.status !== 'running') {
        const staticResult = terminalStaticResult(prior)
        if (staticResult === undefined) throw new Error(`R5 terminal run 缺少 static result：${runId}`)
        continue
      }
      if (prior === undefined) {
        runs.start({
          runId,
          contextId: sample.context.contextId,
          contextHash: sample.context.contextHash,
          symbol: sample.context.symbol,
          primaryTimeframe: '1h',
          triggerSource: `R5:${manifest.experimentId}:${sample.windowId}:${strategy}`,
          modelVersion: `${manifest.route.provider}/${manifest.route.model}`,
          promptVersion: 'decision-r3-v1',
          createdAt: sample.context.asOf,
        })
      }
      let current = runs.require(runId, { contextHash: sample.context.contextHash })
      const runStartAt = clock.now()
      const callStarts = new Map<string, number>()
      const runReservations = new Map<string, R5Reservation>()
      let runCostKnown = current.costKnown !== false

      const addCall = (call: DecisionModelCall, failure: boolean): void => {
        const reservation = runReservations.get(call.requestHash)
        if (reservation === undefined) throw new Error(`R5 模型调用缺少预算 reservation：${call.requestHash}`)
        const startedAt = callStarts.get(call.requestHash)
        const durationMs = startedAt === undefined ? null : Math.max(0, clock.now() - startedAt)
        callStarts.delete(call.requestHash)
        const usage = failure ? null : toLedgerUsage(call.usage)
        const ledgerResult = budgetLedger.record({
          at: clock.now(),
          scopes: [GLOBAL_SCOPE, symbolScope(sample.context.symbol)],
          model: manifest.route.model,
          usage,
          estimatedTokens: reservation.estimatedTokens,
          reservedUsd: reservation.reservedUsd,
        }, priceTable.all())
        const counted = usage ?? { tokensIn: reservation.estimatedTokens, tokensOut: 0, tokensCached: 0 }
        runCostKnown = runCostKnown && ledgerResult.costKnown
        current = runs.update(runId, {
          tokensIn: (current.tokensIn ?? 0) + counted.tokensIn,
          tokensOut: (current.tokensOut ?? 0) + counted.tokensOut,
          tokensCached: (current.tokensCached ?? 0) + counted.tokensCached,
          costUsd: (current.costUsd ?? 0) + ledgerResult.estUsd,
          costKnown: runCostKnown,
          durationMs: (current.durationMs ?? 0) + (durationMs ?? 0),
          modelVersion: `${manifest.route.provider}/${manifest.route.model}`,
          promptVersion: call.promptVersion,
        }, clock.now())
        journal.appendAudit({
          actor: 'system',
          kind: failure ? 'r5_model_call_failed' : 'r5_model_call_completed',
          payload: {
            experimentId: manifest.experimentId,
            runId,
            sampleId: sample.sampleId,
            windowId: sample.windowId,
            strategy,
            stage: call.stage,
            promptVersion: call.promptVersion,
            requestHash: call.requestHash,
            requestChars: call.requestChars,
            estimatedInputTokens: call.estimatedInputTokens,
            request: sanitizeModelTrace(call.request),
            responseHash: fingerprint(call.response),
            response: sanitizeModelTrace({
              response: call.response,
              ...(call.output === undefined ? {} : { structuredOutput: call.output }),
            }),
            durationMs,
            tokens: counted,
            estUsd: ledgerResult.estUsd,
            costKnown: ledgerResult.costKnown,
            warnings: ledgerResult.warnings,
            ...(call.failure === undefined ? {} : { error: sanitizeModelTrace(call.failure) }),
          },
          ts: clock.now(),
        })
        const controlSettlement = registry.settleCall({
          experimentId: manifest.experimentId,
          requestHash: call.requestHash,
          at: clock.now(),
          actualTokens: counted.tokensIn + counted.tokensOut,
          actualUsd: ledgerResult.costKnown ? ledgerResult.estUsd : null,
          costKnown: ledgerResult.costKnown,
          failed: failure,
        })
        settledHashes.add(call.requestHash)
        callsThisInvocation += 1
        if (controlSettlement.overrun) {
          stopped = true
          stopKind = 'budget-overrun'
        } else if (failure) {
          stopped = true
          stopKind = 'call-failed'
        } else if (!ledgerResult.costKnown) {
          stopped = true
          stopKind = 'cost-unknown'
        }
      }

      const stageUpdate = async (stage: 'draft' | 'critique' | 'final', artifact: unknown): Promise<void> => {
        const patch = stagePatch(stage, artifact)
        current = runs.update(runId, patch, clock.now())
      }

      const stages = await runDecisionWorkflowStages({
        strategy,
        context: sample.context,
        model,
        route: manifest.route,
        ...(resumeFromRun(current) === undefined ? {} : { resume: resumeFromRun(current) }),
        beforeCall: async (request, stage) => {
          if (stopped) throw new DecisionBudgetDenied('此前模型调用失败或成本未知，停止后续调用')
          const previousReservation = reservations.get(request.requestHash)
          if (previousReservation !== undefined || settledHashes.has(request.requestHash)) {
            throw new Error(`R5 不自动重发可能已计费的 requestHash：${request.requestHash}`)
          }
          const at = clock.now()
          const estimatedUsage: TokenUsage = { tokensIn: request.estimatedInputTokens, tokensOut: manifest.route.maxTokens, tokensCached: 0 }
          const preflight = budgetLedger.preflight({
            at,
            model: manifest.route.model,
            estimatedUsage,
            dailyBudgetUsd: budgets.dailyBudgetUsd,
            tokenCap: budgets.dailyTokenCap,
            scope: GLOBAL_SCOPE,
            wake: 'W1',
          })
          if (!preflight.decision.allow) throw new DecisionBudgetDenied(preflight.decision.reason)
          if (preflight.estimateUsd === null) throw new DecisionBudgetDenied(preflight.reason ?? '价目未知，停止真实模型调用')
          if (callsThisInvocation >= maxModelCalls) throw new DecisionBudgetDenied('达到本次调用数上限')
          const reservation: R5Reservation = {
            requestHash: request.requestHash,
            estimatedTokens: preflight.estimatedTokens,
            reservedUsd: preflight.estimateUsd,
            stage,
            runId,
            sampleId: sample.sampleId,
            strategy,
          }
          const controlReservation = registry.reserveCall({
            experimentId: manifest.experimentId,
            stateDbId,
            requestHash: request.requestHash,
            runId,
            sampleId: sample.sampleId,
            model: manifest.route.model,
            symbol: sample.context.symbol,
            strategy,
            stage,
            at,
            estimatedTokens: preflight.estimatedTokens,
            reservedUsd: preflight.estimateUsd,
            owner: input.processIdentity,
          })
          if (!controlReservation.allow) {
            if (controlReservation.reason.startsWith('requestHash 已在共享 control registry')) {
              throw new Error(controlReservation.reason)
            }
            throw new DecisionBudgetDenied(controlReservation.reason)
          }
          // reservation 先落 append-only 审计；进程若在 provider 返回前崩溃，重启也不会盲目重复付费请求。
          journal.appendAudit({
            actor: 'system', kind: 'r5_model_call_reserved',
            payload: {
              experimentId: manifest.experimentId, runId, sampleId: sample.sampleId,
              windowId: sample.windowId, strategy, stage, requestHash: request.requestHash,
              estimatedTokens: preflight.estimatedTokens, reservedUsd: preflight.estimateUsd,
              dailyBudgetUsd: budgets.dailyBudgetUsd, dailyTokenCap: budgets.dailyTokenCap,
              totalBudgetUsd: budgets.totalBudgetUsd,
            },
            ts: at,
          })
          reservations.set(request.requestHash, reservation)
          runReservations.set(request.requestHash, reservation)
          callStarts.set(request.requestHash, at)
        },
        onModelCall: async (call) => addCall(call, false),
        onModelFailure: async (call) => addCall(call, true),
        onStage: stageUpdate,
      })

      if (stages.failureKind === 'budget') {
        budgetStopReason = stages.failure ?? '预算闸拒绝后续模型调用'
        stopped = true
        stopKind = 'budget-stopped'
        break
      }

      let staticResult: Readonly<Record<string, unknown>>
      let status: 'completed' | 'review' | 'failed'
      let finalArtifact: unknown
      let eligibility: unknown
      if (stages.final !== undefined) {
        const envelope = bindDecisionEnvelope(stages.final, { runId, context: sample.context })
        eligibility = evaluateDecisionEligibility(sample.context, envelope, stages.evidenceIssues)
        finalArtifact = { candidate: envelope, evidenceIssues: stages.evidenceIssues }
        status = stages.failure === undefined && stages.final.outcome !== 'review' && stages.evidenceIssues.length === 0
          ? 'completed'
          : 'review'
        staticResult = scoreR5StaticSample(sample, strategy, stages)
      } else {
        status = stages.failureKind === 'model' ? 'failed' : 'review'
        finalArtifact = { failure: stages.failure ?? '没有可校验的 final envelope' }
        eligibility = { state: 'decision_only', reasons: [stages.failure ?? 'final envelope missing'], validatedEvidencePaths: [] }
        staticResult = scoreR5StaticSample(sample, strategy, stages)
      }
      const workflow = decisionWorkflowSummary(stages)
      finalArtifact = isRecord(finalArtifact) ? { ...finalArtifact, workflow, r5Static: staticResult } : finalArtifact
      current = runs.update(runId, {
        status,
        final: finalArtifact,
        eligibility,
        modelVersion: `${manifest.route.provider}/${manifest.route.model}`,
        promptVersion: 'decision-r3-v1',
        durationMs: Math.max(0, clock.now() - runStartAt),
        finishedAt: clock.now(),
      }, clock.now())
      journal.appendAudit({
        actor: 'system', kind: 'r5_static_decision_completed',
        payload: { experimentId: manifest.experimentId, runId, sampleId: sample.sampleId, windowId: sample.windowId, strategy, status, r5Static: staticResult },
        ts: clock.now(),
      })
      if (stopped) {
        budgetStopReason ??= '模型调用失败或 cost_known=false；停止新模型调用'
        break
      }
    }
    if (stopped) break
  }

  const allStaticResults: Readonly<Record<string, unknown>>[] = []
  let terminalRuns = 0
  for (const sample of manifest.samples) {
    for (const strategy of R5_STRATEGIES) {
      const run = runs.get(r5RunId(manifest.experimentId, sample, strategy, manifest.route))
      if (run === undefined || run.status === 'running') continue
      const staticResult = terminalStaticResult(run)
      if (staticResult === undefined) throw new Error(`R5 terminal run 缺少 static result：${run.runId}`)
      allStaticResults.push(staticResult)
      terminalRuns += 1
    }
  }
  const staticAggregate = allStaticResults.length === 0 ? undefined : aggregateR5StaticResults(allStaticResults)
  const staticByStrategy = Object.fromEntries(R5_STRATEGIES.map((strategy) => {
    const armResults = allStaticResults.filter((result) => result['strategy'] === strategy)
    return [strategy, armResults.length === 0 ? null : aggregateR5StaticResults(armResults)]
  })) as Record<R5Strategy, ReturnType<typeof aggregateR5StaticResults> | null>
  const controlSnapshot = registry.snapshot(manifest.experimentId)
  if (controlSnapshot.blocker !== null) {
    budgetStopReason ??= controlSnapshot.blocker
    stopKind ??= 'budget-stopped'
  }
  const status = stopKind ?? (stopped ? 'incomplete' : terminalRuns === expectedRuns ? 'finished' : 'incomplete')
  return {
    experimentId: manifest.experimentId,
    manifestHash: summary.manifestHash,
    split: manifest.split,
    status,
    expectedRuns,
    terminalRuns,
    modelCalls: controlSnapshot.callsSettled,
    abandonedReservations: controlSnapshot.abandonedCalls,
    reservedUsd: controlSnapshot.reservedUsd,
    controlBlocker: controlSnapshot.blocker,
    controlCostUnknownCalls: controlSnapshot.costUnknownCalls,
    controlRecoveredAbandonedCalls: recoveredAbandonedCalls,
    ...(budgetStopReason === undefined ? {} : { budgetStopReason }),
    ...(staticAggregate === undefined ? {} : { staticAggregate }),
    staticByStrategy,
    executionChainSamples: 0,
    economicGate: 'not_run',
  }
}
