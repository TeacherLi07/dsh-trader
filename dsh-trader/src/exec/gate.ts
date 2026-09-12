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
  readonly tradingWindowOpen: boolean
  /** 该 `decisionId` 是否已经执行过（幂等根）。 */
  readonly duplicateDecision: boolean
  readonly paperVenue: Venue
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
  const delta = increasesExposure(intent) ? intent.notionalUsd : -intent.notionalUsd
  return Math.max(0, account.totalExposureUsd + delta)
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

  const limits = policy.limits
  if (limits === null) return ALLOW // 用户显式放弃风控：安全机制（幂等/对账/心跳）仍然生效

  // 降险订单不受风控限额阻挡（可平不可开）
  if (!increasesExposure(intent)) return ALLOW

  if (!policy.tradingWindowOpen) {
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
