/**
 * 交易工具定义（plan §11.4 / T1.3）。
 *
 * 设计：**工具是"纯定义 + 注入端口（ports）"**，cordis 适配层只负责 `defineTool` 与 `restrict`。
 * 这样两条硬要求可以在 CI 里被断言，而不是靠读代码相信：
 *   · `trade_propose_order` **绝不触达交易所**（只读账户 + 算数）；
 *   · `trade_execute_order` 在 execute 内部**重新取状态并再过一次硬闸**（二次校验）。
 */

import type Database from 'better-sqlite3'
import type { Clock } from '../clock.js'
import type { RiskLimits, RunMode } from '../config.js'
import type { Broker, OrderRequest, OrderType } from '../exec/broker.js'
import { projectedExposureUsd, projectedLeverage, validateIntent, type GatePolicy } from '../exec/gate.js'
import type { DecisionJournal } from '../exec/journal.js'
import { computeSize, stopPriceFor, takeProfitFor } from '../exec/sizing.js'
import type { BarArchive } from '../market/archive.js'
import type { FeatureArchive } from '../market/feature-archive.js'
import { DECISION_ACTIONS, TIMEFRAMES, type DecisionAction, type StopSpec } from '../plan/schema.js'
import type { PlanStore } from '../plan/store.js'
import { recallLessons } from '../memory/recall.js'

export interface ToolPorts {
  readonly db: Database.Database
  readonly bars: BarArchive
  readonly features: FeatureArchive
  readonly plans: PlanStore
  readonly journal: DecisionJournal
  readonly broker: Broker
  readonly clock: Clock
  readonly limits: RiskLimits | null
  readonly mode: RunMode
  readonly riskPct: number
  /** 结算视界（plan §7.9）：决策记录时算出 `reflection_due_at = now + 视界`。 */
  readonly reflectionHorizonMs?: number
}

/** 默认结算视界：4 小时（日内-摆动之间，1h bar 下约 4 根）。 */
export const DEFAULT_REFLECTION_HORIZON_MS = 4 * 3_600_000

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolArgumentError'
  }
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** true = 能改变交易所状态或写入决策链，因此**只允许发给裁决者**。 */
  readonly sideEffect: boolean
  readonly parameters: Readonly<Record<string, unknown>>
  readonly execute: (args: Readonly<Record<string, unknown>>, ports: ToolPorts) => Promise<unknown>
}

// ── 入参读取（模型可能给任何东西，一律显式校验）──────────────────────────────

function requireString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ToolArgumentError(`${key} 必须是非空字符串，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ToolArgumentError(`${key} 必须是字符串`)
  return value
}

function requireNumber(args: Readonly<Record<string, unknown>>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolArgumentError(`${key} 必须是有限数值，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function optionalNumber(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolArgumentError(`${key} 必须是有限数值`)
  }
  return value
}

function optionalBoolean(args: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ToolArgumentError(`${key} 必须是布尔值`)
  return value
}

function requireEnum<T extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T {
  const value = args[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ToolArgumentError(`${key} 必须是 ${allowed.join('|')} 之一，收到 ${JSON.stringify(value)}`)
  }
  return value as T
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ── 只读工具 ─────────────────────────────────────────────────────────────────

const tradeMarket: ToolDefinition = {
  name: 'trade_market',
  description:
    '只读：取最近 N 根**已收盘** bar 与最新特征快照。绝不返回未收盘 K 线；没有快照时 snapshot 为 null。',
  sideEffect: false,
  parameters: {
    symbol: { type: 'string', required: true },
    timeframe: { type: 'string', required: true, enum: TIMEFRAMES },
    bars: { type: 'number', description: '1..500，默认 200' },
  },
  async execute(args, ports) {
    const symbol = requireString(args, 'symbol')
    const timeframe = requireString(args, 'timeframe')
    const limit = clamp(optionalNumber(args, 'bars') ?? 200, 1, 500)
    const bars = ports.bars.closedBars(symbol, timeframe, { limit })
    const latest = ports.features.latest(symbol, timeframe)
    return {
      symbol,
      timeframe,
      count: bars.length,
      bars: bars.map((bar) => ({
        openTime: bar.openTime,
        closeTime: bar.closeTime,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      })),
      snapshot: latest?.values ?? null,
      fingerprint: latest?.fingerprint ?? null,
    }
  },
}

const tradePortfolio: ToolDefinition = {
  name: 'trade_portfolio',
  description: '只读：实时重取账户权益、持仓与挂单。上下文里记住的持仓数字不得用于计算。',
  sideEffect: false,
  parameters: {},
  async execute(_args, ports) {
    const account = await ports.broker.getAccount()
    const positions = await ports.broker.getPositions()
    const openOrders = await ports.broker.getOpenOrders()
    return { account, positions, openOrders }
  },
}

const tradeOrderStatus: ToolDefinition = {
  name: 'trade_order_status',
  description: '只读：查询挂单状态（可按标的过滤）。',
  sideEffect: false,
  parameters: { symbol: { type: 'string' } },
  async execute(args, ports) {
    const symbol = optionalString(args, 'symbol')
    const orders = await ports.broker.getOpenOrders(symbol)
    return { orders }
  },
}

const tradeLimits: ToolDefinition = {
  name: 'trade_limits',
  description: '只读：当前运行档位与硬闸限额（`waiver=true` 表示用户显式放弃了风控参数）。',
  sideEffect: false,
  parameters: {},
  async execute(_args, ports) {
    return {
      mode: ports.mode,
      limits: ports.limits,
      riskPct: ports.riskPct,
      waiver: ports.limits === null,
    }
  },
}

const tradeRiskCheck: ToolDefinition = {
  name: 'trade_risk_check',
  description:
    '纯计算：给定名义金额，按当前账户与限额**预演**硬闸判定、预计敞口与杠杆。不下单。',
  sideEffect: false,
  parameters: {
    notionalUsd: { type: 'number', required: true },
    symbol: { type: 'string' },
    reduceOnly: { type: 'boolean' },
  },
  async execute(args, ports) {
    const notionalUsd = requireNumber(args, 'notionalUsd')
    const reduceOnly = optionalBoolean(args, 'reduceOnly') ?? false
    const account = await ports.broker.getAccount()
    const probe: OrderRequest = {
      intentId: 'risk-check',
      clientOrderId: 'risk-check',
      decisionId: 'risk-check',
      symbol: optionalString(args, 'symbol') ?? 'UNSPECIFIED',
      type: 'market',
      side: 'buy',
      qty: 1,
      notionalUsd,
      reduceOnly,
    }
    const policy: GatePolicy = {
      mode: ports.mode,
      limits: ports.limits,
      tradingWindowOpen: true,
      duplicateDecision: false,
      paperVenue: 'paper',
    }
    return {
      verdict: validateIntent(probe, account, policy),
      projectedExposureUsd: projectedExposureUsd(probe, account),
      projectedLeverage: projectedLeverage(probe, account),
      account,
    }
  },
}

const tradeRecall: ToolDefinition = {
  name: 'trade_recall',
  description:
    '只读：检索最近的决策与**未过期**的已结算反思（可按标的过滤），用于判断前按需取回。过期的教训不会返回。',
  sideEffect: false,
  parameters: {
    symbol: { type: 'string' },
    limit: { type: 'number', description: '1..100，默认 20' },
  },
  async execute(args, ports) {
    const symbol = optionalString(args, 'symbol')
    const limit = clamp(optionalNumber(args, 'limit') ?? 20, 1, 100)
    const options = symbol === undefined ? { limit } : { symbol, limit }
    const recall = recallLessons(ports.journal, {
      now: ports.clock.now(),
      limit,
      ...(symbol === undefined ? {} : { symbol }),
    })
    return {
      decisions: ports.journal.recentDecisions(options),
      lessons: recall.lessons,
      expiredLessonsSkipped: recall.expired,
    }
  },
}

// ── 提议（不触达交易所）──────────────────────────────────────────────────────

const tradeProposeOrder: ToolDefinition = {
  name: 'trade_propose_order',
  description:
    '产出**意图**：数量由代码按风险公式推导，模型只给方向、止损方法与风险比例。不触达交易所，也不落订单。',
  sideEffect: false,
  parameters: {
    symbol: { type: 'string', required: true },
    timeframe: { type: 'string', required: true, enum: TIMEFRAMES },
    side: { type: 'string', required: true, enum: ['long', 'short'] },
    method: { type: 'string', required: true, enum: ['market', 'limit'] },
    stopMethod: { type: 'string', required: true, enum: ['atr', 'structure'] },
    stopValue: { type: 'number', required: true, description: 'atr 时为 k 倍数；structure 时为结构位价格' },
    riskPct: { type: 'number' },
    targetRMultiple: { type: 'number' },
    limitOffsetBps: { type: 'number' },
  },
  async execute(args, ports) {
    const symbol = requireString(args, 'symbol')
    const timeframe = requireString(args, 'timeframe')
    const side = requireEnum(args, 'side', ['long', 'short'] as const)
    const method = requireEnum(args, 'method', ['market', 'limit'] as const)
    const stopMethod = requireEnum(args, 'stopMethod', ['atr', 'structure'] as const)
    const stopValue = requireNumber(args, 'stopValue')

    const snapshot = ports.features.latest(symbol, timeframe)
    if (snapshot === undefined) {
      return { valid: false, reason: `没有 ${symbol} ${timeframe} 的特征快照（行情尚未回补？）` }
    }

    const entryPrice = snapshot.values.close
    const stop: StopSpec =
      stopMethod === 'atr' ? { method: 'atr', k: stopValue } : { method: 'structure', level: stopValue }
    const stopPrice = stopPriceFor(entryPrice, side, stop, snapshot.values.atr14)
    if (stopPrice === undefined) {
      return { valid: false, reason: '无法推导止损价（ATR 暖机中，或 stopValue 非法）' }
    }

    const account = await ports.broker.getAccount()
    const riskPct = optionalNumber(args, 'riskPct') ?? ports.riskPct
    const sizing = computeSize({
      equityQuote: account.equityQuote,
      riskPct,
      entryPrice,
      stopPrice,
      ...(ports.limits === null ? {} : { maxNotionalUsd: ports.limits.perOrderCapUsd }),
    })
    if (!sizing.ok) return { valid: false, reason: sizing.reason }

    const takeProfit = takeProfitFor(entryPrice, side, stopPrice, optionalNumber(args, 'targetRMultiple'))
    return {
      valid: true,
      symbol,
      timeframe,
      side,
      method,
      entryPrice,
      stopPrice,
      takeProfit: takeProfit ?? null,
      riskPct,
      sizing,
      note: '这只是提议；真正下单由 trade_execute_order 重新取状态并再过一次硬闸',
    }
  },
}

// ── 副作用工具（只发给裁决者）────────────────────────────────────────────────

const tradeExecuteOrder: ToolDefinition = {
  name: 'trade_execute_order',
  description:
    '执行：先向交易所重取账户/持仓，数量由代码推导，再过一次硬闸，然后才下单并把意图/订单/成交落库。',
  sideEffect: true,
  parameters: {
    decisionId: { type: 'string', required: true },
    symbol: { type: 'string', required: true },
    timeframe: { type: 'string', required: true, enum: TIMEFRAMES },
    action: { type: 'string', required: true, enum: ['open', 'reduce', 'close'] },
    side: { type: 'string', enum: ['long', 'short'] },
    method: { type: 'string', enum: ['market', 'limit'] },
    stopMethod: { type: 'string', enum: ['atr', 'structure'] },
    stopValue: { type: 'number' },
    fraction: { type: 'number', description: 'reduce 时减仓比例 (0,1)' },
    limitPrice: { type: 'number', description: '限价单价格（method=limit 时必填）' },
    riskPct: { type: 'number' },
    targetRMultiple: { type: 'number' },
    rationale: { type: 'string' },
  },
  async execute(args, ports) {
    const decisionId = requireString(args, 'decisionId')
    const symbol = requireString(args, 'symbol')
    const timeframe = requireString(args, 'timeframe')
    const action = requireEnum(args, 'action', ['open', 'reduce', 'close'] as const)
    const rationale = optionalString(args, 'rationale')
    // 决策 id 与动作/标的绑定，避免同一 id 被复用于不同动作
    const effectiveDecisionId = `${decisionId}:${action}:${symbol}`

    /**
     * 任何"没执行"的路径都必须留痕（plan §9.1 审计优先）：
     * 审计事件一定写；决策行只在**首次**写（重复调用同一 id 时写决策行会撞主键）。
     */
    const refuse = (reason: string): { executed: false; reason: string } => {
      ports.journal.appendAudit({
        actor: 'system',
        kind: 'execute_refused',
        payload: { decisionId: effectiveDecisionId, reason },
        ts: ports.clock.now(),
      })
      if (!ports.journal.hasDecision(effectiveDecisionId)) {
        ports.journal.recordDecision({
          decisionId: effectiveDecisionId,
          symbol,
          decidedAt: ports.clock.now(),
          contextHash: `refused:${reason}`,
          action,
          executed: false,
          rationale: reason,
        })
      }
      return { executed: false, reason }
    }

    // ① 状态重取（plan §5.4/§6.2）：上下文里的数字只用于理解，不用于计算
    const account = await ports.broker.getAccount()
    const positions = await ports.broker.getPositions()
    const position = positions.find((candidate) => candidate.symbol === symbol)

    // ② 构造意图：数量一律由代码推导
    let intent: OrderRequest | undefined
    let stopPrice: number | undefined
    let takeProfit: number | undefined
    let sizeQty: number | undefined

    if (action === 'open') {
      const side = requireEnum(args, 'side', ['long', 'short'] as const)
      const method = requireEnum(args, 'method', ['market', 'limit'] as const)
      const stopMethod = requireEnum(args, 'stopMethod', ['atr', 'structure'] as const)
      const stopValue = requireNumber(args, 'stopValue')
      const snapshot = ports.features.latest(symbol, timeframe)
      if (snapshot === undefined) {
        return refuse(`没有 ${symbol} ${timeframe} 的特征快照`)
      }
      const entryPrice = snapshot.values.close
      const stop: StopSpec =
        stopMethod === 'atr' ? { method: 'atr', k: stopValue } : { method: 'structure', level: stopValue }
      const limitPrice = optionalNumber(args, 'limitPrice')
      if (method === 'limit' && limitPrice === undefined) {
        return refuse('限价单必须提供 limitPrice（不替你猜价格）')
      }
      const derived = stopPriceFor(entryPrice, side, stop, snapshot.values.atr14)
      if (derived === undefined) return refuse('无法推导止损价')
      const sizing = computeSize({
        equityQuote: account.equityQuote,
        riskPct: optionalNumber(args, 'riskPct') ?? ports.riskPct,
        entryPrice,
        stopPrice: derived,
        ...(ports.limits === null ? {} : { maxNotionalUsd: ports.limits.perOrderCapUsd }),
      })
      if (!sizing.ok) return refuse(sizing.reason)
      stopPrice = derived
      takeProfit = takeProfitFor(entryPrice, side, derived, optionalNumber(args, 'targetRMultiple'))
      sizeQty = sizing.qty
      intent = {
        intentId: `oi:${effectiveDecisionId}`,
        clientOrderId: `co:${effectiveDecisionId}`,
        decisionId,
        symbol,
        type: method as OrderType,
        side: side === 'long' ? 'buy' : 'sell',
        qty: sizing.qty,
        notionalUsd: sizing.notionalUsd,
        reduceOnly: false,
        ...(method === 'limit' && limitPrice !== undefined ? { price: limitPrice } : {}),
        stopLossPrice: derived,
        ...(takeProfit === undefined ? {} : { takeProfitPrice: takeProfit }),
      }
    } else {
      if (position === undefined || position.qty === 0) {
        return refuse(`没有 ${symbol} 的持仓，无法减/平`)
      }
      const fraction = action === 'close' ? 1 : requireNumber(args, 'fraction')
      if (!(fraction > 0) || fraction > 1) {
        return refuse(`fraction 必须在 (0,1] 内，收到 ${fraction}`)
      }
      const qty = Math.abs(position.qty) * fraction
      const price = ports.features.latest(symbol, timeframe)?.values.close
      sizeQty = qty
      intent = {
        intentId: `oi:${effectiveDecisionId}`,
        clientOrderId: `co:${effectiveDecisionId}`,
        decisionId,
        symbol,
        type: 'market',
        side: position.qty > 0 ? 'sell' : 'buy',
        qty,
        notionalUsd: qty * (price ?? position.avgPrice),
        reduceOnly: true,
      }
    }

    if (intent === undefined) return refuse(`不支持的动作：${action}`)

    // ③ 二次硬闸：工具内部**再验一遍**（不依赖上游是否验过）
    const policy: GatePolicy = {
      mode: ports.mode,
      limits: ports.limits,
      tradingWindowOpen: true,
      duplicateDecision: ports.journal.hasClientOrderId(intent.clientOrderId),
      paperVenue: 'paper',
    }
    const verdict = validateIntent(intent, account, policy)
    if (verdict.kind === 'deny') {
      return refuse(verdict.reason)
    }

    // ④ 意图先落库（created），再发请求；崩溃时按 clientOrderId 去交易所查询
    ports.journal.recordDecision({
      decisionId: effectiveDecisionId,
      symbol,
      decidedAt: ports.clock.now(),
      contextHash: `exec:${decisionId}`,
      action,
      executed: false,
      ...(sizeQty === undefined ? {} : { sizeQty }),
      ...(stopPrice === undefined ? {} : { stopPrice }),
      ...(takeProfit === undefined ? {} : { takeProfit }),
      ...(rationale === undefined ? {} : { rationale }),
    })
    ports.journal.recordIntent({
      intentId: intent.intentId,
      clientOrderId: intent.clientOrderId,
      decisionId: effectiveDecisionId,
      venue: ports.broker.venue,
      symbol,
      state: 'created',
      type: intent.type,
      side: intent.side,
      qty: intent.qty,
      notionalUsd: intent.notionalUsd,
      reduceOnly: intent.reduceOnly === true,
      createdAt: ports.clock.now(),
      ...(intent.price === undefined ? {} : { price: intent.price }),
    })

    const ack = await ports.broker.placeOrder(intent)
    ports.journal.markIntentAcked(
      intent.clientOrderId,
      ack.state === 'filled' ? 'filled' : ack.state === 'rejected' ? 'rejected' : 'acked',
      ack.exchangeOrderId,
      ports.clock.now(),
    )

    if (ack.exchangeOrderId !== undefined) {
      ports.journal.recordOrder({
        orderId: ack.exchangeOrderId,
        venue: ports.broker.venue,
        exchangeOrderId: ack.exchangeOrderId,
        clientOrderId: intent.clientOrderId,
        symbol,
        status: ack.state,
        qty: intent.qty,
        filledQty: ack.state === 'filled' ? intent.qty : 0,
        updatedAt: ports.clock.now(),
      })
      if (ack.state === 'filled') {
        const executionPrice =
          intent.price ?? ports.features.latest(symbol, timeframe)?.values.close ?? 0
        ports.journal.recordFill({
          fillId: `fill:${ack.exchangeOrderId}`,
          orderId: ack.exchangeOrderId,
          qty: intent.qty,
          price: executionPrice,
          fee: 0,
          feeCurrency: 'USDT',
          ts: ports.clock.now(),
        })
      }
    }

    const executed = ack.state === 'filled'
    if (executed) {
      ports.journal.markDecisionExecuted(effectiveDecisionId)
      // 只有成交的决策才进结算队列（plan §7.9 ④）：到期时刻与"何时重跑该标的"无关
      if (action === 'open' || action === 'close' || action === 'reduce') {
        ports.journal.markDecisionReflectionDue(
          effectiveDecisionId,
          ports.clock.now() + (ports.reflectionHorizonMs ?? DEFAULT_REFLECTION_HORIZON_MS),
        )
      }
    }

    // ⑤ 成交后**立即**挂保护单（HTX 无原子括号单 ⇒ 已知暴露窗口）
    let protectiveAck: unknown = null
    if (action === 'open' && executed && stopPrice !== undefined) {
      protectiveAck = await ports.broker.placeProtective({
        symbol,
        stopLossPrice: stopPrice,
        ...(takeProfit === undefined ? {} : { takeProfitPrice: takeProfit }),
      })
    }

    return {
      executed,
      clientOrderId: intent.clientOrderId,
      state: ack.state,
      protectiveAck,
    }
  },
}


const tradeCancel: ToolDefinition = {
  name: 'trade_cancel',
  description: '撤单：撤销某标的（或全部）的未结订单。',
  sideEffect: true,
  parameters: { symbol: { type: 'string' } },
  async execute(args, ports) {
    const symbol = optionalString(args, 'symbol')
    await ports.broker.cancelAll(symbol)
    return { canceled: true, symbol: symbol ?? null }
  },
}

const tradeRecordDecision: ToolDefinition = {
  name: 'trade_record_decision',
  description: '把裁决写进审计链（类型化对象）。已执行的动作由 trade_execute_order 自行落库。',
  sideEffect: true,
  parameters: {
    decisionId: { type: 'string', required: true },
    symbol: { type: 'string', required: true },
    action: { type: 'string', required: true },
    sizeQty: { type: 'number' },
    stopPrice: { type: 'number' },
    takeProfit: { type: 'number' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
    contextHash: { type: 'string' },
  },
  async execute(args, ports) {
    const decisionId = requireString(args, 'decisionId')
    const symbol = requireString(args, 'symbol')
    const rawAction = requireString(args, 'action')
    if (!(DECISION_ACTIONS as readonly string[]).includes(rawAction)) {
      throw new ToolArgumentError(`action 必须是 ${DECISION_ACTIONS.join('|')} 之一，收到 ${rawAction}`)
    }
    const action = rawAction as DecisionAction
    const contextHash = optionalString(args, 'contextHash') ?? `manual:${decisionId}`
    const sizeQty = optionalNumber(args, 'sizeQty')
    const stopPrice = optionalNumber(args, 'stopPrice')
    const takeProfit = optionalNumber(args, 'takeProfit')
    const rationale = optionalString(args, 'rationale')
    const inserted = ports.journal.recordDecision({
      decisionId,
      symbol,
      decidedAt: ports.clock.now(),
      contextHash,
      action,
      executed: false,
      ...(sizeQty === undefined ? {} : { sizeQty }),
      ...(stopPrice === undefined ? {} : { stopPrice }),
      ...(takeProfit === undefined ? {} : { takeProfit }),
      ...(rationale === undefined ? {} : { rationale }),
    })
    return { recorded: inserted, decisionId }
  },
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  tradeMarket,
  tradePortfolio,
  tradeOrderStatus,
  tradeLimits,
  tradeRiskCheck,
  tradeRecall,
  tradeProposeOrder,
  tradeExecuteOrder,
  tradeCancel,
  tradeRecordDecision,
]

export const IMPLEMENTED_TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((tool) => tool.name)

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name)
}

export function isRecordArg(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}
