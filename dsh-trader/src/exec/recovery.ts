/**
 * 崩溃恢复（plan §4.2「启动对账」/ §10 P1 ⑤）。
 *
 * 崩溃留下的唯一可靠线索是 `order_intents` 里 `created` 且**没有 ack** 的记录：
 * 请求可能已经发出（甚至已成交），也可能根本没到交易所。**绝不猜** —— §4.2 写得很清楚：
 * "未知持仓告警并冻结自动交易"。
 *
 * 两种结局都要能收敛：
 *   · 能问出状态（broker 支持按 `client_order_id` 查询）⇒ 推进意图状态；
 *   · 问不出来 ⇒ 标 `unknown`、**冻结该标的**、并产出一条可操作的告警。
 *
 * 幂等是硬要求：恢复本身可能被打断再跑一次。恢复**只读交易所 + 更新意图状态**，
 * 绝不重新下单、绝不新增 decision —— 因此"无重复决策"是结构性的，不是靠小心。
 */

import type { Clock } from '../clock.js'
import type { Broker, OrderAck } from './broker.js'
import type { DecisionJournal, InFlightIntent } from './journal.js'

/** 可选的交易所查询能力；不实现就只能判定为"未知"。 */
export interface ClientOrderLookup {
  findOrderByClientOrderId?(clientOrderId: string): Promise<OrderAck | undefined>
}

export type RecoveryOutcome =
  | { readonly kind: 'resolved'; readonly state: OrderAck['state']; readonly exchangeOrderId?: string }
  | { readonly kind: 'unknown'; readonly reason: string }

export interface RecoveryAlert {
  readonly level: 'warning' | 'critical'
  readonly code: string
  readonly message: string
}

export interface RecoveryResult {
  readonly scanned: number
  readonly resolved: readonly { readonly clientOrderId: string; readonly outcome: RecoveryOutcome }[]
  /** 无法判定 ⇒ 调用方必须**冻结这些标的**的自动交易。 */
  readonly freezeSymbols: readonly string[]
  readonly alerts: readonly RecoveryAlert[]
  /** 交易所挂单里没有本地记录的（孤儿订单线索，P2 ① 的硬指标）。 */
  readonly orphanOpenOrders: readonly { readonly symbol: string; readonly exchangeOrderId: string }[]
}

export interface RecoveryDeps {
  readonly journal: DecisionJournal
  readonly broker: Broker & ClientOrderLookup
  readonly clock: Clock
  /** 启动时需要核对的标的；省略表示核对全部在途意图涉及的标的。 */
  readonly symbols?: readonly string[]
}

export class CrashRecovery {
  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * 跑一轮恢复。可重复调用：第二轮看到的意图状态已经推进，因此是 no-op。
   */
  async run(): Promise<RecoveryResult> {
    const { journal, broker } = this.deps
    const inFlight = journal.inFlightIntents()

    const resolved: { clientOrderId: string; outcome: RecoveryOutcome }[] = []
    const alerts: RecoveryAlert[] = []
    const freeze = new Set<string>()

    for (const intent of inFlight) {
      const outcome = await this.#classify(intent)
      resolved.push({ clientOrderId: intent.clientOrderId, outcome })

      if (outcome.kind === 'unknown') {
        // 标 unknown 是**幂等**的：再跑一次不会改变结论，也不会新增任何记录
        journal.markIntentUnknown(intent.clientOrderId, this.deps.clock.now())
        freeze.add(intent.symbol)
        alerts.push({
          level: 'critical',
          code: 'orphan_intent_unknown',
          message:
            `在途意图 ${intent.clientOrderId}（${intent.symbol}）状态未知：` +
            `交易所没有可查询的记录 ⇒ 冻结该标的的自动交易，需人工核对后再放开。原因：${outcome.reason}`,
        })
        continue
      }

      if (outcome.state === 'rejected' || outcome.state === 'canceled') {
        journal.markIntentAcked(intent.clientOrderId, outcome.state, outcome.exchangeOrderId, this.deps.clock.now())
        continue
      }
      journal.markIntentAcked(
        intent.clientOrderId,
        outcome.state === 'filled' ? 'filled' : 'acked',
        outcome.exchangeOrderId,
        this.deps.clock.now(),
      )
    }

    // 孤儿订单：交易所挂着、本地没有对应意图 —— 属于必须撤销的 P0 不一致
    const symbols = [...new Set(this.deps.symbols ?? [...freeze, ...inFlight.map((i) => i.symbol)])]
    const orphanOpenOrders: { symbol: string; exchangeOrderId: string }[] = []
    for (const symbol of symbols) {
      let open: readonly OrderAck[]
      try {
        open = await broker.getOpenOrders(symbol)
      } catch (error) {
        alerts.push({
          level: 'warning',
          code: 'open_orders_unavailable',
          message: `无法读取 ${symbol} 的挂单（恢复不完整，不视为"没有孤儿订单"）：${String(error)}`,
        })
        continue
      }
      for (const order of open) {
        if (order.exchangeOrderId !== undefined && !journal.hasClientOrderId(order.clientOrderId)) {
          orphanOpenOrders.push({ symbol, exchangeOrderId: order.exchangeOrderId })
        }
      }
    }
    for (const orphan of orphanOpenOrders) {
      alerts.push({
        level: 'critical',
        code: 'orphan_open_order',
        message: `交易所存在本地无记录的挂单 ${orphan.exchangeOrderId}（${orphan.symbol}）⇒ 必须撤销`,
      })
    }

    return {
      scanned: inFlight.length,
      resolved,
      freezeSymbols: [...freeze],
      alerts,
      orphanOpenOrders,
    }
  }

  async #classify(intent: InFlightIntent): Promise<RecoveryOutcome> {
    const lookup = this.deps.broker.findOrderByClientOrderId?.bind(this.deps.broker)
    if (lookup === undefined) {
      return {
        kind: 'unknown',
        reason: 'broker 不支持按 client_order_id 查询（无法区分"没发出去"与"已成交"）',
      }
    }
    try {
      const ack = await lookup(intent.clientOrderId)
      if (ack === undefined) {
        return { kind: 'unknown', reason: '交易所查不到该 client_order_id' }
      }
      return {
        kind: 'resolved',
        state: ack.state,
        ...(ack.exchangeOrderId === undefined ? {} : { exchangeOrderId: ack.exchangeOrderId }),
      }
    } catch (error) {
      return { kind: 'unknown', reason: `查询失败：${String(error)}` }
    }
  }
}

/**
 * 冻结判定：把恢复结果转成"哪些标的禁止自动交易"。
 * 上层（supervisor）拿到非空集合就必须拒绝这些标的新开仓。
 */
export function frozenSymbols(result: RecoveryResult): ReadonlySet<string> {
  return new Set(result.freezeSymbols)
}
