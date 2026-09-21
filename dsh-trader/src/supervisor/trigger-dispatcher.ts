/** W2/W3 持久触发消费：预算/限流/过期判定与模型调用共用一个入口。 */

import { BudgetLedger } from '../cost-ledger.js'
import type { Clock } from '../clock.js'
import type { DecisionJournal } from '../exec/journal.js'
import { DEFAULT_TRIGGER_LIMITS } from '../trigger/engine.js'
import { DEFAULT_TRIGGER_RETRY_POLICY, TriggerQueue, type StoredTrigger, type TriggerRetryPolicy } from '../trigger/queue.js'
import type { PlanStore } from '../plan/store.js'
import type { PmStore } from '../predictions/store.js'
import { decideWake, type WakeLimits } from './windows.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface TriggerDecisionResult {
  readonly runId?: string
  readonly status?: string
  readonly retryable?: boolean
  readonly reason?: string
}

export interface TriggerDecisionTarget {
  readonly symbol: string
  readonly timeframe: string
  readonly predictionAlias?: string
}

/** PM 事件必须显式绑定当前 active 计划，并且重取同一时点合格快照；否则不猜交易标的。 */
export function resolvePredictionTriggerTarget(input: {
  readonly trigger: StoredTrigger
  readonly plans: PlanStore
  readonly predictions?: PmStore
  readonly symbols: readonly string[]
  readonly now: number
  readonly maxSnapshotAgeMs?: number
}): TriggerDecisionTarget | undefined {
  const encodedAlias = input.trigger.symbol?.startsWith('pm:') === true ? input.trigger.symbol.slice(3) : undefined
  if (encodedAlias === undefined || input.predictions === undefined) return undefined
  if (!isRecord(input.trigger.payload)) return undefined
  const detail = isRecord(input.trigger.payload['detail']) ? input.trigger.payload['detail'] : input.trigger.payload
  const alias = typeof detail['alias'] === 'string' ? detail['alias'] : undefined
  const planId = typeof detail['planId'] === 'string' ? detail['planId'] : undefined
  if (alias === undefined || alias !== encodedAlias || planId === undefined) return undefined
  const plan = input.plans.get(planId)
  if (plan === undefined || plan.windowEndsAt <= input.now || !input.symbols.includes(plan.symbol) ||
      input.plans.active(plan.symbol)?.planId !== planId) return undefined
  const snapshot = input.predictions.snapshotAt(input.now).find((item) => item.alias === alias)
  const maxSnapshotAgeMs = input.maxSnapshotAgeMs ?? 120_000
  if (!Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs <= 0 || snapshot === undefined ||
      !snapshot.probability.ok || !snapshot.liquidity.pass || snapshot.ageMs === null || snapshot.ageMs > maxSnapshotAgeMs) return undefined
  return { symbol: plan.symbol, timeframe: '1h', predictionAlias: alias }
}

export interface TriggerDispatchOutcome {
  readonly kind: 'idle' | 'processed' | 'retry' | 'rejected' | 'expired' | 'failed' | 'frozen'
  readonly triggerId?: string
  readonly runId?: string
  readonly source?: 'W2' | 'W3'
  readonly reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function timeframeOf(trigger: StoredTrigger): string | undefined {
  if (!isRecord(trigger.payload)) return undefined
  if (typeof trigger.payload['timeframe'] === 'string') return trigger.payload['timeframe']
  const detail = trigger.payload['detail']
  return isRecord(detail) && typeof detail['timeframe'] === 'string' ? detail['timeframe'] : undefined
}

function audit(
  journal: DecisionJournal,
  kind: string,
  trigger: StoredTrigger,
  now: number,
  extra: Readonly<Record<string, unknown>> = {},
): void {
  journal.appendAudit({
    actor: 'system',
    kind,
    payload: {
      triggerId: trigger.triggerId,
      dedupKey: trigger.dedupKey,
      symbol: trigger.symbol ?? null,
      purpose: trigger.purpose,
      disposition: trigger.disposition,
      attempts: trigger.attempts,
      createdAt: trigger.createdAt,
      expiresAt: trigger.expiresAt ?? null,
      ...extra,
    },
    ts: now,
  })
}

function failed(
  input: {
    readonly queue: TriggerQueue
    readonly journal: DecisionJournal
    readonly clock: Clock
    readonly trigger: StoredTrigger
    readonly runId?: string
    readonly reason: string
    readonly retryable: boolean
    readonly retryPolicy?: TriggerRetryPolicy
  },
): TriggerDispatchOutcome {
  const now = input.clock.now()
  const updated = input.queue.fail(input.trigger.triggerId, now, input.reason,
    input.retryable ? input.retryPolicy : { maxAttempts: input.trigger.attempts })
  const terminal = updated.state === 'failed' || updated.state === 'expired'
  const kind = updated.state === 'expired' ? 'expired' : terminal ? 'failed' : 'retry'
  audit(input.journal, kind === 'retry' ? 'trigger.retry_scheduled' : 'trigger.attempt_terminal', updated, now, {
    runId: input.runId ?? null,
    reason: updated.lastError ?? 'trigger attempt failed',
    nextAttemptAt: updated.nextAttemptAt,
    state: updated.state,
  })
  return {
    kind, triggerId: updated.triggerId,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    reason: updated.lastError ?? 'trigger attempt failed',
  }
}

/**
 * 领取并处理至多一条事件。队列状态先持久化再调用模型；所有拒绝、失败、过期都保留审计和错误原因。
 * provider 的瞬时失败重试同一 `runId`/冻结 context；成功或 REVIEW 均视为事件已消费。
 */
export async function dispatchNextTrigger(input: {
  readonly queue: TriggerQueue
  readonly journal: DecisionJournal
  readonly clock: Clock
  readonly budget: BudgetLedger
  readonly symbols: readonly string[]
  readonly timeframes: readonly string[]
  readonly dailyBudgetUsd?: number
  readonly dailyTokenCap?: number
  readonly limits?: WakeLimits
  readonly retryPolicy?: TriggerRetryPolicy
  readonly freezeSymbol?: (symbol: string) => void
  readonly halt?: () => void
  readonly run: (args: {
    readonly trigger: StoredTrigger
    readonly source: 'W2' | 'W3'
    readonly symbol: string
    readonly timeframe: string
    readonly predictionAlias?: string
  }) => Promise<TriggerDecisionResult>
  readonly resolvePredictionTrigger?: (trigger: StoredTrigger) => TriggerDecisionTarget | undefined
}): Promise<TriggerDispatchOutcome> {
  const now = input.clock.now()
  const maxAttempts = input.retryPolicy?.maxAttempts ?? DEFAULT_TRIGGER_RETRY_POLICY.maxAttempts
  for (const expired of input.queue.expire(now)) {
    audit(input.journal, 'trigger.expired', expired, now, { reason: expired.lastError })
  }
  for (const exhausted of input.queue.failExhausted(now, maxAttempts)) {
    audit(input.journal, 'trigger.attempt_terminal', exhausted, now, { reason: exhausted.lastError, state: exhausted.state })
  }
  const trigger = input.queue.claim(now, 1, maxAttempts)[0]
  if (trigger === undefined) return { kind: 'idle' }

  const source = trigger.purpose === 'novelty' ? 'W3' : 'W2'
  if (trigger.purpose === 'invalidation') {
    let frozenScope: string | undefined
    let freezeFailure: string | undefined
    try {
      if (trigger.symbol !== undefined && input.symbols.includes(trigger.symbol) && input.freezeSymbol !== undefined) {
        input.freezeSymbol(trigger.symbol)
        frozenScope = trigger.symbol
      } else if (input.halt !== undefined) {
        input.halt()
        frozenScope = 'all'
      }
    } catch (error) {
      freezeFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      try {
        if (input.halt !== undefined) {
          input.halt()
          frozenScope = 'all'
        }
      } catch (haltError) {
        freezeFailure += `; halt: ${haltError instanceof Error ? haltError.name : 'UnknownError'}`
      }
    }
    if (frozenScope === undefined) {
      return failed({
        queue: input.queue, journal: input.journal, clock: input.clock, trigger,
        reason: freezeFailure ?? `P0 invalidation 无法冻结标的：${trigger.symbol ?? 'missing'}；拒绝模型回退`,
        retryable: freezeFailure !== undefined,
        ...(input.retryPolicy === undefined ? {} : { retryPolicy: input.retryPolicy }),
      })
    }
    input.queue.markDone(trigger.triggerId)
    audit(input.journal, 'trigger.p0_frozen', trigger, input.clock.now(), {
      scope: frozenScope,
      reason: 'invalidation purpose never falls back to LLM',
      ...(freezeFailure === undefined ? {} : { freezeFailure }),
    })
    return { kind: 'frozen', triggerId: trigger.triggerId, source: 'W2', reason: `invalidation P0 已冻结 ${frozenScope}；没有模型调用` }
  }
  if (trigger.purpose !== 'novelty' && trigger.purpose !== 'commitment') {
    return failed({
      queue: input.queue, journal: input.journal, clock: input.clock, trigger,
      reason: `queued trigger purpose 不允许模型唤醒：${trigger.purpose}`,
      retryable: false,
    })
  }
  const expectedDisposition = source === 'W3' ? 'novelty' : 'judgment'
  if (trigger.disposition !== expectedDisposition) {
    return failed({
      queue: input.queue, journal: input.journal, clock: input.clock, trigger,
      reason: `trigger disposition 与 ${source} purpose 不一致：${trigger.disposition}`,
      retryable: false,
    })
  }
  let target: TriggerDecisionTarget | undefined
  if (trigger.symbol?.startsWith('pm:') === true) {
    try {
      target = input.resolvePredictionTrigger?.(trigger)
    } catch (error) {
      return failed({
        queue: input.queue, journal: input.journal, clock: input.clock, trigger,
        reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        retryable: true,
        ...(input.retryPolicy === undefined ? {} : { retryPolicy: input.retryPolicy }),
      })
    }
    if (target === undefined) {
      return failed({
        queue: input.queue, journal: input.journal, clock: input.clock, trigger,
        reason: 'PM W3 事件缺少仍 active 的 planId 映射或可见的合格 PIT 快照',
        retryable: false,
      })
    }
  } else {
    const symbol = trigger.symbol
    const timeframe = timeframeOf(trigger)
    if (symbol !== undefined && timeframe !== undefined) target = { symbol, timeframe }
  }
  const symbol = target?.symbol
  const timeframe = target?.timeframe
  if (symbol === undefined || !input.symbols.includes(symbol)) {
    return failed({
      queue: input.queue, journal: input.journal, clock: input.clock, trigger,
      reason: `触发器没有映射到配置内的可交易标的：${symbol ?? 'missing'}`,
      retryable: false,
    })
  }
  if (timeframe === undefined || !input.timeframes.includes(timeframe)) {
    return failed({
      queue: input.queue, journal: input.journal, clock: input.clock, trigger,
      reason: `触发器缺少配置内的时间框：${timeframe ?? 'missing'}`,
      retryable: false,
    })
  }

  const currentNow = input.clock.now()
  const dayStart = Math.floor(currentNow / DAY_MS) * DAY_MS
  const limits = input.limits ?? DEFAULT_TRIGGER_LIMITS
  const budget = input.dailyBudgetUsd === undefined || !Number.isFinite(input.dailyBudgetUsd) || input.dailyBudgetUsd <= 0
    ? { allow: false as const, reason: '未配置正数日预算，停止模型调用' }
    : input.budget.gate({
        at: currentNow,
        wake: source,
        dailyBudgetUsd: input.dailyBudgetUsd,
        ...(input.dailyTokenCap === undefined ? {} : { tokenCap: input.dailyTokenCap }),
      })
  const wake = decideWake({
    purpose: trigger.purpose,
    matchedCommitment: false,
    judgmentFiredLastHour: input.queue.countFiredSince(['commitment', 'invalidation'], currentNow - HOUR_MS, trigger.triggerId),
    judgmentFiredToday: input.queue.countFiredSince(['commitment', 'invalidation'], dayStart, trigger.triggerId),
    noveltyFiredLastHour: input.queue.countFiredSince(['novelty'], currentNow - HOUR_MS, trigger.triggerId),
    noveltyFiredToday: input.queue.countFiredSince(['novelty'], dayStart, trigger.triggerId),
    limits,
    budget,
  })
  if (wake.wake !== source) {
    const result = failed({
      queue: input.queue, journal: input.journal, clock: input.clock, trigger,
      reason: wake.reason,
      retryable: false,
    })
    audit(input.journal, 'trigger.wake_suppressed', trigger, input.clock.now(), { source, wake })
    return result
  }
  if (trigger.expiresAt !== undefined && input.clock.now() >= trigger.expiresAt) {
    const expired = input.queue.markExpired(trigger.triggerId, input.clock.now(), '模型调用前触发器已过期')
    audit(input.journal, 'trigger.expired', expired, input.clock.now(), { reason: expired.lastError })
    return { kind: 'expired', triggerId: trigger.triggerId, source, reason: expired.lastError ?? 'trigger expired' }
  }

  let result: TriggerDecisionResult
  try {
    result = await input.run({
      trigger, source, symbol, timeframe,
      ...(target?.predictionAlias === undefined ? {} : { predictionAlias: target.predictionAlias }),
    })
  } catch (error) {
    return failed({
      queue: input.queue, journal: input.journal, clock: input.clock, trigger,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      retryable: true,
      ...(input.retryPolicy === undefined ? {} : { retryPolicy: input.retryPolicy }),
    })
  }

  const finishedAt = input.clock.now()
  if (trigger.expiresAt !== undefined && finishedAt >= trigger.expiresAt) {
    const expired = input.queue.markExpired(trigger.triggerId, finishedAt, '模型返回时触发器已过期；拒绝旧触发动作')
    audit(input.journal, 'trigger.expired', expired, finishedAt, { runId: result.runId ?? null, reason: expired.lastError })
    return { kind: 'expired', triggerId: trigger.triggerId, source, runId: result.runId, reason: expired.lastError ?? 'trigger expired' }
  }
  if (result.retryable === true) {
    return failed({
      queue: input.queue, journal: input.journal, clock: input.clock, trigger,
      ...(result.runId === undefined ? {} : { runId: result.runId }),
      reason: result.reason ?? 'DecisionRuntime reported retryable model failure',
      retryable: true,
      ...(input.retryPolicy === undefined ? {} : { retryPolicy: input.retryPolicy }),
    })
  }
  input.queue.markDone(trigger.triggerId)
  audit(input.journal, 'trigger.processed', trigger, finishedAt, {
    source, runId: result.runId ?? null, status: result.status ?? null,
  })
  return { kind: 'processed', triggerId: trigger.triggerId, source, runId: result.runId }
}
