/** 真实冒烟的账户前置与清理纪律；保护单只能在确认空仓后撤销。 */

import type { Broker, OrderAck, PositionSnapshot } from './broker.js'

type SmokeBroker = Pick<Broker, 'cancelAll' | 'getPositions' | 'getOpenOrders'>

export interface SmokeCleanupResult {
  readonly cancelAll: boolean
  readonly flattened: boolean
  readonly note: string | null
}

export interface SmokeLossEnvelope {
  readonly maxLossUsd: number
  readonly conservativeLossUsd: number
  readonly fits: boolean
}

export function evaluateSmokeLossEnvelope(input: {
  readonly equityQuote: number
  readonly maxDrawdownPct: number
  readonly oneContractBase: number
  readonly referencePrice: number
}): SmokeLossEnvelope {
  const { equityQuote, maxDrawdownPct, oneContractBase, referencePrice } = input
  if (!Number.isFinite(equityQuote) || equityQuote <= 0 ||
      !Number.isFinite(maxDrawdownPct) || maxDrawdownPct <= 0 || maxDrawdownPct >= 1 ||
      !Number.isFinite(oneContractBase) || oneContractBase <= 0 ||
      !Number.isFinite(referencePrice) || referencePrice <= 0) {
    throw new Error('冒烟损失额度的权益、比例、合约大小或参考价无效')
  }
  const maxLossUsd = equityQuote * maxDrawdownPct
  // 多单即使止损完全失效，价格归零时的本金损失至少涉及整张合约名义额；
  // 另预留名义额的 2% 给已知交易成本，但价格跳变仍无法给市价成交绝对保证。
  const conservativeLossUsd = oneContractBase * referencePrice * 1.02
  if (!Number.isFinite(maxLossUsd) || !Number.isFinite(conservativeLossUsd)) {
    throw new Error('冒烟损失额度计算溢出')
  }
  return { maxLossUsd, conservativeLossUsd, fits: conservativeLossUsd <= maxLossUsd }
}

export function assertSmokeAccountFlat(
  positions: readonly PositionSnapshot[],
  openOrders: readonly OrderAck[],
): void {
  if (positions.some((position) => !Number.isFinite(position.qty) || position.qty !== 0) || openOrders.length > 0) {
    throw new Error('账户非空仓或有挂单，拒绝开始真实冒烟')
  }
}

function symbolQty(positions: readonly PositionSnapshot[], symbol: string): number {
  const active = positions.filter((position) => position.symbol === symbol && position.qty !== 0)
  if (active.length > 1 || active.some((position) => !Number.isFinite(position.qty))) {
    throw new Error('目标标的仓位数量不可唯一核验，保留保护单')
  }
  return active[0]?.qty ?? 0
}

export async function cleanupSmokePosition(
  broker: SmokeBroker,
  symbol: string,
  closePosition: (qty: number) => Promise<void>,
): Promise<SmokeCleanupResult> {
  const errors: string[] = []
  // 默认撤单只清普通开仓单；已挂的交易所止损必须覆盖直到确认空仓。
  try {
    await broker.cancelAll(symbol)
  } catch (error) {
    errors.push(`cancel entries: ${String(error)}`)
  }

  let flattened = false
  try {
    const qty = symbolQty(await broker.getPositions(), symbol)
    if (qty !== 0) await closePosition(qty)
    flattened = symbolQty(await broker.getPositions(), symbol) === 0
  } catch (error) {
    errors.push(`flatten: ${String(error)}`)
  }

  if (!flattened) {
    return { cancelAll: false, flattened: false, note: errors.join('; ') || '仓位未确认归零，保留保护单' }
  }

  try {
    await broker.cancelAll(symbol, { includeProtection: true })
    const remaining = await broker.getOpenOrders(symbol)
    if (remaining.length > 0) throw new Error('空仓后仍有未撤挂单')
    return { cancelAll: true, flattened: true, note: errors.join('; ') || null }
  } catch (error) {
    errors.push(`cancel protection after flat: ${String(error)}`)
    return { cancelAll: false, flattened: true, note: errors.join('; ') }
  }
}
