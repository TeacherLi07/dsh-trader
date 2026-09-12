/**
 * `trade-exec` —— 执行层与硬闸。
 *
 * 状态：骨架（T0.1）。硬闸纯函数已实现（`src/exec/gate.ts`，有单测）；
 * Broker/对账/paper 实现属 T0.8。
 *
 * 安全：`apiKey`/`apiSecret` 只从环境注入（systemd `EnvironmentFile`，0600），
 * **绝不**写进仓库、配置或 prompt；插件**不打印**密钥。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RiskLimits } from '../config.js'

export const name = 'trade-exec'

export const Config = z.object({
  mode: z.union(['paper', 'live_confirm', 'live_auto']).required(),
  perOrderCapUsd: z.number(),
  maxExposureUsd: z.number(),
  maxLeverage: z.number(),
  dailyLossLimitUsd: z.number(),
  maxDrawdownUsd: z.number(),
  maxConsecutiveLosses: z.number(),
  maxSpreadBps: z.number(),
  maxOpenOrders: z.number(),
  apiKey: z.string(),
  apiSecret: z.string(),
})

export interface ExecConfig {
  mode: 'paper' | 'live_confirm' | 'live_auto'
  perOrderCapUsd?: number
  maxExposureUsd?: number
  maxLeverage?: number
  dailyLossLimitUsd?: number
  maxDrawdownUsd?: number
  maxConsecutiveLosses?: number
  maxSpreadBps?: number
  maxOpenOrders?: number
  apiKey?: string
  apiSecret?: string
}

/** 从配置组装硬闸阈值。任一缺失即视为"未提供"——由启动参数流程决定是否 waiver。 */
export function limitsFromConfig(config: ExecConfig): RiskLimits | null {
  const values = [
    config.perOrderCapUsd,
    config.maxExposureUsd,
    config.maxLeverage,
    config.dailyLossLimitUsd,
    config.maxDrawdownUsd,
    config.maxConsecutiveLosses,
    config.maxSpreadBps,
    config.maxOpenOrders,
  ]
  if (values.some((value) => value === undefined)) return null
  return {
    perOrderCapUsd: config.perOrderCapUsd as number,
    maxExposureUsd: config.maxExposureUsd as number,
    maxLeverage: config.maxLeverage as number,
    dailyLossLimitUsd: config.dailyLossLimitUsd as number,
    maxDrawdownUsd: config.maxDrawdownUsd as number,
    maxConsecutiveLosses: config.maxConsecutiveLosses as number,
    maxSpreadBps: config.maxSpreadBps as number,
    maxOpenOrders: config.maxOpenOrders as number,
  }
}

export function apply(ctx: Context, config: ExecConfig): void {
  // TODO(T0.8): Broker 接口 + PaperBroker + CcxtBroker(htx) + 对账 + 滑点/深度校验 + 降级。
  ctx.effect(
    () => () => {
      /* T0.8: 撤单/断开用户数据流 */
    },
    'trade.exec.close',
  )
  void config
}
