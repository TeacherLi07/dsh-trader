/**
 * 交易所/经纪层契约（plan.md §8.2、§6.2）。
 *
 * 同一份代码跑 paper / 测试网 / 实盘：回测、模拟、实盘共用**同一份** `gate.ts`
 * 与 `Broker` 接口，避免"回测能跑、实盘不能跑"。
 */

/** 生产执行只允许 HTX；paper 仅用于回放/本地撮合。OKX 不再是生产 Broker。 */
export type Venue = 'paper' | 'htx'

export type OrderSide = 'buy' | 'sell'
export type OrderType = 'market' | 'limit'

export type OrderState = 'created' | 'acked' | 'rejected' | 'unknown' | 'canceled' | 'filled'

/** 交易前从交易所**重取**的实时状态（plan §5.4：上下文里的数字只用于理解，不用于计算）。 */
export interface AccountSnapshot {
  readonly venue: Venue
  readonly equityQuote: number
  readonly totalExposureUsd: number
  readonly openOrders: number
  readonly leverage: number
  readonly dailyLossUsd: number
  readonly drawdownUsd: number
  readonly consecutiveLosses: number
  readonly spreadBps: number
  readonly observedAt: number
}

export interface PositionSnapshot {
  readonly symbol: string
  readonly qty: number
  readonly avgPrice: number
  readonly unrealizedPnlUsd: number
  /** 交易所侧已挂的保护性止损；缺失 = "有持仓无保护单"，P0 对账不一致（plan §6.3）。 */
  readonly protectedStopPrice?: number
}

export interface OrderRequest {
  readonly intentId: string
  /** 幂等键；同一 (planId, intentSeq) 重复提交不会重复成交。 */
  readonly clientOrderId: string
  readonly decisionId: string
  readonly symbol: string
  readonly type: OrderType
  readonly side: OrderSide
  readonly qty: number
  /** 限价单价格；市价单可省略。 */
  readonly price?: number
  /**
   * 由调用方在下单前**重取盘口**估算的名义金额（USD）。
   * 硬闸不自己猜价格，避免用陈旧上下文做风控算术。
   */
  readonly notionalUsd: number
  readonly stopLossPrice?: number
  readonly takeProfitPrice?: number
  readonly trailingPercent?: number
  readonly reduceOnly?: boolean
}

export interface OrderAck {
  readonly intentId: string
  readonly clientOrderId: string
  readonly exchangeOrderId?: string
  readonly state: OrderState
  readonly ts: number
  /**
   * 实际成交均价（成交后由 broker 回填）。
   * 结算必须用它，而不是"信号 bar 的收盘价" —— 否则滑点从未进入账本（plan §5.3）。
   */
  readonly avgPrice?: number
  /** 部分成交时的真实成交数量；缺失不允许把请求量当成成交量。 */
  readonly filledQty?: number
  /** 本单实际支付的手续费（计价货币金额）。缺省表示 broker 未提供。 */
  readonly fee?: number
}

export interface ProtectiveRequest {
  readonly symbol: string
  /** 幂等键；由调用方给出后 broker 必须原样使用，保证审计链与恢复对得上。 */
  readonly clientOrderId?: string
  readonly stopLossPrice?: number
  readonly takeProfitPrice?: number
  readonly trailingPercent?: number
  readonly trailingTriggerPrice?: number
}

export interface UserDataEvent {
  readonly kind: 'order' | 'fill' | 'position'
  readonly symbol: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly ts: number
}

export interface Broker {
  readonly venue: Venue
  /** 每次调用都必须真的打交易所（或 paper 撮合），不得返回缓存上下文。 */
  getAccount(): Promise<AccountSnapshot>
  getPositions(): Promise<readonly PositionSnapshot[]>
  getOpenOrders(symbol?: string): Promise<readonly OrderAck[]>
  /** HTX 不支持原子括号单 ⇒ 入场与保护单分两步，中间存在"已成交但未受保护"的窗口。 */
  placeOrder(request: OrderRequest): Promise<OrderAck>
  placeProtective(request: ProtectiveRequest): Promise<OrderAck>
  /** 按 HTX 返回的交易所订单号查询，恢复/成交轮询不得依赖 clientOrderId 回显。 */
  findOrderByExchangeOrderId?(exchangeOrderId: string, symbol?: string): Promise<OrderAck | undefined>
  /** 兼容仅能按 client id 查询的 paper/sim 适配器；生产 HTX 优先使用 exchange id。 */
  findOrderByClientOrderId?(clientOrderId: string, symbol?: string): Promise<OrderAck | undefined>
  cancelOrder(exchangeOrderId: string): Promise<void>
  cancelAll(symbol?: string): Promise<void>
  subscribeUserData(onEvent: (event: UserDataEvent) => void): () => void
}
