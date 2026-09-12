/**
 * 成本与预算（plan.md §8）。
 *
 * DeepSeek 缓存默认开启、自动命中，**不做缓存调优**；但预算以 USD 计，而运行时没有价格表，
 * 因此价目表由我们自己维护并版本化。**模型缺价格行时绝不静默计 0** —— 退化为 token 上限并告警。
 */

export interface ModelPrice {
  readonly model: string
  readonly effectiveFrom: number
  readonly inPerMtok: number
  readonly outPerMtok: number
  /** 缓存命中的输入单价；DeepSeek 自动命中，仅供可见性统计。 */
  readonly cachedInPerMtok?: number
  readonly source?: string
}

export interface TokenUsage {
  readonly tokensIn: number
  readonly tokensOut: number
  readonly tokensCached: number
}

export type CostEstimate =
  | { readonly known: true; readonly usd: number }
  | { readonly known: false; readonly reason: string }

/** 取 `at` 时刻生效的价目（同一模型取 effectiveFrom 最大的那条）。 */
export function selectPrice(
  prices: readonly ModelPrice[],
  model: string,
  at: number,
): ModelPrice | undefined {
  let best: ModelPrice | undefined
  for (const p of prices) {
    if (p.model !== model || p.effectiveFrom > at) continue
    if (best === undefined || p.effectiveFrom > best.effectiveFrom) best = p
  }
  return best
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
  return { known: true, usd }
}

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

/**
 * 预算闸门：超预算停 W2/W3（W1 审议窗照常），并产生审计事件 + 告警。
 * 成本未知时按 token 上限兜底，而不是当作免费。
 */
export function budgetAllows(
  state: BudgetState,
  dailyBudgetUsd: number,
  options: { readonly wake: 'W1' | 'W2' | 'W3' },
): BudgetDecision {
  if (options.wake === 'W1') return { allow: true }

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
