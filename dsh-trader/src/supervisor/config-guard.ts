/** 独立纯配置守卫：避免重复配置造成“看起来能改、实际空读”的假开关。 */

export interface MaybeUnwiredRulesConfig {
  /** W1 审议窗由 `trade-supervisor` 调度，rules 里配它是空读。 */
  readonly windows?: unknown
  /** rules 只消费数值上限；模型路由由 supervisor 唯一持有。 */
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
  throw new Error(`${where} 配置项 ${entries.join(', ')} 不是有效运行入口：${hint}`)
}

const HINT = '移除重复窗口或第二套路由；W1 调度与 W2/W3 模型路由只由 trade-supervisor 管理。'

/** schemastery 会把缺省 object/array 补成空容器；空容器不是“用户已配置”。 */
function hasConfiguredValue(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return true
}

export function assertWiredRulesConfig(config: MaybeUnwiredRulesConfig): void {
  const unwired: string[] = []
  if (hasConfiguredValue(config.windows)) unwired.push('windows')
  if (hasConfiguredValue(config.judgment?.provider)) unwired.push('judgment.provider')
  if (hasConfiguredValue(config.judgment?.model)) unwired.push('judgment.model')
  fail(unwired, 'trade-rules', HINT)
}
