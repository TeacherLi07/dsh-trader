/** W1 直接驱动受限 DecisionEnvelope workflow；无持久 desk agent、无通用工具回合。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { BudgetLedger, dayKey, PriceTableStore, priceTableStaleAlert } from '../cost-ledger.js'
import { getDatabase } from '../db/runtime.js'
import { Statements } from '../db/statements.js'
import { DecisionJournal } from '../exec/journal.js'
import type { TradePorts } from '../exec/ports.js'
import { HeartbeatStore } from '../supervisor/heartbeat.js'
import { validateWindowSpec, type WindowSpec } from '../supervisor/windows.js'
import { SupervisorWindowQueue, type WindowQueueItem } from '../supervisor/window-queue.js'
import { dispatchNextTrigger, resolvePredictionTriggerTarget } from '../supervisor/trigger-dispatcher.js'
import { DEFAULT_TRIGGER_LIMITS, type TriggerLimits } from '../trigger/engine.js'
import { TriggerQueue } from '../trigger/queue.js'
import { getPmRuntime } from '../predictions/runtime.js'
import { getExecPorts } from './exec.js'
import { runDecisionRuntime } from '../agents/decision-runtime.js'
import type { DecisionStrategy } from '../agents/decision-workflow.js'
import type { DecisionModelRoute } from '../agents/decision-workflow.js'

export const name = 'trade-supervisor'
export const inject = ['llm']

const windowSchema = z.object({ id: z.string().required(), at: z.string(), everyMs: z.number() })

export const Config = z.object({
  l3: z.object({ provider: z.string(), model: z.string() }),
  dailyBudgetUsd: z.number(),
  dailyTokenCap: z.number(),
  wakeLimits: z.object({
    judgmentPerHour: z.number(), judgmentPerDay: z.number(),
    noveltyPerHour: z.number(), noveltyPerDay: z.number(),
  }),
  maxOutputTokens: z.number(),
  planWindowMs: z.number(),
  decisionStrategy: z.string(),
  heartbeatMs: z.number(),
  windows: z.array(windowSchema),
  windowScanMs: z.number(),
  wakeTimeoutMs: z.number(),
})

export interface SupervisorConfig {
  l3?: { provider?: string; model?: string }
  dailyBudgetUsd?: number
  dailyTokenCap?: number
  wakeLimits?: Partial<TriggerLimits>
  maxOutputTokens?: number
  planWindowMs?: number
  decisionStrategy?: string
  heartbeatMs?: number
  windows?: readonly WindowSpec[]
  windowScanMs?: number
  wakeTimeoutMs?: number
}

const DEFAULT_WINDOWS: readonly WindowSpec[] = [
  { id: 'w1-00', at: '00:00Z' },
  { id: 'w1-04', at: '04:00Z' },
  { id: 'w1-08', at: '08:00Z' },
  { id: 'w1-12', at: '12:00Z' },
  { id: 'w1-16', at: '16:00Z' },
  { id: 'w1-20', at: '20:00Z' },
]

export function resolveDecisionStrategy(value: string | undefined): DecisionStrategy {
  // 负责人选择 critique 作为默认生产流程；single 仍由插件 Config 显式切回，不代表效果比较结论。
  const strategy = value ?? 'critique'
  if (strategy !== 'single' && strategy !== 'critique') throw new Error(`decisionStrategy 必须是 single|critique，收到 ${strategy}`)
  return strategy
}

function routeOf(config: SupervisorConfig): DecisionModelRoute {
  const provider = config.l3?.provider
  const model = config.l3?.model
  if (provider === undefined || provider.trim() === '' || model === undefined || model.trim() === '') {
    throw new Error('trade-supervisor 需要固定的 strategist l3 provider/model')
  }
  const maxTokens = config.maxOutputTokens ?? 1_024
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 8_192) {
    throw new Error('maxOutputTokens 必须是 1..8192 的整数')
  }
  return {
    provider,
    model,
    maxTokens,
    maxChars: 180_000,
  }
}

function triggerLimitsOf(input: Partial<TriggerLimits> | undefined): TriggerLimits {
  const limits: TriggerLimits = {
    judgmentPerHour: input?.judgmentPerHour ?? DEFAULT_TRIGGER_LIMITS.judgmentPerHour,
    judgmentPerDay: input?.judgmentPerDay ?? DEFAULT_TRIGGER_LIMITS.judgmentPerDay,
    noveltyPerHour: input?.noveltyPerHour ?? DEFAULT_TRIGGER_LIMITS.noveltyPerHour,
    noveltyPerDay: input?.noveltyPerDay ?? DEFAULT_TRIGGER_LIMITS.noveltyPerDay,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`wakeLimits.${name} 必须是非负整数`)
  }
  return limits
}

export function apply(ctx: Context, config: SupervisorConfig): void {
  const strategy = resolveDecisionStrategy(config.decisionStrategy)
  const route = routeOf(config)
  if (config.dailyBudgetUsd !== undefined && (!Number.isFinite(config.dailyBudgetUsd) || config.dailyBudgetUsd <= 0)) {
    throw new Error('dailyBudgetUsd 必须为正数；未配置时 fail-closed 禁止调用模型')
  }
  if (config.dailyTokenCap !== undefined && (!Number.isSafeInteger(config.dailyTokenCap) || config.dailyTokenCap <= 0)) {
    throw new Error('dailyTokenCap 必须是正整数')
  }
  const planWindowMs = config.planWindowMs ?? 4 * 3_600_000
  if (!Number.isSafeInteger(planWindowMs) || planWindowMs <= 0) throw new Error('planWindowMs 必须是正整数')
  const wakeLimits = triggerLimitsOf(config.wakeLimits)

  const logger = ctx.logger('trade-supervisor')
  const clock = systemClock()
  const database = getDatabase()
  const journal = new DecisionJournal(database)
  const heartbeat = new HeartbeatStore(new Statements(database), (event) => journal.appendAudit(event))
  const heartbeatMs = config.heartbeatMs ?? 15_000
  const specs = config.windows ?? DEFAULT_WINDOWS
  for (const spec of specs) {
    const errors = validateWindowSpec(spec)
    if (errors.length > 0) throw new Error(`W1 窗口配置非法：${errors.join('；')}`)
  }

  if (config.dailyBudgetUsd === undefined) {
    journal.appendAudit({
      actor: 'system', kind: 'decision_budget_unconfigured',
      payload: { reason: 'dailyBudgetUsd 未显式设置；W1/W2/W3 均不调用模型', strategy, provider: route.provider, model: route.model },
      ts: clock.now(),
    })
    logger.warn('dailyBudgetUsd 未设置：W1/W2/W3 模型调用 fail-closed')
  }

  const prices = new PriceTableStore(database)
  let lastStaleDay: string | null = null
  const checkPriceTableAge = (): void => {
    const now = clock.now()
    const alert = priceTableStaleAlert(prices.ageDays(now), now)
    if (alert === null) {
      lastStaleDay = null
      return
    }
    const day = dayKey(now)
    if (day === lastStaleDay) return
    lastStaleDay = day
    journal.appendAudit({ actor: 'system', kind: 'price_table_stale', payload: { alert, ageDays: prices.ageDays(now) }, ts: now })
  }

  const windowQueue = new SupervisorWindowQueue(database)
  const triggerQueue = new TriggerQueue(database)
  const budget = new BudgetLedger(database)
  const queueNow = clock.now()
  windowQueue.ensure([...specs], queueNow)
  windowQueue.recover(queueNow)
  for (const trigger of triggerQueue.recoverClaims(queueNow)) {
    journal.appendAudit({
      actor: 'system', kind: trigger.state === 'expired' ? 'trigger.expired' : 'trigger.recovered',
      payload: {
        triggerId: trigger.triggerId, dedupKey: trigger.dedupKey, state: trigger.state,
        attempts: trigger.attempts, nextAttemptAt: trigger.nextAttemptAt, reason: trigger.lastError,
      },
      ts: queueNow,
    })
  }

  heartbeat.beat(clock.now())
  checkPriceTableAge()
  const stopHeartbeat = clock.setInterval(() => {
    heartbeat.beat(clock.now())
    checkPriceTableAge()
  }, heartbeatMs)

  let busy = false
  let currentAbort: AbortController | undefined
  const wakeTimeoutMs = config.wakeTimeoutMs ?? 300_000
  if (!Number.isSafeInteger(wakeTimeoutMs) || wakeTimeoutMs <= 0) throw new Error('wakeTimeoutMs 必须是正整数')

  const model = { stream: (options: Parameters<typeof ctx.llm.stream>[0]) => ctx.llm.stream(options) }
  const decisionConfig = (ports: TradePorts) => ({
    strategy,
    route: { ...route, maxChars: ports.decisionContextConfig?.maxChars ?? route.maxChars },
    ...(config.dailyBudgetUsd === undefined ? {} : { dailyBudgetUsd: config.dailyBudgetUsd }),
    ...(config.dailyTokenCap === undefined ? {} : { dailyTokenCap: config.dailyTokenCap }),
    planWindowMs,
  })
  const runDecision = (
    ports: TradePorts,
    trigger: {
      readonly source: 'W1' | 'W2' | 'W3'
      readonly id: string
      readonly at: number
      readonly attempt: number
      readonly expiresAt?: number
      readonly predictionAlias?: string
    },
    symbol: string,
    timeframe: string,
    signal: AbortSignal,
  ) => runDecisionRuntime({ ports, model, config: decisionConfig(ports), trigger, symbol, timeframe, signal })

  const expireQueuedTriggers = (now: number): void => {
    for (const trigger of triggerQueue.expire(now)) {
      journal.appendAudit({
        actor: 'system', kind: 'trigger.expired',
        payload: { triggerId: trigger.triggerId, dedupKey: trigger.dedupKey, attempts: trigger.attempts, reason: trigger.lastError },
        ts: now,
      })
    }
  }

  const driveWindow = async (fire: WindowQueueItem): Promise<void> => {
    if (busy) {
      windowQueue.fail(fire, 'W1 runner busy；fire 保留到下一次扫描', clock.now())
      return
    }
    busy = true
    currentAbort = new AbortController()
    const abort = currentAbort
    const timeout = setTimeout(() => abort.abort(), wakeTimeoutMs)
    try {
      const ports: TradePorts | undefined = getExecPorts()
      if (ports === undefined) throw new Error('执行组合根尚未就绪，W1 fire 重试')
      const results = []
      for (const symbol of ports.symbols) {
        const result = await runDecision(
          ports,
          { source: 'W1', id: fire.id, at: fire.fireTs, attempt: fire.attempts },
          symbol,
          '1h',
          abort.signal,
        )
        results.push({ symbol, runId: result.runId, status: result.status, retryable: result.retryable === true, reason: result.reason ?? null })
        if (result.retryable === true) throw new Error(`W1 ${symbol} model call transient failure: ${result.reason ?? 'unknown'}`)
      }
      journal.appendAudit({
        actor: 'system', kind: 'w1_decision_batch',
        payload: { windowId: fire.id, fireTs: fire.fireTs, strategy, results },
        ts: clock.now(),
      })
      windowQueue.complete(fire, clock.now())
      logger.info(`W1 ${fire.id}: ${results.length} symbol decisions persisted`)
    } catch (error) {
      windowQueue.fail(fire, safeError(error), clock.now())
      journal.appendAudit({
        actor: 'system', kind: 'w1_decision_batch_failed',
        payload: { windowId: fire.id, fireTs: fire.fireTs, reason: safeError(error) },
        ts: clock.now(),
      })
      logger.error(`W1 ${fire.id} failed: ${safeError(error)}`)
    } finally {
      clearTimeout(timeout)
      if (currentAbort === abort) currentAbort = undefined
      busy = false
    }
  }

  const driveTrigger = async (): Promise<void> => {
    if (busy) return
    busy = true
    currentAbort = new AbortController()
    const abort = currentAbort
    const timeout = setTimeout(() => abort.abort(), wakeTimeoutMs)
    try {
      const ports: TradePorts | undefined = getExecPorts()
      if (ports === undefined) {
        logger.warn('W2/W3 队列待处理：执行组合根尚未就绪')
        return
      }
      const predictionStore = getPmRuntime()?.store ?? ports.pm
      const decisionPorts: TradePorts = predictionStore === undefined || ports.pm !== undefined
        ? ports
        : { ...ports, pm: predictionStore }
      const outcome = await dispatchNextTrigger({
        queue: triggerQueue,
        journal,
        clock,
        budget,
        symbols: ports.symbols,
        timeframes: ports.timeframes,
        ...(config.dailyBudgetUsd === undefined ? {} : { dailyBudgetUsd: config.dailyBudgetUsd }),
        ...(config.dailyTokenCap === undefined ? {} : { dailyTokenCap: config.dailyTokenCap }),
        limits: wakeLimits,
        retryPolicy: { maxAttempts: 5, baseDelayMs: 1_000, maxDelayMs: 60_000 },
        ...(ports.freezeSymbol === undefined ? {} : { freezeSymbol: ports.freezeSymbol }),
        ...(ports.halt === undefined ? {} : { halt: ports.halt }),
        resolvePredictionTrigger: (trigger) => resolvePredictionTriggerTarget({
          trigger, plans: ports.plans, predictions: predictionStore, symbols: ports.symbols,
          now: clock.now(), maxSnapshotAgeMs: ports.decisionContextConfig?.marketGraceMs ?? 120_000,
        }),
        run: ({ trigger, source, symbol, timeframe, predictionAlias }) => runDecision(
          decisionPorts,
          {
            source,
            id: trigger.triggerId,
            at: trigger.createdAt,
            attempt: trigger.attempts,
            ...(trigger.expiresAt === undefined ? {} : { expiresAt: trigger.expiresAt }),
            ...(predictionAlias === undefined ? {} : { predictionAlias }),
          },
          symbol,
          timeframe,
          abort.signal,
        ),
      })
      if (outcome.kind !== 'idle') {
        logger.info(`${outcome.source ?? 'W2/W3'} ${outcome.triggerId ?? ''}: ${outcome.kind}${outcome.reason === undefined ? '' : `（${outcome.reason}）`}`)
      }
    } catch (error) {
      const reason = safeError(error)
      journal.appendAudit({
        actor: 'system', kind: 'trigger.dispatcher_failed',
        payload: { reason }, ts: clock.now(),
      })
      logger.error(`W2/W3 dispatcher failed: ${reason}`)
    } finally {
      clearTimeout(timeout)
      if (currentAbort === abort) currentAbort = undefined
      busy = false
    }
  }

  const windowScanMs = config.windowScanMs ?? 60_000
  const stopWindows = clock.setInterval(() => {
    const now = clock.now()
    windowQueue.enqueueDue([...specs], now)
    expireQueuedTriggers(now)
    if (busy) return
    const fire = windowQueue.claimOne(now, specs.map((spec) => spec.id))
    if (fire !== undefined) void driveWindow(fire)
    else if (triggerQueue.queuedCount() > 0) void driveTrigger()
  }, windowScanMs)

  ctx.effect(() => () => {
    currentAbort?.abort()
    stopHeartbeat()
    stopWindows()
  }, 'trade.supervisor.close')
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return raw.replace(/(api[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 1_000)
}
