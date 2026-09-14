/**
 * dsh-trader — 7×24 无人值守 crypto 交易 agent（DSH 插件包）。
 *
 * 本文件只导出包元信息与稳定的公共 API；运行期行为全部由 `cordis.patch.yml`
 * 逐行挂载的 `plugins/*` 提供（装包即挂载，见 plan.md §9.2）。
 */
export const name = 'dsh-trader'
export const version = '0.0.1'

export * from './config.js'
export * from './clock.js'
export * from './cost.js'
export * from './db/schema.js'
export * from './plan/schema.js'
export * from './plan/dsl.js'
export * from './plan/evaluate.js'
export * from './predictions/pit.js'
export * from './market/types.js'
export * from './market/normalize.js'
export * from './market/ratelimit.js'
export * from './market/archive.js'
export * from './market/backfill.js'
export * from './market/feed.js'
export * from './market/ccxt-source.js'
export * from './market/runtime.js'
export * from './market/indicators.js'
export * from './market/features.js'
export * from './market/feature-archive.js'
export * from './exec/broker.js'
export * from './exec/gate.js'
