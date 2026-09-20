/**
 * 只读预检（plan §12.2 A 第①步：HTX 只读对账）。
 *
 * 目的：在**不下任何单**的前提下，用真实交易所账户回答三个问题：
 *   1. key 能不能认证、端点通不通（`fetchPositions`/`fetchOpenOrders`/`fetchBalance`）；
 *   2. 交易所真实持仓/挂单与本地库是否一致；
 *   3. 有哪些必须人工处理的不一致（未知持仓 = P0，plan §4.2）。
 *
 * 四条硬性质：
 *   · **只读**：本模块**不调用** `placeOrder`/`placeProtective`/`cancelOrder`/`cancelAll`；
 *     它只跑纯函数 `reconcile()` 并**报告**动作，不执行 —— 第①步的执行与否由人决定；
 *   · **不猜**：交易所查不到/字段缺失一律按未知处理（`reconcile` 会冻结标的）；
 *   · **不编**：拿不到权益就写 `null`，绝不用 0 冒充；
 *   · **可复现**：时间从注入的 `Clock` 取，报告是纯数据结构，可落盘对拍。
 *
 * 为什么第①步天然安全：mode 保持 `paper`，而 `gate.ts` 对 `mode==='paper' && venue!=='paper'`
 * 一律 deny。也就是说，即使组合根把真实 broker 接进来，硬闸也会结构性拒绝一切下单。
 */

import type Database from 'better-sqlite3'
import type { Clock } from '../clock.js'
import { Statements } from '../db/statements.js'
import type { Broker, OrderAck, PositionSnapshot, Venue } from './broker.js'
import {
  reconcile,
  type LocalOrderSnapshot,
  type LocalPositionSnapshot,
  type ReconciliationAction,
  type ReconciliationResult,
} from './reconcile.js'
import { reconstructPosition } from '../memory/settle.js'

/** 只读余额能力：由 `CcxtBroker.readOnlyBalance()` 提供；不实现就不报告权益（而不是写 0）。 */
export interface ReadOnlyBalanceSource {
  readOnlyBalance(): Promise<number>
}

export function hasReadOnlyBalance(broker: Broker): broker is Broker & ReadOnlyBalanceSource {
  return typeof (broker as Partial<ReadOnlyBalanceSource>).readOnlyBalance === 'function'
}

export interface ReadOnlyPreflightDeps {
  readonly broker: Broker
  readonly clock: Clock
  readonly localOrders: readonly LocalOrderSnapshot[]
  readonly localPositions: readonly LocalPositionSnapshot[]
}

export interface ReadOnlyPreflightReport {
  readonly ranAt: number
  readonly venue: Venue
  /** 恒定 true —— 与 `executedActions` 一起构成"只读"的结构性证据。 */
  readonly readOnly: true
  /** 恒为空数组：预检**不执行**任何动作（撤单/下单）。测试对此有断言。 */
  readonly executedActions: readonly string[]
  /** 读不到就是 null；绝不用 0 冒充。 */
  readonly equityQuote: number | null
  readonly remote: {
    readonly positions: number
    readonly openOrders: number
    readonly openOrderClientIds: readonly string[]
  }
  readonly local: {
    readonly orders: number
    readonly positions: number
  }
  readonly consistent: boolean
  readonly freezeTrading: boolean
  readonly actions: readonly ReconciliationAction[]
  /** 动作按 kind 计数，便于一眼看到"有几条孤儿/未知持仓"。 */
  readonly actionKinds: Readonly<Record<string, number>>
  readonly notes: readonly string[]
}

/**
 * 跑一次只读预检。**幂等、无副作用**：可以反复运行，结果只取决于市场与本地库的当时状态。
 */
export async function runReadOnlyPreflight(
  deps: ReadOnlyPreflightDeps,
): Promise<ReadOnlyPreflightReport> {
  const { broker } = deps

  // 注意：这里刻意**不调用** `broker.getAccount()` —— 它需要 RiskStateProvider，而只读阶段
  // 本来就没有可靠的 dailyLoss/drawdown 来源。为只读报告编一个 RiskState 是禁止的。
  const positions: readonly PositionSnapshot[] = await broker.getPositions()
  const openOrders: readonly OrderAck[] = await broker.getOpenOrders()
  const equityQuote = hasReadOnlyBalance(broker) ? await broker.readOnlyBalance() : null

  const result: ReconciliationResult = reconcile({
    localOrders: deps.localOrders,
    // HTX 不保证 client id 回显；exchangeOrderId 是主匹配键。
    remoteOrders: openOrders.map((order) => ({
      ...(order.clientOrderId === undefined ? {} : { clientOrderId: order.clientOrderId }),
      ...(order.exchangeOrderId === undefined ? {} : { exchangeOrderId: order.exchangeOrderId }),
    })),
    localPositions: deps.localPositions,
    remotePositions: positions.map((position) => ({
      symbol: position.symbol,
      qty: position.qty,
      ...(position.protectedStopPrice === undefined ? {} : { protectedStopPrice: position.protectedStopPrice }),
    })),
  })

  const actionKinds: Record<string, number> = {}
  for (const action of result.actions) {
    actionKinds[action.kind] = (actionKinds[action.kind] ?? 0) + 1
  }

  const notes: string[] = [
    '只读预检：executedActions 恒为空，不自动撤单、不下单（plan §12.2 A 第①步）。',
    'mode 保持 paper：gate.ts 对 paper 模式下投往真实 venue 的意图一律 deny，结构性禁止下单。',
  ]
  if (equityQuote === null) {
    notes.push('broker 未提供 readOnlyBalance ⇒ 报告不含权益（不编造 0）。')
  }
  if (deps.localPositions.length === 0 && positions.length > 0) {
    notes.push(
      `本地库没有持仓、交易所却有 ${positions.length} 个 ⇒ 首次接真实账户的预期结果，` +
        '必须人工核对后再决定下一步（未知持仓绝不自动处理）。',
    )
  }
  if (openOrders.length > 0 && result.actions.some((action) => action.kind === 'cancel_orphan')) {
    notes.push('存在孤儿挂单：第①步**只报告不撤销**，撤销动作留给人工确认后的对账流程。')
  }

  return {
    ranAt: deps.clock.now(),
    venue: broker.venue,
    readOnly: true,
    executedActions: [],
    equityQuote,
    remote: {
      positions: positions.length,
      openOrders: openOrders.length,
      openOrderClientIds: openOrders.map((order) => order.clientOrderId),
    },
    local: {
      orders: deps.localOrders.length,
      positions: deps.localPositions.length,
    },
    consistent: result.consistent,
    freezeTrading: result.freezeTrading,
    actions: result.actions,
    actionKinds,
    notes,
  }
}

/**
 * 本地状态读取器（只读）：把 `order_intents` / `fills` 折算成 `reconcile()` 需要的形状。
 *
 * 两条口径：
 *   · `created` → `pending`、`acked` → `open`；其余状态（filled/canceled/rejected）不参与对账；
 *   · 本地持仓由**全部成交**按与 `PaperBroker` 相同的均价规则重建；本地 stop intent 只证明
 *     我们曾经请求过挂单，不能证明交易所现在仍有算法保护，所以这里永远不填 protectedStopPrice。
 */
export class LocalStateReader {
  readonly #statements: Statements

  constructor(db: Database.Database) {
    this.#statements = new Statements(db)
  }

  orders(): readonly LocalOrderSnapshot[] {
    const rows = this.#statements
      .get(
         `SELECT client_order_id, symbol, state, exchange_order_id FROM order_intents
         WHERE state IN ('created', 'acked')
         ORDER BY created_at ASC, client_order_id ASC`,
      )
      .all() as { client_order_id: string; symbol: string; state: string; exchange_order_id: string | null }[]
    return rows.map((row) => ({
      clientOrderId: row.client_order_id,
      ...(row.exchange_order_id === null ? {} : { exchangeOrderId: row.exchange_order_id }),
      symbol: row.symbol,
      state: row.state === 'created' ? 'pending' : 'open',
    }))
  }

  positions(): readonly LocalPositionSnapshot[] {
    const rows = this.#statements
      .get(
        `SELECT symbol, qty, price, side FROM (
           SELECT oi.symbol AS symbol, f.qty AS qty, f.price AS price,
                  COALESCE(oi.side, 'buy') AS side, f.ts AS fill_ts, f.fill_id AS fill_id
           FROM fills f
           JOIN orders o ON o.order_id = f.order_id
           JOIN order_intents oi ON oi.client_order_id = o.client_order_id
           UNION ALL
           -- 非终态累计成交尚未进入 fills；在本地仓位镜像中只取该订单最新累计量。
           SELECT oi.symbol AS symbol, o.filled_qty AS qty, o.avg_price AS price,
                  COALESCE(oi.side, 'buy') AS side, o.updated_at AS fill_ts, o.order_id AS fill_id
           FROM orders o
           JOIN order_intents oi ON oi.client_order_id = o.client_order_id
           WHERE o.filled_qty > 0 AND o.avg_price IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM fills f WHERE f.order_id = o.order_id)
         ) ORDER BY fill_ts ASC, fill_id ASC`,
      )
      .all() as { symbol: string; qty: number; price: number; side: string }[]

    const bySymbol = new Map<string, { qty: number; price: number; side: string }[]>()
    for (const row of rows) {
      const list = bySymbol.get(row.symbol) ?? []
      list.push({ qty: row.qty, price: row.price, side: row.side })
      bySymbol.set(row.symbol, list)
    }

    const out: LocalPositionSnapshot[] = []
    for (const [symbol, fills] of bySymbol) {
      const position = reconstructPosition(fills)
      if (position.qty === 0) continue
      out.push({ symbol, qty: position.qty })
    }
    return out.sort((a, b) => a.symbol.localeCompare(b.symbol))
  }
}
