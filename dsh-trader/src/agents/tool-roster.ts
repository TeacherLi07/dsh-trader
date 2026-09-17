/** 运行期工具名册：普通定义工具 + 固化 workflow 特殊入口。 */

import { IMPLEMENTED_TOOL_NAMES } from './tools.js'

/** workflow 特殊工具名放在 agents 层，避免工具插件反向依赖插件实现。 */
export const WORKFLOW_TOOL_NAME = 'trade_workflow_run' as const

/**
 * workflow 不是 TOOL_DEFINITIONS 中的普通工具：它需要 ctx.subagents 和调用者
 * Agent 才能安全运行，所以单独注册；但权限/缺口检查必须看到同一份完整名册。
 */
export const RUNTIME_IMPLEMENTED_TOOL_NAMES: readonly string[] = [
  ...IMPLEMENTED_TOOL_NAMES,
  WORKFLOW_TOOL_NAME,
]
