/**
 * 跨进程持久的确定性模拟交易所（P2 故障注入用）。
 *
 * 这里不复用主库的表：故障注入必须能把交易所状态和本地审计状态分别重开，
 * 否则同一个 SQLite 事务会把“交易所已经成交但 ack 尚未返回”的窗口抹掉。
 * 所有状态都由调用序号驱动，不读取墙钟，因此重开后查询结果仍然稳定。
 */

import Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import type {
  AccountSnapshot,
  Broker,
  OrderAck,
  OrderRequest,
  OrderSide,
  OrderState,
  PositionSnapshot,
  ProtectiveRequest,
  UserDataEvent,
  Venue,
} from './broker.js'
import type { ClientOrderLookup } from './recovery.js'

export interface SimExchangeOptions {
  readonly initialEquityQuote?: number
  readonly feeBps?: number
  readonly slippageBps?: number
  readonly venue?: Venue
  /** 只报告步骤；是否 kill 进程由脚本决定，避免交易所类携带破坏性动作。 */
  readonly onStep?: (step: string) => void
}

export interface SimFill {
  readonly fillId: string
  readonly exchangeOrderId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: OrderSide
  readonly qty: number
  readonly price: number
  readonly fee: number
  readonly ts: number
}

export interface SimOpenOrder {
  readonly exchangeOrderId: string
  readonly clientOrderId: string
  readonly intentId: string
  readonly decisionId: string
  readonly symbol: string
  readonly type: 'market' | 'limit' | 'protective'
  readonly side: OrderSide
  readonly qty: number
  readonly price?: number
  readonly stopLossPrice?: number
  readonly takeProfitPrice?: number
  readonly trailingPercent?: number
  readonly reduceOnly: boolean
  readonly state: OrderState
}

interface SimOrderRow {
  exchange_order_id: string
  client_order_id: string
  intent_id: string
  decision_id: string
  symbol: string
  type: 'market' | 'limit' | 'protective'
  side: OrderSide
  qty: number
  limit_price: number | null
  stop_loss_price: number | null
  take_profit_price: number | null
  trailing_percent: number | null
  trailing_trigger_price: number | null
  reduce_only: number
  is_protective: number
  status: OrderState
  filled_qty: number
  avg_price: number | null
  fee: number
  created_seq: number
  updated_seq: number
  high_water: number | null
}

interface SimPositionRow {
  symbol: string
  qty: number
  avg_price: number
}

interface SimAccountRow {
  id: number
  initial_equity: number
  cash: number
  realized_pnl: number
  peak_equity: number
  consecutive_losses: number
}

interface SimMetaRow {
  next_value: number
}

interface SimPriceRow {
  price: number
}

interface SimFillRow {
  fill_id: string
  exchange_order_id: string
  client_order_id: string
  symbol: string
  side: OrderSide
  qty: number
  price: number
  fee: number
  ts: number
}

const DEFAULT_EQUITY = 10_000

export class SimExchange implements Broker, ClientOrderLookup {
  readonly venue: Venue
  readonly #db: Database.Database
  readonly #statements: Statements
  readonly #ownsDatabase: boolean
  readonly #feeBps: number
  readonly #slippageBps: number
  readonly #onStep: ((step: string) => void) | undefined

  constructor(database: string | Database.Database, options: SimExchangeOptions = {}) {
    this.#ownsDatabase = typeof database === 'string'
    this.#db = typeof database === 'string' ? new Database(database) : database
    this.#statements = new Statements(this.#db)
    this.venue = options.venue ?? 'paper'
    this.#feeBps = options.feeBps ?? 0
    this.#slippageBps = options.slippageBps ?? 0
    this.#onStep = options.onStep

    this.#db.pragma('foreign_keys = ON')
    this.#db.pragma('journal_mode = WAL')
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sim_meta (
        key TEXT PRIMARY KEY,
        next_value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sim_account (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        initial_equity REAL NOT NULL,
        cash REAL NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        peak_equity REAL NOT NULL,
        consecutive_losses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sim_prices (
        symbol TEXT PRIMARY KEY,
        price REAL NOT NULL CHECK (price > 0)
      );
      CREATE TABLE IF NOT EXISTS sim_positions (
        symbol TEXT PRIMARY KEY,
        qty REAL NOT NULL,
        avg_price REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sim_orders (
        exchange_order_id TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL UNIQUE,
        intent_id TEXT NOT NULL,
        decision_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('market', 'limit', 'protective')),
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        qty REAL NOT NULL CHECK (qty > 0),
        limit_price REAL,
        stop_loss_price REAL,
        take_profit_price REAL,
        trailing_percent REAL,
        trailing_trigger_price REAL,
        reduce_only INTEGER NOT NULL CHECK (reduce_only IN (0, 1)),
        is_protective INTEGER NOT NULL CHECK (is_protective IN (0, 1)),
        status TEXT NOT NULL CHECK (status IN ('created', 'acked', 'rejected', 'unknown', 'canceled', 'filled')),
        filled_qty REAL NOT NULL DEFAULT 0,
        avg_price REAL,
        fee REAL NOT NULL DEFAULT 0,
        created_seq INTEGER NOT NULL,
        updated_seq INTEGER NOT NULL,
        high_water REAL
      );
      CREATE INDEX IF NOT EXISTS sim_orders_open_by_symbol
        ON sim_orders (symbol, status, is_protective);
      CREATE TABLE IF NOT EXISTS sim_fills (
        fill_id TEXT PRIMARY KEY,
        exchange_order_id TEXT NOT NULL,
        client_order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        qty REAL NOT NULL CHECK (qty > 0),
        price REAL NOT NULL CHECK (price > 0),
        fee REAL NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        UNIQUE (exchange_order_id, ts, qty)
      );
    `)
    this.#statements
      .get('INSERT INTO sim_meta (key, next_value) VALUES (\'sequence\', 1) ON CONFLICT (key) DO NOTHING')
      .run()
    const initialEquity = options.initialEquityQuote ?? DEFAULT_EQUITY
    this.#statements
      .get(
        `INSERT INTO sim_account (id, initial_equity, cash, realized_pnl, peak_equity, consecutive_losses)
         VALUES (1, ?, ?, 0, ?, 0)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(initialEquity, initialEquity, initialEquity)
  }

  close(): void {
    if (this.#ownsDatabase) this.#db.close()
  }

  /** 推进行情并触发已持久化的止损/止盈单；价格本身也落盘供重开后的账户查询使用。 */
  onPrice(symbol: string, price: number): readonly OrderAck[] {
    if (!Number.isFinite(price) || price <= 0) throw new Error(`onPrice：价格必须为正数，收到 ${price}`)

    return this.#db.transaction(() => {
      this.#statements
        .get(
          `INSERT INTO sim_prices (symbol, price) VALUES (?, ?)
           ON CONFLICT (symbol) DO UPDATE SET price = excluded.price`,
        )
        .run(symbol, price)

      const candidates = this.#openOrderRows(symbol)
      const acks: OrderAck[] = []
      for (const order of candidates) {
        const trigger = order.is_protective === 1 ? this.#triggerPrice(order, price) : this.#limitPrice(order, price)
        if (trigger === undefined) continue
        acks.push(this.#fill(order, trigger))
      }
      return acks
    })()
  }

  async getAccount(): Promise<AccountSnapshot> {
    const account = this.#account()
    const equity = this.#equity(account.cash)
    if (equity > account.peak_equity) {
      this.#statements.get('UPDATE sim_account SET peak_equity = ? WHERE id = 1').run(equity)
    }
    const observedAt = this.#lastSequence()
    const realizedLoss = Math.max(0, -account.realized_pnl)
    return {
      venue: this.venue,
      equityQuote: equity,
      totalExposureUsd: this.#exposure(),
      pendingExposureUsd: this.#pendingExposure(),
      openOrders: this.openOrderCount(),
      leverage: equity > 0 ? this.#exposure() / equity : Number.POSITIVE_INFINITY,
      dailyLossUsd: realizedLoss,
      drawdownUsd: Math.max(0, account.peak_equity - equity),
      consecutiveLosses: account.consecutive_losses,
      spreadBps: 0,
      observedAt,
    }
  }

  async getPositions(): Promise<readonly PositionSnapshot[]> {
    const rows = this.#statements
      .get('SELECT symbol, qty, avg_price FROM sim_positions WHERE qty != 0 ORDER BY symbol')
      .all() as SimPositionRow[]
    return rows.map((row) => {
      const price = this.#price(row.symbol)
      const stop = this.#protectiveStopFor(row.symbol)
      return {
        symbol: row.symbol,
        qty: row.qty,
        avgPrice: row.avg_price,
        unrealizedPnlUsd: price === undefined ? 0 : (price - row.avg_price) * row.qty,
        ...(stop === undefined ? {} : { protectedStopPrice: stop }),
      }
    })
  }

  async getOpenOrders(symbol?: string): Promise<readonly OrderAck[]> {
    return this.#openOrderRows(symbol).map((order) => this.#ack(order))
  }

  async placeOrder(request: OrderRequest): Promise<OrderAck> {
    const known = this.#orderByClientId(request.clientOrderId)
    if (known !== undefined) return this.#ack(known)
    this.#onStep?.('before_persist')

    const inserted = this.#db.transaction(() => {
      const existing = this.#orderByClientId(request.clientOrderId)
      if (existing !== undefined) return false
      const sequence = this.#nextSequence()
      this.#statements
        .get(
          `INSERT INTO sim_orders
             (exchange_order_id, client_order_id, intent_id, decision_id, symbol, type, side, qty,
              limit_price, stop_loss_price, take_profit_price, trailing_percent, trailing_trigger_price,
              reduce_only, is_protective, status, filled_qty, fee, created_seq, updated_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'created', 0, 0, ?, ?)`,
        )
        .run(
          `sim-order-${sequence}`,
          request.clientOrderId,
          request.intentId,
          request.decisionId,
          request.symbol,
          request.type,
          request.side,
          request.qty,
          request.price ?? null,
          request.stopLossPrice ?? null,
          request.takeProfitPrice ?? null,
          request.trailingPercent ?? null,
          null,
          request.reduceOnly === true ? 1 : 0,
          sequence,
          sequence,
        )
      return true
    })()

    if (!inserted) {
      // 唯一键是幂等根；即使另一个进程刚完成撮合，也只返回数据库里的原单。
      const existing = this.#orderByClientId(request.clientOrderId)
      if (existing === undefined) throw new Error(`模拟交易所：幂等订单 ${request.clientOrderId} 消失`)
      return this.#ack(existing)
    }

    this.#onStep?.('after_persist_before_match')
    this.#db.transaction(() => {
      const order = this.#orderByClientId(request.clientOrderId)
      if (order === undefined) throw new Error(`模拟交易所：订单 ${request.clientOrderId} 不存在`)
      const reference = this.#price(order.symbol)
      if (reference === undefined) {
        this.#setOrderState(order, 'rejected', order.updated_seq)
        return
      }

      if (order.type === 'market') {
        this.#fill(order, this.#withSlippage(reference, order.side))
        return
      }

      const limit = order.limit_price
      if (limit === null) {
        this.#setOrderState(order, 'rejected', order.updated_seq)
        return
      }
      const crossed = order.side === 'buy' ? limit >= reference : limit <= reference
      if (crossed) this.#fill(order, limit)
      else this.#setOrderState(order, 'acked', order.updated_seq)
    })()

    // 该回调位于 SQLite 提交之后、调用方收到 ack 之前，故 SIGKILL 会保留交易所状态。
    this.#onStep?.('after_persist_before_ack')
    const order = this.#orderByClientId(request.clientOrderId)
    if (order === undefined) throw new Error(`模拟交易所：订单 ${request.clientOrderId} 不存在`)
    return this.#ack(order)
  }

  async placeProtective(request: ProtectiveRequest): Promise<OrderAck> {
    if (request.clientOrderId !== undefined) {
      const known = this.#orderByClientId(request.clientOrderId)
      if (known !== undefined) return this.#ack(known)
    }
    const position = this.#position(request.symbol)
    if (position === undefined || position.qty === 0) {
      throw new Error(`placeProtective：${request.symbol} 没有持仓`)
    }
    if (request.expectedPositionQty !== undefined &&
        (!Number.isFinite(request.expectedPositionQty) || request.expectedPositionQty === 0 ||
         Math.sign(position.qty) !== Math.sign(request.expectedPositionQty) ||
         Math.abs(position.qty) + 1e-12 < Math.abs(request.expectedPositionQty))) {
      throw new Error(`placeProtective：${request.symbol} 实际持仓小于已确认成交暴露`)
    }
    const sequence = this.#lastSequence() + 1
    const clientOrderId = request.clientOrderId ?? `sim-protect-${request.symbol}-${sequence}`
    this.#onStep?.('before_persist')

    const inserted = this.#db.transaction(() => {
      const existing = this.#orderByClientId(clientOrderId)
      if (existing !== undefined) return false
      const orderSequence = this.#nextSequence()
      const side: OrderSide = position.qty > 0 ? 'sell' : 'buy'
      this.#statements
        .get(
          `INSERT INTO sim_orders
             (exchange_order_id, client_order_id, intent_id, decision_id, symbol, type, side, qty,
              limit_price, stop_loss_price, take_profit_price, trailing_percent, trailing_trigger_price,
              reduce_only, is_protective, status, filled_qty, fee, created_seq, updated_seq, high_water)
           VALUES (?, ?, ?, ?, ?, 'protective', ?, ?, NULL, ?, ?, ?, ?, 1, 1, 'acked', 0, 0, ?, ?, ?)`,
        )
        .run(
          `sim-order-${orderSequence}`,
          clientOrderId,
          `sim-intent-${clientOrderId}`,
          `sim-decision-${clientOrderId}`,
          request.symbol,
          side,
          Math.abs(position.qty),
          request.stopLossPrice ?? null,
          request.takeProfitPrice ?? null,
          request.trailingPercent ?? null,
          request.trailingTriggerPrice ?? null,
          orderSequence,
          orderSequence,
          this.#price(request.symbol) ?? null,
        )
      return true
    })()

    if (!inserted) {
      const existing = this.#orderByClientId(clientOrderId)
      if (existing === undefined) throw new Error(`模拟交易所：保护单 ${clientOrderId} 消失`)
      return this.#ack(existing)
    }

    this.#onStep?.('after_persist_before_ack')
    const order = this.#orderByClientId(clientOrderId)
    if (order === undefined) throw new Error(`模拟交易所：保护单 ${clientOrderId} 不存在`)
    return this.#ack(order)
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    this.#db.transaction(() => {
      const order = this.#orderByExchangeId(exchangeOrderId)
      if (order?.status === 'acked') this.#setOrderState(order, 'canceled', this.#nextSequence())
    })()
  }

  async cancelAll(symbol?: string, options: { readonly includeProtection?: boolean } = {}): Promise<void> {
    if (options.includeProtection === true) {
      const activePosition = this.#statements.get(`SELECT 1 FROM sim_positions
        WHERE qty != 0 AND (? IS NULL OR symbol = ?) LIMIT 1`).get(symbol ?? null, symbol ?? null)
      if (activePosition !== undefined) throw new Error('拒绝在仍有持仓时撤销保护单')
    }
    this.#db.transaction(() => {
      const orders = this.#openOrderRows(symbol)
      for (const order of orders) {
        if (options.includeProtection !== true && order.reduce_only === 1) continue
        this.#setOrderState(order, 'canceled', this.#nextSequence())
      }
    })()
  }

  subscribeUserData(_onEvent: (event: UserDataEvent) => void): () => void {
    return () => {
      /* 模拟器通过 onPrice 返回撮合结果；不伪造一个需要关闭的网络流。 */
    }
  }

  async findOrderByClientOrderId(clientOrderId: string): Promise<OrderAck | undefined> {
    const order = this.#orderByClientId(clientOrderId)
    return order === undefined ? undefined : this.#ack(order)
  }

  async findOrderByExchangeOrderId(exchangeOrderId: string): Promise<OrderAck | undefined> {
    const order = this.#orderByExchangeId(exchangeOrderId)
    return order === undefined ? undefined : this.#ack(order)
  }

  /** 供故障注入报告使用的非异步挂单快照。 */
  openOrders(symbol?: string): readonly SimOpenOrder[] {
    return this.#openOrderRows(symbol).map((order) => ({
      exchangeOrderId: order.exchange_order_id,
      clientOrderId: order.client_order_id,
      intentId: order.intent_id,
      decisionId: order.decision_id,
      symbol: order.symbol,
      type: order.type,
      side: order.side,
      qty: order.qty,
      ...(order.limit_price === null ? {} : { price: order.limit_price }),
      ...(order.stop_loss_price === null ? {} : { stopLossPrice: order.stop_loss_price }),
      ...(order.take_profit_price === null ? {} : { takeProfitPrice: order.take_profit_price }),
      ...(order.trailing_percent === null ? {} : { trailingPercent: order.trailing_percent }),
      reduceOnly: order.reduce_only === 1,
      state: order.status,
    }))
  }

  openOrderCount(): number {
    const row = this.#statements.get("SELECT COUNT(*) AS n FROM sim_orders WHERE status = 'acked'").get() as {
      n: number
    }
    return row.n
  }

  fillCount(): number {
    const row = this.#statements.get('SELECT COUNT(*) AS n FROM sim_fills').get() as { n: number }
    return row.n
  }

  allFills(): readonly SimFill[] {
    const rows = this.#statements
      .get(
        `SELECT fill_id, exchange_order_id, client_order_id, symbol, side, qty, price, fee, ts
         FROM sim_fills ORDER BY ts ASC, fill_id ASC`,
      )
      .all() as SimFillRow[]
    return rows.map((row) => ({
      fillId: row.fill_id,
      exchangeOrderId: row.exchange_order_id,
      clientOrderId: row.client_order_id,
      symbol: row.symbol,
      side: row.side,
      qty: row.qty,
      price: row.price,
      fee: row.fee,
      ts: row.ts,
    }))
  }

  #orderByClientId(clientOrderId: string): SimOrderRow | undefined {
    return this.#statements
      .get('SELECT * FROM sim_orders WHERE client_order_id = ?')
      .get(clientOrderId) as SimOrderRow | undefined
  }

  #orderByExchangeId(exchangeOrderId: string): SimOrderRow | undefined {
    return this.#statements
      .get('SELECT * FROM sim_orders WHERE exchange_order_id = ?')
      .get(exchangeOrderId) as SimOrderRow | undefined
  }

  #openOrderRows(symbol?: string): SimOrderRow[] {
    return (
      symbol === undefined
        ? this.#statements
            .get("SELECT * FROM sim_orders WHERE status = 'acked' ORDER BY created_seq ASC, exchange_order_id ASC")
            .all()
        : this.#statements
            .get(
              "SELECT * FROM sim_orders WHERE status = 'acked' AND symbol = ? ORDER BY created_seq ASC, exchange_order_id ASC",
            )
            .all(symbol)
    ) as SimOrderRow[]
  }

  #nextSequence(): number {
    const row = this.#statements.get("SELECT next_value FROM sim_meta WHERE key = 'sequence'").get() as SimMetaRow
    this.#statements.get("UPDATE sim_meta SET next_value = next_value + 1 WHERE key = 'sequence'").run()
    return row.next_value
  }

  #lastSequence(): number {
    const row = this.#statements.get("SELECT next_value FROM sim_meta WHERE key = 'sequence'").get() as SimMetaRow
    return Math.max(0, row.next_value - 1)
  }

  #account(): SimAccountRow {
    const row = this.#statements.get('SELECT * FROM sim_account WHERE id = 1').get() as SimAccountRow | undefined
    if (row === undefined) throw new Error('模拟交易所：账户未初始化')
    return row
  }

  #position(symbol: string): SimPositionRow | undefined {
    return this.#statements.get('SELECT symbol, qty, avg_price FROM sim_positions WHERE symbol = ?').get(symbol) as
      | SimPositionRow
      | undefined
  }

  #price(symbol: string): number | undefined {
    const row = this.#statements.get('SELECT price FROM sim_prices WHERE symbol = ?').get(symbol) as
      | SimPriceRow
      | undefined
    return row?.price
  }

  #setOrderState(order: SimOrderRow, status: OrderState, updatedSeq: number): void {
    this.#statements
      .get('UPDATE sim_orders SET status = ?, updated_seq = ? WHERE exchange_order_id = ?')
      .run(status, updatedSeq, order.exchange_order_id)
    order.status = status
    order.updated_seq = updatedSeq
  }

  #triggerPrice(order: SimOrderRow, price: number): number | undefined {
    const isLong = order.side === 'sell'
    if (order.trailing_percent !== null) {
      const highWater = isLong
        ? Math.max(order.high_water ?? price, price)
        : Math.min(order.high_water ?? price, price)
      this.#statements
        .get('UPDATE sim_orders SET high_water = ? WHERE exchange_order_id = ?')
        .run(highWater, order.exchange_order_id)
      order.high_water = highWater
    }
    if (order.stop_loss_price !== null) {
      if (isLong && price <= order.stop_loss_price) return order.stop_loss_price
      if (!isLong && price >= order.stop_loss_price) return order.stop_loss_price
    }
    if (order.take_profit_price !== null) {
      if (isLong && price >= order.take_profit_price) return order.take_profit_price
      if (!isLong && price <= order.take_profit_price) return order.take_profit_price
    }
    if (order.trailing_percent !== null && order.high_water !== null) {
      const trail = isLong
        ? order.high_water * (1 - order.trailing_percent / 100)
        : order.high_water * (1 + order.trailing_percent / 100)
      if (isLong && price <= trail) return trail
      if (!isLong && price >= trail) return trail
    }
    return undefined
  }

  #limitPrice(order: SimOrderRow, price: number): number | undefined {
    if (order.type !== 'limit' || order.limit_price === null) return undefined
    const crossed = order.side === 'buy' ? price <= order.limit_price : price >= order.limit_price
    return crossed ? order.limit_price : undefined
  }

  #fill(order: SimOrderRow, price: number): OrderAck {
    if (order.status !== 'created' && order.status !== 'acked') return this.#ack(order)
    const signedOrderQty = order.side === 'buy' ? order.qty : -order.qty
    const current = this.#position(order.symbol)
    const currentQty = current?.qty ?? 0
    let signedQty = signedOrderQty

    // reduceOnly 单只能缩小现有敞口；持仓消失后，保护单必须变成 rejected 而不能反手开仓。
    if (order.reduce_only === 1) {
      if (currentQty === 0 || Math.sign(currentQty) === Math.sign(signedQty)) {
        this.#setOrderState(order, 'rejected', this.#nextSequence())
        return this.#ack(order)
      }
      signedQty = Math.sign(signedQty) * Math.min(Math.abs(signedQty), Math.abs(currentQty))
    }

    const fillSequence = this.#nextSequence()
    const notional = Math.abs(signedQty) * price
    const fee = (notional * this.#feeBps) / 10_000
    const account = this.#account()
    let realizedDelta = -fee

    if (currentQty === 0 || Math.sign(currentQty) === Math.sign(signedQty)) {
      const newQty = currentQty + signedQty
      const avgPrice =
        newQty === 0
          ? 0
          : ((current?.avg_price ?? 0) * Math.abs(currentQty) + price * Math.abs(signedQty)) / Math.abs(newQty)
      this.#upsertPosition(order.symbol, newQty, avgPrice)
    } else {
      const closing = Math.min(Math.abs(signedQty), Math.abs(currentQty))
      const direction = Math.sign(currentQty)
      const gross = (price - (current?.avg_price ?? price)) * closing * direction
      realizedDelta += gross
      const remaining = currentQty + signedQty
      const remainingAvg = remaining === 0 || Math.sign(remaining) !== Math.sign(currentQty) ? price : current?.avg_price ?? price
      this.#upsertPosition(order.symbol, remaining, remaining === 0 ? 0 : remainingAvg)
    }

    this.#statements
      .get('UPDATE sim_account SET cash = cash - ?, realized_pnl = realized_pnl + ?, consecutive_losses = ? WHERE id = 1')
      .run(signedQty * price + fee, realizedDelta, realizedDelta < 0 ? account.consecutive_losses + 1 : 0)
    const fillId = `${order.exchange_order_id}:fill:1`
    this.#statements
      .get(
        `INSERT INTO sim_fills
           (fill_id, exchange_order_id, client_order_id, symbol, side, qty, price, fee, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (fill_id) DO NOTHING`,
      )
      .run(fillId, order.exchange_order_id, order.client_order_id, order.symbol, order.side, Math.abs(signedQty), price, fee, fillSequence)
    this.#statements
      .get(
        `UPDATE sim_orders
         SET status = 'filled', filled_qty = ?, avg_price = ?, fee = ?, updated_seq = ?
         WHERE exchange_order_id = ?`,
      )
      .run(Math.abs(signedQty), price, fee, fillSequence, order.exchange_order_id)
    order.status = 'filled'
    order.filled_qty = Math.abs(signedQty)
    order.avg_price = price
    order.fee = fee
    order.updated_seq = fillSequence

    if ((this.#position(order.symbol)?.qty ?? 0) === 0) {
      this.#statements
        .get(
          "UPDATE sim_orders SET status = 'canceled', updated_seq = ? WHERE symbol = ? AND status = 'acked' AND is_protective = 1",
        )
        .run(this.#nextSequence(), order.symbol)
    }
    return this.#ack(order)
  }

  #upsertPosition(symbol: string, qty: number, avgPrice: number): void {
    this.#statements
      .get(
        `INSERT INTO sim_positions (symbol, qty, avg_price) VALUES (?, ?, ?)
         ON CONFLICT (symbol) DO UPDATE SET qty = excluded.qty, avg_price = excluded.avg_price`,
      )
      .run(symbol, qty, avgPrice)
  }

  #equity(cash: number): number {
    let holdings = 0
    const positions = this.#statements.get('SELECT symbol, qty FROM sim_positions WHERE qty != 0').all() as {
      symbol: string
      qty: number
    }[]
    for (const position of positions) {
      const price = this.#price(position.symbol)
      if (price !== undefined) holdings += position.qty * price
    }
    return cash + holdings
  }

  #exposure(): number {
    let exposure = 0
    const positions = this.#statements.get('SELECT symbol, qty FROM sim_positions WHERE qty != 0').all() as {
      symbol: string
      qty: number
    }[]
    for (const position of positions) {
      const price = this.#price(position.symbol)
      if (price !== undefined) exposure += Math.abs(position.qty * price)
    }
    return exposure
  }

  #pendingExposure(): number | null {
    let total = 0
    for (const order of this.#openOrderRows()) {
      if (order.reduce_only === 1) continue
      const remaining = Math.max(0, order.qty - order.filled_qty)
      if (remaining === 0) continue
      if (order.limit_price === null || !Number.isFinite(order.limit_price) || order.limit_price <= 0) return null
      total += remaining * order.limit_price
    }
    return Number.isFinite(total) ? total : null
  }

  #protectiveStopFor(symbol: string): number | undefined {
    const row = this.#statements
      .get(
        "SELECT stop_loss_price FROM sim_orders WHERE symbol = ? AND status = 'acked' AND is_protective = 1 AND stop_loss_price IS NOT NULL ORDER BY created_seq ASC LIMIT 1",
      )
      .get(symbol) as { stop_loss_price: number } | undefined
    return row?.stop_loss_price
  }

  #withSlippage(reference: number, side: OrderSide): number {
    const factor = side === 'buy' ? 1 + this.#slippageBps / 10_000 : 1 - this.#slippageBps / 10_000
    return reference * factor
  }

  #ack(order: SimOrderRow): OrderAck {
    return {
      intentId: order.intent_id,
      clientOrderId: order.client_order_id,
      symbol: order.symbol,
      exchangeOrderId: order.exchange_order_id,
      state: order.status,
      ts: order.updated_seq,
      ...(order.avg_price === null ? {} : { avgPrice: order.avg_price }),
      filledQty: order.filled_qty,
      ...(order.filled_qty > 0 ? { fee: order.fee } : {}),
    }
  }
}
