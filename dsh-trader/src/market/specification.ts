/** 只投影市场白名单字段；不能把含原始请求或凭据的 exchange 对象送进 context。 */
export interface MarketSpecification {
  readonly symbol: string
  readonly linear: boolean | null
  readonly contractSize: number | null
  readonly amountStepContracts: number | null
  readonly priceStep: number | null
  readonly minAmountContracts: number | null
  readonly minNotionalQuote: number | null
  readonly makerFeeRate: number | null
  readonly takerFeeRate: number | null
}

export function marketSpecification(symbol: string, value: unknown, precisionMode: unknown): MarketSpecification {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, any>
  const number = (raw: unknown): number | null => typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  // ccxt TICK_SIZE=4；其它精度模式不能把“小数位数”冒充步长。
  return { symbol, linear: typeof row.linear === 'boolean' ? row.linear : null,
    contractSize: number(row.contractSize), amountStepContracts: precisionMode === 4 ? number(row.precision?.amount) : null,
    priceStep: precisionMode === 4 ? number(row.precision?.price) : null,
    minAmountContracts: number(row.limits?.amount?.min), minNotionalQuote: number(row.limits?.cost?.min),
    makerFeeRate: number(row.maker), takerFeeRate: number(row.taker),
  }
}
