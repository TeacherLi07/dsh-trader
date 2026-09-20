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
import { withExposureLock } from './exposure-lock.js'
import { computeSize, stopPriceFor, takeProfitFor } from './sizing.js'
import { inferPositionAfterFill, protectPositionOrClose, protectionClientOrderId } from './protection.js'

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
  /** unknown ack 必须立即冻结标的，不能等下一次进程重启才收敛。 */
  readonly freezeSymbol?: (symbol: string) => void
  /** 计划卡 halt 与人工 halt 共用同一持久化熔断。 */
  readonly halt?: () => void
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

/**
 * 将 broker ack 写进订单链。成交量/均价只能来自交易所回报；缺失时 journal 会保留 unknown，
 * 不能拿请求数量或信号价伪造成交。
 */
function recordAck(
  args: ExecuteActionArgs,
  intent: Pick<OrderRequest, 'clientOrderId' | 'symbol' | 'qty' | 'side'>,
  ack: OrderAck,
  now: number,
): { readonly unknown: boolean; readonly filled: boolean } {
  const applied = args.journal.applyOrderAck(ack, now, {
    reflectionHorizonMs: args.reflectionHorizonMs,
  })
  if (applied.unknown) {
    args.freezeSymbol?.(intent.symbol)
    args.journal.appendAudit({
      actor: 'system',
      kind: 'order.unknown',
      payload: { clientOrderId: intent.clientOrderId, symbol: intent.symbol, reason: applied.reason ?? null },
      ts: now,
    })
  }
  return { unknown: applied.unknown, filled: applied.filled }
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
 * 执行一条已经由 matchPlan 命中的计划动作。
 *
 * 该函数不匹配计划卡，也不读取墙钟；调用方负责传入已收盘 bar 和实时状态。
 * 这样 replay 与 live-engine 的差异只剩下行情推进方式，而不再有两套下单实现。
 */
export function executeAction(args: ExecuteActionArgs): Promise<ExecuteActionResult> {
  return withExposureLock(args.journal, () => executeActionUnlocked(args))
}

async function executeActionUnlocked(args: ExecuteActionArgs): Promise<ExecuteActionResult> {
  const now = args.clock.now()
  const decisionId = `dec:${args.plan.planId}:${args.conditionId}:${args.symbol}:${args.barTs}`
  const clientOrderId = primaryClientOrderId(args.plan.planId, args.conditionId, args.barTs)
  const contextHash =
    args.plan.runId === undefined
      ? fingerprint({
          planId: args.plan.planId,
          conditionId: args.conditionId,
          symbol: args.symbol,
          barTs: args.barTs,
        })
      : args.journal.contextHashForRun(args.plan.runId) ??
        fingerprint({
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
      ...(args.plan.runId === undefined ? {} : { runId: args.plan.runId }),
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

  // 机械执行也会与 agent 工具争用同一账户；不能在锁内继续使用调用方进锁前读到的旧快照。
  let currentAccount = args.account
  let currentPosition = args.position
  if (action.action === 'open') {
    try {
      currentAccount = await args.broker.getAccount()
      currentPosition = (await args.broker.getPositions()).find((position) => position.symbol === args.symbol)
    } catch (error) {
      const reason = `开仓前无法重取账户/持仓：${String(error)}`
      record(false, { rationale: reason })
      auditDenied(args, decisionId, reason, now)
      return { executed: false, denied: true, reason, decisionId }
    }
    const requestedSide = (action as OpenAction).side === 'long' ? 1 : -1
    if (currentPosition !== undefined && currentPosition.qty !== 0 && Math.sign(currentPosition.qty) !== requestedSide) {
      const reason = '已有反向持仓；open 不允许隐式反手，请先 reduce/close'
      record(false, { rationale: reason })
      auditDenied(args, decisionId, reason, now)
      return { executed: false, denied: true, reason, decisionId }
    }
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
    args.halt?.()
    record(true, { rationale: action.reason ?? 'halt' })
    return { executed: true, denied: false, decisionId }
  }
  if (action.action === 'cancel_all') {
    const scope = action.scope === 'all' ? undefined : args.symbol
    // 第一遍只撤普通单；保护单只有在交易所确认目标范围为空仓后才允许撤。
    try {
      await args.broker.cancelAll(scope)
    } catch (error) {
      record(false, { rationale: `撤单未完成：${String(error)}` })
      args.journal.appendAudit({
        actor: 'system', kind: 'cancel_all_failed',
        payload: { decisionId, symbol: args.symbol, scope: scope ?? 'all', error: String(error) }, ts: now,
      })
      return { executed: false, denied: true, reason: '挂单类型/撤单状态不可确认', decisionId }
    }
    let positions: readonly PositionSnapshot[]
    try {
      positions = await args.broker.getPositions()
    } catch (error) {
      args.freezeSymbol?.(args.symbol)
      args.journal.appendAudit({
        actor: 'system', kind: 'cancel_all_protection_retained',
        payload: { decisionId, symbol: args.symbol, scope: scope ?? 'all', reason: `无法核验持仓：${String(error)}` },
        ts: now,
      })
      record(false, { rationale: '挂单已尽力撤销，但持仓状态未知，保护单保留' })
      return { executed: false, denied: true, reason: '无法确认空仓；为保安全保留保护单', decisionId }
    }
    const protectedPositions = positions.filter((position) =>
      position.qty !== 0 && (scope === undefined || position.symbol === scope),
    )
    if (protectedPositions.length === 0) {
      try {
        await args.broker.cancelAll(scope, { includeProtection: true })
      } catch (error) {
        record(false, { rationale: `普通挂单已撤；保护单保留，空仓复核失败：${String(error)}` })
        args.journal.appendAudit({
          actor: 'system', kind: 'cancel_all_protection_retained',
          payload: { decisionId, scope: scope ?? 'all', error: String(error) }, ts: now,
        })
        return { executed: false, denied: true, reason: '无法安全撤销保护单', decisionId }
      }
    } else args.journal.appendAudit({
      actor: 'system', kind: 'cancel_all_protection_retained',
      payload: { decisionId, scope: scope ?? 'all', symbols: protectedPositions.map((position) => position.symbol) },
      ts: now,
    })
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

    // decision + protective intent 必须一次提交；否则 crash 恰在两次写入之间会留下
    // executed decision 却没有保护意图，恢复无法知道要查询哪一张单。
    const inserted = args.journal.recordDecisionAndIntent(
      {
        decisionId,
        ...(args.plan.runId === undefined ? {} : { runId: args.plan.runId }),
        symbol: args.symbol,
        ...(args.timeframe === undefined ? {} : { timeframe: args.timeframe }),
        planId: args.plan.planId,
        decidedAt: now,
        contextHash,
        action: toDecisionAction(action.action),
        executed: false,
      },
      {
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
        stopPrice: action.action === 'set_stop' ? (action as LevelAction).price : undefined,
      },
    )
    if (!inserted.intentInserted) {
      return { executed: false, denied: false, reason: 'already_intended', decisionId, alreadyIntended: true }
    }

    const ack = await args.broker.placeProtective({
      symbol: args.symbol,
      clientOrderId: protectiveClientId,
      ...protective,
    })
    const protectiveResult = recordAck(
      args,
      {
        clientOrderId: protectiveClientId,
        symbol: args.symbol,
        qty: Math.abs(args.position.qty),
        side: args.position.qty > 0 ? 'sell' : 'buy',
      },
      ack,
      now,
    )
    // 保护动作的成功标准是 broker 已接受挂单；即使它后来在 bar 内成交，fills 也已由 ack 记录。
    const protectiveAccepted = !protectiveResult.unknown && ack.state !== 'rejected'
    if (protectiveAccepted) args.journal.markDecisionExecuted(decisionId)
    return { executed: protectiveAccepted, denied: protectiveResult.unknown || ack.state === 'rejected', decisionId }
  }

  // ── 订单动作：先定仓、再过硬闸、最后下单 ──────────────────────────────────
  let intent: OrderRequest | undefined
  let stopPrice: number | undefined
  let takeProfit: number | undefined
  let sizeQty: number | undefined

  if (action.action === 'open') {
    const open = action as OpenAction
    if (open.method === 'limit' && args.mode !== 'paper') {
      record(false, { rationale: '增加敞口的限价单在成交监控接入前禁止提交' })
      return { executed: false, denied: true, reason: '增加敞口的限价单在成交监控接入前禁止提交', decisionId }
    }
    const entry = args.referencePrice
    const derivedStop = stopPriceFor(entry, open.side, open.stop, args.atr)
    if (derivedStop === undefined) {
      record(false, { rationale: '无法推导止损价（ATR 暖机中或方法缺失）' })
      return { executed: false, denied: true, reason: '无法推导止损价', decisionId }
    }
    const sizing = computeSize({
      equityQuote: currentAccount.equityQuote,
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
  const verdict = validateIntent(intent, currentAccount, policy)
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

  // 决策与 created intent 必须一次提交；这是 crash recovery 唯一可靠的边界。
  const inserted = args.journal.recordDecisionAndIntent(
    {
      decisionId,
      ...(args.plan.runId === undefined ? {} : { runId: args.plan.runId }),
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
    },
    {
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
      ...(intent.stopLossPrice === undefined ? {} : { stopPrice: intent.stopLossPrice }),
    },
  )
  if (!inserted.intentInserted) {
    return { executed: false, denied: false, reason: 'already_intended', decisionId, alreadyIntended: true }
  }

  const ack = await args.broker.placeOrder(intent)
  const primaryAck = recordAck(args, intent, ack, now)

  // 市价单可能部分成交或在有界轮询后仍 open；先撤掉未完成余量，再以远端持仓增量决定
  // 是否需要保护。撤单/查询不确定时保持 unknown 并冻结，而不是把“没看到 fill”当成未成交。
  let openConfirmed = false
  let openPosition: PositionSnapshot | undefined
  if (action.action === 'open') {
    let finalAck = ack
    let cancelAttempted = false
    let cancelSucceeded = false
    let orderLookupFailed = false
    let positionSnapshotMismatch = false
    const lookup = args.broker.findOrderByExchangeOrderId
    if (ack.exchangeOrderId !== undefined && lookup !== undefined) {
      try {
        const refreshed = await lookup.call(args.broker, ack.exchangeOrderId, args.symbol)
        if (refreshed !== undefined) {
          finalAck = refreshed
          recordAck(args, intent, refreshed, now)
        } else if (ack.state === 'acked') orderLookupFailed = true
      } catch {
        orderLookupFailed = true
      }
    }
    // Live 的新开仓只能是 market；有界等待后若仍未终结，撤掉剩余量，避免一个迟到成交
    // 在已返回“未执行”后突然增加裸露仓位。撤单状态仍不清楚时保留 unknown 并冻结。
    if (args.broker.venue === 'htx' && finalAck.state === 'acked' && finalAck.exchangeOrderId !== undefined) {
      cancelAttempted = true
      try {
        await args.broker.cancelOrder(finalAck.exchangeOrderId)
        cancelSucceeded = true
      } catch {
        cancelSucceeded = false
      }
      if (lookup !== undefined) {
        try {
          const refreshed = await lookup.call(args.broker, finalAck.exchangeOrderId, args.symbol)
          if (refreshed !== undefined) {
            finalAck = refreshed
            recordAck(args, intent, refreshed, now)
            orderLookupFailed = false
          } else orderLookupFailed = true
        } catch {
          orderLookupFailed = true
        }
      }
    }
    if (finalAck.state === 'acked' && (finalAck.exchangeOrderId === undefined || lookup === undefined)) {
      orderLookupFailed = true
    }
    try {
      const positions = await args.broker.getPositions()
      const beforeQty = currentPosition?.qty ?? 0
      const current = positions.find((candidate) => candidate.symbol === args.symbol)
      const afterQty = current?.qty ?? 0
      const delta = afterQty - beforeQty
      const expectedDirection = (action as OpenAction).side === 'long' ? 1 : -1
      const deltaConfirmed = expectedDirection * delta > 1e-12
      const inferred = inferPositionAfterFill(
        args.symbol, currentPosition, intent.side, finalAck.filledQty, finalAck.avgPrice, args.referencePrice,
      )
      const reportedFill = finalAck.filledQty !== undefined && Number.isFinite(finalAck.filledQty) && finalAck.filledQty > 0
      openConfirmed = deltaConfirmed || reportedFill
      if (deltaConfirmed && current !== undefined) openPosition = current
      else if (inferred !== undefined) openPosition = inferred
      if (reportedFill && !deltaConfirmed) {
        positionSnapshotMismatch = true
        args.freezeSymbol?.(args.symbol)
        args.journal.appendAudit({
          actor: 'system', kind: 'open_fill_position_snapshot_mismatch',
          payload: { decisionId, symbol: args.symbol, reportedFilledQty: finalAck.filledQty, observedQty: current?.qty ?? null, inferredQty: inferred?.qty ?? null },
          ts: now,
        })
      }
      const orderHasFill = finalAck.state === 'filled' || (finalAck.filledQty ?? 0) > 0
      if (cancelAttempted && finalAck.state === 'acked') {
        args.journal.markIntentAcked(intent.clientOrderId, 'unknown', finalAck.exchangeOrderId, now)
        args.freezeSymbol?.(args.symbol)
      } else if (openConfirmed && !orderHasFill) {
        // 持仓增量是真实暴露，即使订单回报不可归因，也先保护它并保留冻结审计。
        args.journal.markIntentAcked(intent.clientOrderId, 'unknown', finalAck.exchangeOrderId, now)
        args.freezeSymbol?.(args.symbol)
      } else if (!deltaConfirmed && orderHasFill) {
        args.freezeSymbol?.(args.symbol)
      } else if (orderLookupFailed) {
        args.journal.markIntentAcked(intent.clientOrderId, 'unknown', finalAck.exchangeOrderId, now)
        args.freezeSymbol?.(args.symbol)
      }
    } catch {
      const inferred = inferPositionAfterFill(
        args.symbol, currentPosition, intent.side, finalAck.filledQty, finalAck.avgPrice, args.referencePrice,
      )
      if (finalAck.filledQty !== undefined && Number.isFinite(finalAck.filledQty) && finalAck.filledQty > 0) {
        openConfirmed = true
        openPosition = inferred
        positionSnapshotMismatch = true
      }
      args.freezeSymbol?.(args.symbol)
    }
    if (openPosition !== undefined && Math.sign(openPosition.qty) !== Math.sign(intent.side === 'buy' ? 1 : -1)) {
      args.freezeSymbol?.(args.symbol)
      args.journal.appendAudit({
        actor: 'system', kind: 'open_fill_direction_mismatch',
        payload: { decisionId, symbol: args.symbol, openPositionQty: openPosition.qty, orderSide: intent.side }, ts: now,
      })
      openPosition = undefined
    }
    args.journal.appendAudit({
      actor: 'system',
      kind: 'open_fill_confirmation',
      payload: {
        decisionId,
        symbol: args.symbol,
        ackState: finalAck.state,
        filledQty: finalAck.filledQty ?? null,
        cancelAttempted,
        cancelSucceeded,
        orderLookupFailed,
        positionSnapshotMismatch,
        confirmed: openConfirmed,
      },
      ts: now,
    })
  }
  const slotFilled = action.action === 'open' ? openConfirmed : primaryAck.filled

  // 主单已经成交就是不可逆事实，先登记结算；后续保护单/撤单失败不能让这笔成交消失。
  if (slotFilled && SLOT_FILLING_ACTIONS.has(action.action)) {
    args.journal.markDecisionExecuted(decisionId)
  }

  // 成交后立即挂保护单；保护单自身也先入 order_intents，避免恢复流程把它视为孤儿。
  if (action.action === 'open' && openPosition !== undefined && stopPrice !== undefined) {
    await protectPositionOrClose({
      broker: args.broker,
      journal: args.journal,
      clock: args.clock,
      symbol: args.symbol,
      decisionId,
      clientOrderId: protectionClientOrderId(decisionId, openPosition.qty),
      position: openPosition,
      stopPrice,
      ...(takeProfit === undefined ? {} : { takeProfitPrice: takeProfit }),
      referencePrice: args.referencePrice,
      reflectionHorizonMs: args.reflectionHorizonMs,
      freezeSymbol: args.freezeSymbol,
      reason: 'open_fill',
    })
  }

  // close 只有确认远端 flat 后才能撤保护；ack 但未平仓时撤保护会制造裸仓。
  if (action.action === 'close' && primaryAck.filled) {
    try {
      const remaining = (await args.broker.getPositions()).find((position) => position.symbol === args.symbol)?.qty ?? 0
      if (remaining === 0) await args.broker.cancelAll(args.symbol, { includeProtection: true })
      else {
        args.freezeSymbol?.(args.symbol)
        args.journal.appendAudit({
          actor: 'system',
          kind: 'close_not_flat',
          payload: { decisionId, symbol: args.symbol, remainingQty: remaining },
          ts: now,
        })
      }
    } catch (error) {
      args.freezeSymbol?.(args.symbol)
      args.journal.appendAudit({ actor: 'system', kind: 'close_not_flat', payload: { decisionId, symbol: args.symbol, error: String(error) }, ts: now })
    }
  }

  return { executed: action.action === 'open' ? openConfirmed : primaryAck.filled, denied: ack.state === 'rejected', decisionId }
}

/** 兼容调用方按计划动作命名的别名；实际实现只有上面的一个入口。 */
export const executePlanAction = executeAction
