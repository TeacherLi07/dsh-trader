/**
 * 角色 → 工具白名单 + 模型路由（plan §6.4 / T1.2）。
 *
 * 纯数据 + 纯校验，不依赖 cordis —— 因此"分析师没有副作用工具""desk 工具 ≤ 20"
 * 这类约束可以在 CI 里被断言，而不是靠读代码相信。
 *
 * `KNOWN_TOOL_NAMES` 是**目标**工具箱（plan §11.4 的完整清单）；`missingTools()` 明确报告
 * 还没实现的那些 —— 缺口可见，且**绝不**注册一个"调用即抛错"的占位工具（那会诱导模型调用它）。
 */

export type ModelTier = 'deep' | 'quick'

export const ROLES = ['analyst', 'research', 'trader', 'risk', 'judge', 'meta'] as const
export type RoleName = (typeof ROLES)[number]

export interface RoleSpec {
  readonly name: RoleName
  readonly label: string
  readonly tools: readonly string[]
  readonly modelTier: ModelTier
  /** 是否允许持有会改变交易所状态或写入决策链的工具。 */
  readonly allowsSideEffects: boolean
}

/** 有副作用的工具：能改变交易所状态，或把决策写进审计链。**绝不发给只读角色。** */
export const SIDE_EFFECT_TOOLS = [
  'trade_execute_order',
  'trade_cancel',
  'trade_record_decision',
  'trade_prediction_watch',
  /** 写 plan_cards（本窗口唯一可被机械执行的判断），因此是副作用工具，只给裁决者。 */
  'trade_plan_card',
] as const

/** plan §11.4 的完整目标工具箱（含尚未实现的）。 */
export const KNOWN_TOOL_NAMES = [
  'trade_market',
  'trade_derivatives',
  'trade_news',
  'trade_onchain',
  'trade_predictions',
  'trade_recall',
  'trade_regime',
  'trade_portfolio',
  'trade_propose_order',
  'trade_order_status',
  'trade_risk_check',
  'trade_stress_test',
  'trade_limits',
  'trade_execute_order',
  'trade_cancel',
  'trade_record_decision',
  'trade_plan_card',
  'trade_workflow_run',
  'trade_prediction_watch',
  'trade_review',
  'trade_playbook_update',
] as const

export const ROLE_SPECS: Readonly<Record<RoleName, RoleSpec>> = {
  analyst: {
    name: 'analyst',
    label: '分析师（只读）',
    modelTier: 'quick',
    allowsSideEffects: false,
    tools: ['trade_market', 'trade_derivatives', 'trade_news', 'trade_onchain', 'trade_predictions'],
  },
  research: {
    name: 'research',
    label: '研究与辩论（只读）',
    modelTier: 'quick',
    allowsSideEffects: false,
    tools: [
      'trade_market',
      'trade_derivatives',
      'trade_news',
      'trade_onchain',
      'trade_predictions',
      'trade_recall',
      'trade_regime',
    ],
  },
  trader: {
    name: 'trader',
    label: '交易员（只提议，不成交）',
    modelTier: 'deep',
    allowsSideEffects: false,
    tools: ['trade_portfolio', 'trade_propose_order', 'trade_order_status', 'trade_recall'],
  },
  risk: {
    name: 'risk',
    label: '风控（纯计算）',
    modelTier: 'quick',
    allowsSideEffects: false,
    tools: ['trade_risk_check', 'trade_stress_test', 'trade_limits'],
  },
  judge: {
    name: 'judge',
    label: '裁决/执行（唯一，可下单）',
    modelTier: 'deep',
    allowsSideEffects: true,
    tools: [
      'trade_portfolio',
      'trade_propose_order',
      'trade_order_status',
      'trade_risk_check',
      'trade_limits',
      'trade_recall',
      'trade_execute_order',
      'trade_cancel',
      'trade_record_decision',
      'trade_plan_card',
      'trade_workflow_run',
      'trade_prediction_watch',
    ],
  },
  meta: {
    name: 'meta',
    label: '元循环（离线，产出需人审）',
    modelTier: 'deep',
    allowsSideEffects: false,
    tools: ['trade_review', 'trade_playbook_update'],
  },
}

/** desk（judge）工具数上限：≥30 个工具会显著降低工具选择准确率（plan §7.7）。 */
export const DESK_TOOL_BUDGET = 20

export class RoleSpecError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(`角色工具箱配置有问题：\n- ${problems.join('\n- ')}`)
    this.name = 'RoleSpecError'
    this.problems = problems
  }
}

export function sideEffectToolsFor(role: RoleName): readonly string[] {
  return ROLE_SPECS[role].tools.filter((tool) =>
    (SIDE_EFFECT_TOOLS as readonly string[]).includes(tool),
  )
}

export interface RoleSurfaceInput {
  /** 实际已实现的工具名。 */
  readonly implementedTools: readonly string[]
  readonly budget?: number
}

/**
 * 校验角色工具箱的**结构**约束：
 *   1. 不能引用计划外的工具名（防拼写错误）；
 *   2. 只读角色不得持有副作用工具；
 *   3. desk 工具数不超预算。
 * 未实现的工具**不算错误**（由 `missingTools` 单独报告）。
 */
export function assertRoleSurface(input: RoleSurfaceInput): void {
  const known = new Set<string>(KNOWN_TOOL_NAMES)
  const problems: string[] = []

  for (const role of ROLES) {
    for (const tool of ROLE_SPECS[role].tools) {
      if (!known.has(tool)) problems.push(`${role} 引用了计划外的工具：${tool}`)
    }
    const sideEffects = sideEffectToolsFor(role)
    if (!ROLE_SPECS[role].allowsSideEffects && sideEffects.length > 0) {
      problems.push(`${role} 不该持有副作用工具：${sideEffects.join(', ')}`)
    }
  }

  const budget = input.budget ?? DESK_TOOL_BUDGET
  if (ROLE_SPECS.judge.tools.length > budget) {
    problems.push(`desk(judge) 工具数 ${ROLE_SPECS.judge.tools.length} 超过预算 ${budget}`)
  }

  if (problems.length > 0) throw new RoleSpecError(problems)
  void input
}

/** 目标工具箱中尚未实现的部分 —— 显式报告，不静默跳过。 */
export function missingTools(implementedTools: readonly string[]): readonly string[] {
  const implemented = new Set(implementedTools)
  return KNOWN_TOOL_NAMES.filter((tool) => !implemented.has(tool))
}

export interface ModelRouting {
  readonly provider: string
  readonly model: string
}

export interface RoutingTable {
  readonly deep: ModelRouting
  readonly quick: ModelRouting
}

/** 按角色分层选模型：深度判断用强模型，只读分析用轻量模型（保留 TradingAgents 的分层）。 */
export function modelFor(role: RoleName, routing: RoutingTable): ModelRouting {
  return ROLE_SPECS[role].modelTier === 'deep' ? routing.deep : routing.quick
}

/** 组装 `agentCtx.tools.restrict(...)` 需要的白名单。 */
export function restrictFor(role: RoleName, implementedTools: readonly string[]): {
  readonly allow: readonly string[]
} {
  const implemented = new Set(implementedTools)
  return { allow: ROLE_SPECS[role].tools.filter((tool) => implemented.has(tool)) }
}
