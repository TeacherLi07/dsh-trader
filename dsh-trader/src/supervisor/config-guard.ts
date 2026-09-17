/**
 * 未接线配置守卫（审计 S7，plan §2/§8）。
 *
 * 背景：W2/W3 的"判断通道"在生产路径上**没有接线** —— `supervisor/windows.ts` 的
 * `decideWake` 与 `trigger/queue.ts` 的 `claim()` 都没有调用方，supervisor 只驱动 W1。
 * 这与 P1.5 闸门的判定（关闭 W2/W3，退化为"纯窗口 + 机械执行"）方向一致。
 *
 * 但"配了却不生效"是**最坏的状态**：`dailyBudgetUsd` / `l3MinIntervalMs` / `l2` 会让人
 * 以为限流与预算正在起作用。所以这里的选择是**启动即拒绝**，而不是静默忽略 ——
 * 要么从 `cordis.patch.yml` 删掉，要么先把接线补上。
 *
 * 放在独立纯模块里（不 import cordis / schemastery），这样单测不需要拉起插件运行时。
 */

export interface MaybeUnwiredSupervisorConfig {
  /** W2/W3 分流用的中间层模型路由；未接线。 */
  readonly l2?: unknown
  /** L3 节流间隔；未接线。 */
  readonly l3MinIntervalMs?: unknown
  /** 日预算；`budgetAllows` 目前零调用方，未接线。 */
  readonly dailyBudgetUsd?: unknown
}

export interface MaybeUnwiredRulesConfig {
  /** W1 审议窗由 `trade-supervisor` 调度，rules 里配它是空读。 */
  readonly windows?: unknown
  /** `judgment.provider/model` 是唤醒路由；rules 只消费数值上限。 */
  readonly judgment?:
    | {
        readonly maxPerHour?: unknown
        readonly maxPerDay?: unknown
        readonly provider?: unknown
        readonly model?: unknown
      }
    | undefined
}

function fail(entries: readonly string[], where: string, hint: string): void {
  if (entries.length === 0) return
  throw new Error(
    `${where} 配置项 ${entries.join(', ')} 尚未接线：W2/W3 判断通道未启用` +
      `（P1.5 闸门判定：关闭 W2/W3），这些值不会影响任何唤醒。${hint}`,
  )
}

const HINT = '请从 cordis.patch.yml 移除，或先实现 W2/W3 接线（claim + decideWake + 预算）后再配置。'

/** schemastery 会把缺省 object/array 补成空容器；空容器不是“用户已配置”。 */
function hasConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export function assertWiredSupervisorConfig(config: MaybeUnwiredSupervisorConfig): void {
  const unwired: string[] = []
  if (hasConfiguredValue(config.l2)) unwired.push('l2')
  if (hasConfiguredValue(config.l3MinIntervalMs)) unwired.push('l3MinIntervalMs')
  if (hasConfiguredValue(config.dailyBudgetUsd)) unwired.push('dailyBudgetUsd')
  fail(unwired, 'trade-supervisor', HINT)
}

export function assertWiredRulesConfig(config: MaybeUnwiredRulesConfig): void {
  const unwired: string[] = []
  if (hasConfiguredValue(config.windows)) unwired.push('windows')
  if (hasConfiguredValue(config.judgment?.provider)) unwired.push('judgment.provider')
  if (hasConfiguredValue(config.judgment?.model)) unwired.push('judgment.model')
  fail(unwired, 'trade-rules', HINT)
}
