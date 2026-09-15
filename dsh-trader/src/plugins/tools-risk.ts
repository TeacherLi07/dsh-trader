/**
 * `trade-tools-risk` —— 风控角色工具面：`trade_risk_check` / `trade_stress_test` / `trade_limits`。
 *
 * **纯计算 + 读限额，不能下单。** 风控角色永不被要求"为提案辩护"（decision §3.1 的反面教材）。
 *
 * 已实现的纯计算/限额工具接入注册表；未实现的 stress-test 不注册。
 */

import type { Context } from '@deepseek-ai/cordis'
import { getExecPorts } from './exec.js'
import { implementedToolNames, registerToolSet } from './tools-adapter.js'

export const name = 'trade-tools-risk'

export const RISK_TOOL_NAMES = ['trade_risk_check', 'trade_limits'] as const

export function apply(ctx: Context): void {
  registerToolSet(
    ctx,
    implementedToolNames(RISK_TOOL_NAMES),
    { portsProvider: getExecPorts },
    'trade.tools-risk.close',
  )
}

export const inject = ['tools']
