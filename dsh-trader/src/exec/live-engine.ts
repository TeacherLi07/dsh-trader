/**
 * 常驻进程的计划卡执行引擎（plan §3.5 / §6.2 / §7）。
 *
 * 它只消费已归档的收盘 bar；匹配仍走 matchPlan，动作仍走 executeAction。
 * 因此 live 与 replay 的区别是 bar 如何到达，而不是硬闸或下单逻辑如何实现。
 */

import { horizonMsForTimeframe } from '../memory/settle.js'
import { createFeatureContext } from '../market/context.js'
import type { FeatureSnapshot } from '../market/features.js'
import { timeframeMs } from '../market/normalize.js'
import type { Candle } from '../market/types.js'
import { matchPlan, planDedupKey, type MatchOutcome } from '../plan/match.js'
import { computeContentHash, validatePlanCard, type PlanCard } from '../plan/schema.js'
import type { TriggerQueue } from '../trigger/queue.js'
import { TriggerGovernor } from '../trigger/engine.js'
import type { Clock } from '../clock.js'
import { checkLimitsConsistency, type RiskLimits, type RunMode } from '../config.js'
import type { Broker } from './broker.js'
import {
  executeAction,
  primaryClientOrderId,
  protectiveClientOrderId,
  type ExecuteActionResult,
} from './execute-action.js'
import { DecisionJournal } from './journal.js'
import { BarArchive } from '../market/archive.js'
import { PlanStore } from '../plan/store.js'

/** FeatureEngine/FeaturePipeline 或已经由行情层写好的 FeatureArchive 都满足这个接口。 */
export interface LiveFeatureSource {
  /** 实时路径：消费 bar 并推进增量指标状态。 */
  onClosedCandle?(candle: Candle): FeatureSnapshot
  /** 组合根已由行情层推进特征时，直接读取同一根 bar 的归档快照。 */
  get?(symbol: string, timeframe: string, openTime: number): FeatureSnapshot | undefined
}

export interface LiveEngineDeps {
  readonly journal: DecisionJournal
  readonly plans: PlanStore
  readonly bars: BarArchive
  readonly features: LiveFeatureSource
  readonly broker: Broker
  readonly clock: Clock
  readonly mode: RunMode
  readonly liveArmed?: boolean
  readonly limits: RiskLimits | null
  readonly waiver?: boolean
  readonly riskPct: number
  readonly reflectionHorizonMs?: number
  /** 可选持久触发队列；未注入时由 engine 内存集合承担同一进程内去重。 */
  readonly queue?: TriggerQueue
  /** W2 缺口触发的 TTL；过期事件不能再拿旧行情执行动作。 */
  readonly triggerTtlMs?: number
  readonly triggerCooldownMs?: number
  /** 冻结标的（对账/恢复未决，plan §4.2/§6.3）；透传给硬闸，禁止增加敞口。 */
  readonly frozenSymbols?: () => ReadonlySet<string>
  readonly freezeSymbol?: (symbol: string) => void
  readonly halt?: () => void
}

export interface ClosedBarInput {
  readonly symbol: string
  readonly timeframe: string
  /** `bars.open_time`；与 replay 的 `barTs` 保持同一幂等根。 */
  readonly barTs: number
}

export type LiveResultKind = 'executed' | 'denied' | 'uncovered' | 'expired' | 'noop'

export interface LiveEngineResult {
  /** 便于调用方按 match/replay 的风格消费结果。 */
  readonly kind: LiveResultKind
  /** 与 kind 同值，给只关心状态机的审计/监控调用方一个稳定字段。 */
  readonly status: LiveResultKind
  readonly planId?: string
  readonly conditionId?: string
  readonly decisionId?: string
  readonly reason?: string
}

function result(kind: LiveResultKind, extra: Omit<LiveEngineResult, 'kind' | 'status'> = {}): LiveEngineResult {
  return { kind, status: kind, ...extra }
}

function barKey(symbol: string, timeframe: string, barTs: number): string {
  return `${symbol}|${timeframe}|${barTs}`
}

function actionClientOrderIds(plan: PlanCard, conditionId: string, barTs: number): readonly string[] {
  // 与 execute-action 用同一套确定性**数字** id，否则 #alreadyFired 的对账会与真实下单键不一致。
  return [
    primaryClientOrderId(plan.planId, conditionId, barTs),
    protectiveClientOrderId(plan.planId, conditionId, barTs),
  ]
}

export class LiveEngine {
  #snapshots = new Map<string, FeatureSnapshot>()
  #fired = new Set<string>()
  /** plan §12 #17 的一次性自洽校验：live 模式只有首次读到账户后才知道权益。 */
  #limitsChecked = false

  constructor(private readonly deps: LiveEngineDeps) {}

  /**
   * 消费一根已经收盘的 bar。账户和持仓只在计划确实需要判定时重取，且每次调用都重新读取，
   * 不使用上一次上下文里的数字做硬闸计算。
   */
  async onClosedBar(input: ClosedBarInput): Promise<LiveEngineResult> {
    const now = this.deps.clock.now()
    const bar = this.deps.bars.closedBars(input.symbol, input.timeframe, {
      since: input.barTs,
      until: input.barTs + 1,
      limit: 1,
    })[0]
    if (bar === undefined) {
      return result('noop', { reason: `找不到已归档 bar：${barKey(input.symbol, input.timeframe, input.barTs)}` })
    }
    if (!bar.closed || bar.closeTime > now) {
      return result('noop', { reason: 'bar 尚未收盘' })
    }

    const snapshot = this.#snapshotFor(bar)
    let plan: PlanCard | undefined
    try {
      plan = this.deps.plans.active(input.symbol)
    } catch (error) {
      let freezeAttempted = false
      try {
        this.deps.freezeSymbol?.(input.symbol)
        freezeAttempted = this.deps.freezeSymbol !== undefined
      } catch { /* 失败原因由同一审计事件保留为错误类型，不让异常吞掉 UNCOVERED。 */ }
      this.deps.journal.appendAudit({
        actor: 'system', kind: 'plan.active_read_failed',
        payload: {
          symbol: input.symbol, timeframe: input.timeframe, barTs: input.barTs,
          errorType: error instanceof Error ? error.name : 'UnknownError', freezeAttempted,
        },
        ts: now,
      })
      return result('uncovered', { reason: 'active plan 无法读取；已冻结或必须人工冻结该标的' })
    }
    if (plan === undefined) return result('noop', { reason: '无 active 计划卡' })
    if (now > plan.windowEndsAt) {
      this.deps.plans.expire(now)
      return result('expired', { planId: plan.planId, reason: '计划卡已到期' })
    }
    const planValidation = validatePlanCard(plan)
    const contentHashMatches = plan.contentHash === computeContentHash(plan)
    if (!planValidation.ok || !contentHashMatches) {
      let freezeAttempted = false
      try {
        this.deps.freezeSymbol?.(input.symbol)
        freezeAttempted = this.deps.freezeSymbol !== undefined
      } catch { /* 保留审计并 fail-closed；不因 freeze 异常继续执行脏计划。 */ }
      this.deps.journal.appendAudit({
        actor: 'system', kind: 'plan.active_invalid',
        payload: {
          planId: plan.planId, symbol: input.symbol, timeframe: input.timeframe, barTs: input.barTs,
          validationErrorCount: planValidation.ok ? 0 : planValidation.errors.length,
          contentHashMatches, freezeAttempted,
        },
        ts: now,
      })
      return result('uncovered', { planId: plan.planId, reason: 'active plan schema/contentHash 无效；已冻结或必须人工冻结该标的' })
    }

    // 只有 active 且未过期的计划需要账户/持仓；这里每次 onClosedBar 都从 broker 重取。
    const account = await this.deps.broker.getAccount()
    // plan §12 #17：live 模式的权益此刻才知道 ⇒ 首次读到账户时做一次性自洽校验并落审计。
    // 不自洽 = 每一单都会被 perOrderCapUsd 打回（"看起来在跑"却永远不成交），必须留下证据。
    if (!this.#limitsChecked) {
      this.#limitsChecked = true
      const limits = this.deps.limits
      if (limits !== null) {
        const inconsistent = checkLimitsConsistency({
          equityQuoteUsd: account.equityQuote,
          riskPct: this.deps.riskPct,
          perOrderCapUsd: limits.perOrderCapUsd,
        })
        if (inconsistent !== null) {
          this.deps.journal.appendAudit({
            actor: 'system',
            kind: 'limits_inconsistent',
            payload: {
              symbol: input.symbol,
              reason: inconsistent,
              equityQuoteUsd: account.equityQuote,
              riskPct: this.deps.riskPct,
              perOrderCapUsd: limits.perOrderCapUsd,
            },
            ts: now,
          })
        }
      }
    }
    const positions = await this.deps.broker.getPositions()
    const position = positions.find((candidate) => candidate.symbol === input.symbol)
    // 前一根已收盘 bar 的快照：`cross*` 要用它做边沿判定。取不到就不注入 `previous`，
    // 让 cross 求值 fail-closed 成 UNCOVERED，而不是静默当成"没有穿越"。
    const previousSnapshot = this.deps.features.get?.(
      input.symbol,
      input.timeframe,
      input.barTs - timeframeMs(input.timeframe),
    )
    const context = createFeatureContext(snapshot, {
      extra: {
        'position.qty': position?.qty ?? 0,
        'position.avgPrice': position?.avgPrice ?? 0,
        'position.unrealizedPnl': position?.unrealizedPnlUsd ?? 0,
        'equity.quote': account.equityQuote,
        'price.last': bar.close,
        // 计划窗口从 createdAt 起算；使用 bar closeTime 使 replay/live 在同一 bar 上一致。
        'plan.ageMs': bar.closeTime - plan.createdAt,
        'window.sinceMs': bar.closeTime - plan.createdAt,
      },
      ...(previousSnapshot === undefined ? {} : { previous: previousSnapshot }),
    })

    const outcome = matchPlan({
      plan,
      timeframe: input.timeframe,
      barTs: input.barTs,
      now,
      context,
      alreadyFired: (dedupKey) => this.#alreadyFired(plan, dedupKey, input.barTs),
    })

    if (outcome.kind === 'expired') {
      this.deps.plans.expire(now)
      return result('expired', { planId: plan.planId, reason: '计划卡已到期' })
    }
    if (outcome.kind === 'uncovered') {
      this.#recordUncovered(plan, outcome, input, now)
      return result('uncovered', {
        planId: plan.planId,
        conditionId: outcome.id,
        reason: outcome.reason,
      })
    }
    if (outcome.kind === 'none') return result('noop', { planId: plan.planId, reason: '无命中' })

    const execution = await executeAction({
      journal: this.deps.journal,
      broker: this.deps.broker,
      clock: this.deps.clock,
      plan,
      conditionId: outcome.id,
      action: outcome.action,
      symbol: input.symbol,
      timeframe: input.timeframe,
      barTs: input.barTs,
      referencePrice: bar.close,
      atr: snapshot.values.atr14,
      account,
      position,
      riskPct: this.deps.riskPct,
      mode: this.deps.mode,
      liveArmed: this.deps.liveArmed === true,
      limits: this.deps.limits,
      waiver: this.deps.waiver === true,
      reflectionHorizonMs:
        this.deps.reflectionHorizonMs ?? horizonMsForTimeframe(input.timeframe),
      alreadyIntended: (clientOrderId) => this.deps.journal.hasClientOrderId(clientOrderId),
      ...(this.deps.frozenSymbols === undefined ? {} : { frozenSymbols: this.deps.frozenSymbols }),
      ...(this.deps.freezeSymbol === undefined ? {} : { freezeSymbol: this.deps.freezeSymbol }),
      ...(this.deps.halt === undefined ? {} : { halt: this.deps.halt }),
    })

    this.#markFired(plan, outcome, input, execution, now)
    return this.#executionResult(plan, outcome, execution)
  }

  #snapshotFor(bar: Candle): FeatureSnapshot {
    const key = barKey(bar.symbol, bar.timeframe, bar.openTime)
    const cached = this.#snapshots.get(key)
    if (cached !== undefined) return cached
    const snapshot =
      this.deps.features.onClosedCandle?.(bar) ??
      this.deps.features.get?.(bar.symbol, bar.timeframe, bar.openTime)
    if (snapshot === undefined) {
      // 没有快照时不能拿单根 bar 猜出 EMA/ATR；那会把暖机缺数据误当成可交易信号。
      throw new Error(`缺少特征快照：${bar.symbol} ${bar.timeframe} ${bar.openTime}`)
    }
    this.#snapshots.set(key, snapshot)
    return snapshot
  }

  #alreadyFired(plan: PlanCard, dedupKey: string, barTs: number): boolean {
    if (this.#fired.has(dedupKey) || this.deps.queue?.has(dedupKey) === true) return true
    const condition = [...plan.invalidation, ...plan.commitments].find(
      (candidate) => planDedupKey(plan.planId, candidate.id, plan.symbol, barTs) === dedupKey,
    )
    if (condition === undefined) return false
    // journal 中的任一动作意图存在就视为该计划条件已经消耗，涵盖 primary/protective 两类键。
    return actionClientOrderIds(plan, condition.id, barTs).some((clientId) =>
      this.deps.journal.hasClientOrderId(clientId),
    )
  }

  #markFired(
    plan: PlanCard,
    outcome: Exclude<MatchOutcome, { kind: 'expired' | 'none' | 'uncovered' }>,
    input: ClosedBarInput,
    execution: ExecuteActionResult,
    now: number,
  ): void {
    this.#fired.add(outcome.dedupKey)
    const payload = {
      planId: plan.planId,
      conditionId: outcome.id,
      expression: outcome.expression,
      executed: execution.executed,
      denied: execution.denied,
      reason: execution.reason ?? null,
    }
    if (this.deps.queue !== undefined) {
      this.deps.queue.enqueue({
        triggerId: outcome.dedupKey,
        dedupKey: outcome.dedupKey,
        symbol: input.symbol,
        ruleId: `${plan.planId}:${outcome.id}`,
        purpose: outcome.kind,
        barTs: input.barTs,
        disposition: 'executed',
        state: 'done',
        createdAt: now,
        payload,
      })
      return
    }
    this.deps.journal.appendAudit({
      actor: 'system',
      kind: 'plan.matched',
      payload,
      ts: now,
    })
  }

  #recordUncovered(plan: PlanCard, outcome: Extract<MatchOutcome, { kind: 'uncovered' }>, input: ClosedBarInput, now: number): void {
    const invalidation = plan.invalidation.some((condition) => condition.id === outcome.id)
    let triggerQueued = false
    let triggerDisposition: string = invalidation ? 'p0-freeze' : 'not-queued'
    let freezeAttempted = false
    let freezeError: string | undefined
    if (invalidation) {
      // 失效条件无法求值时不能等模型猜测；先冻结该标的，再由人工/后续判断恢复。
      if (this.deps.freezeSymbol !== undefined) {
        try {
          this.deps.freezeSymbol(input.symbol)
          freezeAttempted = true
        } catch (error) {
          freezeError = String(error)
        }
      }
    } else if (this.deps.queue !== undefined) {
      const ttlMs = this.deps.triggerTtlMs ?? 60 * 60_000
      const cooldownMs = this.deps.triggerCooldownMs ?? 15 * 60_000
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isFinite(now + ttlMs)) {
        throw new Error(`triggerTtlMs 必须是正的安全整数：${String(ttlMs)}`)
      }
      if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0) throw new Error('triggerCooldownMs 必须是非负安全整数')
      const condition = plan.commitments.find((item) => item.id === outcome.id)
      const decision = new TriggerGovernor(this.deps.queue, this.deps.clock).submit({
        ruleId: `${plan.planId}:${outcome.id}`,
        purpose: 'commitment',
        symbol: input.symbol,
        timeframe: input.timeframe,
        barTs: input.barTs,
        severity: 'P1',
        expression: condition?.when ?? `uncovered:${outcome.id}`,
        dedupKey: outcome.dedupKey,
      }, {
        cooldownMs,
        ttlMs,
        payload: {
          wake: 'W2',
          planId: plan.planId,
          conditionId: outcome.id,
          reason: outcome.reason,
        },
      })
      triggerDisposition = decision.disposition.kind
      triggerQueued = decision.disposition.kind === 'judgment' && decision.persisted
    }

    // 没有 queue 也不能把求值失败变成静默 no-op；审计里保留 UNCOVERED 和原因。
    this.deps.journal.appendAudit({
      actor: 'system',
      kind: 'plan.uncovered',
      payload: {
        status: 'UNCOVERED',
        planId: plan.planId,
        conditionId: outcome.id,
        symbol: input.symbol,
        timeframe: input.timeframe,
        barTs: input.barTs,
        reason: outcome.reason,
        wake: invalidation ? (freezeAttempted ? 'P0_FREEZE' : 'P0_FREEZE_REQUIRED') : 'W2',
        triggerQueued,
        triggerDisposition,
        freezeAttempted,
        freezeError: freezeError ?? null,
      },
      ts: now,
    })
  }

  #executionResult(
    plan: PlanCard,
    outcome: Exclude<MatchOutcome, { kind: 'expired' | 'none' | 'uncovered' }>,
    execution: ExecuteActionResult,
  ): LiveEngineResult {
    const kind: LiveResultKind = execution.denied
      ? 'denied'
      : execution.executed
        ? 'executed'
        : 'noop'
    return result(kind, {
      planId: plan.planId,
      conditionId: outcome.id,
      decisionId: execution.decisionId,
      ...(execution.reason === undefined ? {} : { reason: execution.reason }),
    })
  }
}

export function createLiveEngine(deps: LiveEngineDeps): LiveEngine {
  return new LiveEngine(deps)
}
