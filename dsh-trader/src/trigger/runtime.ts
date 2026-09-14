/**
 * 触发层的进程内注册点。
 *
 * 与 `db/runtime.ts` 同构：插件之间**不直接互相依赖**，而是通过一个显式注册点组合，
 * 加载顺序由 `cordis.patch.yml` 保证（`trade-rules` 排在 `trade-market` 之前）。
 * 这样"行情 → 特征 → 规则 → 触发"的链路不需要把 rules 的配置塞进 market 插件。
 */

import type { RuleWatch } from './engine.js'

let current: RuleWatch | undefined

export function setTriggerRuntime(watch: RuleWatch | undefined): void {
  current = watch
}

export function getTriggerRuntime(): RuleWatch | undefined {
  return current
}

export function hasTriggerRuntime(): boolean {
  return current !== undefined
}
