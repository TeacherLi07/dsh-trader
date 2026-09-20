/**
 * CCXT Pro 私有交易适配器（plan §4.2 / §6.2 / §6.3 / T2.1）。
 *
 * 这里故意只依赖注入的 exchange 结构，不 import `ccxt`：生产组合根可以动态构造
 * HTX/OKX，测试则用无网络 fake。venue 的差异只通过 options 表达，不能在业务逻辑
 * 里堆 venue 分支；HTX 是生产选择，OKX 负责只读交叉校验与 sandbox。
 */

import type { Clock } from '../clock.js'
import { numericClientOrderId } from '../util/canonical.js'
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

/** 生产执行领域只承认 HTX；ccxt 仍只是 HTX 的签名/HTTP/market metadata 传输层。 */
export type CcxtVenue = 'htx'
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
/** ccxt `markets` 里我们需要的字段；永续的 `amount` 是**张数**，换算必须用 `contractSize`。 */
export interface CcxtMarketLike {
  readonly contractSize?: number
  readonly linear?: boolean
  readonly inverse?: boolean
  readonly swap?: boolean
  readonly precision?: { readonly amount?: number }
  readonly limits?: { readonly amount?: { readonly min?: number } }
}

export interface CcxtProExchangeLike {
  readonly id: string
  readonly has: Readonly<Record<string, unknown>>
  /** `loadMarkets()` 之后由 ccxt 填充；用于 contractSize / precision，缺了就必须 fail-closed。 */
  readonly markets?: Readonly<Record<string, CcxtMarketLike>>
  /** ccxt 的精度助手（把张数对齐到交易所步长）；不存在时退回 precision.amount 向下取整。 */
  amountToPrecision?(symbol: string, amount: number): string
  /** ccxt 允许覆盖 fetch 实现；`applyProxyAwareFetch` 需要它（plan §12 #14）。 */
  fetchImplementation?: unknown
  /**
   * ccxt 的私有端点要求凭据挂在实例上，且字段名是 **`apiKey`/`secret`**
   * （ccxt 的 `requiredCredentials` 里写的就是 `secret`；写成 `apiSecret` 会被判为缺失，
   * 实测报错 `htx requires "secret" credential`）。由 `CcxtBroker` 构造时写入，绝不打印。
   */
  apiKey?: string
  secret?: string
  loadMarkets(): Promise<unknown>
  fetchBalance(params?: CcxtParams): Promise<CcxtBalanceLike>
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
  /**
   * 读余额/持仓的账户类型（ccxt 的 `fetchBalance({ type })`），如 `'spot'` | `'swap'`。
   *
   * ★ 为什么必须显式：HTX 的**现货账户与 USDT 永续账户是分开的**。策略跑 `BTC/USDT:USDT`
   * 永续时，现货账户通常是 0；不指定类型就会读到 0，进而让 sizing 推出 qty=0、
   * `projectedLeverage` 失去意义 —— 系统会"以为没钱"。实测：现货 0，`type:'swap'` 才是真实可用余额。
   * 省略 = 沿用 ccxt 默认（现货）。
   */
  readonly accountType?: string
  /**
   * HTX 线性永续的 `position_side`：`'long'|'short'|'both'`，单向持仓模式用 `'both'`（默认）。
   *
   * ★ 实测：**算法触发单（sl/tp）不带这个字段会被 HTX 直接拒**（code 1067
   * "The position_side field is invalid"），于是保护单永远挂不上 —— 而"有持仓无保护单"是 P0 不一致。
   */
  readonly positionSide?: string
  /** 市价单成交轮询次数/间隔（默认 6×700ms）；测试可设 0 关闭，避免无谓等待。 */
  readonly fillPollAttempts?: number
  readonly fillPollMs?: number
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

function feeCurrencyFrom(value: Readonly<Record<string, unknown>>): string | null | undefined {
  const fee = value['fee']
  if (isRecord(fee)) return asString(fee['currency'])
  const fees = value['fees']
  if (!Array.isArray(fees)) return undefined
  const currencies = [...new Set(fees.flatMap((item) =>
    isRecord(item) ? [asString(item['currency'])].filter((currency): currency is string => currency !== undefined) : [],
  ))]
  return currencies.length === 1 ? currencies[0] : currencies.length > 1 ? null : undefined
}

function tradeOrderId(value: CcxtTradeLike): string | undefined {
  const order = value['order']
  if (typeof order === 'string' && order.length > 0) return order
  if (typeof order === 'number' && Number.isFinite(order)) return String(order)
  return undefined
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

function isProtectionOrder(value: Readonly<Record<string, unknown>>): boolean {
  if (isReduceOnly(value) || stopPriceFrom(value) !== undefined) return true
  const type = asString(value['type'])?.toLowerCase().replaceAll('-', '_') ?? ''
  if (['stop', 'trigger', 'trailing', 'take_profit', 'takeprofit', 'conditional'].some((part) => type.includes(part))) {
    return true
  }
  const info = infoOf(value)
  return info !== undefined && [
    'stopLossPrice', 'stop_loss_price', 'takeProfitPrice', 'take_profit_price',
    'triggerPrice', 'trigger_price', 'trailingPercent', 'callbackRate',
  ].some((key) => valueFromRecordOrInfo(value, [key]) !== undefined)
}

function isKnownEntryOrder(value: Readonly<Record<string, unknown>>): boolean {
  const type = asString(value['type'])?.toLowerCase().replaceAll('-', '_')
  return (type === 'market' || type === 'limit') && !isProtectionOrder(value)
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

function quoteFreeAmount(balance: CcxtBalanceLike, quoteCurrency: string): number | undefined {
  const root = balance as Readonly<Record<string, unknown>>
  const free = root['free']
  if (isRecord(free)) {
    const value = asNumber(free[quoteCurrency])
    if (value !== undefined) return value
  }
  const currency = root[quoteCurrency]
  return isRecord(currency) ? asNumber(currency['free']) : undefined
}

function lookupMiss(error: unknown): boolean {
  if (error instanceof Error && (NOT_FOUND_RE.test(error.name) || NOT_SUPPORTED_RE.test(error.name))) return true
  const message = error instanceof Error ? error.message : String(error)
  return NOT_FOUND_RE.test(message) || NOT_SUPPORTED_RE.test(message)
}

function addParam(params: CcxtParams, key: string, value: number | string | boolean | undefined): void {
  if (value !== undefined) params[key] = value
}

export class HtxBroker implements Broker {
  readonly venue: CcxtVenue
  readonly #exchange: CcxtProExchangeLike
  readonly #clock: Clock
  readonly #apiKey: string
  readonly #apiSecret: string
  readonly #riskStateProvider: RiskStateProvider | undefined
  readonly #quoteCurrency: string
  readonly #spreadSymbol: string | undefined
  readonly #protectiveOrderType: string
  readonly #accountType: string | undefined
  readonly #positionSide: string
  readonly #fillPollAttempts: number
  readonly #fillPollMs: number
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
    this.#accountType = options.accountType
    this.#positionSide = options.positionSide ?? 'both'
    this.#fillPollAttempts = options.fillPollAttempts ?? 6
    this.#fillPollMs = options.fillPollMs ?? 700

    // ★ ccxt 的私有端点（fetchBalance/fetchPositions/createOrder…）要求凭据挂在 **exchange 实例**上，
    // 只传给本 broker 是不够的；而且字段名必须是 ccxt 的 `apiKey`/`secret`（不是 `apiSecret`）。
    // 实测两种错法：不设置 ⇒ `htx requires "apiKey" credential`；只设 apiSecret ⇒ `htx requires "secret" credential`。
    // 值只写入 exchange，不打印、不落库、不进 prompt；错误消息经 #safeError 脱敏。
    options.exchange.apiKey = options.apiKey
    options.exchange.secret = options.apiSecret

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
    const balance = await this.#call(() => this.#exchange.fetchBalance(this.#balanceParams()))
    const positions = await this.#call(() => this.#exchange.fetchPositions())
    // HTX 的保护单在算法端点，普通列表为空并不表示没有挂单；账户计数必须和对账/撤单使用同一合并视图。
    const openOrders = await this.#fetchOpenOrdersMerged()
    const equity = quoteAmount(balance, this.#quoteCurrency)
    if (equity === undefined) {
      throw this.#safeError(new Error(`余额中没有可识别的 ${this.#quoteCurrency} equity`))
    }

    const readings = positions.map((position) => this.#readPosition(position))
    const totalExposureUsd = this.#exposure(readings)
    const pendingExposureUsd = this.#pendingExposure(openOrders)
    const spreadSymbol = this.#spreadSymbol ?? this.#firstSymbol(positions, openOrders)
    const spreadBps = await this.#spread(spreadSymbol)
    const observedAt = this.#clock.now()
    return {
      venue: this.venue,
      equityQuote: equity,
      freeMarginQuote: quoteFreeAmount(balance, this.#quoteCurrency) ?? null,
      totalExposureUsd,
      pendingExposureUsd,
      openOrders: openOrders.length,
      leverage: equity > 0 ? totalExposureUsd / equity : Number.POSITIVE_INFINITY,
      dailyLossUsd: risk.dailyLossUsd,
      drawdownUsd: risk.drawdownUsd,
      consecutiveLosses: risk.consecutiveLosses,
      spreadBps,
      observedAt,
    }
  }

  /**
   * 只读余额（plan §12.2 A 第①步的预检入口）。
   *
   * 与 `getAccount()` 的区别：**不读 `RiskStateProvider`**。只读预检只需要"账户能不能读到、
   * 权益是多少"，而 dailyLoss/drawdown/连亏在只读阶段本来就没有可靠来源。若走 `getAccount()`
   * 就必须为它编一个 RiskState，那正是 T2.1 明令禁止的"填 0 伪装成没有亏损"。
   * 本方法只调 `fetchBalance`，绝不用于下单。
   */
  async readOnlyBalance(): Promise<number> {
    await this.#ensureMarketsLoaded()
    const balance = await this.#call(() => this.#exchange.fetchBalance(this.#balanceParams()))
    const equity = quoteAmount(balance, this.#quoteCurrency)
    if (equity === undefined) {
      throw this.#safeError(new Error(`余额中没有可识别的 ${this.#quoteCurrency} equity`))
    }
    return equity
  }

  async getPositions(): Promise<readonly PositionSnapshot[]> {
    await this.#ensureMarketsLoaded()
    const [positions, openOrders] = await Promise.all([
      this.#call(() => this.#exchange.fetchPositions()),
      this.#fetchOpenOrdersMerged(),
    ])
    const observedAt = this.#clock.now()
    const stops = new Map<string, number>()
    for (const order of openOrders) {
      if (!isProtectionOrder(order)) continue
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
        observedAt,
        ...(stop === undefined ? {} : { protectedStopPrice: stop }),
      })
    }
    return out
  }

  async getOpenOrders(symbol?: string): Promise<readonly OrderAck[]> {
    await this.#ensureMarketsLoaded()
    const orders = await this.#fetchOpenOrdersMerged(symbol)
    const observedAt = this.#clock.now()
    const acks: OrderAck[] = []
    for (const order of orders) {
      if (symbol !== undefined && order['symbol'] !== symbol) continue
      const ack = this.#orderAck(order, undefined, 'acked')
      if (ack !== undefined) acks.push({ ...ack, symbol: asString(order['symbol']), observedAt })
      else {
        const exchangeOrderId = exchangeOrderIdFrom(order)
        // HTX 算法单常不回显 client id；exchangeOrderId 是对账主键，使用它作为
        // 仅用于展示/孤儿检测的占位 client id，绝不拿它去做本地意图匹配。
        if (exchangeOrderId !== undefined) {
          const synthetic = this.#orderAck(order, { clientOrderId: exchangeOrderId }, 'acked')
          if (synthetic !== undefined) acks.push({ ...synthetic, symbol: asString(order['symbol']), observedAt })
        }
      }
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
    if (request.expectedPositionQty !== undefined &&
        (!Number.isFinite(request.expectedPositionQty) || request.expectedPositionQty === 0 ||
         Math.sign(position.snapshot.qty) !== Math.sign(request.expectedPositionQty) ||
         Math.abs(position.snapshot.qty) + 1e-12 < Math.abs(request.expectedPositionQty))) {
      throw this.#safeError(new Error(`placeProtective：${request.symbol} 实际持仓小于已确认成交暴露`))
    }

    const params: CcxtParams = { clientOrderId, reduceOnly: true }
    // HTX 线性永续的算法触发单必须显式带 position_side（实测 code 1067）。
    params['position_side'] = this.#positionSide
    addParam(params, 'stopLossPrice', request.stopLossPrice)
    addParam(params, 'takeProfitPrice', request.takeProfitPrice)
    addParam(params, 'trailingPercent', request.trailingPercent)
    addParam(params, 'trailingTriggerPrice', request.trailingTriggerPrice)

    const side: OrderSide = position.snapshot.qty > 0 ? 'sell' : 'buy'
    const protectiveAmount = this.#toContracts(request.symbol, Math.abs(position.snapshot.qty))
    const created = await this.#call(() =>
      this.#exchange.createOrder(
        request.symbol,
        this.#protectiveOrderType,
        side,
        protectiveAmount,
        undefined,
        params,
      ),
    )
    return this.#requirePlacedAck(created, { clientOrderId, intentId: clientOrderId, symbol: request.symbol })
  }

  async cancelOrder(exchangeOrderId: string): Promise<void> {
    await this.#ensureMarketsLoaded()
    // 公共 Broker 契约只有 exchangeOrderId。先从交易所返回的真实订单解析 symbol；解析失败时传 undefined，
    // 让交易所自行按订单号定位或明确报错，不能把 spreadSymbol 当成未知订单的假 symbol。
    const symbol = await this.#resolveCancelSymbol(exchangeOrderId)
    await this.#cancelOrder(exchangeOrderId, symbol)
  }

  async #cancelOrder(exchangeOrderId: string, symbol: string | undefined): Promise<void> {
    // ★ HTX 的**算法单（sl/tp/trigger/trailing）**在普通撤单端点查不到（实测 `not.found`），
    // 必须带对应标志走 `v5/algo/cancel_orders`。逐个尝试，全 miss 才报错。
    const attempts: readonly CcxtParams[] = [
      {},
      { stopLossTakeProfit: true },
      { trigger: true },
      { trailing: true },
    ]
    let lastError: unknown
    let canceled = false
    for (const params of attempts) {
      try {
        await this.#exchange.cancelOrder(exchangeOrderId, symbol, params)
        canceled = true
        break
      } catch (error) {
        lastError = error
        if (!lookupMiss(error)) throw this.#safeError(error)
      }
    }
    if (canceled) {
      // 交易所撤单响应与查询通常是最终一致的；留出短暂窗口再复核，避免无等待查询造成假失败。
      if (await this.#orderStillOpenAfterCancel(exchangeOrderId)) {
        throw this.#safeError(new Error(`撤单成功响应后仍发现挂单 ${exchangeOrderId}`))
      }
      return
    }
    if (lastError === undefined) return
    // 全部尝试都"查不到"：说明这个 id 不属于本账户/本 venue，必须报错而不是静默成功。
    throw this.#safeError(lastError)
  }

  async cancelAll(symbol?: string, options: { readonly includeProtection?: boolean } = {}): Promise<void> {
    await this.#ensureMarketsLoaded()
    const orders = await this.#fetchOpenOrdersMerged(symbol)
    if (options.includeProtection === true) {
      if (orders.some((order) => !isProtectionOrder(order))) {
        throw this.#safeError(new Error('仍有未撤普通/未知挂单；为避免裸仓而拒绝撤保护单'))
      }
      const positions = await this.#call(() => this.#exchange.fetchPositions())
      const openPosition = positions
        .map((position) => this.#readPosition(position))
        .some((position) => position !== undefined && position.snapshot.qty !== 0 &&
          (symbol === undefined || position.snapshot.symbol === symbol))
      if (openPosition) {
        throw this.#safeError(new Error('拒绝在仍有持仓时撤销保护单'))
      }
    }
    for (const order of orders) {
      if (options.includeProtection !== true) {
        if (isProtectionOrder(order)) continue
        if (!isKnownEntryOrder(order)) {
          throw this.#safeError(new Error('挂单类型不可识别；为保留可能的保护单而拒绝 cancelAll'))
        }
      }
      const exchangeOrderId = exchangeOrderIdFrom(order)
      if (exchangeOrderId === undefined) {
        throw this.#safeError(new Error('挂单缺少 exchange order id，无法安全执行 cancelAll'))
      }
      const orderSymbol = asString(order['symbol'])
      if (orderSymbol === undefined) {
        // 即使调用方传了 symbol，也不能把查询参数冒充成订单字段；未知标的撤单可能误伤另一市场。
        throw this.#safeError(new Error(`挂单 ${exchangeOrderId} 缺少 symbol，无法安全执行 cancelAll`))
      }
      if (options.includeProtection === true) {
        // 撤单过程可能恰好有最后一笔部分成交；每撤一张保护单前都复核没有新增 entry 单和仓位。
        const remainingOrders = await this.#fetchOpenOrdersMerged(symbol)
        if (remainingOrders.some((candidate) => !isProtectionOrder(candidate))) {
          throw this.#safeError(new Error('撤保护前发现新增普通/未知挂单，拒绝继续'))
        }
        const currentPositions = await this.#call(() => this.#exchange.fetchPositions())
        const currentOpenPosition = currentPositions
          .map((candidate) => this.#readPosition(candidate))
          .some((candidate) => candidate !== undefined && candidate.snapshot.qty !== 0 &&
            (symbol === undefined || candidate.snapshot.symbol === symbol))
        if (currentOpenPosition) {
          throw this.#safeError(new Error('撤保护前发现持仓，拒绝继续'))
        }
      }
      await this.#cancelOrder(exchangeOrderId, orderSymbol)
    }
  }

  async #resolveCancelSymbol(exchangeOrderId: string): Promise<string | undefined> {
    if (this.#can('fetchOpenOrders')) {
      const orders = await this.#fetchOpenOrdersMerged()
      const matching = orders.find((order) => exchangeOrderIdFrom(order) === exchangeOrderId)
      const symbol = matching === undefined ? undefined : asString(matching['symbol'])
      if (symbol !== undefined) return symbol
    }

    // 某些交易所允许按 id 直接查询，且查询结果带真实 symbol；不带 symbol 试探失败时继续走无 symbol 的撤单，
    // 不能回退到 spreadSymbol。ArgumentsRequired/未找到只代表无法解析，不应遮掉后续安全撤单策略。
    if (this.#can('fetchOrder')) {
      try {
        const order = await this.#exchange.fetchOrder(exchangeOrderId)
        if (order !== undefined && exchangeOrderIdFrom(order) === exchangeOrderId) {
          return asString(order['symbol'])
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!lookupMiss(error) && !/argument|required|symbol/i.test(message)) {
          throw this.#safeError(error)
        }
      }
    }
    return undefined
  }

  async #orderStillOpen(exchangeOrderId: string): Promise<boolean> {
    if (!this.#can('fetchOpenOrders')) return false
    const orders = await this.#fetchOpenOrdersMerged()
    return orders.some((order) => exchangeOrderIdFrom(order) === exchangeOrderId)
  }

  async #orderStillOpenAfterCancel(exchangeOrderId: string): Promise<boolean> {
    // HTX 算法端点存在短暂最终一致性；固定、有界重试足够覆盖常见延迟，又不会让撤单无限等待。
    for (const delayMs of [25, 100, 250]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (!(await this.#orderStillOpen(exchangeOrderId))) return false
    }
    return true
  }

  subscribeUserData(_onEvent: (event: UserDataEvent) => void): () => void {
    // 免费 ccxt 没有稳定的用户数据流；v0 用轮询对账，避免假装实时而丢成交回报。
    return () => {
      /* v0 无 WS 用户数据订阅 */
    }
  }

  async findOrderByClientOrderId(clientOrderId: string, symbol?: string): Promise<OrderAck | undefined> {
    await this.#ensureMarketsLoaded()
    const marketSymbol = symbol ?? this.#spreadSymbol

    if (this.#can('fetchOrder')) {
      // ★ HTX 线性永续：**普通单与算法单（sl/tp/trigger/trailing）在不同端点**，而且普通单查询
      // **必须带 symbol**（否则 ccxt 抛 ArgumentsRequired）。旧实现传 undefined + 不带 algo 标志，
      // 两条路都查不到 —— 实测开仓成交后 `findOrderByClientOrderId` 返回 undefined。
      // 顺序：先普通单，再逐个算法类型；查不到不猜。
      const attempts: readonly { readonly params: CcxtParams; readonly algo: boolean }[] = [
        { params: { clientOrderId }, algo: false },
        { params: { clientOrderId, stopLoss: true }, algo: true },
        { params: { clientOrderId, takeProfit: true }, algo: true },
        { params: { clientOrderId, trigger: true }, algo: true },
        { params: { clientOrderId, trailing: true }, algo: true },
        { params: { clientOrderId, stopLossTakeProfit: true }, algo: true },
      ]
      for (const attempt of attempts) {
        // 普通单没有 symbol 就无法查询（ccxt 会抛）；算法单不强制，但也尽量带上。
        if (!attempt.algo && marketSymbol === undefined) continue
        try {
          const order = await this.#exchange.fetchOrder(clientOrderId, marketSymbol, attempt.params)
          if (order !== undefined && clientOrderIdFrom(order) === clientOrderId) {
            return this.#orderAck(order, { clientOrderId, ...(marketSymbol === undefined ? {} : { symbol: marketSymbol }) }, 'acked')
          }
        } catch (error) {
          if (!lookupMiss(error)) throw this.#safeError(error)
        }
      }
    }

    if (this.#can('fetchOpenOrders')) {
      try {
        const orders = await this.#exchange.fetchOpenOrders()
        for (const order of orders) {
          if (clientOrderIdFrom(order) === clientOrderId) {
            return this.#orderAck(order, { clientOrderId, ...(marketSymbol === undefined ? {} : { symbol: marketSymbol }) }, 'acked')
          }
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

  async findOrderByExchangeOrderId(exchangeOrderId: string, symbol?: string): Promise<OrderAck | undefined> {
    await this.#ensureMarketsLoaded()
    if (!this.#can('fetchOrder')) return undefined
    try {
      const order = await this.#exchange.fetchOrder(exchangeOrderId, symbol)
      if (order === undefined || exchangeOrderIdFrom(order) !== exchangeOrderId) return undefined
      const ack = this.#orderAck(order, { clientOrderId: exchangeOrderId, symbol }, 'acked')
      if (ack === undefined || ack.fee !== undefined || ack.filledQty === undefined || ack.filledQty <= 0 ||
          !['filled', 'canceled', 'rejected'].includes(ack.state) || symbol === undefined || !this.#can('fetchMyTrades')) {
        return ack
      }
      // CCXT 的 order 响应可能没有 fee；成交明细才带逐笔费用。只聚合同一 exchange order，
      // 且所有成交费用都必须可读、计价币必须一致，否则保留 null 并让结算继续 deferred。
      let trades: readonly CcxtTradeLike[]
      try {
        trades = await this.#call(() => this.#exchange.fetchMyTrades(symbol))
      } catch {
        // 成交状态已由订单端点确认；费用查询失败只延迟结算，不能把已知订单降成未知。
        return ack
      }
      const matched = trades.filter((trade) => tradeOrderId(trade) === exchangeOrderId)
      if (matched.length === 0) return ack
      const costs = matched.map((trade) => feeFrom(trade as Readonly<Record<string, unknown>>))
      const currencies = matched.map((trade) => feeCurrencyFrom(trade as Readonly<Record<string, unknown>>))
      if (costs.some((cost) => cost === undefined || !Number.isFinite(cost) || cost < 0) ||
          currencies.some((currency) => currency !== this.#quoteCurrency)) return ack
      const fee = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
      return Number.isFinite(fee) ? { ...ack, fee } : ack
    } catch (error) {
      if (lookupMiss(error)) return undefined
      throw this.#safeError(error)
    }
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

    const amount = this.#toContracts(request.symbol, request.qty)
    const created = await this.#call(() =>
      this.#exchange.createOrder(request.symbol, request.type, request.side, amount, request.price, params),
    )
    const ack = this.#requirePlacedAck(
      created,
      { clientOrderId: request.clientOrderId, intentId: request.intentId, symbol: request.symbol },
    )
    // ★ HTX 市价单的 create 响应常是 open/new，成交要再查一次。不回填的后果不是"显示问题"：
    // execute-action 只在 `state==='filled'` 时记 fill / 登记结算 / 挂保护单 —— 于是一笔真实成交
    // 会被当成"没成交"，既没有保护单也没有结算（实测冒烟第一步就撞到）。
    if (request.type === 'market' && ack.state !== 'filled' && ack.exchangeOrderId !== undefined) {
      return this.#awaitFill(request.symbol, ack)
    }
    return ack
  }

  /** 轮询确认市价单成交（有界）；查不到就返回原 ack，绝不编造 avgPrice。 */
  async #awaitFill(symbol: string, ack: OrderAck): Promise<OrderAck> {
    if (!this.#can('fetchOrder') || ack.exchangeOrderId === undefined) return ack
    let current = ack
    for (let attempt = 0; attempt < this.#fillPollAttempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, this.#fillPollMs))
      try {
        const order = await this.#call(() =>
          this.#exchange.fetchOrder(ack.exchangeOrderId as string, symbol),
        )
        if (order === undefined) continue
        const refreshed = this.#orderAck(
          order,
          { clientOrderId: ack.clientOrderId, intentId: ack.intentId, symbol },
          'acked',
        )
        if (refreshed !== undefined) {
          current = refreshed
          if (refreshed.state === 'filled' || refreshed.state === 'rejected' || refreshed.state === 'canceled') {
            return refreshed
          }
        }
      } catch {
        // 单次查询失败继续轮询；到点仍未确认则返回原 ack（由恢复流程兜底）
      }
    }
    return current
  }

  #requirePlacedAck(
    value: CcxtOrderLike,
    fallback: { readonly clientOrderId: string; readonly intentId: string; readonly symbol: string },
  ): OrderAck {
    const ack = this.#orderAck(value, fallback, 'acked')
    if (ack === undefined || ack.state === 'unknown' || ack.state === 'created') {
      // createOrder 已返回但状态不可解释，仍属于不确定结果；交给恢复查询，绝不能伪装成 acked。
      throw this.#safeError(new Error('交易所返回了无法确认的订单状态'))
    }
    return ack
  }

  /**
   * `fetchBalance` 的账户类型参数。HTX 现货/永续账户分离，不指定就会读到另一个账户的 0。
   * 只影响**读取**；下单走 symbol 对应的市场，不受这个参数影响。
   */
  /**
   * 合并"普通挂单 + 算法挂单"。
   *
   * ★ HTX 把 sl/tp/trigger/trailing 放在 `/v5/algo/*`，普通 `fetchOpenOrders()` **看不到它们**。
   * 不合并的后果："有持仓但无保护单"会被误判成 P0 不一致，或反过来把真实的保护单当不存在。
   * 非 HTX venue 只取普通挂单（其它 venue 的算法单语义不同，不能照搬）。
   */
  async #fetchOpenOrdersMerged(symbol?: string): Promise<readonly CcxtOrderLike[]> {
    const collected: CcxtOrderLike[] = []
    const seenIds = new Set<string>()
    const seenClientIds = new Set<string>()
    const seenAnonymous = new Set<string>()
    const push = (orders: readonly CcxtOrderLike[]): void => {
      for (const order of orders) {
        const exchangeOrderId = exchangeOrderIdFrom(order)
        const clientOrderId = clientOrderIdFrom(order)
        // 同一订单可能同时出现在普通端点和算法端点；优先用任一稳定 id 去重，
        // 不能只看 exchange id，否则某端点只回 client id 时会把同一张单计两次。
        const anonymous = exchangeOrderId === undefined && clientOrderId === undefined
          ? JSON.stringify(order).slice(0, 60)
          : undefined
        if (
          (exchangeOrderId !== undefined && seenIds.has(exchangeOrderId)) ||
          (clientOrderId !== undefined && seenClientIds.has(clientOrderId)) ||
          (anonymous !== undefined && seenAnonymous.has(anonymous))
        ) continue
        if (exchangeOrderId !== undefined) seenIds.add(exchangeOrderId)
        if (clientOrderId !== undefined) seenClientIds.add(clientOrderId)
        if (anonymous !== undefined) seenAnonymous.add(anonymous)
        collected.push(order)
      }
    }
    push(await this.#call(() => this.#exchange.fetchOpenOrders(symbol)))
    // HTX 的普通挂单端点看不到算法单；五种标志都走同一 merged 视图。
    for (const flag of ['stopLossTakeProfit', 'stopLoss', 'takeProfit', 'trigger', 'trailing'] as const) {
      try {
        const algo = await this.#exchange.fetchOpenOrders(symbol, undefined, undefined, { [flag]: true })
        if (Array.isArray(algo)) push(algo)
      } catch (error) {
        if (!lookupMiss(error)) throw this.#safeError(error)
      }
    }
    return collected
  }

  #balanceParams(): CcxtParams {
    return this.#accountType === undefined ? {} : { type: this.#accountType }
  }

  #market(symbol: string): CcxtMarketLike | undefined {
    return this.#exchange.markets?.[symbol]
  }

  /** 永续：一张 = `contractSize` 个基础币；现货为 1。缺元数据时按 1（fail-closed 由 assertLinear/精度兜底）。 */
  #contractSize(symbol: string): number {
    const size = this.#market(symbol)?.contractSize
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : 1
  }

  /**
   * 只支持**线性**（USDT 本位）永续。inverse 的 contractSize 以计价币计，`张数×contractSize`
   * 不是币数，换算会错一个价格因子 —— 宁可拒绝，也不静默把仓位下错。
   */
  #assertLinear(symbol: string): void {
    const market = this.#market(symbol)
    if (market?.inverse === true) {
      throw this.#safeError(new Error(`${symbol} 是 inverse 合约：本 broker 只支持 linear，拒绝按错误口径换算`))
    }
  }

  /**
   * 基础币数量 → ccxt 的 `amount`（永续是**张数**）。这是实盘最容易错、也最致命的一步：
   * 差一个 contractSize 就是几十倍的仓位。优先用 ccxt 的 `amountToPrecision` 对齐交易所步长，
   * 缺失时按 `precision.amount` 向下取整；结果 ≤ 0 说明不足一张最小单，必须拒绝。
   */
  #toContracts(symbol: string, baseQty: number): number {
    this.#assertLinear(symbol)
    const raw = baseQty / this.#contractSize(symbol)
    const toPrecision = this.#exchange.amountToPrecision?.bind(this.#exchange)
    let amount = Number.NaN
    if (toPrecision !== undefined) {
      amount = Number(toPrecision(symbol, raw))
    } else {
      const step = this.#market(symbol)?.precision?.amount
      amount = typeof step === 'number' && step > 0 ? Math.floor(raw / step) * step : Math.floor(raw)
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw this.#safeError(
        new Error(
          `${symbol} 的下单量不足一张最小合约（base=${baseQty}，contractSize=${this.#contractSize(symbol)}）`,
        ),
      )
    }
    return amount
  }

  /** ccxt 永续回报量是张数；Broker/Journal 的统一数量单位是基础币。 */
  #toBaseQty(symbol: string, contracts: number): number {
    this.#assertLinear(symbol)
    return contracts * this.#contractSize(symbol)
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
      let lastError: unknown
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await this.#exchange.loadMarkets()
          this.#marketsLoaded = true
          return
        } catch (error) {
          lastError = error
        }
      }
      throw this.#safeError(lastError)
    })()
    this.#marketsLoading.finally(() => {
      this.#marketsLoading = undefined
    }).catch(() => undefined)
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
    const contracts = positionQty(raw)
    if (symbol === undefined || contracts === undefined) return undefined
    // ★ 仓位数量统一换算成**基础币**：ccxt 永续的 `contracts` 是张数，乘 contractSize 才是币数。
    // 不换算会让敞口/持仓数量差一个 contractSize（BTC 差 1000×、ADA 差 10×），硬闸算术随之全错。
    this.#assertLinear(symbol)
    const qty = contracts * this.#contractSize(symbol)

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

  /** 对所有可能增加仓位的未成交订单预留最大可识别名义；缺关键字段时返回 null。 */
  #pendingExposure(orders: readonly CcxtOrderLike[]): number | null {
    let total = 0
    for (const order of orders) {
      if (isProtectionOrder(order)) continue
      const symbol = asString(order['symbol'])
      const amount = firstNumber(order, ['amount', 'qty', 'contracts', 'volume'])
      const filled = firstNumber(order, ['filled', 'filledQty', 'filled_qty']) ?? 0
      const remaining = firstNumber(order, ['remaining']) ??
        (amount === undefined ? undefined : Math.max(0, amount - filled))
      if (remaining === undefined) return null
      if (!Number.isFinite(remaining) || remaining < 0) return null
      if (remaining === 0) continue
      const price = firstNumber(order, ['price'])
      const type = asString(order['type'])?.toLowerCase()
      // 只把明确的 limit price 当作剩余量上界。市价单的 price/average 可能是已成交均价，
      // 不能约束未成交余量的滑点；ccxt cost 也通常只表示已成交部分成本。
      if (type !== 'limit' || symbol === undefined || price === undefined || price <= 0) return null
      total += remaining * this.#contractSize(symbol) * price
    }
    return Number.isFinite(total) && total >= 0 ? total : null
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
    fallback: { readonly clientOrderId?: string; readonly intentId?: string; readonly symbol?: string } | undefined,
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
    const filledContracts = firstNumber(raw, ['filled', 'filledQty', 'filled_qty'])
    const rawFee = feeFrom(raw)
    const feeCurrency = feeCurrencyFrom(raw)
    const fee = feeCurrency === null || (feeCurrency !== undefined && feeCurrency !== this.#quoteCurrency)
      ? undefined
      : rawFee
    const exchangeOrderId = exchangeOrderIdFrom(raw)
    const symbol = asString(raw['symbol']) ?? fallback?.symbol
    const filled = filledContracts === undefined || symbol === undefined
      ? filledContracts
      : this.#toBaseQty(symbol, filledContracts)
    return {
      intentId,
      clientOrderId,
      ...(symbol === undefined ? {} : { symbol }),
      ...(asString(raw['symbol']) === undefined ? {} : { symbol: asString(raw['symbol']) }),
      state,
      ts: timestamp,
      ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
      ...(average === undefined ? {} : { avgPrice: average }),
      ...(filled === undefined ? {} : { filledQty: filled }),
      ...(fee === undefined ? {} : { fee }),
    }
  }

  #tradeAck(value: CcxtTradeLike, clientOrderId: string): OrderAck {
    const raw = value as Readonly<Record<string, unknown>>
    const symbol = asString(raw['symbol'])
    const order = raw['order']
    const exchangeOrderId =
      typeof order === 'string' && order.length > 0
        ? order
        : typeof order === 'number' && Number.isFinite(order)
          ? String(order)
          : undefined
    const timestamp = firstNumber(raw, ['timestamp']) ?? this.#clock.now()
    const price = firstNumber(raw, ['price'])
    const filledContracts = firstNumber(raw, ['amount', 'filled', 'qty'])
    const filled = filledContracts === undefined || symbol === undefined
      ? filledContracts
      : this.#toBaseQty(symbol, filledContracts)
    const rawFee = feeFrom(raw)
    const feeCurrency = feeCurrencyFrom(raw)
    const fee = feeCurrency === null || (feeCurrency !== undefined && feeCurrency !== this.#quoteCurrency)
      ? undefined
      : rawFee
    return {
      intentId: clientOrderId,
      clientOrderId,
      ...(symbol === undefined ? {} : { symbol }),
      ...(exchangeOrderId === undefined ? {} : { exchangeOrderId }),
      state: 'filled',
      ts: timestamp,
      ...(price === undefined ? {} : { avgPrice: price }),
      ...(filled === undefined ? {} : { filledQty: filled }),
      ...(fee === undefined ? {} : { fee }),
    }
  }

  #protectiveClientOrderId(request: ProtectiveRequest): string {
    // ProtectiveRequest 允许省略 id；用请求内容形成稳定键，避免用墙钟生成不可恢复的 id。
    // 但交易所只认**数字** id（实测 HTX/ccxt 会静默丢弃非数字 id），所以这里也走 numeric。
    return numericClientOrderId(
      [
        'protect',
        request.symbol,
        request.stopLossPrice ?? '',
        request.takeProfitPrice ?? '',
        request.trailingPercent ?? '',
        request.trailingTriggerPrice ?? '',
      ].join(':'),
    )
  }
}

/** 旧测试/内部导入名只作为类型别名保留；生产组合根实例化 HtxBroker。 */
export { HtxBroker as CcxtBroker }
