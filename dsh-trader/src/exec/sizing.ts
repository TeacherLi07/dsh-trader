/**
 * 仓位与保护位推导（plan §3.4）。
 *
 * **数量由代码算，不由模型给** —— 模型只表达"用哪种止损方法 + 多少风险"，因此它给不出危险的数量。
 * 纯函数：同样的输入永远同样的输出，可单测、可回放。
 */

import type { StopSpec } from '../plan/schema.js'

export interface SizingInput {
  readonly equityQuote: number
  readonly riskPct: number
  readonly entryPrice: number
  readonly stopPrice: number
  /** 交易对的数量步进（`market.precision.amount`）。 */
  readonly qtyStep?: number
  readonly minQty?: number
  readonly maxNotionalUsd?: number
}

export type SizingResult =
  | {
      readonly ok: true
      readonly qty: number
      readonly stopDistance: number
      readonly riskQuote: number
      readonly notionalUsd: number
    }
  | { readonly ok: false; readonly reason: string }

export function computeSize(input: SizingInput): SizingResult {
  const { equityQuote, riskPct, entryPrice, stopPrice } = input

  if (!(equityQuote > 0)) return { ok: false, reason: `权益必须为正：${equityQuote}` }
  if (!(riskPct > 0) || riskPct > 0.05) {
    return { ok: false, reason: `riskPct 必须在 (0, 0.05] 内：${riskPct}` }
  }
  if (!(entryPrice > 0)) return { ok: false, reason: `入场价必须为正：${entryPrice}` }

  const stopDistance = Math.abs(entryPrice - stopPrice)
  if (!(stopDistance > 0)) return { ok: false, reason: '止损距离为 0 —— 无法据此定仓' }

  const riskQuote = equityQuote * riskPct
  const step = input.qtyStep !== undefined && input.qtyStep > 0 ? input.qtyStep : undefined
  let qty = riskQuote / stopDistance
  if (step !== undefined) qty = Math.floor(qty / step) * step

  const minQty = input.minQty ?? 0
  if (!(qty > 0) || qty < minQty) {
    return { ok: false, reason: `计算数量 ${qty} 低于最小下单量 ${minQty}` }
  }

  const notionalUsd = qty * entryPrice
  if (input.maxNotionalUsd !== undefined && notionalUsd > input.maxNotionalUsd) {
    return { ok: false, reason: `名义金额 ${notionalUsd} 超过单笔上限 ${input.maxNotionalUsd}` }
  }

  return { ok: true, qty, stopDistance, riskQuote, notionalUsd }
}

/**
 * 由 `StopSpec` 推导**具体价位**。
 * `structure` 用结构位；`atr` 需要当根 ATR，缺失时返回 undefined（**不猜**）。
 */
export function stopPriceFor(
  entryPrice: number,
  side: 'long' | 'short',
  stop: StopSpec,
  atr: number | null | undefined,
): number | undefined {
  if (stop.method === 'structure') return stop.level
  if (typeof atr !== 'number' || !Number.isFinite(atr) || !(atr > 0)) return undefined
  const distance = stop.k * atr
  const price = side === 'long' ? entryPrice - distance : entryPrice + distance
  return price > 0 ? price : undefined
}

/** 由 R 倍数推导止盈价（省略 `target` 时返回 undefined）。 */
export function takeProfitFor(
  entryPrice: number,
  side: 'long' | 'short',
  stopPrice: number,
  rMultiple: number | undefined,
): number | undefined {
  if (rMultiple === undefined || !(rMultiple > 0)) return undefined
  const distance = Math.abs(entryPrice - stopPrice) * rMultiple
  return side === 'long' ? entryPrice + distance : entryPrice - distance
}
