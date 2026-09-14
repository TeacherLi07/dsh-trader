/**
 * 启动/周期对账（plan §4.2、§8.2 五条之三）。
 *
 * **纯函数**：输入本地镜像与交易所真值，输出该做的动作。不读时钟、不写库、不下单 ——
 * 这样"对账逻辑"可以在没有网络的环境里被完整测试（本机交易所访问要经过代理）。
 *
 * 三条铁律：
 *   · 孤儿订单（本地有、交易所有）→ **撤销**；
 *   · 未知持仓（交易所有、本地无）→ **告警并冻结自动交易**，绝不"猜"；
 *   · 有持仓但无保护单 → **P0 不一致**（plan §6.3，HTX 不支持原子括号单带来的窗口）。
 */

export interface LocalOrderSnapshot {
  readonly clientOrderId: string
  readonly symbol: string
  readonly state: 'pending' | 'open' | 'filled' | 'canceled'
}

export interface RemoteOrderSnapshot {
  readonly clientOrderId: string
  readonly symbol: string
}

export interface LocalPositionSnapshot {
  readonly symbol: string
  readonly qty: number
  readonly protectedStopPrice?: number
}

export interface RemotePositionSnapshot {
  readonly symbol: string
  readonly qty: number
}

export interface ReconciliationInput {
  readonly localOrders: readonly LocalOrderSnapshot[]
  readonly remoteOrders: readonly RemoteOrderSnapshot[]
  readonly localPositions: readonly LocalPositionSnapshot[]
  readonly remotePositions: readonly RemotePositionSnapshot[]
}

export type ReconciliationAction =
  | { readonly kind: 'cancel_orphan'; readonly clientOrderId: string; readonly reason: string }
  | { readonly kind: 'alert_missing_order'; readonly clientOrderId: string; readonly reason: string }
  | { readonly kind: 'alert_unknown_position'; readonly symbol: string; readonly qty: number }
  | { readonly kind: 'alert_unprotected_position'; readonly symbol: string }
  | { readonly kind: 'alert_qty_mismatch'; readonly symbol: string; readonly local: number; readonly remote: number }

export type SeverityClass = 'P0' | 'P1'

export interface ReconciliationResult {
  readonly actions: readonly ReconciliationAction[]
  /** true = 无需人工介入；任何 action 都会让它是 false。 */
  readonly consistent: boolean
  /** 是否必须冻结自动交易（未知持仓 = 绝对不能继续）。 */
  readonly freezeTrading: boolean
}

function severityOf(action: ReconciliationAction): SeverityClass {
  switch (action.kind) {
    case 'alert_unknown_position':
    case 'alert_unprotected_position':
    case 'alert_qty_mismatch':
      return 'P0'
    case 'cancel_orphan':
    case 'alert_missing_order':
      return 'P1'
  }
}

export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const actions: ReconciliationAction[] = []

  const remoteByClientId = new Map(input.remoteOrders.map((order) => [order.clientOrderId, order]))
  const localByClientId = new Map(input.localOrders.map((order) => [order.clientOrderId, order]))

  // 本地认为还挂着的单，但交易所没有 → 可能已被成交/撤销，必须查证而不是假设
  for (const order of input.localOrders) {
    if (order.state !== 'pending' && order.state !== 'open') continue
    if (!remoteByClientId.has(order.clientOrderId)) {
      actions.push({
        kind: 'alert_missing_order',
        clientOrderId: order.clientOrderId,
        reason: '本地标记为未结，但交易所无此单',
      })
    }
  }

  // 交易所有、本地没有 → 孤儿单，撤销（绝不让不受本地状态约束的单继续挂着）
  for (const order of input.remoteOrders) {
    const local = localByClientId.get(order.clientOrderId)
    if (local === undefined || local.state === 'canceled' || local.state === 'filled') {
      actions.push({
        kind: 'cancel_orphan',
        clientOrderId: order.clientOrderId,
        reason: local === undefined ? '本地无记录' : `本地状态为 ${local.state}`,
      })
    }
  }

  const localPositions = new Map(input.localPositions.map((position) => [position.symbol, position]))

  for (const remote of input.remotePositions) {
    const local = localPositions.get(remote.symbol)
    if (local === undefined) {
      actions.push({ kind: 'alert_unknown_position', symbol: remote.symbol, qty: remote.qty })
      continue
    }
    if (Math.abs(local.qty - remote.qty) > 1e-12) {
      actions.push({
        kind: 'alert_qty_mismatch',
        symbol: remote.symbol,
        local: local.qty,
        remote: remote.qty,
      })
    }
    if (remote.qty !== 0 && local.protectedStopPrice === undefined) {
      actions.push({ kind: 'alert_unprotected_position', symbol: remote.symbol })
    }
  }

  // 本地有、交易所没有的持仓同样危险（本地幽灵仓）
  const remoteSymbols = new Set(input.remotePositions.map((position) => position.symbol))
  for (const local of input.localPositions) {
    if (local.qty === 0) continue
    if (!remoteSymbols.has(local.symbol)) {
      actions.push({
        kind: 'alert_qty_mismatch',
        symbol: local.symbol,
        local: local.qty,
        remote: 0,
      })
    }
  }

  const freezeTrading = actions.some((action) => action.kind === 'alert_unknown_position')

  return {
    actions,
    consistent: actions.length === 0,
    freezeTrading,
  }
}

export { severityOf }
