import type { OrderState } from './broker.js'

/** HTX 订单状态机；所有写入意图/订单的路径都必须服从这张表。 */
const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  created: ['created', 'acked', 'filled', 'rejected', 'canceled', 'unknown'],
  acked: ['acked', 'filled', 'rejected', 'canceled', 'unknown'],
  unknown: ['unknown', 'acked', 'filled', 'rejected', 'canceled'],
  filled: ['filled'],
  rejected: ['rejected'],
  canceled: ['canceled'],
}

export function canTransitionOrder(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from].includes(to)
}

export function terminalOrderState(state: OrderState): boolean {
  return state === 'filled' || state === 'rejected' || state === 'canceled'
}
