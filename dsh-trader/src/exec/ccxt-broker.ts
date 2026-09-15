/**
 * CCXT Pro 私有交易适配器（plan §4.2 / §6.2 / §6.3 / T2.1）。
 *
 * 这里故意只依赖注入的 exchange 结构，不 import `ccxt`：生产组合根可以动态构造
 * HTX/OKX，测试则用无网络 fake。venue 的差异只通过 options 表达，不能在业务逻辑
 * 里堆 venue 分支；HTX 是生产选择，OKX 负责只读交叉校验与 sandbox。
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

export type CcxtVenue = Exclude<Venue, 'paper'>
export type CcxtParams = Record<string, unknown>

/** CCXT 余额的最小结构；字段值保留 unknown，因为不同交易所会返回数字字符串。 */
export interface CcxtBalanceLike {
  readonly total?: unknown
  readonly free?: unknown
  readonly used?: unknown
  readonly info?: unknown
  readonly [currency: string]: unknown
}

/** CCXT 持仓的最小结构。其余交易所扩展字段不进入 broker 的返回值。 */
export interface CcxtPositionLike {
  readonly symbol?: unknown
  readonly side?: unknown
  readonly contracts?: unknown
  readonly amount?: unknown
  readonly qty?: unknown
  readonly size?: unknown
  readonly entryPrice?: unknown
  readonly average?: unknown
  readonly avgPrice?: unknown
  readonly markPrice?: unknown
  readonly notional?: unknown
  readonly unrealizedPnl?: unknown
  readonly unrealizedProfit?: unknown
  readonly pnl?: unknown
  readonly info?: unknown
  readonly [field: string]: unknown
}

/** CCXT 订单的最小结构；订单原始 info 只用于读取，不会原样返回或落库。 */
export interface CcxtOrderLike {
  readonly id?: unknown
  readonly clientOrderId?: unknown
  readonly symbol?: unknown
  readonly type?: unknown
  readonly side?: unknown
  readonly amount?: unknown
  readonly filled?: unknown
  readonly price?: unknown
  readonly average?: unknown
  readonly avgPrice?: unknown
  readonly status?: unknown
  readonly timestamp?: unknown
  readonly lastTradeTimestamp?: unknown
  readonly fee?: unknown
  readonly fees?: unknown
  readonly reduceOnly?: unknown
  readonly stopLossPrice?: unknown
  readonly takeProfitPrice?: unknown
  readonly triggerPrice?: unknown
  readonly stopPrice?: unknown
  readonly trailingPercent?: unknown
  readonly info?: unknown
  readonly [field: string]: unknown
}

/** 成交查询只需要这些 CCXT 常见字段。 */
export interface CcxtTradeLike {
  readonly id?: unknown
  readonly order?: unknown
  readonly clientOrderId?: unknown
  readonly symbol?: unknown
  readonly price?: unknown
  readonly amount?: unknown
  readonly timestamp?: unknown
  readonly fee?: unknown
  readonly fees?: unknown
  readonly info?: unknown
  readonly [field: string]: unknown
}

/** ticker 的 bid/ask 是 CCXT 统一字段；bestBid/bestAsk 兼容部分 exchange-like 测试替身。 */
export interface CcxtTickerLike {
  readonly bid?: unknown
  readonly ask?: unknown
  readonly bestBid?: unknown
  readonly bestAsk?: unknown
  readonly info?: unknown
  readonly [field: string]: unknown
}

/**
 * 只声明本适配器实际使用的 CCXT Pro 能力，避免把第三方整包类型带入核心执行层。
 * `has[x] === false` 时查询能力明确不可用；未声明时仍尝试调用，以兼容精简 fake。
 */
export interface CcxtProExchangeLike {
  readonly id: string
  readonly has: Readonly<Record<string, unknown>>
  loadMarkets(): Promise<unknown>
  fetchBalance(): Promise<CcxtBalanceLike>
  fetchPositions(symbols?: readonly string[], params?: CcxtParams): Promise<readonly CcxtPositionLike[]>
  fetchOpenOrders(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: CcxtParams,
  ): Promise<readonly CcxtOrderLike[]>
  createOrder(
    symbol: string,
    type: string,
    side: string,
    amount: number,
    price?: number,
    params?: CcxtParams,
  ): Promise<CcxtOrderLike>
  cancelOrder(id: string, symbol?: string, params?: CcxtParams): Promise<CcxtOrderLike | void>
  fetchOrder(id: string, symbol?: string, params?: CcxtParams): Promise<CcxtOrderLike | undefined>
  fetchMyTrades(
    symbol?: string,
    since?: number,
    limit?: number,
    params?: CcxtParams,
  ): Promise<readonly CcxtTradeLike[]>
  fetchTicker(symbol: string): Promise<CcxtTickerLike>
  setSandboxMode?(enabled: boolean): void
}

export interface RiskState {
  readonly dailyLossUsd: number
  readonly drawdownUsd: number
  readonly consecutiveLosses: number
}

/**
 * 交易所没有完整的本地风控状态；主进程应从 journal/config 组装后注入这里。
 * 不注入时 broker 必须报错，不能填 0 伪装成“没有亏损”。
 */
export type RiskStateProvider = () => RiskState

export interface CcxtBrokerOptions {
  readonly exchange: CcxtProExchangeLike
  readonly venue: CcxtVenue
  readonly clock: Clock
  readonly apiKey: string
  readonly apiSecret: string
  readonly riskStateProvider?: RiskStateProvider
  /** 兼容组合根的简写；两个 provider 同时存在时优先使用 riskStateProvider。 */
  readonly riskState?: RiskStateProvider
  readonly quoteCurrency?: string
  /** getAccount 价差重取的标的；未提供且没有持仓/挂单时，价差 fail-closed。 */
  readonly spreadSymbol?: string
  /** `symbol` 是 spreadSymbol 的兼容简写，便于组合根只配置一个主标的。 */
  readonly symbol?: string
  /** 交易所侧条件单类型，默认统一用 stop；不按 venue 写分支。 */
  readonly protectiveOrderType?: string
  /** OKX sandbox 可用；HTX 没有 sandbox 时该选项不应打开。 */
  readonly sandbox?: boolean
}

interface PositionReading {
  readonly snapshot: PositionSnapshot
  readonly exposureUsd: number
}

const NOT_FOUND_RE = /not[ _-]?found|does not exist|no such order|unknown order|order_not_found/i
const NOT_SUPPORTED_RE = /not[_ -]?supported|unsupported|has no method|not available/i

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function firstNumber(record: Readonly<Record<string, unknown>>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function firstString(record: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function infoOf(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  const info = record['info']
  return isRecord(info) ? info : undefined
}

function valueFromRecordOrInfo(
  record: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): unknown {
  const direct = firstNumber(record, keys)
  if (direct !== undefined) return direct
  const info = infoOf(record)
  return info === undefined ? undefined : firstNumber(info, keys)
}

function clientOrderIdFrom(value: Readonly<Record<string, unknown>>): string | undefined {
  const direct = firstString(value, ['clientOrderId', 'client_order_id', 'client-order-id', 'clOrdId'])
  if (direct !== undefined) return direct

  const info = infoOf(value)
  if (info === undefined) return undefined

  const explicit = firstString(info, [
    'clientOrderId',
    'client_order_id',
    'client-order-id',
    'clientOrderID',
    'clOrdId',
    'client_oid',
  ])
  if (explicit !== undefined) return explicit

  // 不同交易所的 info key 命名不一致，只读取语义明确的 client/cl 编号，不猜 order id。
  for (const [key, raw] of Object.entries(info)) {
    const normalized = key.toLowerCase().replaceAll('_', '').replaceAll('-', '')
    if (normalized === 'clientorderid' || normalized === 'clordid' || normalized === 'clientoid') {
      const value = asString(raw)
      if (value !== undefined) return value
    }
  }
  return undefined
}

function exchangeOrderIdFrom(value: Readonly<Record<string, unknown>>): string | undefined {
  const id = value['id']
  if (typeof id === 'string' && id.length > 0) return id
  if (typeof id === 'number' && Number.isFinite(id)) return String(id)
  return undefined
}

function orderState(value: Readonly<Record<string, unknown>>, fallback: OrderState): OrderState {
  const status = asString(value['status'])?.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  if (status === undefined) return fallback
  if (status === 'open' || status === 'new' || status === 'pending' || status === 'partial' || status === 'partially_filled') {
    return 'acked'
  }
  if (status === 'closed' || status === 'filled' || status === 'triggered') return 'filled'
  if (status === 'canceled' || status === 'cancelled' || status === 'expired') return 'canceled'
  if (status === 'rejected') return 'rejected'
  // 未知状态不能伪装成可继续执行的 ack；恢复会把 unknown 冻结并交给人工核对。
  return 'unknown'
}

function feeFrom(value: Readonly<Record<string, unknown>>): number | undefined {
  const fee = value['fee']
  const direct = asNumber(fee)
  if (direct !== undefined) return direct
  if (isRecord(fee)) {
    const cost = asNumber(fee['cost'])
    if (cost !== undefined) return cost
  }
  const fees = value['fees']
  if (!Array.isArray(fees)) return undefined
  let total = 0
  let found = false
  for (const item of fees) {
    if (!isRecord(item)) continue
    const cost = asNumber(item['cost'])
    if (cost === undefined) continue
    total += cost
    found = true
  }
  return found ? total : undefined
}

function truthyBoolean(value: unknown): boolean {
  if (value === true) return true
  if (value === 1) return true
  if (typeof value !== 'string') return false
  return ['true', '1', 'yes'].includes(value.toLowerCase())
}

function isReduceOnly(value: Readonly<Record<string, unknown>>): boolean {
  if (truthyBoolean(value['reduceOnly'])) return true
  const info = infoOf(value)
  return (
    info !== undefined &&
    (truthyBoolean(info['reduceOnly']) ||
      truthyBoolean(info['reduce_only']) ||
      truthyBoolean(info['reduce-only']))
  )
}

function stopPriceFrom(value: Readonly<Record<string, unknown>>): number | undefined {
  const type = asString(value['type'])?.toLowerCase().replaceAll('-', '_') ?? ''
  if (type.includes('take_profit') || type.includes('takeprofit')) return undefined

  const explicit = valueFromRecordOrInfo(value, ['stopLossPrice', 'stop_loss_price'])
  const explicitNumber = asNumber(explicit)
  if (explicitNumber !== undefined) return explicitNumber
  const trigger = valueFromRecordOrInfo(value, ['stopPrice', 'stop_price', 'triggerPrice', 'trigger_price'])
  if (!type.includes('stop') && trigger === undefined) return undefined
  return asNumber(trigger)
}

function positionQty(value: Readonly<Record<string, unknown>>): number | undefined {
  const qty = firstNumber(value, ['contracts', 'amount', 'qty', 'size'])
  if (qty === undefined || qty === 0) return qty
  const side = asString(value['side'])?.toLowerCase()
  if (side === 'short') return -Math.abs(qty)
  if (side === 'long') return Math.abs(qty)
  return qty
}

function quoteAmount(balance: CcxtBalanceLike, quoteCurrency: string): number | undefined {
  const root = balance as Readonly<Record<string, unknown>>
  const total = root['total']
  if (isRecord(total)) {
    const value = asNumber(total[quoteCurrency])
    if (value !== undefined) return value
  } else {
    const scalar = asNumber(total)
    if (scalar !== undefined) return scalar
  }

  const currency = root[quoteCurrency]
  if (isRecord(currency)) {
    const value = asNumber(currency['total'])
    if (value !== undefined) return value
    const free = asNumber(currency['free'])
    const used = asNumber(currency['used'])
    if (free !== undefined && used !== undefined) return free + used
  } else {
    const scalar = asNumber(currency)
    if (scalar !== undefined) return scalar
  }

  const free = isRecord(root['free']) ? asNumber(root['free'][quoteCurrency]) : undefined
  const used = isRecord(root['used']) ? asNumber(root['used'][quoteCurrency]) : undefined
  return free !== undefined && used !== undefined ? free + used : undefined
}

function lookupMiss(error: unknown): boolean {
  if (error instanceof Error && (NOT_FOUND_RE.test(error.name) || NOT_SUPPORTED_RE.test(error.name))) return true
  const message = error instanceof Error ? error.message : String(error)
  return NOT_FOUND_RE.test(message) || NOT_SUPPORTED_RE.test(message)
}

function addParam(params: CcxtParams, key: string, value: number | string | boolean | undefined): void {
  if (value !== undefined) params[key] = value
}

export class CcxtBroker implements Broker {
  readonly venue: CcxtVenue
  readonly #exchange: CcxtProExchangeLike
  readonly #clock: Clock
  readonly #apiKey: string
  readonly #apiSecret: string
  readonly #riskStateProvider: RiskStateProvider | undefined
  readonly #quoteCurrency: string
  readonly #spreadSymbol: string | undefined
  readonly #protectiveOrderType: string
  #marketsLoaded = false
  #marketsLoading: Promise<void> | undefined
  readonly #inFlight = new Map<string, Promise<OrderAck>>()

  constructor(options: CcxtBrokerOptions) {
    this.venue = options.venue
    this.#exchange = options.exchange
    this.#clock = options.clock
    this.#apiKey = options.apiKey
    this.#apiSecret = options.apiSecret
    this.#riskStateProvider = options.riskStateProvider ?? options.riskState
    this.#quoteCurrency = options.quoteCurrency ?? 'USDT'
    this.#spreadSymbol = options.spreadSymbol ?? options.symbol
    this.#protectiveOrderType = options.protectiveOrderType ?? 'stop'

    if (options.sandbox === true) {
      try {
        // setSandboxMode 是同步配置，不触网；HTX 没有该能力时 optional 调用自然跳过。
        options.exchange.setSandboxMode?.(true)
      } catch (error) {
        throw this.#safeError(error)
      }
    }
  }

  async getAccount(): Promise<AccountSnapshot> {
    const risk = this.#riskState()
    await this.#ensureMarketsLoaded()
    const balance = await this.#call(() => this.#exchange.fetchBalance())
    const positions = await this.#call(() => this.#exchange.fetchPositions())
    const openOrders = await this.#call(() => this.#exchange.fetchOpenOrders())
    const equity = quoteAmount(balance, this.#quoteCurrency)
    if (equity === undefined) {
      throw this.#safeError(new Error(`余额中没有可识别的 ${this.#quoteCurrency} equity`))
    }

    const readings = positions.map((position) => this.#readPosition(position))
    const totalExposureUsd = this.#exposure(readings)
    const spreadSymbol = this.#spreadSymbol ?? this.#firstSymbol(positions, openOrders)
    const spreadBps = await this.#spread(spreadSymbol)
    const observedAt = this.#clock.now()
    return {
      venue: this.venue,
      equityQuote: equity,
      totalExposureUsd,
      openOrders: openOrders.length,
      leverage: equity > 0 ? totalExposureUsd / equity : Number.POSITIVE_INFINITY,
      dailyLossUsd: risk.dailyLossUsd,
      drawdownUsd: risk.drawdownUsd,
      consecutiveLosses: risk.consecutiveLosses,
      spreadBps,
      observedAt,
    }
  }

  async getPositions(): Promise<readonly PositionSnapshot[]> {
    await this.#ensureMarketsLoaded()
    const [positions, openOrders] = await Promise.all([
      this.#call(() => this.#exchange.fetchPositions()),
      this.#call(() => this.#exchange.fetchOpenOrders()),
    ])
    const stops = new Map<string, number>()
    for (const order of openOrders) {
      if (!isReduceOnly(order)) continue
      const symbol = asString(order['symbol'])
      const stop = stopPriceFrom(order)
      if (symbol !== undefined && stop !== undefined && !stops.has(symbol)) stops.set(symbol, stop)
    }

    const out: PositionSnapshot[] = []
    for (const position of positions) {
      const reading = this.#readPosition(position)
      if (reading === undefined || reading.snapshot.qty === 0) continue
      const stop = stops.get(reading.snapshot.symbol)
      out.push({
        ...reading.snapshot,
        ...(stop === undefined ? {} : { protectedStopPrice: stop }),
      })
    }
    return out
  }

  async getOpenOrders(symbol?: string): Promise<readonly OrderAck[]> {
    await this.#ensureMarketsLoaded()
    const orders = await this.#call(() => this.#exchange.fetchOpenOrders(symbol))
    const acks: OrderAck[] = []
    for (const order of orders) {
      if (symbol !== undefined && order['symbol'] !== symbol) continue
      const ack = this.#orderAck(order, undefined, 'acked')
      if (ack !== undefined) acks.push(ack)
      // 没有 clientOrderId 的远端单不能安全纳入本地审计映射；这里跳过而非编造 id。
    }
    return acks
  }

  async placeOrder(request: OrderRequest): Promise<OrderAck> {
    const running = this.#inFlight.get(request.clientOrderId)
    if (running !== undefined) return running

    const operation = this.#placeOrder(request)
    this.#inFlight.set(request.clientOrderId, operation)
    try {
      return await operation
    } finally {
      if (this.#inFlight.get(request.clientOrderId) === operation) this.#inFlight.delete(request.clientOrderId)
    }
  }

  async placeProtective(request: ProtectiveRequest): Promise<OrderAck> {
    const clientOrderId = request.clientOrderId ?? this.#protectiveClientOrderId(request)
    const existing = await this.findOrderByClientOrderId(clientOrderId)
    if (existing !== undefined) return existing

    if (
      request.stopLossPrice === undefined &&
      request.takeProfitPrice === undefined &&
      request.trailingPercent === undefined
    ) {
      throw this.#safeError(new Error('保护单至少需要 stopLossPrice、takeProfitPrice 或 trailingPercent'))
    }

    await this.#ensureMarketsLoaded()
    const positions = await this.#call(() => this.#exchange.fetchPositions())
    const position = positions
      .map((candidate) => this.#readPosition(candidate))
      .find((candidate) => candidate?.snapshot.symbol === request.symbol && candidate.snapshot.qty !== 0)
    if (position === undefined) {
      throw this.#safeError(new Error(`placeProtective：${request.symbol} 没有持仓`))
    }

    const params: CcxtParams = { clientOrderId, reduceOnly: true }
    addParam(params, 'stopLossPrice', request.stopLossPrice)
    addParam(params, 'takeProfitPrice', request.takeProfitPrice)
    addParam(params, 'trailingPercent', request.trailingPercent)
    addParam(params, 'trailingTriggerPrice', request.trailingTriggerPrice)

    const side: OrderSide = position.snapshot.qty > 0 ? 'sell' : 'buy'
    const created = await this.#call(() =>
      this.#exchange.createOrder(
        request.symbol,
        this.#protectiveOrderType,
        side,
        Math.abs(position.snapshot.qty),
        undefined,
        params,
      ),
    )
    return this.#requirePlacedAck(created, { clientOrderId, intentId: clientOrderId })
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    await this.#ensureMarketsLoaded()
    await this.#call(() => this.#exchange.cancelOrder(exchangeOrderId))
  }

  async cancelAll(symbol?: string): Promise<void> {
    await this.#ensureMarketsLoaded()
    const orders = await this.#call(() => this.#exchange.fetchOpenOrders(symbol))
    for (const order of orders) {
      const exchangeOrderId = exchangeOrderIdFrom(order)
      if (exchangeOrderId === undefined) {
        throw this.#safeError(new Error('挂单缺少 exchange order id，无法安全执行 cancelAll'))
      }
      await this.cancelOrder(exchangeOrderId)
    }
  }

  subscribeUserData(_onEvent: (event: UserDataEvent) => void): () => void {
    // 免费 ccxt 没有稳定的用户数据流；v0 用轮询对账，避免假装实时而丢成交回报。
    return () => {
      /* v0 无 WS 用户数据订阅 */
    }
  }

  async findOrderByClientOrderId(clientOrderId: string): Promise<OrderAck | undefined> {
    await this.#ensureMarketsLoaded()

    if (this.#can('fetchOrder')) {
      try {
        const order = await this.#exchange.fetchOrder(clientOrderId, undefined, { clientOrderId })
        if (order !== undefined && clientOrderIdFrom(order) === clientOrderId) {
          return this.#orderAck(order, { clientOrderId }, 'acked')
        }
      } catch (error) {
        if (!lookupMiss(error)) throw this.#safeError(error)
      }
    }

    if (this.#can('fetchOpenOrders')) {
      try {
        const orders = await this.#exchange.fetchOpenOrders()
        for (const order of orders) {
          if (clientOrderIdFrom(order) === clientOrderId) return this.#orderAck(order, { clientOrderId }, 'acked')
        }
      } catch (error) {
        if (!lookupMiss(error)) throw this.#safeError(error)
      }
    }

    if (this.#can('fetchMyTrades')) {
      try {
        const trades = await this.#exchange.fetchMyTrades(undefined, undefined, undefined, { clientOrderId })
        for (const trade of trades) {
          if (clientOrderIdFrom(trade) === clientOrderId) return this.#tradeAck(trade, clientOrderId)
        }
      } catch (error) {
        if (!lookupMiss(error)) throw this.#safeError(error)
      }
    }

    // 查不到绝不猜测 exchangeOrderId 或状态；CrashRecovery 会把它判为 unknown 并冻结标的。
    return undefined
  }

  async #placeOrder(request: OrderRequest): Promise<OrderAck> {
    // 传输失败/不确定失败必须 throw：调用方已落库的 created 意图要留给 CrashRecovery 收敛。
    // 不能返回 { state: 'unknown' }，现有 tools.ts 会把 unknown 误当 acked，进而丢掉在途信号。
    const existing = await this.findOrderByClientOrderId(request.clientOrderId)
    if (existing !== undefined) return existing

    await this.#ensureMarketsLoaded()
    const params: CcxtParams = {
      clientOrderId: request.clientOrderId,
      reduceOnly: request.reduceOnly === true,
    }
    addParam(params, 'stopLossPrice', request.stopLossPrice)
    addParam(params, 'takeProfitPrice', request.takeProfitPrice)
    addParam(params, 'trailingPercent', request.trailingPercent)

    const created = await this.#call(() =>
      this.#exchange.createOrder(request.symbol, request.type, request.side, request.qty, request.price, params),
    )
    return this.#requirePlacedAck(
      created,
      { clientOrderId: request.clientOrderId, intentId: request.intentId },
    )
  }

  #requirePlacedAck(
    value: CcxtOrderLike,
    fallback: { readonly clientOrderId: string; readonly intentId: string },
  ): OrderAck {
    const ack = this.#orderAck(value, fallback, 'acked')
    if (ack === undefined || ack.state === 'unknown' || ack.state === 'created') {
      // createOrder 已返回但状态不可解释，仍属于不确定结果；交给恢复查询，绝不能伪装成 acked。
      throw this.#safeError(new Error('交易所返回了无法确认的订单状态'))
    }
    return ack
  }

  #riskState(): RiskState {
    if (this.#riskStateProvider === undefined) {
      throw this.#safeError(
        new Error('CcxtBroker 未注入 RiskStateProvider：dailyLoss/drawdown/连续亏损不能默认填 0'),
      )
    }
    let state: RiskState
    try {
      state = this.#riskStateProvider()
    } catch (error) {
      throw this.#safeError(error)
    }
    if (
      !Number.isFinite(state.dailyLossUsd) ||
      !Number.isFinite(state.drawdownUsd) ||
      !Number.isFinite(state.consecutiveLosses)
    ) {
      throw this.#safeError(new Error('RiskStateProvider 返回了非有限风险状态'))
    }
    return state
  }

  async #ensureMarketsLoaded(): Promise<void> {
    if (this.#marketsLoaded) return
    if (this.#marketsLoading !== undefined) return this.#marketsLoading
    this.#marketsLoading = (async () => {
      try {
        await this.#exchange.loadMarkets()
        this.#marketsLoaded = true
      } catch (error) {
        throw this.#safeError(error)
      }
    })()
    return this.#marketsLoading
  }

  async #call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      throw this.#safeError(error)
    }
  }

  #safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : String(error)
    for (const secret of [this.#apiKey, this.#apiSecret]) {
      if (secret.length > 0) message = message.replaceAll(secret, '[REDACTED]')
    }
    return new Error(message.length > 0 ? message : '交易所请求失败')
  }

  #can(capability: string): boolean {
    return this.#exchange.has[capability] !== false
  }

  #readPosition(value: CcxtPositionLike): PositionReading | undefined {
    const raw = value as Readonly<Record<string, unknown>>
    const symbol = asString(raw['symbol'])
    const qty = positionQty(raw)
    if (symbol === undefined || qty === undefined) return undefined

    const avgPrice = firstNumber(raw, ['entryPrice', 'average', 'avgPrice', 'price']) ?? 0
    const markPrice = asNumber(raw['markPrice'])
    const notional = asNumber(raw['notional'])
    const exposureUsd =
      notional !== undefined
        ? Math.abs(notional)
        : markPrice !== undefined
          ? Math.abs(qty * markPrice)
          : avgPrice > 0
            ? Math.abs(qty * avgPrice)
            : Number.POSITIVE_INFINITY
    const unrealizedPnlUsd = firstNumber(raw, ['unrealizedPnl', 'unrealizedProfit', 'pnl']) ?? 0
    return {
      snapshot: {
        symbol,
        qty,
        avgPrice,
        unrealizedPnlUsd,
      },
      exposureUsd,
    }
  }

  #exposure(readings: readonly (PositionReading | undefined)[]): number {
    let total = 0
    for (const reading of readings) {
      // 远端返回了无法解析的持仓时不能按 0 计入风险；未知敞口必须让硬闸拒绝开仓。
      if (reading === undefined) return Number.POSITIVE_INFINITY
      if (reading.snapshot.qty === 0) continue
      if (!Number.isFinite(reading.exposureUsd)) return Number.POSITIVE_INFINITY
      total += reading.exposureUsd
    }
    return total
  }

  #firstSymbol(
    positions: readonly CcxtPositionLike[],
    orders: readonly CcxtOrderLike[],
  ): string | undefined {
    for (const position of positions) {
      const symbol = asString(position['symbol'])
      if (symbol !== undefined) return symbol
    }
    for (const order of orders) {
      const symbol = asString(order['symbol'])
      if (symbol !== undefined) return symbol
    }
    return undefined
  }

  async #spread(symbol: string | undefined): Promise<number> {
    if (symbol === undefined) return Number.POSITIVE_INFINITY
    let ticker: CcxtTickerLike
    try {
      ticker = await this.#exchange.fetchTicker(symbol)
    } catch {
      // 盘口读取失败和缺 bid/ask 等价处理：视为最宽点差，宁可被硬闸拒绝。
      return Number.POSITIVE_INFINITY
    }
    const raw = ticker as Readonly<Record<string, unknown>>
    const info = infoOf(raw)
    const bid =
      firstNumber(raw, ['bid', 'bestBid']) ??
      (info === undefined ? undefined : firstNumber(info, ['bid', 'bestBid']))
    const ask =
      firstNumber(raw, ['ask', 'bestAsk']) ??
      (info === undefined ? undefined : firstNumber(info, ['ask', 'bestAsk']))
    if (bid === undefined || ask === undefined || !(bid > 0) || !(ask >= bid)) {
      // 缺盘口视为最宽点差，宁可被硬闸拒，不把缺数据伪装成零点差。
      return Number.POSITIVE_INFINITY
    }
    const mid = (bid + ask) / 2
    return mid > 0 ? ((ask - bid) / mid) * 10_000 : Number.POSITIVE_INFINITY
  }

  #orderAck(
    value: CcxtOrderLike,
    fallback: { readonly clientOrderId?: string; readonly intentId?: string } | undefined,
    defaultState: OrderState,
  ): OrderAck | undefined {
    const raw = value as Readonly<Record<string, unknown>>
    const clientOrderId = clientOrderIdFrom(raw) ?? fallback?.clientOrderId
    if (clientOrderId === undefined) return undefined
    // 远端 info 是不可信数据，不把其中的任意字段回传为本地 intentId。
    const intentId = fallback?.intentId ?? clientOrderId
    const state = orderState(raw, defaultState)
    const timestamp = firstNumber(raw, ['timestamp', 'lastTradeTimestamp']) ?? this.#clock.now()
    const average = firstNumber(raw, ['average', 'avgPrice'])
    const fee = feeFrom(raw)
    const exchangeOrderId = exchangeOrderIdFrom(raw)
    return {
      intentId,
      clientOrderId,
      state,
      ts: timestamp,
      ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
      ...(average === undefined ? {} : { avgPrice: average }),
      ...(fee === undefined ? {} : { fee }),
    }
  }

  #tradeAck(value: CcxtTradeLike, clientOrderId: string): OrderAck {
    const raw = value as Readonly<Record<string, unknown>>
    const order = raw['order']
    const exchangeOrderId =
      typeof order === 'string' && order.length > 0
        ? order
        : typeof order === 'number' && Number.isFinite(order)
          ? String(order)
          : undefined
    const timestamp = firstNumber(raw, ['timestamp']) ?? this.#clock.now()
    const price = firstNumber(raw, ['price'])
    const fee = feeFrom(raw)
    return {
      intentId: clientOrderId,
      clientOrderId,
      ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
      state: 'filled',
      ts: timestamp,
      ...(price === undefined ? {} : { avgPrice: price }),
      ...(fee === undefined ? {} : { fee }),
    }
  }

  #protectiveClientOrderId(request: ProtectiveRequest): string {
    // ProtectiveRequest 允许省略 id；用请求内容形成稳定键，避免用墙钟生成不可恢复的 id。
    return [
      'protect',
      request.symbol,
      request.stopLossPrice ?? '',
      request.takeProfitPrice ?? '',
      request.trailingPercent ?? '',
      request.trailingTriggerPrice ?? '',
    ].join(':')
  }
}
