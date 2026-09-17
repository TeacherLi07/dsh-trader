import { describe, expect, it } from 'vitest'
import { assertWiredRulesConfig, assertWiredSupervisorConfig } from '../src/supervisor/config-guard.js'

/**
 * 审计 S7 的回归：W2/W3 判断通道未接线时，相关配置必须**启动即拒绝**，
 * 而不是"配了却不生效"（那会让人误以为限流与预算在起作用）。
 */
describe('未接线配置守卫（审计 S7）', () => {
  it('空 object/array 是 schema 缺省值，不应伪装成已配置', () => {
    expect(() => assertWiredSupervisorConfig({ l2: {}, l3MinIntervalMs: undefined, dailyBudgetUsd: undefined })).not.toThrow()
    expect(() => assertWiredRulesConfig({ windows: [], judgment: {} })).not.toThrow()
  })

  it('supervisor：配了 l2 / l3MinIntervalMs / dailyBudgetUsd ⇒ 拒绝启动并点名', () => {
    expect(() => assertWiredSupervisorConfig({ l2: { provider: 'p', model: 'm' } })).toThrow(/l2/)
    expect(() => assertWiredSupervisorConfig({ l3MinIntervalMs: 14_400_000 })).toThrow(/l3MinIntervalMs/)
    expect(() => assertWiredSupervisorConfig({ dailyBudgetUsd: 5 })).toThrow(/dailyBudgetUsd/)
  })

  it('rules：windows 与 judgment.provider/model 拒绝；纯数值上限通过', () => {
    expect(() => assertWiredRulesConfig({ judgment: { maxPerHour: 3, maxPerDay: 8 } })).not.toThrow()
    expect(() => assertWiredRulesConfig({ windows: [{ id: 'w1' }] })).toThrow(/windows/)
    expect(() => assertWiredRulesConfig({ judgment: { provider: 'deepseek-official' } })).toThrow(
      /judgment\.provider/,
    )
    expect(() => assertWiredRulesConfig({ judgment: { model: 'deepseek-reasoner' } })).toThrow(/judgment\.model/)
  })
})
