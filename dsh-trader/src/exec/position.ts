/** 同一成交必须在paper撮合与历史镜像中产生相同数量、均价和已实现价差。 */
export interface PositionBasis {
  readonly qty: number
  readonly avgPrice: number
}

export function applyPositionFill(
  position: PositionBasis,
  fill: { readonly qty: number; readonly price: number; readonly side: string },
): PositionBasis & { readonly closedQty: number; readonly realizedGrossQuote: number } {
  if (fill.side !== 'buy' && fill.side !== 'sell') throw new Error('成交方向缺失或无效')
  if (!Number.isFinite(fill.qty) || fill.qty <= 0 || !Number.isFinite(fill.price) || fill.price <= 0) {
    throw new Error('成交数量或价格无效')
  }
  if (!Number.isFinite(position.qty) || !Number.isFinite(position.avgPrice) ||
      (position.qty === 0 ? position.avgPrice !== 0 : position.avgPrice <= 0)) {
    throw new Error('成交前持仓数量或均价无效')
  }
  const signed = fill.side === 'sell' ? -fill.qty : fill.qty
  const nextQty = position.qty + signed
  const adding = position.qty === 0 || Math.sign(position.qty) === Math.sign(signed)
  const closedQty = adding ? 0 : Math.min(Math.abs(position.qty), fill.qty)
  const realizedGrossQuote = closedQty === 0 ? 0 :
    (fill.price - position.avgPrice) * closedQty * Math.sign(position.qty)
  // 翻仓只把超出旧仓位的部分作为新入场；新均价必须是本次成交价。
  const avgPrice = nextQty === 0 ? 0 : adding
    ? (position.avgPrice * Math.abs(position.qty) + fill.price * fill.qty) / Math.abs(nextQty)
    : Math.sign(nextQty) === Math.sign(position.qty) ? position.avgPrice : fill.price
  if (!Number.isFinite(nextQty) || !Number.isFinite(avgPrice) || !Number.isFinite(realizedGrossQuote)) {
    throw new Error('成交持仓或价差计算溢出')
  }
  return { qty: nextQty, avgPrice, closedQty, realizedGrossQuote }
}
