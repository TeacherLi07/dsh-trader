import { describe, expect, it } from 'vitest'
import { assertWiredRulesConfig } from '../src/supervisor/config-guard.js'

/**
 * 回归：rules 不承载第二套窗口或模型路由；数值上限仍由触发治理消费。
 */
describe('rules 防重复配置守卫', () => {
  it('空 object/array 是 schema 缺省值，不应伪装成已配置', () => {
    expect(() => assertWiredRulesConfig({ windows: [], judgment: {} })).not.toThrow()
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
