/**
 * `trade-tools-research` —— 分析师/辩论角色工具面（**全部只读**）。
 *
 * 已实现的只读工具返回结构化摘要；`trade_derivatives` / `trade_news` / `trade_onchain`
 * 仍在诚实清单中，因此不注册任何占位能力。
 *
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { getExecPorts } from './exec.js'
import {
  implementedToolNames,
  registerToolSet,
} from './tools-adapter.js'

export const name = 'trade-tools-research'

/** 全局注册分片；角色权限仍由 agent 侧 restrict 决定。 */
export const RESEARCH_TOOL_NAMES = ['trade_market', 'trade_predictions', 'trade_recall'] as const

export const Config = z.object({
  maxBars: z.number().default(500),
})

export interface ResearchToolsConfig {
  maxBars: number
}

export function apply(ctx: Context, config: ResearchToolsConfig): void {
  registerToolSet(
    ctx,
    implementedToolNames(RESEARCH_TOOL_NAMES),
    { portsProvider: getExecPorts },
    'trade.tools-research.close',
  )
  void config
}

export const inject = ['tools']
