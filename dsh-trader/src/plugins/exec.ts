/**
 * `trade-exec` —— 执行层与硬闸。
 *
 * 硬闸纯函数在 `src/exec/gate.ts`；CCXT broker 通过组合根注入 exchange，
 * 因而本插件不在 `apply` 期间构造交易所或触网。
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

export type ExecBrokerKind = 'paper' | 'ccxt'

function hasCredential(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 纯函数：只有非 paper 模式且两把凭据都存在，才允许组合根选择 CcxtBroker。
 * 没有凭据时保持 paper 是安全默认；返回值只包含路由，不携带任何密钥。
 */
export function shouldUseLiveBroker(config: ExecConfig): boolean {
  return config.mode !== 'paper' && hasCredential(config.apiKey) && hasCredential(config.apiSecret)
}

/** 供组合根/测试使用的 broker 路由；缺凭据的 live 配置安全降级为 paper。 */
export function resolveExecBroker(config: ExecConfig): ExecBrokerKind {
  return shouldUseLiveBroker(config) ? 'ccxt' : 'paper'
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
  // apply 只登记生命周期；真实 exchange factory 尚由组合根接线，避免插件加载时打网络。
  // 即使 mode 写成 live，没有凭据也只能沿用 paper，不能因为配置缺项而意外实盘。
  const route = resolveExecBroker(config)
  ctx.effect(
    () => () => {
      /* 由组合根持有 broker 时在这里解除用户数据流；本插件本身不拥有网络资源。 */
    },
    'trade.exec.close',
  )
  void route
}
