/**
 * 成本与预算（plan.md §8）。
 *
 * DeepSeek 缓存默认开启、自动命中，**不做缓存调优**；但预算以 USD 计，而运行时没有价格表，
 * 因此价目表由我们自己维护并版本化。**模型缺价格行时绝不静默计 0** —— 退化为 token 上限并告警。
 *
 * ★ 官方价目**分峰谷**（§8.1）：同一模型峰时/谷时单价差 2×。
 *   只存一行"平均价"会让谷时高估一倍、峰时低估一倍 —— 所以 `price_table` 带 `tier`，
 *   取价时按**注入的时间**判峰谷（不读系统时钟，plan §7）。
 */

/** 价目档位：`any` 为不分峰谷的兜底行。 */
export type PriceTier = 'any' | 'peak' | 'off_peak'

export interface ModelPrice {
  readonly model: string
  readonly effectiveFrom: number
  readonly inPerMtok: number
  readonly outPerMtok: number
  /** 缓存命中的输入单价；DeepSeek 自动命中，仅供可见性统计。 */
  readonly cachedInPerMtok?: number
  readonly tier?: PriceTier
  readonly source?: string
}

export interface TokenUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly tokensCached: number
}

export type CostEstimate =
  | { readonly known: true; readonly usd: number; readonly tier: PriceTier }
  | { readonly known: false; readonly reason: string }

/**
 * 峰谷判定（官方口径）：**UTC 周一至周五** 01:00–04:00 与 06:00–10:00 为峰时，
 * 其余（含整个周末）为谷时；谷时价为峰时价的一半。
 *
 * 只依赖传入的时间戳 —— 读系统时钟会让回放与实盘算出不同预算（plan §7）。
 */
export function priceTier(at: number): PriceTier {
  const date = new Date(at)
  const day = date.getUTCDay() // 0=周日, 6=周六
  if (day === 0 || day === 6) return 'off_peak'
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? 'peak' : 'off_peak'
}

/**
 * 取 `at` 时刻生效的价目：
 *   1. 过滤 `effectiveFrom <= at`，取生效时间**最大**的那个版本；
 *   2. 版本内优先精确匹配 `at` 的档位，其次 `any` 兜底行。
 */
export function selectPrice(
  prices: readonly ModelPrice[],
  model: string,
  at: number,
): ModelPrice | undefined {
  const candidates = prices.filter((p) => p.model === model && p.effectiveFrom <= at)
  const first = candidates[0]
  if (first === undefined) return undefined
  let version = first
  for (const p of candidates) {
    if (p.effectiveFrom > version.effectiveFrom) version = p
  }
  const sameVersion = candidates.filter((p) => p.effectiveFrom === version.effectiveFrom)
  const wanted = priceTier(at)
  const exact = sameVersion.find((p) => (p.tier ?? 'any') === wanted)
  if (exact !== undefined) return exact
  // 只允许 `any` 兜底；**缺本档位就必须当作"缺行"**（返回 undefined ⇒ cost_known=0 + 告警）。
  // 旧实现 `?? version` 会把峰时价拿去算谷时（或反之），静默高估/低估一倍且标记为可信。
  return sameVersion.find((p) => (p.tier ?? 'any') === 'any')
}

export function estimateCost(
  usage: TokenUsage,
  prices: readonly ModelPrice[],
  model: string,
  at: number,
): CostEstimate {
  const price = selectPrice(prices, model, at)
  if (price === undefined) {
    return { known: false, reason: `price_table 无 ${model} 在 ${at} 生效的价目` }
  }
  const cached = Math.min(Math.max(usage.tokensCached, 0), Math.max(usage.tokensIn, 0))
  const uncachedIn = Math.max(usage.tokensIn - cached, 0)
  const cachedRate = price.cachedInPerMtok ?? price.inPerMtok
  const usd =
    (uncachedIn / 1_000_000) * price.inPerMtok +
    (cached / 1_000_000) * cachedRate +
    (Math.max(usage.tokensOut, 0) / 1_000_000) * price.outPerMtok
  return { known: true, usd, tier: price.tier ?? 'any' }
}

export const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing (2026-09-14)'

/**
 * 官方价目种子（§8.1）。来源见 `PRICING_SOURCE`，抓取于 2026-09-14。
 * 谷时价 = 峰时价 ÷ 2（官方明示）；这里**显式写出两档**而不是运行时除以 2，
 * 让价目表成为唯一事实来源 —— 改价只需改表。
 * 单位：USD / 1M tokens。
 */
export const DEEPSEEK_PRICE_SEED: readonly ModelPrice[] = [
  { model: 'deepseek-flash', effectiveFrom: Date.UTC(2026, 8, 14), tier: 'peak', cachedInPerMtok: 0.006, inPerMtok: 0.3, outPerMtok: 1.2, source: PRICING_SOURCE },
  { model: 'deepseek-flash', effectiveFrom: Date.UTC(2026, 8, 14), tier: 'off_peak', cachedInPerMtok: 0.003, inPerMtok: 0.15, outPerMtok: 0.6, source: PRICING_SOURCE },
  { model: 'deepseek-v4-pro', effectiveFrom: Date.UTC(2026, 8, 14), tier: 'peak', cachedInPerMtok: 0.044, inPerMtok: 1.32, outPerMtok: 3.96, source: PRICING_SOURCE },
  { model: 'deepseek-v4-pro', effectiveFrom: Date.UTC(2026, 8, 14), tier: 'off_peak', cachedInPerMtok: 0.022, inPerMtok: 0.66, outPerMtok: 1.98, source: PRICING_SOURCE },
]

export interface BudgetState {
  readonly spentUsd: number
  readonly estimatedUsd: number
  readonly unknownCostCalls: number
  readonly tokens: number
  readonly tokenCap: number | null
}

export type BudgetDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string }

/** 超预算停止所有新增模型判断；成本未知只能在显式 token cap 下运行。 */
export function budgetAllows(
  state: BudgetState,
  dailyBudgetUsd: number,
  options: { readonly wake: 'W1' | 'W2' | 'W3' },
): BudgetDecision {
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0) {
    return { allow: false, reason: 'dailyBudgetUsd 必须是有限非负数' }
  }
  if (![state.spentUsd, state.estimatedUsd, state.unknownCostCalls, state.tokens].every((value) => Number.isFinite(value) && value >= 0)) {
    return { allow: false, reason: '预算状态包含非有限或负值' }
  }
  if (state.tokenCap !== null && (!Number.isFinite(state.tokenCap) || state.tokenCap <= 0)) {
    return { allow: false, reason: 'tokenCap 必须是正数或 null' }
  }
  if (state.tokenCap !== null && state.tokens >= state.tokenCap) {
    return { allow: false, reason: `token 上限已达（${state.tokens}/${state.tokenCap}）` }
  }
  if (state.unknownCostCalls > 0 && state.tokenCap === null) {
    return {
      allow: false,
      reason: `成本未知（price_table 缺少价目，${state.unknownCostCalls} 次调用）且无 token 上限`,
    }
  }
  const projected = state.spentUsd + state.estimatedUsd
  if (projected > dailyBudgetUsd) {
    return {
      allow: false,
      reason: `超出日预算：已用 ${state.spentUsd.toFixed(4)} + 预估 ${state.estimatedUsd.toFixed(4)} > ${dailyBudgetUsd}`,
    }
  }
  return { allow: true }
}
