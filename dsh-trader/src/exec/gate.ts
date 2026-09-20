/**
 * 硬闸（plan.md §6.2）：**模型提议，确定性系统裁决**。
 *
 * 三条设计要点：
 *   1. 它在模型的**外部** —— 没有绕过它的工具，也没有"申请豁免"的通道；
 *   2. 它只读**结构化字段**，理由文本永不参与判定；
 *   3. 它同时是**写入门禁** —— 通过校验的意图才被写入 `order_intents`。
 *
 * v0 裁决规则（安全偏向）：
 *   · 永远生效：模式一致性、幂等、结构校验；
 *   · **只拦"增加敞口"的订单**：perOrderCap / 总敞口 / 杠杆 / 挂单数 / 日亏 / 回撤 / 连亏 / 点差；
 *   · **降险订单（reduceOnly）直接放行** —— "不能开仓永远比乱开仓安全"，同理"能平仓永远比不能平仓安全"；
 *   · `limits === null`（用户显式放弃风控）时只保留永远生效的三条，并在审计里持续可见。
 */

import type { AccountSnapshot, OrderRequest, Venue } from './broker.js'
import type { RiskLimits, RunMode } from '../config.js'

export interface GatePolicy {
  readonly mode: RunMode
  readonly limits: RiskLimits | null
  /**
   * 宏观事件窗口是否允许开新仓。
   *
   * **当前不启用**（plan §12.1 #22）：调用方不传该字段 ⇒ 硬闸不做时间窗拦截。
   * 宏观风险改为在 `news` 分析师的提示词里提示（软判断，主动权在 agent 与裁决者），
   * 而不是用一条恒真/恒假的开关假装有风控。保留参数是为了将来接上日历后不必再改硬闸结构。
   */
  readonly tradingWindowOpen?: boolean
  /** 该 `decisionId` 是否已经执行过（幂等根）。 */
  readonly duplicateDecision: boolean
  readonly paperVenue: Venue
  /**
   * 对账/恢复判定"冻结自动交易"的标的（plan §4.2/§6.3）。
   * 只拦**增加敞口**：平仓/减仓永远放行（"能平仓永远比不能平仓安全"）。
   * 未提供视为空集；它是"永远生效"的安全检查，不受 `limits === null` 影响。
   */
  readonly frozenSymbols?: ReadonlySet<string>
}

export type GateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }

export const ALLOW: GateDecision = { kind: 'allow' }

export function deny(reason: string): GateDecision {
  return { kind: 'deny', reason }
}

/** 增加敞口的订单 = 非 reduceOnly。降险订单一律放行（除永远生效的检查外）。 */
export function increasesExposure(intent: Pick<OrderRequest, 'reduceOnly'>): boolean {
  return intent.reduceOnly !== true
}

export function projectedExposureUsd(intent: OrderRequest, account: AccountSnapshot): number {
  const increasing = increasesExposure(intent)
  if (increasing && account.pendingExposureUsd === null) return Number.POSITIVE_INFINITY
  const pending = increasing ? account.pendingExposureUsd ?? Number.POSITIVE_INFINITY : 0
  const delta = increasing ? intent.notionalUsd : -intent.notionalUsd
  return Math.max(0, account.totalExposureUsd + pending + delta)
}

export function projectedLeverage(intent: OrderRequest, account: AccountSnapshot): number {
  if (!(account.equityQuote > 0)) return Number.POSITIVE_INFINITY
  return projectedExposureUsd(intent, account) / account.equityQuote
}

export function validateIntent(
  intent: OrderRequest,
  account: AccountSnapshot,
  policy: GatePolicy,
): GateDecision {
  // ---- 永远生效：模式一致性 ----
  if (policy.mode === 'paper' && account.venue !== policy.paperVenue) {
    return deny(`paper 模式只能走 ${policy.paperVenue} 撮合，收到 ${account.venue}`)
  }
  if (policy.mode !== 'paper' && account.venue === policy.paperVenue) {
    return deny(`${policy.mode} 模式不允许提交到 ${policy.paperVenue} 撮合`)
  }

  // ---- 永远生效：幂等 ----
  if (policy.duplicateDecision) {
    return deny(`decision ${intent.decisionId} 已经执行过（幂等拒绝）`)
  }

  // ---- 永远生效：冻结标的禁止增加敞口（plan §4.2/§6.3）----
  // 必须在 `limits === null` 之前：用户放弃风控**参数**，不等于放弃冻结/幂等这类安全机制。
  // 只拦增加敞口 —— 冻结期间仍然允许平/减仓。
  if (increasesExposure(intent) && policy.frozenSymbols?.has(intent.symbol) === true) {
    return deny(`标的 ${intent.symbol} 已被冻结（对账/恢复存在未决状态），禁止新开仓`)
  }

  // ---- 永远生效：结构校验（数量/名义金额必须是重取实时状态后算出的数值） ----
  if (typeof intent.qty !== 'number' || !Number.isFinite(intent.qty) || intent.qty <= 0) {
    return deny(`qty 必须是有限正数，收到 ${JSON.stringify(intent.qty)}`)
  }
  if (
    typeof intent.notionalUsd !== 'number' ||
    !Number.isFinite(intent.notionalUsd) ||
    intent.notionalUsd <= 0
  ) {
    return deny('notionalUsd 必须由下单前重取的实时盘口估算得出')
  }

  // 账户快照也是不可信输入。NaN 会让所有 `>` 比较返回 false，若不先拒绝会把
  // “无法读取风控状态”误判成“没有风险”。unknown/Infinity 一律 fail-closed。
  const accountNumbers: readonly [string, number][] = [
    ['equityQuote', account.equityQuote],
    ['totalExposureUsd', account.totalExposureUsd],
    ['openOrders', account.openOrders],
    ['leverage', account.leverage],
    ['dailyLossUsd', account.dailyLossUsd],
    ['drawdownUsd', account.drawdownUsd],
    ['consecutiveLosses', account.consecutiveLosses],
    ['spreadBps', account.spreadBps],
    ['observedAt', account.observedAt],
  ]
  for (const [name, value] of accountNumbers) {
    if (!Number.isFinite(value) || value < 0) return deny(`账户状态 ${name} 非有限非负数，拒绝执行`)
  }
  if (account.pendingExposureUsd !== null &&
      (!Number.isFinite(account.pendingExposureUsd) || account.pendingExposureUsd < 0)) {
    return deny('账户状态 pendingExposureUsd 无效，拒绝执行')
  }
  if (increasesExposure(intent) && account.pendingExposureUsd === null) {
    return deny('无法核算未成交挂单敞口，拒绝增加风险')
  }

  const limits = policy.limits
  if (limits === null) return ALLOW // 用户显式放弃风控：安全机制（幂等/对账/心跳）仍然生效

  // 降险订单不受风控限额阻挡（可平不可开）
  if (!increasesExposure(intent)) return ALLOW

  if (policy.tradingWindowOpen === false) {
    return deny('不在交易窗口内（重大宏观事件前后禁止开仓）')
  }
  if (intent.notionalUsd > limits.perOrderCapUsd) {
    return deny(`单笔名义金额 ${intent.notionalUsd} 超过上限 ${limits.perOrderCapUsd}`)
  }
  const exposure = projectedExposureUsd(intent, account)
  if (exposure > limits.maxExposureUsd) {
    return deny(`预计总敞口 ${exposure.toFixed(2)} 超过上限 ${limits.maxExposureUsd}`)
  }
  const leverage = projectedLeverage(intent, account)
  if (leverage > limits.maxLeverage) {
    return deny(`预计杠杆 ${leverage.toFixed(3)} 超过上限 ${limits.maxLeverage}`)
  }
  if (account.dailyLossUsd > limits.dailyLossLimitUsd) {
    return deny(`当日亏损 ${account.dailyLossUsd} 已达上限 ${limits.dailyLossLimitUsd}`)
  }
  if (account.drawdownUsd > limits.maxDrawdownUsd) {
    return deny(`回撤 ${account.drawdownUsd} 已达上限 ${limits.maxDrawdownUsd}`)
  }
  if (account.consecutiveLosses >= limits.maxConsecutiveLosses) {
    return deny(`连续亏损 ${account.consecutiveLosses} 次，达到上限 ${limits.maxConsecutiveLosses}`)
  }
  if (account.spreadBps > limits.maxSpreadBps) {
    return deny(`点差 ${account.spreadBps}bps 超过上限 ${limits.maxSpreadBps}bps`)
  }
  if (account.openOrders >= limits.maxOpenOrders) {
    return deny(`挂单数 ${account.openOrders} 达到上限 ${limits.maxOpenOrders}`)
  }

  return ALLOW
}
