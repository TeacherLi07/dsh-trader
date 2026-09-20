/**
 * 纸面撮合（plan §8.2 / T0.8）。
 *
 * 与实盘共用**同一份** `Broker` 接口与 `gate.ts`，因此"回测能跑、实盘不能跑"不会发生。
 * 三条纪律：
 *   1. **幂等**：同一 `clientOrderId` 只成交一次，重复提交返回原 ack；
 *   2. **只用注入的时间与价格**：不读墙钟、不联网，回放可复现；
 *   3. 成交价含**滑点与手续费**，绝不用"理想价格"高估策略。
 */

import type { Clock } from '../clock.js'
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

export interface PaperBook {
  /** 最近一次已知参考价（回放时 = 该 bar 的收盘价）。 */
  price(symbol: string): number | undefined
}

export interface PaperCandle {
  readonly high: number
  readonly low: number
  readonly close: number
}

export interface PaperBrokerOptions {
  readonly clock: Clock
  readonly book: PaperBook
  readonly initialEquityQuote?: number
  readonly slippageBps?: number
  readonly feeBps?: number
  readonly venue?: Venue
}

interface PaperPosition {
  qty: number
  avgPrice: number
}

interface ProtectiveSpec {
  readonly stopLossPrice?: number
  readonly takeProfitPrice?: number
  readonly trailingPercent?: number
  readonly reduceOnly: boolean
}

interface PaperOrder {
  readonly orderId: string
  readonly clientOrderId: string
  readonly symbol: string
  readonly side: OrderSide
  readonly qty: number
  readonly price?: number
  filledQty: number
  avgPrice?: number
  /** 本单累计手续费（从现金里扣除过）—— 回填到 OrderAck 供结算对账。 */
  feePaid: number
  status: OrderState
  readonly protective: ProtectiveSpec
  highWater?: number
  createdAt: number
}

const DAY_MS = 86_400_000

export class PaperBroker implements Broker {
  readonly venue: Venue
  #cash: number
  #positions = new Map<string, PaperPosition>()
  #lastPrice = new Map<string, number>()
  #orders = new Map<string, PaperOrder>()
  #byClientId = new Map<string, string>()
  #realizedPnl = 0
  #realizedByDay = new Map<number, number>()
  #peakEquity: number
  #consecutiveLosses = 0
  #sequence = 0
  readonly #subscribers = new Set<(event: UserDataEvent) => void>()

  constructor(private readonly options: PaperBrokerOptions) {
    this.venue = options.venue ?? 'paper'
    this.#cash = options.initialEquityQuote ?? 10_000
    this.#peakEquity = this.#cash
  }

  // ── 行情推进（纸面专用）────────────────────────────────────────────────────

  /**
   * 用一根 bar 推进纸面撮合：更新保护单触发，并登记该时刻的价格。
   * 撮合按 **bar 内可能的路径** 保守处理：先判止损（不利方向优先），再判止盈。
   */
  onBar(symbol: string, candle: PaperCandle): readonly OrderAck[] {
    // 回放时 bar 就是价格来源：先记住收盘价，再按 high/low 检查保护单
    this.#lastPrice.set(symbol, candle.close)
    const acks: OrderAck[] = []
    for (const order of this.#orders.values()) {
      if (order.symbol !== symbol || order.status !== 'acked') continue
      const trigger = this.#triggerPrice(order, candle)
      if (trigger === undefined) continue
      acks.push(this.#fill(order, trigger, this.options.clock.now()))
    }
    for (const ack of acks) {
      for (const subscriber of this.#subscribers) {
        subscriber({
          kind: 'fill',
          symbol,
          payload: ack as unknown as Record<string, unknown>,
          ts: ack.ts,
        })
      }
    }
    return acks
  }

  #triggerPrice(order: PaperOrder, candle: PaperCandle): number | undefined {
    const spec = order.protective
    const isLong = order.side === 'sell' // 保护单是平多头
    if (spec.stopLossPrice !== undefined) {
      if (isLong && candle.low <= spec.stopLossPrice) return spec.stopLossPrice
      if (!isLong && candle.high >= spec.stopLossPrice) return spec.stopLossPrice
    }
    if (spec.takeProfitPrice !== undefined) {
      if (isLong && candle.high >= spec.takeProfitPrice) return spec.takeProfitPrice
      if (!isLong && candle.low <= spec.takeProfitPrice) return spec.takeProfitPrice
    }
    if (spec.trailingPercent !== undefined) {
      const price = candle.close
      order.highWater = isLong
        ? Math.max(order.highWater ?? price, candle.high)
        : Math.min(order.highWater ?? price, candle.low)
      const trail =
        isLong
          ? (order.highWater ?? price) * (1 - spec.trailingPercent / 100)
          : (order.highWater ?? price) * (1 + spec.trailingPercent / 100)
      if (isLong && candle.low <= trail) return trail
      if (!isLong && candle.high >= trail) return trail
    }
    return undefined
  }

  // ── Broker 实现 ───────────────────────────────────────────────────────────

  async getAccount(): Promise<AccountSnapshot> {
    const equity = this.#equity()
    this.#peakEquity = Math.max(this.#peakEquity, equity)
    const now = this.options.clock.now()
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS
    const dailyLoss = Math.max(0, -(this.#realizedByDay.get(dayStart) ?? 0))
    return {
      venue: this.venue,
      equityQuote: equity,
      // paper 撮合没有逐仓/全仓保证金模型，不能把现金余额冒充交易所可用保证金。
      freeMarginQuote: null,
      totalExposureUsd: this.#exposure(),
      pendingExposureUsd: this.#pendingExposure(),
      openOrders: this.#openOrders().length,
      leverage: equity > 0 ? this.#exposure() / equity : Number.POSITIVE_INFINITY,
      dailyLossUsd: dailyLoss,
      drawdownUsd: Math.max(0, this.#peakEquity - equity),
      consecutiveLosses: this.#consecutiveLosses,
      spreadBps: 0, // 纸面按收盘价撮合，无盘口；真实执行前必须重取盘口（plan §6.2）
      observedAt: now,
    }
  }

  async getPositions(): Promise<readonly PositionSnapshot[]> {
    const out: PositionSnapshot[] = []
    const observedAt = this.options.clock.now()
    for (const [symbol, position] of this.#positions) {
      if (position.qty === 0) continue
      const price = this.#price(symbol)
      out.push({
        symbol,
        observedAt,
        qty: position.qty,
        avgPrice: position.avgPrice,
        unrealizedPnlUsd: price === undefined ? 0 : (price - position.avgPrice) * position.qty,
        ...(this.#protectiveStopFor(symbol) === undefined
          ? {}
          : { protectedStopPrice: this.#protectiveStopFor(symbol) as number }),
      })
    }
    return out
  }

  async getOpenOrders(symbol?: string): Promise<readonly OrderAck[]> {
    const observedAt = this.options.clock.now()
    return this.#openOrders()
      .filter((order) => symbol === undefined || order.symbol === symbol)
      .map((order) => ({ ...this.#ack(order), observedAt }))
  }

  async findOrderByExchangeOrderId(exchangeOrderId: string): Promise<OrderAck | undefined> {
    const order = this.#orders.get(exchangeOrderId)
    return order === undefined ? undefined : this.#ack(order)
  }

  async findOrderByClientOrderId(clientOrderId: string): Promise<OrderAck | undefined> {
    const orderId = this.#byClientId.get(clientOrderId)
    return orderId === undefined ? undefined : this.findOrderByExchangeOrderId(orderId)
  }

  async placeOrder(request: OrderRequest): Promise<OrderAck> {
    const existing = this.#byClientId.get(request.clientOrderId)
    if (existing !== undefined) {
      // 幂等：重复提交不再成交（P2 验收"同一 clientOrderId 只成交一次"）
      return this.#ack(this.#orders.get(existing) as PaperOrder)
    }

    const order: PaperOrder = {
      orderId: `paper-${++this.#sequence}`,
      clientOrderId: request.clientOrderId,
      symbol: request.symbol,
      side: request.side,
      qty: request.qty,
      ...(request.price === undefined ? {} : { price: request.price }),
      filledQty: 0,
      feePaid: 0,
      status: 'acked',
      protective: {
        ...(request.stopLossPrice === undefined ? {} : { stopLossPrice: request.stopLossPrice }),
        ...(request.takeProfitPrice === undefined ? {} : { takeProfitPrice: request.takeProfitPrice }),
        ...(request.trailingPercent === undefined ? {} : { trailingPercent: request.trailingPercent }),
        reduceOnly: request.reduceOnly === true,
      },
      createdAt: this.options.clock.now(),
    }
    this.#orders.set(order.orderId, order)
    this.#byClientId.set(request.clientOrderId, order.orderId)

    const reference = this.#price(request.symbol)
    if (reference === undefined) {
      order.status = 'rejected'
      return this.#ack(order)
    }

    if (request.type === 'market') {
      this.#fill(order, this.#withSlippage(reference, request.side), order.createdAt)
    } else {
      const limit = request.price
      if (limit === undefined) {
        order.status = 'rejected'
        return this.#ack(order)
      }
      const crossed = request.side === 'buy' ? limit >= reference : limit <= reference
      if (crossed) this.#fill(order, limit, order.createdAt)
    }
    return this.#ack(order)
  }

  async placeProtective(request: ProtectiveRequest): Promise<OrderAck> {
    const position = this.#positions.get(request.symbol)
    if (position === undefined || position.qty === 0) {
      throw new Error(`placeProtective：${request.symbol} 没有持仓`)
    }
    if (request.expectedPositionQty !== undefined &&
        (!Number.isFinite(request.expectedPositionQty) || request.expectedPositionQty === 0 ||
         Math.sign(position.qty) !== Math.sign(request.expectedPositionQty) ||
         Math.abs(position.qty) + 1e-12 < Math.abs(request.expectedPositionQty))) {
      throw new Error(`placeProtective：${request.symbol} 实际持仓小于已确认成交暴露`)
    }
    const side: OrderSide = position.qty > 0 ? 'sell' : 'buy'
    const now = this.options.clock.now()
    // 调用方给了幂等键就用它（审计/恢复能对上）；没给才退回自造键
    const clientOrderId = request.clientOrderId ?? `protect-${request.symbol}-${now}`

    const existing = this.#byClientId.get(clientOrderId)
    if (existing !== undefined) return this.#ack(this.#orders.get(existing) as PaperOrder)

    // 保护单是**挂单**：必须等触发价被碰到，绝不能立刻按市价成交
    const order: PaperOrder = {
      orderId: `paper-${++this.#sequence}`,
      clientOrderId,
      symbol: request.symbol,
      side,
      qty: Math.abs(position.qty),
      filledQty: 0,
      feePaid: 0,
      status: 'acked',
      protective: {
        ...(request.stopLossPrice === undefined ? {} : { stopLossPrice: request.stopLossPrice }),
        ...(request.takeProfitPrice === undefined ? {} : { takeProfitPrice: request.takeProfitPrice }),
        ...(request.trailingPercent === undefined ? {} : { trailingPercent: request.trailingPercent }),
        reduceOnly: true,
      },
      createdAt: now,
    }
    this.#orders.set(order.orderId, order)
    this.#byClientId.set(clientOrderId, order.orderId)
    return this.#ack(order)
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    const order = this.#orders.get(exchangeOrderId)
    if (order !== undefined && order.status === 'acked') order.status = 'canceled'
  }

  async cancelAll(symbol?: string, options: { readonly includeProtection?: boolean } = {}): Promise<void> {
    if (options.includeProtection === true) {
      const hasPosition = [...this.#positions].some(([positionSymbol, position]) =>
        position.qty !== 0 && (symbol === undefined || positionSymbol === symbol))
      if (hasPosition) throw new Error('拒绝在仍有持仓时撤销保护单')
    }
    for (const order of this.#orders.values()) {
      if (order.status !== 'acked') continue
      if (symbol !== undefined && order.symbol !== symbol) continue
      if (options.includeProtection !== true && order.protective.reduceOnly) continue
      order.status = 'canceled'
    }
  }

  subscribeUserData(_onEvent: (event: UserDataEvent) => void): () => void {
    this.#subscribers.add(_onEvent)
    return () => this.#subscribers.delete(_onEvent)
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  #price(symbol: string): number | undefined {
    // 优先用最近一根 bar 的收盘价（回放/纸面），否则回落到注入的 book
    return this.#lastPrice.get(symbol) ?? this.options.book.price(symbol)
  }

  #withSlippage(reference: number, side: OrderSide): number {
    const bps = this.options.slippageBps ?? 5
    const factor = side === 'buy' ? 1 + bps / 10_000 : 1 - bps / 10_000
    return reference * factor
  }

  #fill(order: PaperOrder, price: number, at: number): OrderAck {
    let signed = order.side === 'buy' ? order.qty : -order.qty

    // ★ reduceOnly 绝不能增加/翻转敞口：一个"平多"的止损单在持仓已被部分平掉后，
    // 若不封顶就会把仓位翻成裸空（实测），并留下旧均价 → 虚假浮盈与错误权益。
    if (order.protective.reduceOnly) {
      const current = this.#positions.get(order.symbol)
      const currentQty = current?.qty ?? 0
      if (currentQty === 0 || Math.sign(currentQty) === Math.sign(signed)) {
        order.status = 'rejected'
        return this.#ack(order)
      }
      if (Math.abs(signed) > Math.abs(currentQty)) {
        signed = Math.sign(signed) * Math.abs(currentQty)
      }
    }

    let position = this.#positions.get(order.symbol)
    if (position === undefined) {
      position = { qty: 0, avgPrice: 0 }
      this.#positions.set(order.symbol, position)
    }
    const notional = Math.abs(signed) * price
    const fee = (notional * (this.options.feeBps ?? 5)) / 10_000

    // 手续费是一等成本（plan §5.3 / §8）：`realizedPnl` 与每日亏损都必须含费，
    // 否则硬闸的 dailyLossLimit 与 A/B 的净 PnL 都会低估成本。
    this.#realizedPnl -= fee
    const feeDay = Math.floor(at / DAY_MS) * DAY_MS
    this.#realizedByDay.set(feeDay, (this.#realizedByDay.get(feeDay) ?? 0) - fee)

    if (position.qty === 0 || Math.sign(position.qty) === Math.sign(signed)) {
      const newQty = position.qty + signed
      position.avgPrice =
        newQty === 0 ? 0 : (position.avgPrice * Math.abs(position.qty) + price * Math.abs(signed)) / Math.abs(newQty)
      position.qty = newQty
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(position.qty))
      const direction = Math.sign(position.qty)
      const gross = (price - position.avgPrice) * closing * direction
      const net = gross - fee
      this.#realizedPnl += gross
      const day = Math.floor(at / DAY_MS) * DAY_MS
      this.#realizedByDay.set(day, (this.#realizedByDay.get(day) ?? 0) + gross)
      this.#consecutiveLosses = net < 0 ? this.#consecutiveLosses + 1 : 0
      position.qty += signed
      if (position.qty === 0) position.avgPrice = 0
    }

    this.#cash -= signed * price
    this.#cash -= fee
    order.filledQty += Math.abs(signed)
    order.feePaid += fee
    order.avgPrice = price
    order.status = 'filled'
    return this.#ack(order)
  }

  #openOrders(): readonly PaperOrder[] {
    return [...this.#orders.values()].filter((order) => order.status === 'acked')
  }

  #protectiveStopFor(symbol: string): number | undefined {
    for (const order of this.#orders.values()) {
      if (order.symbol === symbol && order.status === 'acked' && order.protective.stopLossPrice !== undefined) {
        return order.protective.stopLossPrice
      }
    }
    return undefined
  }

  #equity(): number {
    let holdings = 0
    for (const [symbol, position] of this.#positions) {
      const price = this.#price(symbol)
      if (price === undefined) continue
      holdings += position.qty * price
    }
    return this.#cash + holdings
  }

  #exposure(): number {
    let exposure = 0
    for (const [symbol, position] of this.#positions) {
      const price = this.#price(symbol)
      if (price === undefined) continue
      exposure += Math.abs(position.qty * price)
    }
    return exposure
  }

  #pendingExposure(): number | null {
    let total = 0
    for (const order of this.#openOrders()) {
      if (order.protective.reduceOnly) continue
      const remaining = Math.max(0, order.qty - order.filledQty)
      if (remaining === 0) continue
      if (order.price === undefined || !Number.isFinite(order.price) || order.price <= 0) return null
      total += remaining * order.price
    }
    return Number.isFinite(total) ? total : null
  }

  #ack(order: PaperOrder): OrderAck {
    return {
      intentId: order.clientOrderId,
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      exchangeOrderId: order.orderId,
      state: order.status,
      ts: this.options.clock.now(),
      filledQty: order.filledQty,
      ...(order.avgPrice === undefined ? {} : { avgPrice: order.avgPrice }),
      ...(order.filledQty > 0 ? { fee: order.feePaid } : {}),
    }
  }

  /** 回放统计用：已实现盈亏（含手续费）。 */
  realizedPnl(): number {
    return this.#realizedPnl
  }

  cash(): number {
    return this.#cash
  }
}
