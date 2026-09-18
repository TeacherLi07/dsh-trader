/**
 * 交易工具定义（plan §11.4 / T1.3）。
 *
 * 设计：**工具是"纯定义 + 注入端口（ports）"**，cordis 适配层只负责 `defineTool` 与 `restrict`。
 * 这样两条硬要求可以在 CI 里被断言，而不是靠读代码相信：
 *   · `trade_propose_order` **绝不触达交易所**（只读账户 + 算数）；
 *   · `trade_execute_order` 在 execute 内部**重新取状态并再过一次硬闸**（二次校验）。
 */

import type Database from 'better-sqlite3'
import { numericClientOrderId } from '../util/canonical.js'
import type { Clock } from '../clock.js'
import type { RiskLimits, RunMode } from '../config.js'
import type { Broker, OrderRequest, OrderType } from '../exec/broker.js'
import { projectedExposureUsd, projectedLeverage, validateIntent, type GatePolicy } from '../exec/gate.js'
import type { DecisionJournal } from '../exec/journal.js'
import { computeSize, stopPriceFor, takeProfitFor } from '../exec/sizing.js'
import type { BarArchive } from '../market/archive.js'
import type { FeatureArchive } from '../market/feature-archive.js'
import { regimeOf } from '../market/regime.js'
import {
  DECISION_ACTIONS,
  TIMEFRAMES,
  computeContentHash,
  validatePlanCard,
  type DecisionAction,
  type StopSpec,
} from '../plan/schema.js'
import type { PlanStore } from '../plan/store.js'
import { recallLessons } from '../memory/recall.js'
import { horizonMsForTimeframe } from '../memory/settle.js'
import {
  WATCH_KINDS,
  WATCH_PURPOSES,
  WatchError,
  type PmStore,
  type WatchKind,
  type WatchPurpose,
} from '../predictions/store.js'
import { WorkflowContextStore, type WorkflowContextRecord } from '../supervisor/workflow-context.js'

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
  /**
   * 本轮组装出的 `ctxHash`（plan §5.1 / T1.5）。
   * 未提供时决策落库为 `exec:<id>` —— 一个**显式标明"未组装"**的占位符，
   * 而不是伪装成真哈希（否则"同一 contextHash"的对拍就失去意义）。
   */
  readonly contextHash?: string
  /** 预测市场存储（plan §4.4）：只读工具与关注登记都走它；未接入时不注册相关工具。 */
  readonly pm?: PmStore
  /**
   * 是否允许把 pm 当**承诺**触发（plan §12 #11）。
   * 默认 **false** —— 该问题由 P1.5 A/B 闸门判定；未判定前一律拒绝，绝不默认放行。
   */
  readonly allowPmCommitment?: boolean
  /**
   * 冻结标的（对账/恢复存在未决状态 ⇒ 禁止增加敞口，plan §4.2/§6.3）。
   * 只读；未提供视为空集。平/减仓不受影响。
   */
  readonly frozenSymbols?: () => ReadonlySet<string>
  /** 执行层状态未知时立即冻结，而不是等下一次重启。 */
  readonly freezeSymbol?: (symbol: string) => void
  readonly halt?: () => void
  /** 生产组合根配置的唯一允许范围；计划工具缺少它们时必须拒绝，不能猜。 */
  readonly symbols?: readonly string[]
  readonly timeframes?: readonly string[]
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

function optionalStringArray(
  args: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new ToolArgumentError(`${key} 必须是字符串数组`)
  return value.map((item) => {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new ToolArgumentError(`${key} 的元素必须是非空字符串`)
    }
    return item
  })
}

function optionalEnum<T extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ToolArgumentError(`${key} 必须是 ${allowed.join('|')} 之一，收到 ${JSON.stringify(value)}`)
  }
  return value as T
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function requireWorkflowContext(
  args: Readonly<Record<string, unknown>>,
  ports: ToolPorts,
  symbol: string,
  timeframe: string,
): { readonly token: string; readonly record: WorkflowContextRecord; readonly store: WorkflowContextStore } {
  const token = requireString(args, 'contextToken')
  const store = new WorkflowContextStore(ports.db)
  const record = store.verify(token, ports.clock.now(), { symbol, timeframe })
  if (record === undefined) {
    throw new ToolArgumentError('contextToken 无效、已过期、已消费，或与 symbol/timeframe 不匹配；必须先成功运行 trade_workflow_run')
  }
  return { token, record, store }
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

const tradeRegime: ToolDefinition = {
  name: 'trade_regime',
  description:
    '只读：按同标的同时间框架近 90 天特征快照计算 regime 分桶；历史不足或指标暖机时 fail-closed。',
  sideEffect: false,
  parameters: {
    symbol: { type: 'string', required: true },
    timeframe: { type: 'string', required: true, enum: TIMEFRAMES },
  },
  async execute(args, ports) {
    const symbol = requireString(args, 'symbol')
    const timeframe = requireEnum(args, 'timeframe', TIMEFRAMES)
    const asOf = ports.clock.now()
    const ninetyDaysMs = 90 * 24 * 3_600_000
    const snapshots = ports.features.range(symbol, timeframe, {
      since: asOf - ninetyDaysMs,
      until: asOf,
      // 90 天的 1m 快照约 12.96 万根；归档上限会再次保护异常大的请求。
      limit: 200_000,
    })
    const latest = snapshots.at(-1)
    const inputs = {
      ema20: latest?.values.ema20 ?? null,
      ema50: latest?.values.ema50 ?? null,
      atr14: latest?.values.atr14 ?? null,
      volRealized20: latest?.values.volRealized20 ?? null,
    }
    const volHistory = snapshots
      .map((snapshot) => snapshot.values.volRealized20)
      .filter((value): value is number => value !== null && Number.isFinite(value))
    const result = regimeOf({ symbol, timeframe, ...inputs, volHistory })

    if (!result.ok) {
      return {
        ok: false,
        symbol,
        timeframe,
        bucket: null,
        trend: null,
        vol: null,
        inputs,
        samples: volHistory.length,
        asOf,
        reason: result.reason,
        note: 'regime 未完成暖机或历史样本不足；不猜测桶。',
      }
    }

    return {
      ok: true,
      symbol,
      timeframe,
      bucket: result.bucket,
      trend: result.trend,
      vol: result.vol,
      inputs,
      samples: result.samples,
      asOf,
      note: 'trend 使用 abs(ema20-ema50)/atr14，vol 使用近 90 天 volRealized20 分位；结果只读。',
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
      duplicateDecision: false,
      paperVenue: 'paper',
      ...(ports.frozenSymbols === undefined ? {} : { frozenSymbols: ports.frozenSymbols() }),
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
          timeframe,
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
      if (method === 'limit' && ports.mode !== 'paper') return refuse('增加敞口的限价单在成交监控接入前禁止提交')
      const snapshot = ports.features.latest(symbol, timeframe)
      if (snapshot === undefined) {
        return refuse(`没有 ${symbol} ${timeframe} 的特征快照`)
      }
      const entryPrice = snapshot.values.close
      const stop: StopSpec =
        stopMethod === 'atr' ? { method: 'atr', k: stopValue } : { method: 'structure', level: stopValue }
      const limitPrice = optionalNumber(args, 'limitPrice')
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
        clientOrderId: numericClientOrderId(`co:${effectiveDecisionId}`),
        decisionId,
        symbol,
        type: method as OrderType,
        side: side === 'long' ? 'buy' : 'sell',
        qty: sizing.qty,
        notionalUsd: sizing.notionalUsd,
        reduceOnly: false,
        ...(limitPrice === undefined ? {} : { price: limitPrice }),
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
        clientOrderId: numericClientOrderId(`co:${effectiveDecisionId}`),
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
      duplicateDecision: ports.journal.hasClientOrderId(intent.clientOrderId),
      paperVenue: 'paper',
      ...(ports.frozenSymbols === undefined ? {} : { frozenSymbols: ports.frozenSymbols() }),
    }
    const verdict = validateIntent(intent, account, policy)
    if (verdict.kind === 'deny') {
      return refuse(verdict.reason)
    }

    // ④ 意图先落库（created），再发请求；崩溃时按 clientOrderId 去交易所查询
    const inserted = ports.journal.recordDecisionAndIntent(
      {
        decisionId: effectiveDecisionId,
        symbol,
        timeframe,
        decidedAt: ports.clock.now(),
        contextHash: ports.contextHash ?? `unassembled-exec:${decisionId}`,
        action,
        executed: false,
        ...(sizeQty === undefined ? {} : { sizeQty }),
        ...(stopPrice === undefined ? {} : { stopPrice }),
        ...(takeProfit === undefined ? {} : { takeProfit }),
        ...(rationale === undefined ? {} : { rationale }),
      },
      {
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
        ...(intent.stopLossPrice === undefined ? {} : { stopPrice: intent.stopLossPrice }),
      },
    )
    if (!inserted.intentInserted) return { executed: false, reason: 'already_intended' }

    const ack = await ports.broker.placeOrder(intent)
    const applied = ports.journal.applyOrderAck(ack, ports.clock.now(), {
      fallbackQty: intent.qty,
      fallbackPrice: intent.price ?? ports.features.latest(symbol, timeframe)?.values.close,
      reflectionHorizonMs: ports.reflectionHorizonMs ?? horizonMsForTimeframe(timeframe),
    })
    if (applied.unknown) ports.freezeSymbol?.(symbol)

    let executed = applied.filled
    if (action === 'open' && !executed && ack.state !== 'rejected') {
      try {
        const before = position?.qty ?? 0
        const after = (await ports.broker.getPositions()).find((candidate) => candidate.symbol === symbol)?.qty ?? 0
        const direction = intent.side === 'buy' ? 1 : -1
        const deltaConfirmed = direction * (after - before) > 1e-12
        if (deltaConfirmed && ports.broker.venue === 'paper') executed = true
        else if (deltaConfirmed && ack.exchangeOrderId !== undefined) {
          const refreshed = await ports.broker.findOrderByExchangeOrderId?.(ack.exchangeOrderId, symbol)
          if (refreshed?.state === 'filled') {
            const refreshedResult = ports.journal.applyOrderAck(refreshed, ports.clock.now(), {
              fallbackQty: intent.qty,
              fallbackPrice: intent.price ?? ports.features.latest(symbol, timeframe)?.values.close,
              reflectionHorizonMs: ports.reflectionHorizonMs ?? horizonMsForTimeframe(timeframe),
            })
            executed = refreshedResult.filled
          }
        }
        if (deltaConfirmed && !executed) ports.freezeSymbol?.(symbol)
      } catch {
        ports.freezeSymbol?.(symbol)
      }
    }
    if (executed) {
      ports.journal.markDecisionExecuted(effectiveDecisionId)
      // 只有成交的决策才进结算队列（plan §7.9 ④）：到期时刻与"何时重跑该标的"无关。
      // 视界**按 tf 推导**（plan §12 #18）：1h→4h、4h→16h、1d→24h；全局 4h 常量对 1d 卡过短。
      if (action === 'open' || action === 'close' || action === 'reduce') {
        ports.journal.markDecisionReflectionDue(
          effectiveDecisionId,
          ports.clock.now() +
            (ports.reflectionHorizonMs ?? horizonMsForTimeframe(timeframe)),
        )
      }
    }

    // ⑤ 成交后**立即**挂保护单（HTX 无原子括号单 ⇒ 已知暴露窗口）
    let protectiveAck: unknown = null
    if (action === 'open' && executed && stopPrice !== undefined) {
      const protectiveClientId = numericClientOrderId(`pco:${effectiveDecisionId}`)
      // 保护单同样要进审计链：否则恢复流程会把它当成"交易所挂着、本地无记录"的孤儿单
      ports.journal.recordIntent({
        intentId: `pi:${effectiveDecisionId}`,
        clientOrderId: protectiveClientId,
        decisionId: effectiveDecisionId,
        venue: ports.broker.venue,
        symbol,
        state: 'created',
        type: 'protective',
        side: intent.side === 'buy' ? 'sell' : 'buy',
        qty: intent.qty,
        reduceOnly: true,
        createdAt: ports.clock.now(),
      })
      try {
        const pAck = await ports.broker.placeProtective({
          symbol,
          clientOrderId: protectiveClientId,
          stopLossPrice: stopPrice,
          ...(takeProfit === undefined ? {} : { takeProfitPrice: takeProfit }),
        })
        const protectiveResult = ports.journal.applyOrderAck(pAck, ports.clock.now(), {
          fallbackQty: intent.qty,
          fallbackPrice: stopPrice,
          reflectionHorizonMs: ports.reflectionHorizonMs ?? horizonMsForTimeframe(timeframe),
        })
        protectiveAck = pAck
        if (pAck.state === 'rejected' || protectiveResult.unknown) {
          await degradeUnprotectedOpen(
            ports,
            symbol,
            intent,
            effectiveDecisionId,
            intent.price ?? ports.features.latest(symbol, timeframe)?.values.close,
            'protective_rejected',
          )
        }
      } catch (error) {
        ports.journal.appendAudit({
          actor: 'system',
          kind: 'protection_failed',
          payload: { decisionId: effectiveDecisionId, symbol, error: String(error) },
          ts: ports.clock.now(),
        })
        await degradeUnprotectedOpen(
          ports,
          symbol,
          intent,
          effectiveDecisionId,
          intent.price ?? ports.features.latest(symbol, timeframe)?.values.close,
          `protective_failed:${String(error)}`,
        )
      }
    }

    // `close` = 全平 + cancelAll(symbol)（plan §3.3）
    if (action === 'close' && executed) {
      const remaining = (await ports.broker.getPositions()).find((candidate) => candidate.symbol === symbol)?.qty ?? 0
      if (remaining === 0) await ports.broker.cancelAll(symbol)
      else {
        ports.freezeSymbol?.(symbol)
        ports.journal.appendAudit({ actor: 'system', kind: 'close_not_flat', payload: { decisionId: effectiveDecisionId, symbol, remainingQty: remaining }, ts: ports.clock.now() })
      }
    }

    return {
      executed,
      clientOrderId: intent.clientOrderId,
      state: ack.state,
      protectiveAck,
    }
  },
}


/**
 * §6.3 降级：入场成交后保护单挂失败 ⇒ 立即平掉这笔仓位。
 * 与 `execute-action.ts` 的同名逻辑保持同一语义 —— 工具路径与机械执行路径不能有两套保护语义。
 */
async function degradeUnprotectedOpen(
  ports: ToolPorts,
  symbol: string,
  intent: OrderRequest,
  decisionId: string,
  price: number | undefined,
  reason: string,
): Promise<void> {
  const qty = Math.abs(intent.qty)
  try {
    const clientOrderId = numericClientOrderId(`degrade:${decisionId}`)
    ports.journal.recordIntent({
      intentId: `degrade:${decisionId}`,
      clientOrderId,
      decisionId,
      venue: ports.broker.venue,
      symbol,
      state: 'created',
      type: 'market',
      side: intent.side === 'buy' ? 'sell' : 'buy',
      qty,
      notionalUsd: qty * (price ?? 0),
      reduceOnly: true,
      createdAt: ports.clock.now(),
    })
    const ack = await ports.broker.placeOrder({
      intentId: `degrade:${decisionId}`,
      clientOrderId,
      decisionId,
      symbol,
      type: 'market',
      side: intent.side === 'buy' ? 'sell' : 'buy',
      qty,
      notionalUsd: qty * (price ?? 0),
      reduceOnly: true,
    })
    ports.journal.applyOrderAck(ack, ports.clock.now(), { fallbackQty: qty, fallbackPrice: price })
    if (ack.state !== 'filled') {
      ports.freezeSymbol?.(symbol)
      ports.journal.appendAudit({ actor: 'system', kind: 'protection_degrade_failed', payload: { decisionId, symbol, reason, qty, ackState: ack.state }, ts: ports.clock.now() })
      return
    }
    const remaining = (await ports.broker.getPositions()).find((candidate) => candidate.symbol === symbol)?.qty ?? 0
    if (remaining !== 0) {
      ports.freezeSymbol?.(symbol)
      ports.journal.appendAudit({ actor: 'system', kind: 'protection_degrade_failed', payload: { decisionId, symbol, reason, qty, remainingQty: remaining }, ts: ports.clock.now() })
      return
    }
    ports.journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_closed',
      payload: { decisionId, symbol, reason, qty },
      ts: ports.clock.now(),
    })
  } catch (error) {
    // 平仓也失败 ⇒ 如实落审计；下次对账会看到"有持仓无保护单"并冻结该标的。
    ports.journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_failed',
      payload: { decisionId, symbol, reason, error: String(error), qty },
      ts: ports.clock.now(),
    })
  }
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
    timeframe: { type: 'string', enum: TIMEFRAMES },
    contextToken: { type: 'string', required: true, description: 'trade_workflow_run 返回的一次性上下文 token' },
    action: { type: 'string', required: true },
    sizeQty: { type: 'number' },
    stopPrice: { type: 'number' },
    takeProfit: { type: 'number' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
  async execute(args, ports) {
    const decisionId = requireString(args, 'decisionId')
    const symbol = requireString(args, 'symbol')
    const rawAction = requireString(args, 'action')
    if (!(DECISION_ACTIONS as readonly string[]).includes(rawAction)) {
      throw new ToolArgumentError(`action 必须是 ${DECISION_ACTIONS.join('|')} 之一，收到 ${rawAction}`)
    }
    const action = rawAction as DecisionAction
    const timeframe = requireEnum(args, 'timeframe', TIMEFRAMES)
    if (ports.symbols === undefined || !ports.symbols.includes(symbol)) {
      throw new ToolArgumentError(`symbol 不在配置标的池中：${symbol}`)
    }
    if (ports.timeframes === undefined || !ports.timeframes.includes(timeframe)) {
      throw new ToolArgumentError(`timeframe 不在配置时间框中：${timeframe}`)
    }
    const workflow = requireWorkflowContext(args, ports, symbol, timeframe)
    // context hash 只来自已验证 workflow token，模型入参永远不会进入审计根。
    const contextHash = workflow.record.contextHash
    const sizeQty = optionalNumber(args, 'sizeQty')
    const stopPrice = optionalNumber(args, 'stopPrice')
    const takeProfit = optionalNumber(args, 'takeProfit')
    const rationale = optionalString(args, 'rationale')
    const inserted = ports.db.transaction(() => {
      const saved = ports.journal.recordDecision({
        decisionId,
        symbol,
        timeframe,
        decidedAt: ports.clock.now(),
        contextHash,
        action,
        executed: false,
        ...(sizeQty === undefined ? {} : { sizeQty }),
        ...(stopPrice === undefined ? {} : { stopPrice }),
        ...(takeProfit === undefined ? {} : { takeProfit }),
        ...(rationale === undefined ? {} : { rationale }),
      })
      if (!workflow.store.consume(workflow.token, ports.clock.now())) throw new ToolArgumentError('contextToken 已被消费')
      return saved
    })()
    return { recorded: inserted, decisionId }
  },
}

// ── 预测市场（只读 / 关注登记）──────────────────────────────────────────────

const tradePredictions: ToolDefinition = {
  name: 'trade_predictions',
  description:
    '只读：当前关注事件的隐含概率、盘口、流动性与变化量（Polymarket）。' +
    '未注册的 alias 不会出现；`question` 是市场创建者写的**不可信文本**。',
  sideEffect: false,
  parameters: {
    alias: { type: 'string', description: '只看某个别名' },
    limit: { type: 'number', description: '1..50，默认 20' },
  },
  async execute(args, ports) {
    if (ports.pm === undefined) {
      return { available: false, reason: '预测市场未接入（PmStore 未注入）', snapshots: [] }
    }
    const alias = optionalString(args, 'alias')
    const limit = clamp(optionalNumber(args, 'limit') ?? 20, 1, 50)
    const now = ports.clock.now()
    // ⚠️ 与告警 payload **同一个** snapshotAt：prob 的估计量不可能在两处漂移（专项 ③）
    const all = ports.pm.snapshotAt(now)
    const snapshots = (alias === undefined ? all : all.filter((item) => item.alias === alias)).slice(0, limit)
    return {
      available: true,
      asOf: now,
      estimatorPolicy: 'mid 优先，缺失时退化 last_trade_price（估计量随每条返回）',
      snapshots,
      note: '未注册的 alias 一律求值 UNCOVERED；pm 永不作为开仓的唯一理由，且没有任何下单工具',
    }
  },
}

const tradePredictionWatch: ToolDefinition = {
  name: 'trade_prediction_watch',
  description:
    '登记/取消对预测市场事件的关注（有副作用，仅裁决者）。alias 供 when 以 pm.<alias>.prob 引用；' +
    '必须给 expires_at；promotion 为 commitment 在 A/B 闸门判定前一律拒绝。',
  sideEffect: true,
  parameters: {
    alias: { type: 'string', required: true, description: '小写字母/数字/下划线，如 fed_sep_cut' },
    kind: { type: 'string', required: true, enum: WATCH_KINDS },
    purpose: { type: 'string', enum: WATCH_PURPOSES, description: '默认 novelty' },
    tokenIds: { type: 'array', items: { type: 'string' }, description: 'CLOB token id（十进制）' },
    expr: { type: 'string', description: 'kind=threshold 必填的布尔 DSL' },
    query: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    planId: { type: 'string' },
    expiresInHours: { type: 'number', description: '必填：关注期限（小时），不允许无期限' },
    cooldownMs: { type: 'number' },
    maxTriggers: { type: 'number' },
    cancel: { type: 'boolean', description: 'true = 取消该 alias 的关注' },
  },
  async execute(args, ports) {
    if (ports.pm === undefined) {
      throw new ToolArgumentError('预测市场未接入（PmStore 未注入）')
    }
    const alias = requireString(args, 'alias')
    const now = ports.clock.now()

    if (optionalBoolean(args, 'cancel') === true) {
      const cancelled = ports.pm.cancelWatch(alias)
      return { cancelled, alias, asOf: now }
    }

    const kind = requireEnum(args, 'kind', WATCH_KINDS)
    // purpose 默认 novelty（最保守：novelty 必须过流动性门槛，info 只落库通知）
    const purpose = optionalEnum(args, 'purpose', WATCH_PURPOSES) ?? 'novelty'
    if (purpose === 'commitment' && ports.allowPmCommitment !== true) {
      throw new ToolArgumentError(
        '不允许把预测市场登记为 commitment：该问题由 P1.5 A/B 闸门判定（plan §12 #11），判定前一律拒绝',
      )
    }
    const expiresInHours = requireNumber(args, 'expiresInHours')
    if (!(expiresInHours > 0)) {
      throw new ToolArgumentError(`expiresInHours 必须是正数，收到 ${expiresInHours}`)
    }
    const tokenIds = optionalStringArray(args, 'tokenIds') ?? []
    const tags = optionalStringArray(args, 'tags') ?? []
    const expr = optionalString(args, 'expr')
    const query = optionalString(args, 'query')
    const planId = optionalString(args, 'planId')
    const cooldownMs = optionalNumber(args, 'cooldownMs')
    const maxTriggers = optionalNumber(args, 'maxTriggers')

    try {
      const { watch, created } = ports.pm.registerWatch(
        {
          alias,
          kind: kind as WatchKind,
          purpose: purpose as WatchPurpose,
          tokenIds,
          tags,
          ...(expr === undefined ? {} : { expr }),
          ...(query === undefined ? {} : { query }),
          ...(planId === undefined ? {} : { planId }),
          ...(cooldownMs === undefined ? {} : { cooldownMs }),
          ...(maxTriggers === undefined ? {} : { maxTriggers }),
          expiresAt: now + expiresInHours * 3_600_000,
          // 工具由模型调用 ⇒ 一律记 model；人审通道不走这个工具
          createdBy: 'model',
        },
        now,
      )
      return {
        registered: created,
        watchId: watch.watchId,
        alias: watch.alias,
        expr: watch.expr ?? null,
        expiresAt: watch.expiresAt,
        cooldownMs: watch.cooldownMs,
        maxTriggers: watch.maxTriggers,
        distinctAliasReason: 'DSH 的 when DSL 没有字符串，所以 pm 只能以别名进入词汇表',
      }
    } catch (error) {
      if (error instanceof WatchError) throw new ToolArgumentError(error.message)
      throw error
    }
  },
}

/**
 * 计划卡落地工具（plan §3.1）—— 把模型的"判断与方法"变成一张**可判定、有期限、幂等、不可事后改写**的卡。
 *
 * 为什么必须有它：`live-engine` 每根已收盘 bar 只能执行**已存在**的计划卡；没有这个工具，
 * 无人值守回路就产不出任何卡，机械执行永远匹配不到东西（= 系统看起来在跑，但一笔都不会发生）。
 *
 * 卡片以 `cardJson` 传入（结构化 JSON），代码负责：补齐 createdAt/windowEndsAt/contentHash/planId、
 * 用 `validatePlanCard` 做结构+语义校验（失败即拒，绝不回退成散文再正则解析）、再 `PlanStore.save`。
 * 数量/价位仍由执行层推导（§3.4），这里不接受 qty。
 */
const tradePlanCard: ToolDefinition = {
  name: 'trade_plan_card',
  description:
    '提交/更新本窗口的计划卡（有副作用，仅裁决者）。计划卡是本窗口唯一可被机械执行的判断：' +
    'commitments/invalidation 的 when 必须是 §3.2 词表内、能被代码求值的布尔表达式；' +
    '同一个标的新卡会取代旧卡（旧卡留档），因此这是"提高判断质量"的正常路径，不是错误。',
  sideEffect: true,
  parameters: {
    symbol: { type: 'string', required: true },
    timeframe: { type: 'string', required: true, enum: TIMEFRAMES },
    contextToken: { type: 'string', required: true, description: 'trade_workflow_run 返回的一次性上下文 token' },
    windowEndsInHours: { type: 'number', required: true, description: '本卡有效期（小时），到期即失效' },
    cardJson: {
      type: 'string',
      required: true,
      description:
        'JSON：{thesis, confidence, keyLevels?, invalidation:[{id,tf,when,then}], ' +
        'commitments:[{id,seq,tf,when,then,...}], forbidden?, noTrade?}；when 用 §3.2 DSL',
    },
    planId: { type: 'string', description: '省略时按 symbol+时间+内容指纹生成' },
  },
  async execute(args, ports) {
    const symbol = requireString(args, 'symbol')
    const timeframe = requireEnum(args, 'timeframe', TIMEFRAMES)
    if (ports.symbols === undefined || !ports.symbols.includes(symbol)) {
      throw new ToolArgumentError(`symbol 不在配置标的池中：${symbol}`)
    }
    if (ports.timeframes === undefined || !ports.timeframes.includes(timeframe)) {
      throw new ToolArgumentError(`timeframe 不在配置时间框中：${timeframe}`)
    }
    const workflow = requireWorkflowContext(args, ports, symbol, timeframe)
    const windowEndsInHours = requireNumber(args, 'windowEndsInHours')
    if (!(windowEndsInHours > 0) || windowEndsInHours > 24 * 14) {
      throw new ToolArgumentError(`windowEndsInHours 必须在 (0, 336] 内，收到 ${windowEndsInHours}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(requireString(args, 'cardJson'))
    } catch (error) {
      throw new ToolArgumentError(`cardJson 不是合法 JSON：${(error as Error).message}`)
    }
    if (!isRecord(parsed)) throw new ToolArgumentError('cardJson 必须是 JSON 对象')

    const createdAt = ports.clock.now()
    const windowEndsAt = createdAt + windowEndsInHours * 3_600_000
    // 模型只提供判断内容；身份/时间/哈希一律由代码补齐，避免模型自造幂等根。
    const base = {
      ...parsed,
      symbol,
      createdAt,
      windowEndsAt,
      author: 'model' as const,
      authority: 'model' as const,
    }
    // planId 的指纹**不含 planId 自身**（否则自指）；最终 contentHash 再对含 planId 的完整内容求一次。
    // 这样 PlanStore.save 的"contentHash 必须与内容一致"校验才会通过，且相同判断重放得到同一 id。
    const idHash = computeContentHash(base as Parameters<typeof computeContentHash>[0])
    const planId =
      optionalString(args, 'planId') ??
      `pc-${symbol.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}-${createdAt}-${idHash.slice(7, 15)}`
    const finalCard = { ...base, planId }
    const contentHash = computeContentHash(finalCard as Parameters<typeof computeContentHash>[0])
    const validation = validatePlanCard({ ...finalCard, contentHash })
    if (!validation.ok) {
      throw new ToolArgumentError(`计划卡校验失败：${validation.errors.join('；')}`)
    }

    const conditionTimeframes = [...validation.card.invalidation, ...validation.card.commitments].map((item) => item.tf)
    if (conditionTimeframes.some((candidate) => candidate !== timeframe)) {
      throw new ToolArgumentError(`计划卡条件 tf 必须全部等于本次 workflow timeframe=${timeframe}`)
    }

    const saved = ports.db.transaction(() => {
      const result = ports.plans.save(validation.card, createdAt)
      if (!workflow.store.consume(workflow.token, ports.clock.now())) throw new ToolArgumentError('contextToken 已被消费')
      return result
    })()
    return {
      saved: true,
      status: saved.status,
      planId: saved.planId,
      version: saved.version,
      contentHash,
      windowEndsAt,
      note: '已广播给 live-engine：下一根已收盘 bar 起按 invalidation → commitments 优先级执行',
    }
  },
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  tradeMarket,
  tradeRegime,
  tradePortfolio,
  tradeOrderStatus,
  tradeLimits,
  tradeRiskCheck,
  tradeRecall,
  tradeProposeOrder,
  tradeExecuteOrder,
  tradeCancel,
  tradeRecordDecision,
  tradePlanCard,
  tradePredictions,
  tradePredictionWatch,
]

export const IMPLEMENTED_TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((tool) => tool.name)

export function toolByName(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name)
}

export function isRecordArg(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}
