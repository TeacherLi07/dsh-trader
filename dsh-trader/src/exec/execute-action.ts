/**
 * 计划卡动作的唯一执行路径（plan §3.3 / §3.4 / §6.2）。
 *
 * 回放和常驻进程都必须经过同一条链：代码定仓 → 硬闸裁决 → 意图落库 → broker ack
 * → 成交/保护单/结算登记。把它放在单独模块，是为了避免回放不断修 bug 而实盘仍走旧逻辑。
 */

import type { Clock } from '../clock.js'
import type { RiskLimits, RunMode } from '../config.js'
import {
  toDecisionAction,
  type LevelAction,
  type OpenAction,
  type PlanAction,
  type PlanCard,
  type ReduceAction,
  type TrailingAction,
} from '../plan/schema.js'
import { fingerprint, numericClientOrderId } from '../util/canonical.js'
import { ALLOW, validateIntent, type GatePolicy } from './gate.js'
import type {
  AccountSnapshot,
  Broker,
  OrderAck,
  OrderRequest,
  PositionSnapshot,
} from './broker.js'
import { DecisionJournal } from './journal.js'
import { computeSize, stopPriceFor, takeProfitFor } from './sizing.js'

export interface ExecuteActionArgs {
  readonly journal: DecisionJournal
  readonly broker: Broker
  readonly clock: Clock
  readonly plan: PlanCard
  readonly conditionId: string
  readonly action: PlanAction
  readonly symbol: string
  /** 该条件所在的时间框；写入 decisions.timeframe，供结算按正确的 bar 窗口结算。 */
  readonly timeframe?: string
  /** 计划卡匹配所对应 bar 的 openTime；它是幂等根的一部分。 */
  readonly barTs: number
  readonly referencePrice: number
  readonly atr: number | null
  readonly account: AccountSnapshot
  readonly position: PositionSnapshot | undefined
  readonly riskPct: number
  readonly mode: RunMode
  readonly limits: RiskLimits | null
  readonly reflectionHorizonMs: number
  /** 查询已落库意图；实现必须以 clientOrderId 为唯一键。 */
  readonly alreadyIntended: (clientOrderId: string) => boolean
  /** 冻结标的（plan §4.2/§6.3）；由调用方从组合根取，透传给硬闸。 */
  readonly frozenSymbols?: ReadonlySet<string>
}

export interface ExecuteActionResult {
  readonly executed: boolean
  /** 硬闸或确定性执行前置条件拒绝；`noop`/`escalate` 不算拒绝。 */
  readonly denied: boolean
  readonly reason?: string
  readonly decisionId: string
  /** 意图已存在时短路，保证重试不会再次触发 broker。 */
  readonly alreadyIntended?: boolean
}

/** 会改变仓位、因而需要结算的动作。 */
const SLOT_FILLING_ACTIONS = new Set(['open', 'reduce', 'close'])

/**
 * 主单 / 保护单的 clientOrderId —— **数字**且确定性（交易所必须能按它查回来）。
 * 语义种子保持可读（co/pco + plan + condition + bar），交易所只看到数字串。
 */
export function primaryClientOrderId(planId: string, conditionId: string, barTs: number): string {
  return numericClientOrderId(`co:${planId}:${conditionId}:${barTs}`)
}

export function protectiveClientOrderId(planId: string, conditionId: string, barTs: number): string {
  return numericClientOrderId(`pco:${planId}:${conditionId}:${barTs}`)
}

function actionClientOrderId(plan: PlanCard, conditionId: string, barTs: number, action: PlanAction): string | undefined {
  if (action.action === 'open' || action.action === 'reduce' || action.action === 'close') {
    return primaryClientOrderId(plan.planId, conditionId, barTs)
  }
  if (action.action === 'set_stop' || action.action === 'set_target' || action.action === 'set_trailing') {
    return protectiveClientOrderId(plan.planId, conditionId, barTs)
  }
  return undefined
}

function ackIntentState(ack: OrderAck): 'acked' | 'filled' | 'rejected' {
  // 保持回放原有的意图迁移语义：未完成/未拒绝的 ack 统一视为已确认挂出，
  // 同时不把 broker 的真实订单状态丢在 orders 表里。
  return ack.state === 'filled' ? 'filled' : ack.state === 'rejected' ? 'rejected' : 'acked'
}

/**
 * 将 broker ack 写进订单链。成交价和手续费优先取 ack 的实值；只有 broker 明确没提供时才使用
 * 调用方传入的保底值，因为旧 venue 适配器的 ack 契约允许字段暂缺，不能凭空制造价格。
 */
function recordAck(
  args: ExecuteActionArgs,
  intent: Pick<OrderRequest, 'clientOrderId' | 'symbol' | 'qty' | 'side'>,
  ack: OrderAck,
  fallbackPrice: number,
  now: number,
): void {
  args.journal.markIntentAcked(
    intent.clientOrderId,
    ackIntentState(ack),
    ack.exchangeOrderId,
    now,
  )
  if (ack.exchangeOrderId === undefined) return

  args.journal.recordOrder({
    orderId: ack.exchangeOrderId,
    venue: args.broker.venue,
    exchangeOrderId: ack.exchangeOrderId,
    clientOrderId: intent.clientOrderId,
    symbol: intent.symbol,
    status: ack.state,
    qty: intent.qty,
    filledQty: ack.state === 'filled' ? intent.qty : 0,
    ...(ack.avgPrice === undefined ? {} : { avgPrice: ack.avgPrice }),
    updatedAt: now,
  })
  if (ack.state !== 'filled') return

  args.journal.recordFill({
    fillId: `fill:${ack.exchangeOrderId}`,
    orderId: ack.exchangeOrderId,
    qty: intent.qty,
    price: ack.avgPrice ?? fallbackPrice,
    fee: ack.fee ?? 0,
    feeCurrency: 'USDT',
    ts: now,
  })
}

function auditDenied(args: ExecuteActionArgs, decisionId: string, reason: string, now: number): void {
  // 被硬闸拒绝时不能只靠日志字符串：日志可能被截断，append-only 审计才是可恢复证据。
  args.journal.appendAudit({
    actor: 'system',
    kind: 'execute.denied',
    payload: {
      decisionId,
      planId: args.plan.planId,
      conditionId: args.conditionId,
      symbol: args.symbol,
      barTs: args.barTs,
      action: args.action.action,
      status: 'denied',
      reason,
    },
    ts: now,
  })
}

/**
 * §6.3 降级：入场成交后保护单挂失败 ⇒ **立即平掉这笔仓位**。
 *
 * 为什么选"平仓"而不是"冻结"：execute-action 拿不到组合根的冻结集合，而裸仓是**已知**的
 * 危险状态 —— 能立刻消除就不要留着等下一次对账（对账默认 5 分钟一次，裸仓随时可能爆）。
 * 平仓自身失败（例如交易所已不可用）⇒ 原样落审计；上层对账会看到"有持仓无保护单"并冻结，
 * 由此刻起硬闸禁止再增加敞口（fail-closed）。
 */
async function degradeUnprotectedOpen(
  args: ExecuteActionArgs,
  openQty: number,
  openSide: 'buy' | 'sell',
  now: number,
  decisionId: string,
  reason: string,
): Promise<void> {
  const qty = Math.abs(openQty)
  try {
    await args.broker.placeOrder({
      intentId: `degrade:${decisionId}`,
      clientOrderId: numericClientOrderId(`degrade:${decisionId}`),
      decisionId,
      symbol: args.symbol,
      type: 'market',
      side: openSide === 'buy' ? 'sell' : 'buy',
      qty,
      notionalUsd: qty * args.referencePrice,
      reduceOnly: true,
    })
    args.journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_closed',
      payload: { decisionId, symbol: args.symbol, reason, qty },
      ts: now,
    })
  } catch (error) {
    args.journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_failed',
      payload: { decisionId, symbol: args.symbol, reason, error: String(error), qty },
      ts: now,
    })
  }
}

/**
 * 执行一条已经由 matchPlan 命中的计划动作。
 *
 * 该函数不匹配计划卡，也不读取墙钟；调用方负责传入已收盘 bar 和实时状态。
 * 这样 replay 与 live-engine 的差异只剩下行情推进方式，而不再有两套下单实现。
 */
export async function executeAction(args: ExecuteActionArgs): Promise<ExecuteActionResult> {
  const now = args.clock.now()
  const decisionId = `dec:${args.plan.planId}:${args.conditionId}:${args.symbol}:${args.barTs}`
  const clientOrderId = primaryClientOrderId(args.plan.planId, args.conditionId, args.barTs)
  const contextHash = fingerprint({
    planId: args.plan.planId,
    conditionId: args.conditionId,
    symbol: args.symbol,
    barTs: args.barTs,
  })
  const action = args.action

  // ★ 决策级幂等：同一 (plan, condition, symbol, barTs) 只要已经落过决策（无论执行成功、
  // 被硬闸拒、还是 noop/escalate），重放就必须完全 no-op。只靠 clientOrderId 不够 ——
  // noop/escalate/halt/cancel_all 没有 clientOrderId，被拒的路径也可能没写 intent，
  // 于是重放会重复落库甚至撞 decisions 主键（实测：paper 全链路第二遍就抛了）。
  if (args.journal.hasDecision(decisionId)) {
    return { executed: false, denied: false, reason: 'already_decided', decisionId, alreadyIntended: true }
  }

  const record = (
    executed: boolean,
    extra: { sizeQty?: number; stopPrice?: number; takeProfit?: number; rationale?: string } = {},
  ): void => {
    args.journal.recordDecision({
      decisionId,
      symbol: args.symbol,
      ...(args.timeframe === undefined ? {} : { timeframe: args.timeframe }),
      planId: args.plan.planId,
      decidedAt: now,
      contextHash,
      action: toDecisionAction(action.action),
      executed,
      ...extra,
    })
  }

  // 意图唯一键是跨进程的第二道保险；先短路才能让重试不触发 fake/真实 broker。
  const knownClientOrderId = actionClientOrderId(args.plan, args.conditionId, args.barTs, action)
  if (knownClientOrderId !== undefined && args.alreadyIntended(knownClientOrderId)) {
    return { executed: false, denied: false, reason: 'already_intended', decisionId, alreadyIntended: true }
  }

  // ── 无订单动作 ────────────────────────────────────────────────────────────
  if (action.action === 'noop') {
    record(false, { rationale: 'noop' })
    return { executed: false, denied: false, reason: 'noop', decisionId }
  }
  if (action.action === 'escalate') {
    record(false, { rationale: action.reason })
    return { executed: false, denied: false, reason: `escalate:${action.reason}`, decisionId }
  }
  if (action.action === 'halt') {
    record(true, { rationale: action.reason ?? 'halt' })
    return { executed: true, denied: false, decisionId }
  }
  if (action.action === 'cancel_all') {
    await args.broker.cancelAll(action.scope === 'all' ? undefined : args.symbol)
    record(true)
    return { executed: true, denied: false, decisionId }
  }
  if (action.action === 'set_stop' || action.action === 'set_target' || action.action === 'set_trailing') {
    if (args.position === undefined || args.position.qty === 0) {
      record(false, { rationale: '无持仓，无法挂保护单' })
      return { executed: false, denied: true, reason: '无持仓', decisionId }
    }
    const protective =
      action.action === 'set_stop'
        ? { stopLossPrice: (action as LevelAction).price }
        : action.action === 'set_target'
          ? { takeProfitPrice: (action as LevelAction).price }
          : { trailingPercent: (action as TrailingAction).percent }
    const protectiveClientId = protectiveClientOrderId(args.plan.planId, args.conditionId, args.barTs)

    // order_intents.decision_id 有外键，所以决策必须先写；保护单也必须有本地意图。
    record(true)
    const inserted = args.journal.recordIntent({
      intentId: `pi:${decisionId}`,
      clientOrderId: protectiveClientId,
      decisionId,
      venue: args.broker.venue,
      symbol: args.symbol,
      state: 'created',
      type: 'protective',
      side: args.position.qty > 0 ? 'sell' : 'buy',
      qty: Math.abs(args.position.qty),
      reduceOnly: true,
      createdAt: now,
    })
    if (!inserted) {
      return { executed: false, denied: false, reason: 'already_intended', decisionId, alreadyIntended: true }
    }

    const ack = await args.broker.placeProtective({
      symbol: args.symbol,
      clientOrderId: protectiveClientId,
      ...protective,
    })
    const fallbackPrice =
      action.action === 'set_stop' || action.action === 'set_target'
        ? (action as LevelAction).price
        : args.referencePrice
    recordAck(
      args,
      {
        clientOrderId: protectiveClientId,
        symbol: args.symbol,
        qty: Math.abs(args.position.qty),
        side: args.position.qty > 0 ? 'sell' : 'buy',
      },
      ack,
      fallbackPrice,
      now,
    )
    // 保护动作的成功标准是 broker 已接受挂单；即使它后来在 bar 内成交，fills 也已由 ack 记录。
    return { executed: true, denied: ack.state === 'rejected', decisionId }
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
      return { executed: false, denied: true, reason: '无法推导止损价', decisionId }
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
      return { executed: false, denied: true, reason: sizing.reason, decisionId }
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
            // 偏移往更优方向挂：做空应在参考价上方，否则会立即以更差价格成交。
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
      return { executed: false, denied: true, reason: '无持仓', decisionId }
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
    return { executed: false, denied: true, reason: `未实现的动作：${action.action}`, decisionId }
  }

  // 不传 `tradingWindowOpen`：宏观时间窗**不是硬闸**（plan §12.1 #22），由 news 分析师提示词软判断。
  const policy: GatePolicy = {
    mode: args.mode,
    limits: args.limits,
    duplicateDecision: args.alreadyIntended(intent.clientOrderId),
    paperVenue: 'paper',
    ...(args.frozenSymbols === undefined ? {} : { frozenSymbols: args.frozenSymbols }),
  }
  const verdict = validateIntent(intent, args.account, policy)
  if (verdict.kind === 'deny') {
    record(false, {
      sizeQty,
      ...(stopPrice === undefined ? {} : { stopPrice }),
      rationale: verdict.reason,
    })
    auditDenied(args, decisionId, verdict.reason, now)
    return { executed: false, denied: true, reason: verdict.reason, decisionId }
  }
  if (verdict !== ALLOW) {
    const reason = '硬闸未放行'
    record(false, { rationale: reason })
    auditDenied(args, decisionId, reason, now)
    return { executed: false, denied: true, reason, decisionId }
  }

  // 先记决策和意图，再发请求；created 且没有 ack 是崩溃恢复唯一可靠的线索。
  args.journal.recordDecision({
    decisionId,
    symbol: args.symbol,
    ...(args.timeframe === undefined ? {} : { timeframe: args.timeframe }),
    planId: args.plan.planId,
    decidedAt: now,
    contextHash,
    action: toDecisionAction(action.action),
    executed: false,
    ...(sizeQty === undefined ? {} : { sizeQty }),
    ...(stopPrice === undefined ? {} : { stopPrice }),
    ...(takeProfit === undefined ? {} : { takeProfit }),
  })
  const inserted = args.journal.recordIntent({
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
  if (!inserted) {
    return { executed: false, denied: false, reason: 'already_intended', decisionId, alreadyIntended: true }
  }

  const ack = await args.broker.placeOrder(intent)
  recordAck(args, intent, ack, args.referencePrice, now)

  // ★ 成交回填可能超时（HTX 市价单实测：createOrder 只回 open/new，靠有界轮询 fetchOrder 回填）。
  // 若轮询到点仍未确认，ack.state 是 'acked'；**绝不能据此断定"没成交"** —— 那会留下
  // 无止损裸仓、且不登记结算。对 open：向交易所重取持仓来确认（"执行前重取状态"同一原则）。
  let openConfirmed = ack.state === 'filled'
  if (action.action === 'open' && ack.state !== 'filled') {
    try {
      const positions = await args.broker.getPositions()
      openConfirmed = (positions.find((candidate) => candidate.symbol === args.symbol)?.qty ?? 0) !== 0
    } catch {
      openConfirmed = false
    }
    args.journal.appendAudit({
      actor: 'system',
      kind: 'open_fill_confirmation',
      payload: { decisionId, symbol: args.symbol, ackState: ack.state, confirmed: openConfirmed },
      ts: now,
    })
  }
  const slotFilled = action.action === 'open' ? openConfirmed : ack.state === 'filled'

  // 主单已经成交就是不可逆事实，先登记结算；后续保护单/撤单失败不能让这笔成交消失。
  if (slotFilled && SLOT_FILLING_ACTIONS.has(action.action)) {
    args.journal.markDecisionExecuted(decisionId)
    args.journal.markDecisionReflectionDue(decisionId, now + args.reflectionHorizonMs)
  }

  // 成交后立即挂保护单；保护单自身也先入 order_intents，避免恢复流程把它视为孤儿。
  if (action.action === 'open' && openConfirmed && stopPrice !== undefined) {
    const protectiveClientId = `pco-open:${decisionId}`
    const protectiveSide: 'sell' | 'buy' = intent.side === 'buy' ? 'sell' : 'buy'
    const protectiveInserted = args.journal.recordIntent({
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
    if (protectiveInserted) {
      try {
        const protectiveAck = await args.broker.placeProtective({
          symbol: args.symbol,
          clientOrderId: protectiveClientId,
          stopLossPrice: stopPrice,
          ...(takeProfit === undefined ? {} : { takeProfitPrice: takeProfit }),
        })
        recordAck(
          args,
          { clientOrderId: protectiveClientId, symbol: args.symbol, qty: intent.qty, side: protectiveSide },
          protectiveAck,
          stopPrice,
          now,
        )
        // 交易所**明确拒绝**保护单同样是"裸仓"：必须走同一降级，不能记成已挂出。
        if (protectiveAck.state === 'rejected') {
          await degradeUnprotectedOpen(args, intent.qty, intent.side, now, decisionId, 'protective_rejected')
        }
      } catch (error) {
        // 保护单挂失败：先落审计（失败状态逐字保留），再降级平仓。
        args.journal.appendAudit({
          actor: 'system',
          kind: 'protection_failed',
          payload: {
            decisionId,
            planId: args.plan.planId,
            conditionId: args.conditionId,
            symbol: args.symbol,
            error: String(error),
          },
          ts: now,
        })
        await degradeUnprotectedOpen(args, intent.qty, intent.side, now, decisionId, `protective_failed:${String(error)}`)
      }
    }
  }

  // close = 全平 + cancelAll(symbol)，否则残留保护单可能在平仓后反向开仓。
  if (action.action === 'close') await args.broker.cancelAll(args.symbol)

  return { executed: action.action === 'open' ? openConfirmed : ack.state === 'filled', denied: ack.state === 'rejected', decisionId }
}

/** 兼容调用方按计划动作命名的别名；实际实现只有上面的一个入口。 */
export const executePlanAction = executeAction
