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
  readonly minimumRule?: 'htx-whole-contracts-v1'
}

export function marketSpecification(symbol: string, value: unknown, precisionMode: unknown): MarketSpecification {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, any>
  const number = (raw: unknown): number | null => typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  const info = row.info as Record<string, unknown> | undefined
  const contractSize = number(row.contractSize)
  const nativeCode = symbol.endsWith('/USDT:USDT') ? symbol.replace('/USDT:USDT', '-USDT') : undefined
  const htxWholeContracts = nativeCode !== undefined && row.id === nativeCode &&
    row.symbol === symbol && row.swap === true && row.linear === true &&
    contractSize !== null && contractSize > 0 && info?.['contract_code'] === row.id &&
    info?.['business_type'] === 'swap' && info?.['trade_partition'] === 'USDT' &&
    number(info?.['contract_size']) === contractSize
  // HTX 原生 volume 是正整数张数；当前 ccxt 把 amount.min 写成基础币 contractSize，不能再当张数使用。
  // 原生整张合约规则没有额外报价币 floor；只有确认该元数据来源时才标记为 0，未知源仍保留 null。
  const minNotionalQuote = number(row.limits?.cost?.min) ??
    (htxWholeContracts && row.limits?.cost?.min === undefined ? 0 : null)
  // ccxt TICK_SIZE=4；其它精度模式不能把“小数位数”冒充步长。
  return { symbol, linear: typeof row.linear === 'boolean' ? row.linear : null,
    contractSize, amountStepContracts: precisionMode === 4 ? number(row.precision?.amount) : null,
    priceStep: precisionMode === 4 ? number(row.precision?.price) : null,
    minAmountContracts: htxWholeContracts ? 1 : number(row.limits?.amount?.min), minNotionalQuote,
    makerFeeRate: number(row.maker), takerFeeRate: number(row.taker),
    ...(htxWholeContracts ? { minimumRule: 'htx-whole-contracts-v1' as const } : {}),
  }
}
