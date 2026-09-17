/**
 * `trade-tools-desk` —— 交易员/裁决者的工具面（plan §11.4）。
 *
 * 目标：`trade_portfolio`、`trade_propose_order`、`trade_execute_order`、`trade_cancel`、
 * `trade_order_status`、`trade_record_decision`、`trade_workflow_run`、`trade_recall`。
 *
 * 纪律：
 *   · `propose` 与 `execute` **必须分离**；
 *   · `trade_execute_order` 仍保留给机械/兼容执行路径；judge 的 agent setup 会把它从模型白名单移除；
 *   · 每个 execute 内部**强制**再验一遍硬闸（双保险）；
 *   · desk agent 的工具白名单目标 ≤ 20（工具过多会显著降低选择准确率）。
 *
 * 注册适配已实现；诚实清单中的未实现工具不注册，避免诱导模型调用占位能力。
 */

import type { Context } from '@deepseek-ai/cordis'
import { RUNTIME_IMPLEMENTED_TOOL_NAMES } from '../agents/tool-roster.js'
import { getExecPorts } from './exec.js'
import { implementedToolNames, registerToolSet } from './tools-adapter.js'
import { registerWorkflowTool } from './workflow-runner.js'
import { WORKFLOW_TOOL_NAME } from '../agents/tool-roster.js'

export const name = 'trade-tools-desk'

const RESEARCH_TOOL_NAMES = new Set(['trade_market', 'trade_predictions', 'trade_recall'])
const RISK_TOOL_NAMES = new Set(['trade_risk_check', 'trade_limits'])

/** 其余已实现工具归 desk；这样新增实现不会因忘记更新白名单而漏注册。 */
export const DESK_TOOL_NAMES: readonly string[] = RUNTIME_IMPLEMENTED_TOOL_NAMES.filter(
  (tool) => !RESEARCH_TOOL_NAMES.has(tool) && !RISK_TOOL_NAMES.has(tool),
)

/** 普通工具仍走共享适配器；workflow 需要 subagents/parent，因此单独 effect 注册。 */
const DESK_DEFINITION_TOOL_NAMES = DESK_TOOL_NAMES.filter((tool) => tool !== WORKFLOW_TOOL_NAME)

export function apply(ctx: Context): void {
  registerToolSet(
    ctx,
    implementedToolNames(DESK_DEFINITION_TOOL_NAMES),
    { portsProvider: getExecPorts },
    'trade.tools-desk.close',
  )
  registerWorkflowTool(ctx, getExecPorts)
}

export const inject = ['tools', 'subagents']
