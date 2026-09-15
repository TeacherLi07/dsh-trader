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
import { FeatureEngine } from '../market/features.js'
import { matchPlan, planDedupKey } from '../plan/match.js'
import {
  toDecisionAction,
  type LevelAction,
  type OpenAction,
  type PlanAction,
  type PlanCard,
  type ReduceAction,
  type TrailingAction,
} from '../plan/schema.js'
import { PlanStore } from '../plan/store.js'
import { RuleWatch, TriggerGovernor, type RuleSpec } from '../trigger/engine.js'
import type { TriggerQueue } from '../trigger/queue.js'
import { fingerprint } from '../util/canonical.js'
import { ALLOW, validateIntent, type GatePolicy } from './gate.js'
import type { AccountSnapshot, Broker, OrderAck, OrderRequest, PositionSnapshot } from './broker.js'
import { DecisionJournal } from './journal.js'
import { computeSize, stopPriceFor, takeProfitFor } from './sizing.js'

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
  readonly limits: RiskLimits | null
  /** 结算视界（plan §7.9）；默认 4h，与 `DEFAULT_REFLECTION_HORIZON_MS` 同值。 */
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


interface ExecuteArgs {
  readonly journal: DecisionJournal
  readonly broker: Broker
  readonly clock: Clock
  readonly plan: PlanCard
  readonly conditionId: string
  readonly action: PlanAction
  readonly symbol: string
  readonly barTs: number
  readonly referencePrice: number
  readonly atr: number | null
  readonly account: AccountSnapshot
  readonly position: PositionSnapshot | undefined
  readonly riskPct: number
  readonly mode: RunMode
  readonly limits: RiskLimits | null
  readonly reflectionHorizonMs: number
  readonly alreadyIntended: (clientOrderId: string) => boolean
}

interface ExecuteOutcome {
  readonly executed: boolean
  readonly reason?: string
  readonly decisionId: string
}

function advanceClock(clock: Clock, ts: number): void {
  if (clock instanceof ReplayClock) clock.advanceTo(ts)
}

async function executePlanAction(args: ExecuteArgs): Promise<ExecuteOutcome> {
  const now = args.clock.now()
  const decisionId = `dec:${args.plan.planId}:${args.conditionId}:${args.symbol}:${args.barTs}`
  const clientOrderId = `co:${args.plan.planId}:${args.conditionId}:${args.barTs}`
  const contextHash = fingerprint({
    planId: args.plan.planId,
    conditionId: args.conditionId,
    symbol: args.symbol,
    barTs: args.barTs,
  })
  const action = args.action

  const record = (
    executed: boolean,
    extra: { sizeQty?: number; stopPrice?: number; takeProfit?: number; rationale?: string } = {},
  ): void => {
    args.journal.recordDecision({
      decisionId,
      symbol: args.symbol,
      planId: args.plan.planId,
      decidedAt: now,
      contextHash,
      action: toDecisionAction(action.action),
      executed,
      ...extra,
    })
  }

  // ── 无订单动作 ────────────────────────────────────────────────────────────
  if (action.action === 'noop') {
    record(false, { rationale: 'noop' })
    return { executed: false, reason: 'noop', decisionId }
  }
  if (action.action === 'escalate') {
    record(false, { rationale: action.reason })
    return { executed: false, reason: `escalate:${action.reason}`, decisionId }
  }
  if (action.action === 'halt') {
    record(true, { rationale: action.reason ?? 'halt' })
    return { executed: true, decisionId }
  }
  if (action.action === 'cancel_all') {
    await args.broker.cancelAll(action.scope === 'all' ? undefined : args.symbol)
    record(true)
    return { executed: true, decisionId }
  }
  if (action.action === 'set_stop' || action.action === 'set_target' || action.action === 'set_trailing') {
    if (args.position === undefined || args.position.qty === 0) {
      record(false, { rationale: '无持仓，无法挂保护单' })
      return { executed: false, reason: '无持仓', decisionId }
    }
    const protective =
      action.action === 'set_stop'
        ? { stopLossPrice: (action as LevelAction).price }
        : action.action === 'set_target'
          ? { takeProfitPrice: (action as LevelAction).price }
          : { trailingPercent: (action as TrailingAction).percent }
    const protectiveClientId = `pco:${args.plan.planId}:${args.conditionId}:${args.barTs}`
    // ★ 顺序：先写决策（`order_intents.decision_id` 有外键），再写意图，最后才发请求。
    // 旧实现先 recordIntent 后 record(true)，任何 set_stop 都会撞外键直接崩掉整个回放（实测）。
    record(true)
    args.journal.recordIntent({
      intentId: `pi:${decisionId}`,
      clientOrderId: protectiveClientId,
      decisionId,
      venue: args.broker.venue,
      symbol: args.symbol,
      state: 'created',
      type: 'protective',
      side: (args.position.qty ?? 0) > 0 ? 'sell' : 'buy',
      qty: Math.abs(args.position.qty),
      reduceOnly: true,
      createdAt: now,
    })
    const ack = await args.broker.placeProtective({
      symbol: args.symbol,
      clientOrderId: protectiveClientId,
      ...protective,
    })
    args.journal.markIntentAcked(
      protectiveClientId,
      ack.state === 'filled' ? 'filled' : ack.state === 'rejected' ? 'rejected' : 'acked',
      ack.exchangeOrderId,
      now,
    )
    if (ack.exchangeOrderId !== undefined) {
      args.journal.recordOrder({
        orderId: ack.exchangeOrderId,
        venue: args.broker.venue,
        exchangeOrderId: ack.exchangeOrderId,
        clientOrderId: protectiveClientId,
        symbol: args.symbol,
        status: ack.state,
        qty: Math.abs(args.position.qty),
        filledQty: ack.state === 'filled' ? Math.abs(args.position.qty) : 0,
        updatedAt: now,
      })
    }
    return { executed: true, decisionId }
  }

  // ── 订单动作：先定仓、再过硬闸、最后下单 ──────────────────────────────────
  let intent: OrderRequest | undefined
  let stopPrice: number | undefined
  let takeProfit: number | undefined
  let sizeQty: number | undefined

  if (action.action === 'open') {
    const open = action as OpenAction
    const entry = args.referencePrice
    const derivedStop = stopPriceFor(entry, open.side, open.stop, args.atr)
    if (derivedStop === undefined) {
      record(false, { rationale: '无法推导止损价（ATR 暖机中或方法缺失）' })
      return { executed: false, reason: '无法推导止损价', decisionId }
    }
    const sizing = computeSize({
      equityQuote: args.account.equityQuote,
      riskPct: open.riskPct ?? args.riskPct,
      entryPrice: entry,
      stopPrice: derivedStop,
      ...(args.limits === null ? {} : { maxNotionalUsd: args.limits.perOrderCapUsd }),
    })
    if (!sizing.ok) {
      record(false, { rationale: sizing.reason })
      return { executed: false, reason: sizing.reason, decisionId }
    }
    stopPrice = derivedStop
    takeProfit = takeProfitFor(entry, open.side, derivedStop, open.target?.rMultiple)
    sizeQty = sizing.qty
    intent = {
      intentId: clientOrderId,
      clientOrderId,
      decisionId,
      symbol: args.symbol,
      type: open.method,
      side: open.side === 'long' ? 'buy' : 'sell',
      qty: sizing.qty,
      notionalUsd: sizing.notionalUsd,
      reduceOnly: false,
      ...(open.method === 'limit' && open.limitOffsetBps !== undefined
        ? {
            // 限价偏移是"往更优方向挂"：做多挂在 reference 之下，做空挂在 reference 之上。
            // 旧实现一律 `entry * (1 - bps)`，做空会挂到市价之下 → 立即成交且成交价更差。
            price:
              open.side === 'long'
                ? entry * (1 - open.limitOffsetBps / 10_000)
                : entry * (1 + open.limitOffsetBps / 10_000),
          }
        : {}),
      stopLossPrice: derivedStop,
      ...(takeProfit === undefined ? {} : { takeProfitPrice: takeProfit }),
    }
  } else if (action.action === 'reduce' || action.action === 'close') {
    const position = args.position
    if (position === undefined || position.qty === 0) {
      record(false, { rationale: '无持仓可减/可平' })
      return { executed: false, reason: '无持仓', decisionId }
    }
    const fraction = action.action === 'close' ? 1 : (action as ReduceAction).fraction
    const qty = Math.abs(position.qty) * fraction
    sizeQty = qty
    intent = {
      intentId: clientOrderId,
      clientOrderId,
      decisionId,
      symbol: args.symbol,
      type: action.action === 'reduce' ? ((action as ReduceAction).method ?? 'market') : 'market',
      side: position.qty > 0 ? 'sell' : 'buy',
      qty,
      notionalUsd: qty * args.referencePrice,
      reduceOnly: true,
    }
  }

  if (intent === undefined) {
    record(false, { rationale: `未实现的动作：${action.action}` })
    return { executed: false, reason: `未实现的动作：${action.action}`, decisionId }
  }

  const policy: GatePolicy = {
    mode: args.mode,
    limits: args.limits,
    tradingWindowOpen: true,
    // 同一根 bar 重放时，已存在的 intent 会让硬闸拒绝 —— 幂等的第二道保险
    duplicateDecision: args.alreadyIntended(intent.clientOrderId),
    paperVenue: 'paper',
  }
  const verdict = validateIntent(intent, args.account, policy)
  if (verdict.kind === 'deny') {
    record(false, {
      sizeQty,
      ...(stopPrice === undefined ? {} : { stopPrice }),
      rationale: verdict.reason,
    })
    return { executed: false, reason: verdict.reason, decisionId }
  }
  if (verdict !== ALLOW) {
    record(false, { rationale: '硬闸未放行' })
    return { executed: false, reason: '硬闸未放行', decisionId }
  }

  // ★ 意图**先落库**再发请求（plan §4.2）：崩溃时 `order_intents` 里那条 `created`
  // 且无 ack 的记录是恢复的唯一线索。旧实现先 placeOrder 后落库，崩溃窗口里交易所
  // 可能已受理而本地毫无记录（孤儿订单）。决策行也必须先写：意图有 decision_id 外键。
  args.journal.recordDecision({
    decisionId,
    symbol: args.symbol,
    planId: args.plan.planId,
    decidedAt: now,
    contextHash,
    action: toDecisionAction(action.action),
    executed: false,
    ...(sizeQty === undefined ? {} : { sizeQty }),
    ...(stopPrice === undefined ? {} : { stopPrice }),
    ...(takeProfit === undefined ? {} : { takeProfit }),
  })
  args.journal.recordIntent({
    intentId: `oi:${decisionId}`,
    clientOrderId: intent.clientOrderId,
    decisionId,
    venue: args.broker.venue,
    symbol: args.symbol,
    state: 'created',
    type: intent.type,
    side: intent.side,
    qty: intent.qty,
    notionalUsd: intent.notionalUsd,
    reduceOnly: intent.reduceOnly === true,
    createdAt: now,
    ...(intent.price === undefined ? {} : { price: intent.price }),
  })

  const ack = await args.broker.placeOrder(intent)
  args.journal.markIntentAcked(
    intent.clientOrderId,
    ack.state === 'filled' ? 'filled' : ack.state === 'rejected' ? 'rejected' : 'acked',
    ack.exchangeOrderId,
    now,
  )
  if (ack.exchangeOrderId !== undefined) {
    args.journal.recordOrder({
      orderId: ack.exchangeOrderId,
      venue: args.broker.venue,
      exchangeOrderId: ack.exchangeOrderId,
      clientOrderId: intent.clientOrderId,
      symbol: args.symbol,
      status: ack.state,
      qty: intent.qty,
      filledQty: ack.state === 'filled' ? intent.qty : 0,
      // 真实成交均价（含滑点），不是信号 bar 的收盘价
      ...(ack.avgPrice === undefined ? {} : { avgPrice: ack.avgPrice }),
      updatedAt: now,
    })
    if (ack.state === 'filled') {
      args.journal.recordFill({
        fillId: `fill:${ack.exchangeOrderId}`,
        orderId: ack.exchangeOrderId,
        qty: intent.qty,
        // 用 broker 回填的实际成交价与手续费；缺失时才退回参考价（并记 0 费）
        price: ack.avgPrice ?? args.referencePrice,
        fee: ack.fee ?? 0,
        feeCurrency: 'USDT',
        ts: now,
      })
    }
    // 成交后**立即**挂保护单（HTX 不支持原子括号单 ⇒ 存在暴露窗口，plan §8.2）
    if (action.action === 'open' && ack.state === 'filled' && stopPrice !== undefined) {
      const protectiveClientId = `pco-open:${decisionId}`
      const protectiveSide: 'sell' | 'buy' = intent.side === 'buy' ? 'sell' : 'buy'
      // 保护单也要落库：否则它对恢复流程而言是"交易所挂着、本地无记录"的孤儿单
      // （实测会被判成 P0 不一致并要求撤销）。
      args.journal.recordIntent({
        intentId: `pi-open:${decisionId}`,
        clientOrderId: protectiveClientId,
        decisionId,
        venue: args.broker.venue,
        symbol: args.symbol,
        state: 'created',
        type: 'protective',
        side: protectiveSide,
        qty: intent.qty,
        reduceOnly: true,
        createdAt: now,
      })
      const protectiveAck = await args.broker.placeProtective({
        symbol: args.symbol,
        clientOrderId: protectiveClientId,
        stopLossPrice: stopPrice,
        ...(takeProfit === undefined ? {} : { takeProfitPrice: takeProfit }),
      })
      args.journal.markIntentAcked(
        protectiveClientId,
        protectiveAck.state === 'filled' ? 'filled' : 'acked',
        protectiveAck.exchangeOrderId,
        now,
      )
      if (protectiveAck.exchangeOrderId !== undefined) {
        args.journal.recordOrder({
          orderId: protectiveAck.exchangeOrderId,
          venue: args.broker.venue,
          exchangeOrderId: protectiveAck.exchangeOrderId,
          clientOrderId: protectiveClientId,
          symbol: args.symbol,
          status: protectiveAck.state,
          qty: intent.qty,
          filledQty: 0,
          updatedAt: now,
        })
      }
    }
  }

  // `close` = 全平 + cancelAll(symbol)（plan §3.3）：否则残留的保护单之后会触发，
  // 把一个已平的仓位反向打开（实测）。
  if (action.action === 'close') {
    await args.broker.cancelAll(args.symbol)
  }

  // ★ 成交后登记结算到期时刻（plan §7.9）：**回放/机械执行路径也必须进结算队列**。
  // 少了这一步，`SettlementScheduler` 在回放数据上永远扫不到任何东西 ——
  // 反思闭环与 P1 ④ 的成功率都会"在没有样本的情况下通过"。
  if (ack.state === 'filled' && SLOT_FILLING_ACTIONS.has(action.action)) {
    args.journal.markDecisionExecuted(decisionId)
    args.journal.markDecisionReflectionDue(decisionId, now + args.reflectionHorizonMs)
  }

  return { executed: ack.state === 'filled', decisionId }
}

/** 会改变仓位、因而需要结算的动作。 */
const SLOT_FILLING_ACTIONS = new Set(['open', 'reduce', 'close'])

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
          : await executePlanAction({
              journal,
              broker: deps.broker,
              clock: deps.clock,
              plan,
              conditionId: outcome.id,
              action: outcome.action,
              symbol: request.symbol,
              barTs: bar.openTime,
              referencePrice: bar.close,
              atr: snapshot.values.atr14,
              account,
              position,
              riskPct: deps.riskPct,
              mode: deps.mode,
              limits: deps.limits,
              reflectionHorizonMs: deps.reflectionHorizonMs ?? 4 * 3_600_000,
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
