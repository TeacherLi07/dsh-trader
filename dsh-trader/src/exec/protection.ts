/**
 * 开仓暴露的唯一保护降级：先请求交易所侧保护；确认失败时立即 reduce-only 平仓。
 * 普通上下文、本地 stop intent 或模型输出都不能替代 broker 的保护订单状态。
 */

import type { Clock } from '../clock.js'
import { numericClientOrderId } from '../util/canonical.js'
import type { Broker, PositionSnapshot } from './broker.js'
import { DecisionJournal } from './journal.js'

export interface ProtectPositionInput {
  readonly broker: Broker
  readonly journal: DecisionJournal
  readonly clock: Clock
  readonly symbol: string
  readonly decisionId: string
  readonly clientOrderId: string
  readonly position: PositionSnapshot
  readonly stopPrice?: number
  readonly takeProfitPrice?: number
  readonly referencePrice: number
  readonly reflectionHorizonMs: number
  readonly freezeSymbol?: (symbol: string) => void
  readonly reason: string
}

export interface ProtectPositionResult {
  readonly protected: boolean
  readonly closed: boolean
}

/** 用真实订单累计成交量修补滞后的持仓快照；绝不把请求量当成交量。 */
export function inferPositionAfterFill(
  symbol: string,
  before: PositionSnapshot | undefined,
  side: 'buy' | 'sell',
  filledQty: number | undefined,
  fillPrice: number | undefined,
  fallbackPrice: number,
): PositionSnapshot | undefined {
  if (filledQty === undefined || !Number.isFinite(filledQty) || filledQty <= 0) return undefined
  const previousQty = before?.qty ?? 0
  if (!Number.isFinite(previousQty)) return undefined
  const signedFill = side === 'buy' ? filledQty : -filledQty
  const qty = previousQty + signedFill
  if (!Number.isFinite(qty) || qty === 0) return undefined

  const validPrice = (value: number | undefined): value is number =>
    value !== undefined && Number.isFinite(value) && value > 0
  const previousPrice = validPrice(before?.avgPrice) ? before.avgPrice : undefined
  const executionPrice = validPrice(fillPrice) ? fillPrice : undefined
  const estimate = validPrice(fallbackPrice) ? fallbackPrice : undefined
  let avgPrice: number | undefined
  if (previousQty === 0 || previousQty * signedFill > 0) {
    const oldNotional = previousPrice === undefined ? 0 : Math.abs(previousQty) * previousPrice
    const fillNotional = executionPrice === undefined ? 0 : filledQty * executionPrice
    const knownQty = (previousPrice === undefined ? 0 : Math.abs(previousQty)) +
      (executionPrice === undefined ? 0 : filledQty)
    avgPrice = knownQty > 0 ? (oldNotional + fillNotional) / knownQty : estimate
  } else if (filledQty < Math.abs(previousQty)) {
    avgPrice = previousPrice ?? estimate
  } else {
    avgPrice = executionPrice ?? estimate
  }
  if (!validPrice(avgPrice)) return undefined
  return { symbol, qty, avgPrice, unrealizedPnlUsd: 0 }
}

export function protectionClientOrderId(decisionId: string, positionQty: number): string {
  if (!Number.isFinite(positionQty) || positionQty === 0) throw new Error('保护单幂等键需要非零有限持仓数量')
  // 数量进入幂等域：新增的部分成交扩大仓位时必须能再挂一张覆盖新总量的 reduce-only 保护单。
  return numericClientOrderId(`pco-open:${decisionId}:${Math.abs(positionQty).toPrecision(12)}`)
}

/** 挂保护失败时不能把已知裸仓留到下一轮模型或五分钟对账。 */
export async function protectPositionOrClose(input: ProtectPositionInput): Promise<ProtectPositionResult> {
  const { broker, journal, clock, symbol, decisionId } = input
  const now = clock.now()
  let position = input.position
  try {
    const observed = (await broker.getPositions()).find((item) => item.symbol === symbol)
    if (observed !== undefined && observed.qty !== 0) {
      if (Math.sign(observed.qty) === Math.sign(input.position.qty) &&
          Math.abs(observed.qty) + 1e-12 >= Math.abs(input.position.qty)) {
        position = observed
      } else {
        input.freezeSymbol?.(symbol)
        journal.appendAudit({
          actor: 'system', kind: 'protection_position_mismatch',
          payload: { decisionId, symbol, inferredQty: input.position.qty, observedQty: observed.qty }, ts: clock.now(),
        })
      }
    } else {
      // 成交回报已确认而仓位端点暂时缺失/返回旧的 flat 快照，不等于交易所证明空仓。
      // 保留 fill 派生数量继续尝试保护/减险，绝不因此撤掉现有保护单。
      input.freezeSymbol?.(symbol)
      journal.appendAudit({
        actor: 'system', kind: 'protection_position_snapshot_missing',
        payload: { decisionId, symbol, inferredQty: input.position.qty }, ts: clock.now(),
      })
    }
  } catch (error) {
    input.freezeSymbol?.(symbol)
    journal.appendAudit({
      actor: 'system', kind: 'protection_state_unknown',
      payload: { decisionId, symbol, error: String(error) }, ts: clock.now(),
    })
  }
  if (!Number.isFinite(position.qty) || position.qty === 0) {
    input.freezeSymbol?.(symbol)
    journal.appendAudit({ actor: 'system', kind: 'protection_position_unusable', payload: { decisionId, symbol, qty: position.qty }, ts: clock.now() })
    return { protected: false, closed: false }
  }
  const side = position.qty > 0 ? 'sell' : 'buy'
  const qty = Math.abs(position.qty)
  const intent = input.stopPrice === undefined ? undefined : {
    intentId: `pi-open:${decisionId}:${input.clientOrderId}`,
    clientOrderId: input.clientOrderId,
    decisionId,
    venue: broker.venue,
    symbol,
    state: 'created' as const,
    type: 'protective',
    side,
    qty,
    reduceOnly: true,
    createdAt: now,
    stopPrice: input.stopPrice,
  }

  let failure: string | undefined = input.stopPrice === undefined ? '开仓意图缺少可用止损价' : undefined
  if (intent !== undefined && !journal.recordIntent(intent)) {
    try {
      const existing = await broker.findOrderByClientOrderId?.(input.clientOrderId, symbol)
      if (existing !== undefined) {
        const applied = journal.applyOrderAck(existing, clock.now(), { reflectionHorizonMs: input.reflectionHorizonMs })
        if (existing.state === 'acked' && !applied.unknown) return { protected: true, closed: false }
      }
      const positionNow = (await broker.getPositions()).find((item) => item.symbol === symbol)
      if (positionNow?.qty !== undefined && positionNow.qty !== 0 &&
          positionNow.protectedStopPrice !== undefined && Math.sign(positionNow.qty) === Math.sign(position.qty) &&
          Math.abs(positionNow.qty) + 1e-12 >= Math.abs(position.qty)) return { protected: true, closed: false }
      failure = '保护意图已存在但交易所侧保护不可核验'
    } catch (error) {
      failure = `保护意图已存在且查询失败：${String(error)}`
    }
  } else if (intent !== undefined) {
    try {
      const ack = await broker.placeProtective({
        symbol,
        clientOrderId: input.clientOrderId,
        stopLossPrice: input.stopPrice,
        ...(input.takeProfitPrice === undefined ? {} : { takeProfitPrice: input.takeProfitPrice }),
        expectedPositionQty: position.qty,
      })
      const applied = journal.applyOrderAck(ack, clock.now(), { reflectionHorizonMs: input.reflectionHorizonMs })
      if (ack.state === 'acked' && !applied.unknown) {
        journal.appendAudit({
          actor: 'system',
          kind: 'protection_installed',
          payload: { decisionId, symbol, clientOrderId: input.clientOrderId, exchangeOrderId: ack.exchangeOrderId ?? null, stopPrice: input.stopPrice, qty },
          ts: clock.now(),
        })
        return { protected: true, closed: false }
      }
      failure = applied.reason ?? `保护单返回非挂单状态 ${ack.state}`
    } catch (error) {
      failure = String(error)
    }
  }

  journal.appendAudit({
    actor: 'system',
    kind: 'protection_failed',
    payload: { decisionId, symbol, reason: input.reason, error: failure, qty },
    ts: clock.now(),
  })
  return flattenUnprotectedPosition(input, failure ?? '保护单未确认')
}

async function flattenUnprotectedPosition(
  input: ProtectPositionInput,
  reason: string,
): Promise<ProtectPositionResult> {
  const { broker, journal, clock, symbol, decisionId } = input
  let position = input.position
  try {
    const current = (await broker.getPositions()).find((item) => item.symbol === symbol)
    if (current !== undefined && current.qty !== 0) {
      if (Math.sign(current.qty) === Math.sign(input.position.qty) &&
          Math.abs(current.qty) + 1e-12 >= Math.abs(input.position.qty)) {
        position = current
      } else {
        input.freezeSymbol?.(symbol)
        journal.appendAudit({ actor: 'system', kind: 'protection_degrade_position_mismatch', payload: { decisionId, symbol, inferredQty: input.position.qty, observedQty: current.qty }, ts: clock.now() })
      }
    } else {
      // 缺失/flat 快照与已确认 fill 冲突；只能按 reduce-only 降险，不能宣称 flat 或撤保护。
      input.freezeSymbol?.(symbol)
      journal.appendAudit({ actor: 'system', kind: 'protection_degrade_position_snapshot_missing', payload: { decisionId, symbol, inferredQty: input.position.qty }, ts: clock.now() })
    }
  } catch (error) {
    input.freezeSymbol?.(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_failed',
      payload: { decisionId, symbol, reason, error: `重取持仓失败：${String(error)}` },
      ts: clock.now(),
    })
  }
  if (!Number.isFinite(position.qty) || position.qty === 0) return { protected: false, closed: false }

  const qty = Math.abs(position.qty)
  const side = position.qty > 0 ? 'sell' : 'buy'
  const price = Number.isFinite(input.referencePrice) && input.referencePrice > 0
    ? input.referencePrice
    : position.avgPrice
  if (!Number.isFinite(price) || price <= 0) {
    input.freezeSymbol?.(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_failed',
      payload: { decisionId, symbol, reason, error: '没有可核验的平仓估值价格', qty },
      ts: clock.now(),
    })
    return { protected: false, closed: false }
  }

  const clientOrderId = numericClientOrderId(`protection-close:${decisionId}`)
  try {
    journal.recordIntent({
      intentId: `protection-close:${decisionId}`,
      clientOrderId,
      decisionId,
      venue: broker.venue,
      symbol,
      state: 'created',
      type: 'market',
      side,
      qty,
      notionalUsd: qty * price,
      reduceOnly: true,
      createdAt: clock.now(),
    })
    const ack = await broker.placeOrder({
      intentId: `protection-close:${decisionId}`,
      clientOrderId,
      decisionId,
      symbol,
      type: 'market',
      side,
      qty,
      notionalUsd: qty * price,
      reduceOnly: true,
    })
    const applied = journal.applyOrderAck(ack, clock.now(), { reflectionHorizonMs: input.reflectionHorizonMs })
    const remainingPosition = (await broker.getPositions()).find((item) => item.symbol === symbol)
    if (remainingPosition !== undefined && remainingPosition.qty === 0) {
      try {
        await broker.cancelAll(symbol, { includeProtection: true })
      } catch (error) {
        input.freezeSymbol?.(symbol)
        journal.appendAudit({
          actor: 'system',
          kind: 'protection_cleanup_failed',
          payload: { decisionId, symbol, error: String(error) },
          ts: clock.now(),
        })
      }
      journal.appendAudit({
        actor: 'system',
        kind: 'protection_degrade_closed',
        payload: { decisionId, symbol, reason, qty, ackState: ack.state, fillKnown: !applied.unknown },
        ts: clock.now(),
      })
      return { protected: false, closed: true }
    }
    input.freezeSymbol?.(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_failed',
      payload: { decisionId, symbol, reason, qty, ackState: ack.state, fillKnown: !applied.unknown, remainingQty: remainingPosition?.qty ?? null },
      ts: clock.now(),
    })
    return { protected: false, closed: false }
  } catch (error) {
    input.freezeSymbol?.(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'protection_degrade_failed',
      payload: { decisionId, symbol, reason, qty, error: String(error) },
      ts: clock.now(),
    })
    return { protected: false, closed: false }
  }
}
