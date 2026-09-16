/**
 * 执行组合根：在一个地方组装 broker、归档、计划、journal 与对账。
 *
 * 交易工具只拿到这里产生的同一组端口；这样 paper/live 不会各自绕过硬闸，
 * 对账也不会因为另建一个 journal 而看不到工具刚写入的意图。
 */

import type Database from 'better-sqlite3'
import type { Clock, Disposer } from '../clock.js'
import type { RiskLimits } from '../config.js'
import { Statements } from '../db/statements.js'
import { applyProxyAwareFetch } from '../market/ccxt-source.js'
import { BarArchive } from '../market/archive.js'
import { FeatureArchive } from '../market/feature-archive.js'
import { PlanStore } from '../plan/store.js'
import { CcxtBroker, type CcxtProExchangeLike, type RiskStateProvider } from './ccxt-broker.js'
import type { Broker, Venue } from './broker.js'
import { DecisionJournal } from './journal.js'
import { PaperBroker } from './paper.js'
import { LocalStateReader } from './preflight.js'
import {
  reconcile,
  Reconciler,
  type ReconciliationAction,
  type ReconciliationResult,
  type ReconcilerResult,
} from './reconcile.js'
import type { ExecRuntimeConfig, ExecRuntimeDeps, TradePorts } from './ports.js'

const DAY_MS = 86_400_000
const LIVE_VENUES: readonly Exclude<Venue, 'paper'>[] = ['htx', 'okx']
const LIMIT_KEYS: readonly (keyof RiskLimits)[] = [
  'perOrderCapUsd',
  'maxExposureUsd',
  'maxLeverage',
  'dailyLossLimitUsd',
  'maxDrawdownUsd',
  'maxConsecutiveLosses',
  'maxSpreadBps',
  'maxOpenOrders',
]

export interface ExecReconciliationReport {
  readonly ranAt: number
  readonly acknowledgeOrphans: boolean
  readonly result: ReconciliationResult
  /** 顶层别名便于上层直接消费报告，不必依赖纯函数结果的嵌套位置。 */
  readonly actions: readonly ReconciliationAction[]
  readonly consistent: boolean
  readonly applied: readonly ReconciliationAction[]
  readonly freezeTrading: boolean
}

export interface ExecRuntime {
  readonly broker: Broker
  getPorts(): TradePorts
  reconcileOnce(): Promise<ExecReconciliationReport>
  frozenSymbols(): ReadonlySet<string>
  dispose(): Promise<void>
}

interface RiskOutcomeRow {
  settled_at: number
  realized_net_pct: number
  entry_price: number
  size_qty: number | null
  entry_fill_qty: number | null
}

const RISK_OUTCOME_SQL = [
  'SELECT o.settled_at, o.realized_net_pct, o.entry_price, d.size_qty,',
  '       (SELECT f.qty',
  '        FROM fills f',
  '        JOIN orders ord ON ord.order_id = f.order_id',
  '        JOIN order_intents oi ON oi.client_order_id = ord.client_order_id',
  '        WHERE oi.decision_id = d.decision_id',
  '        ORDER BY f.ts ASC, f.fill_id ASC LIMIT 1) AS entry_fill_qty',
  'FROM outcomes o',
  'JOIN decisions d ON d.decision_id = o.decision_id',
  'WHERE o.settled_at <= ?',
  'ORDER BY o.settled_at ASC, o.outcome_id ASC',
].join('\n')

/**
 * 从已结算 outcome 重建本地风险状态。
 *
 * 口径是「已结算交易级净收益」：realized_net_pct 已包含结算器记录的手续费与
 * 滑点，因此只用 entry_price × 首笔成交数量把百分比换成报价币金额，不能再扣一遍
 * fees_quote。drawdown 是累计已实现收益相对历史峰值的最大回撤；未结算仓位的浮盈亏
 * 不会被伪造进来。没有已结算样本、成交数量或价格缺失时直接抛错，让 CcxtBroker
 * 的 getAccount() fail-closed，而不是用 0 冒充「没有亏损」。
 */
export function createRiskStateProvider(
  db: Database.Database,
  clock: Clock,
  journal?: DecisionJournal,
): RiskStateProvider {
  // 保留 journal 参数是为了让调用方明确这是同一份 journal 的数据源；查询走 Statements
  // 缓存，避免高频 getAccount() 不断 prepare 新语句。
  void journal
  const statements = new Statements(db)

  return () => {
    const rows = statements.get(RISK_OUTCOME_SQL).all(clock.now()) as RiskOutcomeRow[]
    if (rows.length === 0) {
      throw new Error('RiskStateProvider：journal 没有已结算 outcome，无法计算已实现风险状态')
    }

    const pnl: { settledAt: number; usd: number }[] = []
    for (const row of rows) {
      const qty = row.size_qty !== null && Math.abs(row.size_qty) > 0 ? row.size_qty : row.entry_fill_qty
      if (
        qty === null ||
        qty === undefined ||
        !Number.isFinite(qty) ||
        !Number.isFinite(row.entry_price) ||
        row.entry_price <= 0 ||
        !Number.isFinite(row.realized_net_pct)
      ) {
        throw new Error(
          'RiskStateProvider：outcome 在 ' +
            String(row.settled_at) +
            ' 缺少可核验的 entry price/成交数量，拒绝编造 USD PnL',
        )
      }
      const usd = (row.realized_net_pct / 100) * Math.abs(qty) * row.entry_price
      if (!Number.isFinite(usd)) {
        throw new Error('RiskStateProvider：已实现 PnL 不是有限数，拒绝继续执行')
      }
      pnl.push({ settledAt: row.settled_at, usd })
    }

    const now = clock.now()
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS
    const dailyNet = pnl
      .filter((item) => item.settledAt >= dayStart && item.settledAt <= now)
      .reduce((sum, item) => sum + item.usd, 0)

    let cumulative = 0
    let peak = 0
    let drawdownUsd = 0
    for (const item of pnl) {
      cumulative += item.usd
      peak = Math.max(peak, cumulative)
      drawdownUsd = Math.max(drawdownUsd, peak - cumulative)
    }

    let consecutiveLosses = 0
    for (let index = pnl.length - 1; index >= 0; index -= 1) {
      const item = pnl[index]
      if (item === undefined || item.usd >= 0) break
      consecutiveLosses += 1
    }

    return {
      dailyLossUsd: Math.max(0, -dailyNet),
      drawdownUsd,
      consecutiveLosses,
    }
  }
}

function hasCredential(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function finitePositive(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) throw new Error(label + ' 必须是有限正数')
  return value
}

function finiteNonNegative(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0) throw new Error(label + ' 必须是非负有限数')
  return value
}

function limitsFromConfig(config: ExecRuntimeConfig): RiskLimits | null {
  if (config.limits !== undefined) {
    if (config.limits === null) return null
    for (const key of LIMIT_KEYS) {
      const value = config.limits[key]
      if (!Number.isFinite(value) || value <= 0) throw new Error('limits.' + key + ' 必须是有限正数')
    }
    return config.limits
  }

  const values = LIMIT_KEYS.map((key) => config[key])
  const supplied = values.some((value) => value !== undefined)
  if (!supplied) return null
  if (values.some((value) => value === undefined)) {
    throw new Error('风控限额字段不完整：不允许把部分配置静默降级为无风控')
  }
  for (const [index, value] of values.entries()) {
    if (!Number.isFinite(value) || (value as number) <= 0) {
      throw new Error('limits.' + (LIMIT_KEYS[index] ?? 'unknown') + ' 必须是有限正数')
    }
  }
  return {
    perOrderCapUsd: config.perOrderCapUsd as number,
    maxExposureUsd: config.maxExposureUsd as number,
    maxLeverage: config.maxLeverage as number,
    dailyLossLimitUsd: config.dailyLossLimitUsd as number,
    maxDrawdownUsd: config.maxDrawdownUsd as number,
    maxConsecutiveLosses: config.maxConsecutiveLosses as number,
    maxSpreadBps: config.maxSpreadBps as number,
    maxOpenOrders: config.maxOpenOrders as number,
  }
}

function validateConfig(config: ExecRuntimeConfig, limits: RiskLimits | null): void {
  if (!['paper', 'live_confirm', 'live_auto'].includes(config.mode)) {
    throw new Error('mode 非法：' + String(config.mode))
  }
  if (!Number.isFinite(config.riskPct) || config.riskPct < 0) {
    throw new Error('riskPct 必须是非负有限数')
  }
  if (!Array.isArray(config.symbols) || config.symbols.length === 0) throw new Error('symbols 不能为空')
  if (!Array.isArray(config.timeframes) || config.timeframes.length === 0) {
    throw new Error('timeframes 不能为空')
  }
  if (typeof config.benchmark !== 'string' || config.benchmark.trim() === '') {
    throw new Error('benchmark 不能为空')
  }
  if (!Number.isFinite(config.reconcileMs) || config.reconcileMs <= 0) {
    throw new Error('reconcileMs 必须是有限正数')
  }
  if (config.mode !== 'paper') {
    if (!LIVE_VENUES.includes(config.venue as Exclude<Venue, 'paper'>)) {
      throw new Error('实盘 venue 非法：' + String(config.venue) + '（只允许 htx | okx）')
    }
    if (typeof config.accountType !== 'string' || config.accountType.trim() === '') {
      throw new Error('实盘 accountType 必须显式提供')
    }
  }
  finitePositive(config.paperInitialEquityQuote, 'paperInitialEquityQuote')
  finiteNonNegative(config.paperSlippageBps, 'paperSlippageBps')
  finiteNonNegative(config.paperFeeBps, 'paperFeeBps')
}

type ExchangeFactory = NonNullable<ExecRuntimeDeps['createExchange']>

async function defaultCreateExchange(
  venue: Exclude<Venue, 'paper'>,
  options?: Readonly<Record<string, unknown>>,
): Promise<CcxtProExchangeLike> {
  const mod = (await import('ccxt')) as unknown as {
    default?: Record<string, new (options: unknown) => CcxtProExchangeLike>
  }
  const ccxt = mod.default ?? (mod as unknown as Record<string, new (options: unknown) => CcxtProExchangeLike>)
  const Exchange = ccxt[venue]
  if (Exchange === undefined) throw new Error('未知交易所：' + venue)
  return new Exchange(options ?? {})
}

function defaultPriceOf(bars: BarArchive, symbols: readonly string[], timeframes: readonly string[]) {
  return (symbol: string): number | undefined => {
    if (!symbols.includes(symbol)) return undefined
    let newest: { close: number; closeTime: number } | undefined
    for (const timeframe of timeframes) {
      const candle = bars.recentClosedBars(symbol, timeframe, 1).at(-1)
      if (candle !== undefined && (newest === undefined || candle.closeTime > newest.closeTime)) {
        newest = { close: candle.close, closeTime: candle.closeTime }
      }
    }
    return newest?.close
  }
}

type FreezeAction = Extract<
  ReconciliationAction,
  { readonly kind: 'alert_unknown_position' | 'alert_unprotected_position' | 'alert_qty_mismatch' }
>

function isFreezeAction(action: ReconciliationAction): action is FreezeAction {
  return (
    action.kind === 'alert_unknown_position' ||
    action.kind === 'alert_unprotected_position' ||
    action.kind === 'alert_qty_mismatch'
  )
}

export async function createExecRuntime(
  config: ExecRuntimeConfig,
  deps: ExecRuntimeDeps,
): Promise<ExecRuntime> {
  const limits = limitsFromConfig(config)
  validateConfig(config, limits)

  const bars = new BarArchive(deps.db)
  const features = new FeatureArchive(deps.db)
  const plans = new PlanStore(deps.db)
  const journal = new DecisionJournal(deps.db)
  const local = new LocalStateReader(deps.db)
  const riskStateProvider = createRiskStateProvider(deps.db, deps.clock, journal)
  const acknowledgeOrphans = config.liveAckOrphans ?? config.acknowledgeOrphans ?? false

  let broker: Broker
  let exchange: CcxtProExchangeLike | undefined
  let closeExchange: (() => Promise<void>) | undefined

  if (config.mode === 'paper' || !hasCredential(config.apiKey) || !hasCredential(config.apiSecret)) {
    // 缺凭据的 live 配置安全落到 paper，但保留原 mode；gate 会因 venue=paper deny，
    // 所以这个降级不会把「想实盘」误变成可下单的纸面授权。
    const priceOf = deps.priceOf ?? config.priceOf ?? defaultPriceOf(bars, config.symbols, config.timeframes)
    broker = new PaperBroker({
      clock: deps.clock,
      book: { price: priceOf },
      initialEquityQuote: config.paperInitialEquityQuote,
      slippageBps: config.paperSlippageBps,
      feeBps: config.paperFeeBps,
    })
  } else {
    const venue = config.venue as Exclude<Venue, 'paper'>
    const factory: ExchangeFactory = deps.createExchange ?? defaultCreateExchange
    exchange = await factory(venue, { enableRateLimit: true, defaultType: config.accountType })
    applyProxyAwareFetch(exchange)
    broker = new CcxtBroker({
      exchange,
      venue,
      clock: deps.clock,
      apiKey: config.apiKey as string,
      apiSecret: config.apiSecret as string,
      accountType: config.accountType,
      positionSide: config.positionSide ?? 'both',
      spreadSymbol: config.symbols[0],
      sandbox: config.sandbox === true,
      riskStateProvider,
    })
    closeExchange = async () => {
      const closable = exchange as CcxtProExchangeLike & { close?: () => Promise<void> }
      await closable.close?.()
    }
  }

  let unsubscribe: Disposer = () => {}
  try {
    // 即使 v0 ccxt 没有 WS，也保留统一的订阅生命周期；未来换成用户数据流时，
    // dispose 不会遗留一个仍能写入已卸载组合根的回调。
    unsubscribe = broker.subscribeUserData(() => undefined)
  } catch (error) {
    await closeExchange?.()
    throw error
  }

  const ports: TradePorts = {
    db: deps.db,
    bars,
    features,
    plans,
    journal,
    broker,
    clock: deps.clock,
    limits,
    mode: config.mode,
    riskPct: config.riskPct,
    symbols: Object.freeze([...config.symbols]),
    timeframes: Object.freeze([...config.timeframes]),
    benchmark: config.benchmark,
    ...(config.reflectionHorizonMs === undefined ? {} : { reflectionHorizonMs: config.reflectionHorizonMs }),
    ...(config.contextHash === undefined ? {} : { contextHash: config.contextHash }),
    ...(config.pm === undefined ? {} : { pm: config.pm }),
    ...(config.allowPmCommitment === undefined ? {} : { allowPmCommitment: config.allowPmCommitment }),
  }

  const frozen = new Set<string>()
  let disposed = false
  let timer: Disposer | undefined
  let running: Promise<ExecReconciliationReport> | undefined

  const updateFrozen = (actions: readonly ReconciliationAction[]): void => {
    for (const action of actions) if (isFreezeAction(action)) frozen.add(action.symbol)
  }

  const reconcileOperation = async (): Promise<ExecReconciliationReport> => {
    const ranAt = deps.clock.now()
    if (!acknowledgeOrphans) {
      const [remoteOrders, remotePositions] = await Promise.all([broker.getOpenOrders(), broker.getPositions()])
      const result = reconcile({
        localOrders: local.orders(),
        remoteOrders: remoteOrders.map((order) => ({ clientOrderId: order.clientOrderId })),
        localPositions: local.positions(),
        remotePositions: remotePositions.map((position) => ({ symbol: position.symbol, qty: position.qty })),
      })
      updateFrozen(result.actions)
      // 第①步只报告不撤单；仍写入完整审计，方便解释为何没有执行动作。
      journal.appendAudit({
        actor: 'system',
        kind: 'reconcile_report',
        payload: { acknowledgeOrphans, result, applied: [] },
        ts: ranAt,
      })
      return {
        ranAt,
        acknowledgeOrphans: false,
        result,
        actions: result.actions,
        consistent: result.consistent,
        applied: [],
        freezeTrading: result.freezeTrading,
      }
    }

    const reconciler = new Reconciler({
      broker: {
        getOpenOrders: () => broker.getOpenOrders(),
        getPositions: () => broker.getPositions(),
        cancelOrder: (exchangeOrderId) => broker.cancelOrder(exchangeOrderId),
      },
      clock: deps.clock,
      localOrders: () => local.orders(),
      localPositions: () => local.positions(),
      onAlert: (event) => {
        if (isFreezeAction(event.action)) frozen.add(event.action.symbol)
        journal.appendAudit({ actor: 'system', kind: 'reconcile_action', payload: event, ts: event.at })
      },
    })
    const reconcilerResult: ReconcilerResult = await reconciler.runOnce()
    updateFrozen(reconcilerResult.result.actions)
    journal.appendAudit({
      actor: 'system',
      kind: 'reconcile_report',
      payload: { acknowledgeOrphans, result: reconcilerResult.result, applied: reconcilerResult.applied },
      ts: ranAt,
    })
    return {
      ranAt,
      acknowledgeOrphans: true,
      result: reconcilerResult.result,
      actions: reconcilerResult.result.actions,
      consistent: reconcilerResult.result.consistent,
      applied: reconcilerResult.applied,
      freezeTrading: reconcilerResult.freezeTrading,
    }
  }

  const reconcileOnce = (): Promise<ExecReconciliationReport> => {
    if (disposed) return Promise.reject(new Error('ExecRuntime 已 dispose，拒绝再次对账'))
    if (running !== undefined) return running
    const operation = reconcileOperation()
    running = operation
    void operation.then(
      () => {
        if (running === operation) running = undefined
      },
      () => {
        if (running === operation) running = undefined
      },
    )
    return operation
  }

  const onPeriodicError = (error: unknown): void => {
    // 周期任务不能把 rejected Promise 变成未处理异常；错误仍须可审计，且未知状态时
    // 把配置范围全部冻结，避免上层把一次不完整对账当成一致。
    for (const symbol of config.symbols) frozen.add(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'reconcile_failed',
      payload: { error: String(error), freezeSymbols: [...config.symbols] },
      ts: deps.clock.now(),
    })
  }

  try {
    // 启动先对账，再注册周期任务；启动报告失败就不返回看似可用的 runtime。
    await reconcileOnce()
    if (!disposed) timer = deps.clock.setInterval(() => void reconcileOnce().catch(onPeriodicError), config.reconcileMs)
  } catch (error) {
    disposed = true
    timer?.()
    unsubscribe()
    await closeExchange?.()
    throw error
  }

  return {
    broker,
    getPorts: () => ports,
    reconcileOnce,
    frozenSymbols: () => new Set(frozen),
    async dispose() {
      if (disposed) return
      disposed = true
      timer?.()
      timer = undefined
      unsubscribe()
      await closeExchange?.()
    },
  }
}
