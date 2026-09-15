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

import type { Clock } from '../clock.js'
import type { OrderAck, PositionSnapshot } from './broker.js'

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

export type ReconciliationSnapshotProvider<T> = (() => T | Promise<T>) | T

export type ReconciliationEvent = ReconciliationAction & {
  /** 保留完整动作，调用方不必依赖动作联合的字段展开方式。 */
  readonly action: ReconciliationAction
  readonly at: number
  readonly level: SeverityClass
  readonly message: string
  readonly error?: string
}

export interface ReconcilerDeps {
  readonly broker: {
    readonly getOpenOrders: () =>
      | readonly (Pick<OrderAck, 'clientOrderId'> & { readonly symbol?: string })[]
      | Promise<readonly (Pick<OrderAck, 'clientOrderId'> & { readonly symbol?: string })[]>
    readonly getPositions: () =>
      | readonly Pick<PositionSnapshot, 'symbol' | 'qty'>[]
      | Promise<readonly Pick<PositionSnapshot, 'symbol' | 'qty'>[]>
    readonly cancelOrder: (exchangeOrderId: string) => Promise<unknown>
  }
  readonly clock: Clock
  readonly localOrders: ReconciliationSnapshotProvider<readonly LocalOrderSnapshot[]>
  readonly localPositions: ReconciliationSnapshotProvider<readonly LocalPositionSnapshot[]>
  /** 该回调也是审计端口：包括已执行的撤单与未执行成功的动作。 */
  readonly onAlert: (event: ReconciliationEvent) => void
  readonly audit?: (event: ReconciliationEvent) => void
}

export interface ReconcilerResult {
  readonly result: ReconciliationResult
  readonly applied: readonly ReconciliationAction[]
  readonly freezeTrading: boolean
}

async function readSnapshot<T>(provider: ReconciliationSnapshotProvider<T>): Promise<T> {
  if (typeof provider === 'function') return await (provider as () => T)()
  return provider
}

function eventFor(action: ReconciliationAction, at: number, error?: unknown): ReconciliationEvent {
  return {
    ...action,
    action,
    at,
    level: severityOf(action),
    message: actionMessage(action),
    ...(error === undefined ? {} : { error: String(error) }),
  } as ReconciliationEvent
}

function emitEvent(deps: ReconcilerDeps, event: ReconciliationEvent): void {
  deps.onAlert(event)
  deps.audit?.(event)
}

function actionMessage(action: ReconciliationAction): string {
  switch (action.kind) {
    case 'cancel_orphan':
      return '撤销孤儿订单 ' + action.clientOrderId + '：' + action.reason
    case 'alert_missing_order':
      return '本地订单 ' + action.clientOrderId + ' 在交易所不存在：' + action.reason
    case 'alert_unknown_position':
      return '发现未知持仓 ' + action.symbol + '，数量 ' + action.qty + '；冻结自动交易。'
    case 'alert_unprotected_position':
      return '持仓 ' + action.symbol + ' 没有保护单；冻结自动交易。'
    case 'alert_qty_mismatch':
      return (
        '持仓 ' +
        action.symbol +
        ' 数量不一致：本地 ' +
        action.local +
        '，交易所 ' +
        action.remote +
        '；冻结自动交易。'
      )
  }
}

function isFreezeAction(action: ReconciliationAction): boolean {
  return (
    action.kind === 'alert_unknown_position' ||
    action.kind === 'alert_unprotected_position' ||
    action.kind === 'alert_qty_mismatch'
  )
}

export class Reconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  async runOnce(): Promise<ReconcilerResult> {
    const [remoteOrders, remotePositions, localOrders, localPositions] = await Promise.all([
      this.deps.broker.getOpenOrders(),
      this.deps.broker.getPositions(),
      readSnapshot(this.deps.localOrders),
      readSnapshot(this.deps.localPositions),
    ])
    const result = reconcile({
      localOrders,
      remoteOrders: remoteOrders.map(toRemoteOrder),
      localPositions,
      remotePositions: remotePositions.map(toRemotePosition),
    })
    const applied: ReconciliationAction[] = []
    let freezeTrading = result.freezeTrading

    for (const action of result.actions) {
      const at = this.deps.clock.now()
      if (action.kind === 'cancel_orphan') {
        try {
          // 当前快照没有单独的 exchangeOrderId 字段，只能沿用其稳定 clientOrderId。
          await this.deps.broker.cancelOrder(action.clientOrderId)
          applied.push(action)
          emitEvent(this.deps, eventFor(action, at))
        } catch (error) {
          freezeTrading = true
          emitEvent(this.deps, {
            ...eventFor(action, at, error),
            level: 'P0',
            message: '撤销孤儿订单失败，冻结自动交易：' + action.clientOrderId,
          } as ReconciliationEvent)
        }
        continue
      }

      if (isFreezeAction(action)) freezeTrading = true
      applied.push(action)
      emitEvent(this.deps, eventFor(action, at))
    }

    return { result, applied, freezeTrading }
  }
}

type BrokerOpenOrder = Pick<OrderAck, 'clientOrderId'> & { readonly symbol?: string }
type BrokerPosition = Pick<PositionSnapshot, 'symbol' | 'qty'>

function toRemoteOrder(order: BrokerOpenOrder): RemoteOrderSnapshot {
  return {
    clientOrderId: order.clientOrderId,
    symbol: order.symbol ?? '',
  }
}

function toRemotePosition(position: BrokerPosition): RemotePositionSnapshot {
  return { symbol: position.symbol, qty: position.qty }
}
