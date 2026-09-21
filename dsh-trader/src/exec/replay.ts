/**
 * 确定性回放（plan §10 P0 验收 ②③ / T0.8b）。
 *
 * 一条链路走到底：**bar → 保护单检查 → 特征 → 计划卡匹配 → 执行(硬闸) → 规则/触发**。
 * 全部时间来自注入的 `Clock`、全部价格来自归档 bar，因此"回放两遍结果完全一致"可被断言。
 *
 * 日志契约（验收 ③「每次命中都能归因」）：
 *   · `matched:<conditionId>`  —— 计划卡条件命中并确定性执行（零 token）
 *   · `UNCOVERED:<reason>`     —— 计划卡条件无法求值
 *   · `UNCOVERED:rule:<ruleId>` —— 判断类规则命中但计划卡没覆盖（W2 输入）
 *   · `rule:<ruleId>:<disposition>` —— 每条规则命中都有一条归属记录
 *   · `denied:<conditionId>:<reason>` —— 被硬闸拒绝
 */

import type Database from 'better-sqlite3'
import { ReplayClock, type Clock } from '../clock.js'
import type { RiskLimits, RunMode } from '../config.js'
import { BarArchive } from '../market/archive.js'
import { createFeatureContext } from '../market/context.js'
import { FeatureEngine, type FeatureSnapshot } from '../market/features.js'
import { matchPlan, planDedupKey } from '../plan/match.js'
import { horizonMsForTimeframe } from '../memory/settle.js'
import type { PlanAction } from '../plan/schema.js'
import { PlanStore } from '../plan/store.js'
import { RuleWatch, TriggerGovernor, type RuleSpec } from '../trigger/engine.js'
import type { TriggerQueue } from '../trigger/queue.js'
import type { OrderAck, Broker } from './broker.js'
import { executeAction } from './execute-action.js'
import { DecisionJournal } from './journal.js'

/** 纸面/回放 broker 额外提供"用一根 bar 推进撮合"的能力。 */
export interface ReplayBroker extends Broker {
  onBar(symbol: string, candle: { high: number; low: number; close: number }): readonly OrderAck[]
  realizedPnl?(): number
}

export interface ReplayDeps {
  readonly db: Database.Database
  readonly bars: BarArchive
  readonly plans: PlanStore
  readonly queue: TriggerQueue
  readonly broker: ReplayBroker
  readonly clock: Clock
  readonly rules?: readonly RuleSpec[]
  readonly riskPct: number
  readonly mode: RunMode
  readonly liveArmed?: boolean
  readonly limits: RiskLimits | null
  readonly waiver?: boolean
  /** 结算视界（plan §7.9 / §12 #18）；省略时按 `timeframe` 推导（4 根 bar 夹在 4h–24h）。 */
  readonly reflectionHorizonMs?: number
  /** 判断通道（W2/W3）。不注入 = A 臂（纯机械执行）。 */
  readonly judgment?: JudgmentChannel
}

export interface ReplayRequest {
  readonly symbol: string
  readonly timeframe: string
  readonly since: number
  readonly until: number
  readonly maxBars?: number
}

export interface ReplayCounters {
  readonly bars: number
  readonly matched: number
  readonly uncovered: number
  readonly denied: number
  readonly executed: number
}

export interface ReplayResult {
  readonly counters: ReplayCounters
  readonly decisionIds: readonly string[]
  readonly intentIds: readonly string[]
  readonly clientOrderIds: readonly string[]
  readonly fillIds: readonly string[]
  readonly triggerKeys: readonly string[]
  readonly log: readonly string[]
  /** 恒应为 0（`client_order_id` 唯一约束）—— P0 验收 ② 的硬指标。 */
  readonly duplicateClientOrderIds: number
  readonly realizedPnl: number
  /** 每笔已实现盈亏（按产生顺序）—— P1.5 闸门要的是分布，不是一个总和。 */
  readonly tradePnl: readonly number[]
  /** 判断通道的裁决计数（A/B 闸门的两臂差异来源）。 */
  readonly judgment: JudgmentCounters
}

/** 判断通道（W2/W3）在一次命中上的裁决。 */
export interface JudgmentVerdict {
  readonly approve: boolean
  readonly reason: string
}

export interface JudgmentInput {
  readonly symbol: string
  readonly timeframe: string
  readonly barTs: number
  readonly planId: string
  readonly conditionId: string
  readonly expression: string
  readonly action: PlanAction
  readonly referencePrice: number
  readonly atr: number | null
  readonly equityQuote: number
  readonly positionQty: number
}

/**
 * 判断通道钩子（plan §10 P1.5）。
 * A 臂（机械执行）不注入它；B 臂注入它，于是两臂唯一差异就是"判断层是否经手"。
 */
export type JudgmentChannel = (input: JudgmentInput) => Promise<JudgmentVerdict>

export interface JudgmentCounters {
  readonly reviewed: number
  readonly approved: number
  readonly vetoed: number
}


function advanceClock(clock: Clock, ts: number): void {
  if (clock instanceof ReplayClock) clock.advanceTo(ts)
}

export async function replay(deps: ReplayDeps, request: ReplayRequest): Promise<ReplayResult> {
  const bars = deps.bars.closedBars(request.symbol, request.timeframe, {
    since: request.since,
    until: request.until,
    limit: request.maxBars ?? 100_000,
  })

  const journal = new DecisionJournal(deps.db)
  const engine = new FeatureEngine()
  const watch =
    deps.rules !== undefined && deps.rules.length > 0
      ? new RuleWatch(deps.rules, new TriggerGovernor(deps.queue, deps.clock))
      : undefined

  const log: string[] = []
  let matched = 0
  let uncovered = 0
  let denied = 0
  let executed = 0
  let reviewed = 0
  let approved = 0
  let vetoed = 0
  const tradePnl: number[] = []
  let lastRealized = deps.broker.realizedPnl?.() ?? 0

  /** 每根 bar 后把新实现的盈亏记成一笔 —— 闸门要的是分布而不是总和。 */
  const samplePnl = (): void => {
    const now = deps.broker.realizedPnl?.() ?? 0
    const delta = now - lastRealized
    if (delta !== 0) tradePnl.push(delta)
    lastRealized = now
  }

  // `cross*` 需要前一根 bar 的取值；回放按序推进，直接留住上一根的增量快照即可。
  let previousSnapshot: FeatureSnapshot | undefined

  for (const bar of bars) {
    // 1) 时钟推进到本 bar 收盘；保护单先按 bar 的 high/low 触发（毫秒级不依赖 LLM）
    advanceClock(deps.clock, bar.closeTime)
    const protectiveFills = deps.broker.onBar(request.symbol, {
      high: bar.high,
      low: bar.low,
      close: bar.close,
    })
    // 保护单在 bar 内触发也是**成交**，必须落库（plan §13.7 审计优先 / §5.3 用真实成交）。
    // 否则 fills 表只有入场腿，出场腿缺失，且恢复/对账看到的成交不完整。
    for (const ack of protectiveFills) {
      if (ack.state !== 'filled' || ack.exchangeOrderId === undefined) continue
      const intentRow = journal.intentByClientOrderId(ack.clientOrderId)
      if (intentRow === undefined || intentRow.qty === null) continue
      journal.recordFill({
        fillId: `fill:${ack.exchangeOrderId}`,
        orderId: ack.exchangeOrderId,
        qty: intentRow.qty,
        price: ack.avgPrice ?? intentRow.price ?? bar.close,
        fee: ack.fee ?? 0,
        feeCurrency: 'USDT',
        ts: deps.clock.now(),
      })
    }

    // 2) 特征（增量）
    const snapshot = engine.onClosedCandle(bar)

    // 3) 实时重取账户与持仓（上下文里的数字只用于"理解"，不用于"计算"）
    const account = await deps.broker.getAccount()
    const positions = await deps.broker.getPositions()
    const position = positions.find((candidate) => candidate.symbol === request.symbol)

    // 4) 计划卡：先取 active（context 需要按计划计算 plan.ageMs / window.sinceMs）
    const plan = deps.plans.active(request.symbol)

    const context = createFeatureContext(snapshot, {
      extra: {
        'position.qty': position?.qty ?? 0,
        'position.avgPrice': position?.avgPrice ?? 0,
        'position.unrealizedPnl': position?.unrealizedPnlUsd ?? 0,
        'equity.quote': account.equityQuote,
        'price.last': bar.close,
        // v0 计划卡的窗口 = [createdAt, windowEndsAt]；窗口开始即计划创建时刻。
        // 这两个取值在 §3.2 词汇表里，必须真的提供，否则引用它们的计划卡永远 UNCOVERED。
        ...(plan === undefined
          ? {}
          : { 'plan.ageMs': bar.closeTime - plan.createdAt, 'window.sinceMs': bar.closeTime - plan.createdAt }),
      },
      ...(previousSnapshot === undefined ? {} : { previous: previousSnapshot }),
    })

    let matchedThisBar = false
    if (plan !== undefined) {
      const outcome = matchPlan({
        plan,
        timeframe: request.timeframe,
        barTs: bar.openTime,
        now: bar.closeTime,
        context,
        alreadyFired: (dedupKey) => deps.queue.has(dedupKey),
      })

      if (outcome.kind === 'invalidation' || outcome.kind === 'commitment') {
        matchedThisBar = true
        matched += 1
        log.push(`matched:${outcome.id}`)

        // 判断通道（B 臂）在机械命中之后、执行之前介入；否决也要留痕
        let vetoedHere = false
        if (deps.judgment !== undefined) {
          reviewed += 1
          const verdict = await deps.judgment({
            symbol: request.symbol,
            timeframe: request.timeframe,
            barTs: bar.openTime,
            planId: plan.planId,
            conditionId: outcome.id,
            expression: outcome.expression,
            action: outcome.action,
            referencePrice: bar.close,
            atr: snapshot.values.atr14,
            equityQuote: account.equityQuote,
            positionQty: position?.qty ?? 0,
          })
          if (verdict.approve) {
            approved += 1
            log.push(`judgment:approve:${outcome.id}:${verdict.reason}`)
          } else {
            vetoed += 1
            vetoedHere = true
            log.push(`judgment:veto:${outcome.id}:${verdict.reason}`)
          }
        }

        const result = vetoedHere
          ? { executed: false, decisionId: `veto:${outcome.id}`, reason: 'judgment_veto' }
          : await executeAction({
              journal,
              broker: deps.broker,
              clock: deps.clock,
              plan,
              conditionId: outcome.id,
              action: outcome.action,
              symbol: request.symbol,
              timeframe: request.timeframe,
              barTs: bar.openTime,
              referencePrice: bar.close,
              atr: snapshot.values.atr14,
              account,
              position,
              riskPct: deps.riskPct,
              mode: deps.mode,
              liveArmed: deps.liveArmed === true,
              limits: deps.limits,
              waiver: deps.waiver === true,
              reflectionHorizonMs:
                deps.reflectionHorizonMs ?? horizonMsForTimeframe(request.timeframe),
              alreadyIntended: (clientOrderId) => journal.hasClientOrderId(clientOrderId),
            })
        // 计划条件命中也要落库：这样 `alreadyFired` 才能跨重启工作，审计里也能看到"执行了什么"
        deps.queue.enqueue({
          triggerId: planDedupKey(plan.planId, outcome.id, request.symbol, bar.openTime),
          dedupKey: planDedupKey(plan.planId, outcome.id, request.symbol, bar.openTime),
          symbol: request.symbol,
          ruleId: `${plan.planId}:${outcome.id}`,
          purpose: outcome.kind,
          barTs: bar.openTime,
          disposition: 'executed',
          state: 'done',
          createdAt: deps.clock.now(),
          payload: {
            planId: plan.planId,
            conditionId: outcome.id,
            expression: outcome.expression,
            executed: result.executed,
            reason: result.reason ?? null,
          },
        })
        if (result.executed) executed += 1
        else if (!vetoedHere) {
          denied += 1
          log.push(`denied:${outcome.id}:${result.reason ?? 'unknown'}`)
        }
      } else if (outcome.kind === 'uncovered') {
        uncovered += 1
        log.push(`UNCOVERED:${outcome.reason}`)
      } else if (outcome.kind === 'expired') {
        deps.plans.expire(bar.closeTime)
      }
    }

    // 5) 规则与触发治理
    if (watch !== undefined) {
      const outcome = watch.onBar({
        symbol: request.symbol,
        timeframe: request.timeframe,
        barTs: bar.openTime,
        context,
      })
      for (const hit of outcome.hits) {
        const decision = outcome.decisions.find((candidate) => candidate.dedupKey === hit.dedupKey)
        log.push(`rule:${hit.ruleId}:${decision?.disposition.kind ?? 'unknown'}`)
        if (
          (hit.purpose === 'commitment' || hit.purpose === 'invalidation') &&
          !matchedThisBar
        ) {
          uncovered += 1
          log.push(`UNCOVERED:rule:${hit.ruleId}`)
        }
      }
    }

    // 每根 bar 结束都采样一次：保护单可能在 onBar 阶段就平掉了仓位（与计划卡是否命中无关）。
    // 旧实现只在计划卡命中后采样，漏掉了"止损在非命中 bar 触发"的盈亏（实测 realizedPnl=0）。
    samplePnl()
    // 本根成为下一根 bar 的"前值"（cross* 用）
    previousSnapshot = snapshot
  }

  return {
    counters: { bars: bars.length, matched, uncovered, denied, executed },
    decisionIds: journal.decisionIds(),
    intentIds: journal.intentIds(),
    clientOrderIds: journal.clientOrderIds(),
    fillIds: journal.fillIds(),
    triggerKeys: journal.triggerKeys(),
    log,
    duplicateClientOrderIds: journal.duplicateClientOrderIds(),
    realizedPnl: deps.broker.realizedPnl?.() ?? lastRealized,
    tradePnl,
    judgment: { reviewed, approved, vetoed },
  }
}
