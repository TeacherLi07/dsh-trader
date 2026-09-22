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
import { HtxBroker, type CcxtProExchangeLike, type RiskStateProvider } from './ccxt-broker.js'
import type { Broker, OrderAck, PositionSnapshot, Venue } from './broker.js'
import { DecisionJournal } from './journal.js'
import { StartupTracker } from './startup.js'
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
import { CrashRecovery, type ClientOrderLookup } from './recovery.js'
import { SettlementScheduler } from '../memory/settle.js'
import { HeartbeatStore } from '../supervisor/heartbeat.js'
import { decisionContextConfig } from '../agents/context-config.js'
import { protectPositionOrClose, protectionClientOrderId } from './protection.js'
import { withExposureLock } from './exposure-lock.js'
import { canonicalJson } from '../util/canonical.js'

const DAY_MS = 86_400_000
const LIVE_VENUES: readonly Exclude<Venue, 'paper'>[] = ['htx']
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

/** paper 是缺省；live_auto 必须显式 arm，不能因旧模式名或遗漏配置悄悄进入执行 runtime。 */
export function assertExecRuntimeMode(mode: ExecRuntimeConfig['mode'], liveArmed?: boolean): void {
  if (mode !== 'paper' && mode !== 'live_auto') throw new Error(`mode 非法：${String(mode)}`)
  if (mode === 'live_auto' && liveArmed !== true) {
    throw new Error('live_auto 需要显式 liveArmed=true；未 arm 时拒绝创建执行 runtime')
  }
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
  'WHERE o.settled_at <= ? AND EXISTS (SELECT 1 FROM order_intents ri WHERE ri.decision_id = d.decision_id AND (? = \'*\' OR ri.venue = ?))',
  'ORDER BY o.settled_at ASC, o.outcome_id ASC',
].join('\n')

/**
 * 从已结算 outcome 重建本地风险状态。
 *
 * 口径是「已结算交易级净收益」：realized_net_pct 已包含结算器记录的手续费与
 * 滑点，因此只用 entry_price × 首笔成交数量把百分比换成报价币金额，不能再扣一遍
 * fees_quote。drawdown 是累计已实现收益相对历史峰值的最大回撤；未结算仓位的浮盈亏
 * 不会被伪造进来。没有已结算样本时从经过审计的空账本基线启动；异常数据让 HtxBroker
 * 的 getAccount() fail-closed，而不是用 0 冒充「没有亏损」。
 */
export function createRiskStateProvider(
  db: Database.Database,
  clock: Clock,
  journal?: DecisionJournal,
  options: { readonly venue?: string } = {},
): RiskStateProvider {
  // 保留 journal 参数是为了让调用方明确这是同一份 journal 的数据源；查询走 Statements
  // 缓存，避免高频 getAccount() 不断 prepare 新语句。
  void journal
  const statements = new Statements(db)
  let emptyAudited = false

  return () => {
    const venueFilter = options.venue ?? '*'
    const rows = statements.get(RISK_OUTCOME_SQL).all(clock.now(), venueFilter, venueFilter) as RiskOutcomeRow[]
    if (rows.length === 0) {
      if (!emptyAudited && journal !== undefined) {
        emptyAudited = true
        journal.appendAudit({
          actor: 'system',
          kind: 'risk_state_empty',
          payload: { venue: options.venue ?? 'htx', dailyLossUsd: 0, drawdownUsd: 0, consecutiveLosses: 0 },
          ts: clock.now(),
        })
      }
      return { dailyLossUsd: 0, drawdownUsd: 0, consecutiveLosses: 0 }
    }

    const pnl: { settledAt: number; usd: number }[] = []
    for (const row of rows) {
      const qty = row.entry_fill_qty !== null && Math.abs(row.entry_fill_qty) > 0 ? row.entry_fill_qty : row.size_qty
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
  if (!['paper', 'live_auto'].includes(config.mode)) {
    throw new Error('mode 非法：' + String(config.mode))
  }
  if (config.mode === 'live_auto' && limits === null) throw new Error('live_auto 必须提供全部硬风险限额')
  if (config.mode === 'live_auto' && config.waiver === true) throw new Error('live_auto 不允许 waiver')
  if (config.mode === 'paper' && limits === null && config.waiver !== true) {
    throw new Error('paper 无硬风险限额时必须显式 waiver=true')
  }
  if (limits !== null && config.waiver === true) throw new Error('已有完整硬风险限额时不能同时设置 waiver')
  if (!Number.isFinite(config.riskPct) || config.riskPct <= 0 || config.riskPct > 0.05) {
    throw new Error('riskPct 必须在 (0, 0.05] 内')
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
  if (config.settleMs !== undefined && (!Number.isFinite(config.settleMs) || config.settleMs <= 0)) {
    throw new Error('settleMs 必须是有限正数')
  }
  if (config.mode !== 'paper') {
    if (!hasCredential(config.apiKey) || !hasCredential(config.apiSecret)) {
      throw new Error('live_auto 必须同时注入非空 API key 与 secret')
    }
    if (!LIVE_VENUES.includes(config.venue as Exclude<Venue, 'paper'>)) {
      throw new Error('实盘 venue 非法：' + String(config.venue) + '（生产只允许 htx）')
    }
    if (typeof config.accountType !== 'string' || config.accountType.trim() === '') {
      throw new Error('实盘 accountType 必须显式提供')
    }
    if (config.venue === 'htx' && config.accountType !== 'swap') {
      throw new Error('HTX live_auto 固定使用 swap accountType；拒绝读取错误账户计算实盘风险')
    }
  }
  finitePositive(config.paperInitialEquityQuote, 'paperInitialEquityQuote')
  finiteNonNegative(config.paperSlippageBps, 'paperSlippageBps')
  finiteNonNegative(config.paperFeeBps, 'paperFeeBps')
}

/** 版本化可审计运行配置，但只存凭据存在性；密钥本身绝不进入数据库。 */
function recordExecConfigVersion(
  db: Database.Database,
  now: number,
  config: ExecRuntimeConfig,
  limits: RiskLimits | null,
): void {
  const safeParams = {
    mode: config.mode,
    liveArmed: config.liveArmed === true,
    waiver: config.waiver === true,
    riskPct: config.riskPct,
    symbols: [...config.symbols],
    timeframes: [...config.timeframes],
    benchmark: config.benchmark,
    limits,
    venue: config.venue,
    accountType: config.accountType,
    positionSide: config.positionSide ?? 'both',
    decisionContext: decisionContextConfig(config.decisionContext),
    reconcileMs: config.reconcileMs,
    settleMs: config.settleMs ?? 60_000,
    liveAckOrphans: config.liveAckOrphans ?? config.acknowledgeOrphans ?? false,
    sandbox: config.sandbox === true,
    paperInitialEquityQuote: config.paperInitialEquityQuote ?? 10_000,
    paperSlippageBps: config.paperSlippageBps ?? 5,
    paperFeeBps: config.paperFeeBps ?? 5,
    credentials: {
      keyInjected: hasCredential(config.apiKey),
      secretInjected: hasCredential(config.apiSecret),
    },
  }
  const paramsJson = canonicalJson(safeParams)
  const statements = new Statements(db)
  const latest = statements.get('SELECT version, params_json FROM config_versions ORDER BY version DESC LIMIT 1')
  const insert = statements.get('INSERT INTO config_versions (ts, author, waiver, params_json) VALUES (?, ?, ?, ?)')
  const record = db.transaction(() => {
    const existing = latest.get() as { version: number; params_json: string } | undefined
    if (existing?.params_json === paramsJson) return existing.version
    insert.run(now, 'system', config.waiver === true ? 1 : 0, paramsJson)
    const inserted = statements.get('SELECT MAX(version) AS version FROM config_versions').get() as { version: number | null }
    if (inserted.version === null) throw new Error('runtime config version insert failed')
    return inserted.version
  })
  record()
}

type ExchangeFactory = (venue: 'htx', options?: Readonly<Record<string, unknown>>) => CcxtProExchangeLike | Promise<CcxtProExchangeLike>

async function defaultCreateExchange(
  venue: 'htx',
  options?: Readonly<Record<string, unknown>>,
): Promise<CcxtProExchangeLike> {
  const mod = (await import('ccxt')) as unknown as {
    default?: Record<string, new (options: unknown) => CcxtProExchangeLike>
  }
  const ccxt = mod.default ?? (mod as unknown as Record<string, new (options: unknown) => CcxtProExchangeLike>)
  const Exchange = ccxt.htx
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

type FreezeAction = Extract<ReconciliationAction, { readonly symbol?: string }>

function isFreezeAction(action: ReconciliationAction): action is FreezeAction {
  return (
    action.kind === 'cancel_orphan' ||
    action.kind === 'alert_missing_order' ||
    action.kind === 'alert_unknown_position' ||
    action.kind === 'alert_unprotected_position' ||
    action.kind === 'alert_qty_mismatch'
  )
}

export async function createExecRuntime(
  config: ExecRuntimeConfig,
  deps: ExecRuntimeDeps,
): Promise<ExecRuntime> {
  const journal = new DecisionJournal(deps.db)
  const startup = new StartupTracker(journal, deps.clock)
  startup.start('database')

  let limits: RiskLimits | null
  try {
    assertExecRuntimeMode(config.mode, config.liveArmed)
    limits = limitsFromConfig(config)
    validateConfig(config, limits)
    recordExecConfigVersion(deps.db, deps.clock.now(), config, limits)
  } catch (error) {
    startup.fail('database', error)
    throw error
  }
  startup.succeed('database')

  const bars = new BarArchive(deps.db)
  const features = new FeatureArchive(deps.db)
  const plans = new PlanStore(deps.db)
  const local = new LocalStateReader(deps.db)
  const heartbeat = new HeartbeatStore(new Statements(deps.db))
  const riskStateProvider = createRiskStateProvider(deps.db, deps.clock, journal, {
    venue: config.mode === 'paper' ? 'paper' : 'htx',
  })
  const acknowledgeOrphans = config.liveAckOrphans ?? config.acknowledgeOrphans ?? false

  let broker: Broker
  let exchange: CcxtProExchangeLike | undefined
  let closeExchange: (() => Promise<void>) | undefined

  startup.start('exchange')
  try {
    if (config.mode === 'paper') {
      const priceOf = deps.priceOf ?? config.priceOf ?? defaultPriceOf(bars, config.symbols, config.timeframes)
      broker = new PaperBroker({
        clock: deps.clock,
        book: { price: priceOf },
        initialEquityQuote: config.paperInitialEquityQuote,
        slippageBps: config.paperSlippageBps,
        feeBps: config.paperFeeBps,
      })
    } else {
      const venue = config.venue as 'htx'
      const factory: ExchangeFactory = deps.createExchange ?? defaultCreateExchange
      exchange = await factory(venue, { enableRateLimit: true, defaultType: config.accountType })
      applyProxyAwareFetch(exchange)
      broker = new HtxBroker({
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
    startup.succeed('exchange')
  } catch (error) {
    startup.fail('exchange', error)
    throw error
  }

  let unsubscribe: Disposer = () => {}
  try {
    // 即使 v0 ccxt 没有 WS，也保留统一的订阅生命周期；未来换成用户数据流时，
    // dispose 不会遗留一个仍能写入已卸载组合根的回调。
    unsubscribe = broker.subscribeUserData(() => undefined)
  } catch (error) {
    await closeExchange?.()
    startup.fail('exchange', error)
    throw error
  }

  // 冻结集合必须在 ports 之前声明：`ports.frozenSymbols()` 是工具与 live-engine 执行
  // plan §4.2/§6.3「冻结自动交易」的唯一通道。旧实现只把冻结算进 Set、无任何消费方，
  // 于是"已冻结"的同时照常开仓（审计说冻结、行为没冻结）。
  const frozen = new Set<string>()
  // 读取失败造成的组合级临时冻结可在一次完整成功对账后解除；具体订单/持仓冲突仍留在 frozen。
  const reconciliationFailureFrozen = new Set<string>()

  const freezeSymbol = (symbol: string): void => {
    frozen.add(symbol)
  }

  const halt = (): void => {
    heartbeat.halt(deps.clock.now())
    for (const symbol of config.symbols) frozen.add(symbol)
  }

  const frozenSymbols = (): ReadonlySet<string> => {
    const current = new Set([...frozen, ...reconciliationFailureFrozen])
    if (heartbeat.isHalted()) {
      // halt 是组合级的死人开关，不只冻结触发故障的标的；否则其它配置标的
      // 仍能增加敞口，/halt 的安全承诺会被分片绕过。每次读取数据库使得
      // /resume 能立即解除这一层，而对账冻结仍保留在 `frozen` 中。
      for (const symbol of config.symbols) current.add(symbol)
    }
    return current
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
    liveArmed: config.liveArmed === true,
    waiver: config.waiver === true,
    riskPct: config.riskPct,
    symbols: Object.freeze([...config.symbols]),
    timeframes: Object.freeze([...config.timeframes]),
    benchmark: config.benchmark,
    decisionContextConfig: decisionContextConfig(config.decisionContext),
    ...(config.reflectionHorizonMs === undefined ? {} : { reflectionHorizonMs: config.reflectionHorizonMs }),
    ...(config.pm === undefined ? {} : { pm: config.pm }),
    frozenSymbols,
    freezeSymbol,
    halt,
  }

  let disposed = false
  let timer: Disposer | undefined
  let settleTimer: Disposer | undefined
  let running: Promise<ExecReconciliationReport> | undefined

  const updateFrozen = (actions: readonly ReconciliationAction[]): void => {
    for (const action of actions) {
      if (!isFreezeAction(action)) continue
      if ('symbol' in action && action.symbol !== undefined && action.symbol !== '') frozen.add(action.symbol)
      else for (const symbol of config.symbols) frozen.add(symbol)
    }
  }

  const protectLateOpenUnlocked = async (
    intent: ReturnType<DecisionJournal['pollableIntents']>[number],
    ack?: OrderAck,
  ): Promise<void> => {
    if (intent.reduceOnly) return
    if (intent.decisionId === null) {
      frozen.add(intent.symbol)
      journal.appendAudit({
        actor: 'system', kind: 'late_open_without_decision',
        payload: { symbol: intent.symbol, clientOrderId: intent.clientOrderId }, ts: deps.clock.now(),
      })
      return
    }
    try {
      let position: PositionSnapshot | undefined
      try {
        position = (await broker.getPositions()).find((item) => item.symbol === intent.symbol)
      } catch (error) {
        if (ack?.filledQty === undefined || ack.filledQty <= 0 ||
            (intent.side !== 'buy' && intent.side !== 'sell')) throw error
        position = {
          symbol: intent.symbol,
          qty: intent.side === 'buy' ? ack.filledQty : -ack.filledQty,
          avgPrice: ack.avgPrice ?? intent.price ?? 0,
          unrealizedPnlUsd: 0,
        }
      }
      const localPosition = local.positions().find((item) => item.symbol === intent.symbol)
      if (localPosition !== undefined && localPosition.qty !== 0 &&
          (position === undefined || position.qty === 0 ||
           Math.sign(position.qty) !== Math.sign(localPosition.qty) ||
           Math.abs(position.qty) + 1e-12 < Math.abs(localPosition.qty))) {
        frozen.add(intent.symbol)
        journal.appendAudit({
          actor: 'system', kind: 'late_open_position_snapshot_mismatch',
          payload: { symbol: intent.symbol, clientOrderId: intent.clientOrderId, localQty: localPosition.qty, remoteQty: position?.qty ?? null },
          ts: deps.clock.now(),
        })
        position = {
          symbol: intent.symbol,
          qty: localPosition.qty,
          avgPrice: position?.avgPrice ?? ack?.avgPrice ?? intent.price ?? 0,
          unrealizedPnlUsd: position?.unrealizedPnlUsd ?? 0,
        }
      }
      if (position === undefined && ack?.filledQty !== undefined && ack.filledQty > 0 &&
          (intent.side === 'buy' || intent.side === 'sell')) {
        position = {
          symbol: intent.symbol,
          qty: intent.side === 'buy' ? ack.filledQty : -ack.filledQty,
          avgPrice: ack.avgPrice ?? intent.price ?? 0,
          unrealizedPnlUsd: 0,
        }
      }
      if (position === undefined || position.qty === 0) return
      await protectPositionOrClose({
        broker,
        journal,
        clock: deps.clock,
        symbol: intent.symbol,
        decisionId: intent.decisionId,
        clientOrderId: protectionClientOrderId(intent.decisionId, position.qty),
        position,
        ...(intent.stopPrice === null ? {} : { stopPrice: intent.stopPrice }),
        referencePrice: position.avgPrice,
        reflectionHorizonMs: config.reflectionHorizonMs ?? 4 * 3_600_000,
        freezeSymbol,
        reason: 'late_or_partial_open_fill',
      })
    } catch (error) {
      frozen.add(intent.symbol)
      journal.appendAudit({
        actor: 'system', kind: 'late_open_protection_check_failed',
        payload: { symbol: intent.symbol, clientOrderId: intent.clientOrderId, error: String(error) },
        ts: deps.clock.now(),
      })
    }
  }

  const reconcileOperation = async (): Promise<ExecReconciliationReport> => {
    const ranAt = deps.clock.now()
    // HTX 市价/算法单可能先 ack 后成交；每轮对账先按 exchangeOrderId 查询，
    // 把 delayed fill 走同一 journal 状态机，避免只更新远端仓位却丢本地成交链。
    const findOrderByExchangeOrderId = broker.findOrderByExchangeOrderId
    if (findOrderByExchangeOrderId !== undefined) {
      for (const intent of journal.pollableIntents()) {
        if (intent.feePending) {
          let ack: Awaited<ReturnType<NonNullable<Broker['findOrderByExchangeOrderId']>>> | undefined
          try {
            ack = await findOrderByExchangeOrderId.call(broker, intent.exchangeOrderId, intent.symbol)
          } catch (error) {
            journal.appendAudit({ actor: 'system', kind: 'fill_fee_refresh_failed', payload: { symbol: intent.symbol, exchangeOrderId: intent.exchangeOrderId, error: String(error) }, ts: deps.clock.now() })
          }
          // 终态成交只因费用尚未回填而重试；不重复运行迟到开仓保护逻辑，避免旧决策给新仓位挂旧止损。
          if (ack?.fee !== undefined && ack.state === intent.state) {
            journal.applyOrderAck({ ...ack, clientOrderId: intent.clientOrderId }, deps.clock.now())
          } else if (ack?.fee !== undefined) {
            journal.appendAudit({
              actor: 'system', kind: 'fill_fee_refresh_state_mismatch',
              payload: { symbol: intent.symbol, clientOrderId: intent.clientOrderId, expectedState: intent.state, observedState: ack.state },
              ts: deps.clock.now(),
            })
          }
          continue
        }

        // 开仓轮询与执行共享账户锁：必须把订单查询、必要的撤单/最终查询、成交落账和
        // 持仓保护作为一个临界区，避免另一标的在“挂单已消失、仓位快照尚未更新”时过闸。
        if (!intent.reduceOnly) {
          await withExposureLock(journal, async () => {
            let ack: Awaited<ReturnType<NonNullable<Broker['findOrderByExchangeOrderId']>>> | undefined
            try {
              ack = await findOrderByExchangeOrderId.call(broker, intent.exchangeOrderId, intent.symbol)
            } catch (error) {
              frozen.add(intent.symbol)
              journal.appendAudit({ actor: 'system', kind: 'order_poll_failed', payload: { symbol: intent.symbol, exchangeOrderId: intent.exchangeOrderId, error: String(error) }, ts: deps.clock.now() })
            }
            if (ack === undefined) {
              journal.markIntentAcked(intent.clientOrderId, 'unknown', intent.exchangeOrderId, deps.clock.now())
              frozen.add(intent.symbol)
              journal.appendAudit({ actor: 'system', kind: 'order_lookup_missing', payload: { symbol: intent.symbol, exchangeOrderId: intent.exchangeOrderId, clientOrderId: intent.clientOrderId }, ts: deps.clock.now() })
              await protectLateOpenUnlocked(intent)
              return
            }

            if (broker.venue === 'htx' && ack.state === 'acked') {
              let finalLookupMissing = false
              try {
                await broker.cancelOrder(intent.exchangeOrderId)
              } catch (error) {
                journal.appendAudit({ actor: 'system', kind: 'open_order_cancel_uncertain', payload: { symbol: intent.symbol, exchangeOrderId: intent.exchangeOrderId, error: String(error) }, ts: deps.clock.now() })
              }
              try {
                const settled = await findOrderByExchangeOrderId.call(broker, intent.exchangeOrderId, intent.symbol)
                if (settled !== undefined) ack = settled
                else {
                  journal.markIntentAcked(intent.clientOrderId, 'unknown', intent.exchangeOrderId, deps.clock.now())
                  frozen.add(intent.symbol)
                  finalLookupMissing = true
                }
              } catch (error) {
                journal.markIntentAcked(intent.clientOrderId, 'unknown', intent.exchangeOrderId, deps.clock.now())
                frozen.add(intent.symbol)
                finalLookupMissing = true
                journal.appendAudit({ actor: 'system', kind: 'open_order_final_lookup_failed', payload: { symbol: intent.symbol, exchangeOrderId: intent.exchangeOrderId, error: String(error) }, ts: deps.clock.now() })
              }
              if (finalLookupMissing) {
                await protectLateOpenUnlocked(intent, ack)
                return
              }
              if (ack.state === 'acked') {
                journal.markIntentAcked(intent.clientOrderId, 'unknown', intent.exchangeOrderId, deps.clock.now())
                frozen.add(intent.symbol)
                await protectLateOpenUnlocked(intent)
                return
              }
            }

            const applied = journal.applyOrderAck({ ...ack, clientOrderId: intent.clientOrderId }, deps.clock.now())
            if (applied.unknown) frozen.add(intent.symbol)
            await protectLateOpenUnlocked(intent, ack)
          })
          continue
        }

        let ack: Awaited<ReturnType<NonNullable<Broker['findOrderByExchangeOrderId']>>> | undefined
        try {
          ack = await findOrderByExchangeOrderId.call(broker, intent.exchangeOrderId, intent.symbol)
        } catch (error) {
          frozen.add(intent.symbol)
          journal.appendAudit({ actor: 'system', kind: 'order_poll_failed', payload: { symbol: intent.symbol, exchangeOrderId: intent.exchangeOrderId, error: String(error) }, ts: deps.clock.now() })
        }
        if (ack === undefined) {
          journal.markIntentAcked(intent.clientOrderId, 'unknown', intent.exchangeOrderId, deps.clock.now())
          frozen.add(intent.symbol)
          journal.appendAudit({ actor: 'system', kind: 'order_lookup_missing', payload: { symbol: intent.symbol, exchangeOrderId: intent.exchangeOrderId, clientOrderId: intent.clientOrderId }, ts: deps.clock.now() })
          continue
        }
        const applied = journal.applyOrderAck({ ...ack, clientOrderId: intent.clientOrderId }, deps.clock.now())
        if (applied.unknown) frozen.add(intent.symbol)
      }
    }
    if (!acknowledgeOrphans) {
      // 只读对账也会产生冻结裁决；快照、判定、冻结和审计必须先于排队开仓的锁内重读。
      return await withExposureLock(journal, async () => {
        const [remoteOrders, remotePositions] = await Promise.all([broker.getOpenOrders(), broker.getPositions()])
        const result = reconcile({
          localOrders: local.orders(),
          remoteOrders: remoteOrders.map((order) => ({
            ...(order.clientOrderId === undefined ? {} : { clientOrderId: order.clientOrderId }),
            ...(order.exchangeOrderId === undefined ? {} : { exchangeOrderId: order.exchangeOrderId }),
            ...(order.symbol === undefined ? {} : { symbol: order.symbol }),
          })),
          localPositions: local.positions(),
          remotePositions: remotePositions.map((position) => ({
            symbol: position.symbol,
            qty: position.qty,
            ...(position.protectedStopPrice === undefined ? {} : { protectedStopPrice: position.protectedStopPrice }),
          })),
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
      })
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
        updateFrozen([event.action])
        journal.appendAudit({ actor: 'system', kind: 'reconcile_action', payload: event, ts: event.at })
      },
    })
    // 孤儿撤单同样会改变账户在途敞口；快照、撤单和 freeze 回调与开仓串行化。
    const reconcilerResult: ReconcilerResult = await withExposureLock(journal, () => reconciler.runOnce())
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
      (report) => {
        if (report.consistent && report.actions.length === 0) reconciliationFailureFrozen.clear()
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
    for (const symbol of config.symbols) reconciliationFailureFrozen.add(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'reconcile_failed',
      payload: { error: String(error), freezeSymbols: [...config.symbols] },
      ts: deps.clock.now(),
    })
  }

  // ── 结算调度（plan §5.3）────────────────────────────────────────────────────
  // 旧实现里 `SettlementScheduler` 只在验收脚本被 new 出来，常驻进程从不扫描
  // `reflection_due_at` ⇒ 决策永远不结算、无 outcomes/lessons，闭环静默断掉。
  // 每个配置时间框各一个 scheduler：结算窗口 `decidedAt + horizonMs(tf)` 依赖 tf，
  // 混用会把 1h 决策用 4h 窗口结算（journal 已按 tf 过滤，各 scheduler 只看自己的）。
  const settlers = config.timeframes.map((timeframe) => ({
    timeframe,
    scheduler: new SettlementScheduler({
      journal,
      bars,
      clock: deps.clock,
      timeframe,
      benchmarkSymbol: config.benchmark,
      slippageBps: config.paperSlippageBps ?? 5,
    }),
  }))

  const runSettlements = async (): Promise<void> => {
    const now = deps.clock.now()
    for (const { timeframe, scheduler } of settlers) {
      const result = await scheduler.runOnce(now)
      // 缺数据 deferred 是正常状态（下一轮重试），不落审计以免噪声；
      // 只有真的结算/写反思/出错才留痕。
      if (result.settled > 0 || result.reflectionsWritten > 0 || result.errors.length > 0) {
        journal.appendAudit({
          actor: 'system',
          kind: 'settle_run',
          payload: {
            timeframe,
            scanned: result.scanned,
            settled: result.settled,
            deferred: result.deferred,
            deferredIds: result.deferredIds,
            reflectionsWritten: result.reflectionsWritten,
            errors: result.errors,
          },
          ts: now,
        })
      }
    }
  }
  let settling: Promise<void> | undefined
  const runSettlementsSingleFlight = (): Promise<void> => {
    if (settling !== undefined) return settling
    const operation = runSettlements()
    settling = operation
    void operation.finally(() => {
      if (settling === operation) settling = undefined
    }).catch(() => undefined)
    return operation
  }

  const onSettlementError = (error: unknown): void => {
    journal.appendAudit({
      actor: 'system',
      kind: 'settle_failed',
      payload: { error: String(error) },
      ts: deps.clock.now(),
    })
  }

  // ── 崩溃恢复必须在普通对账**之前**跑（plan §4.2 / §10 P1 ⑤）──────────────────
  // `order_intents` 里 `created` 且无 ack 的在途意图是"请求可能已发出甚至已成交"的唯一线索，
  // 普通 Reconciler 只看 orders/positions，覆盖不到它。旧实现里 CrashRecovery 只在验收脚本
  // 被 new 出来，常驻进程从不调用 ⇒ 崩溃后 created 意图永不收敛，也不触发"未知即冻结"。
  startup.start('recovery')
  try {
    const recovered = await new CrashRecovery({
      journal,
      // paper broker 不一定实现 findOrderByClientOrderId；缺了就让恢复判 unknown 并冻结。
      broker: broker as Broker & ClientOrderLookup,
      clock: deps.clock,
      symbols: config.symbols,
    }).run()
    for (const symbol of recovered.freezeSymbols) frozen.add(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'crash_recovery',
      payload: {
        scanned: recovered.scanned,
        freezeSymbols: [...recovered.freezeSymbols],
        orphanOpenOrders: recovered.orphanOpenOrders.length,
        alerts: recovered.alerts.map((alert) => alert.code),
      },
      ts: deps.clock.now(),
    })
    startup.succeed('recovery')
  } catch (error) {
    // 恢复失败 = 状态未知。fail-closed：冻结全部配置标的；但不阻断启动
    //（交易所短暂不可用不应让进程起不来），与周期对账失败同一处理。
    for (const symbol of config.symbols) frozen.add(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'crash_recovery_failed',
      payload: { error: String(error), freezeSymbols: [...config.symbols] },
      ts: deps.clock.now(),
    })
    startup.fail('recovery', error)
  }

  let startupReconcileFailed = false
  try {
    startup.start('reconcile')
    await reconcileOnce()
    startup.succeed('reconcile')
  } catch (error) {
    // 初始读失败时仍发布只允许降险的组合根：broker 后续若恢复可读，减仓/平仓可重新取实时状态执行。
    // 新增敞口由 reconciliationFailureFrozen 拦截；周期对账成功且完整后才解除该临时冻结。
    startupReconcileFailed = true
    startup.fail('reconcile', error)
    for (const symbol of config.symbols) reconciliationFailureFrozen.add(symbol)
    journal.appendAudit({
      actor: 'system',
      kind: 'reconcile_failed',
      payload: { startup: true, error: String(error), freezeSymbols: [...config.symbols] },
      ts: deps.clock.now(),
    })
  }
  if (!disposed) timer = deps.clock.setInterval(() => void reconcileOnce().catch(onPeriodicError), config.reconcileMs)
  if (!disposed) {
    settleTimer = deps.clock.setInterval(
      () => void runSettlementsSingleFlight().catch(onSettlementError),
      config.settleMs ?? 60_000,
    )
  }
  if (!startupReconcileFailed) {
    startup.start('ready')
    startup.succeed('ready')
  }

  return {
    broker,
    getPorts: () => ports,
    reconcileOnce,
    frozenSymbols,
    async dispose() {
      if (disposed) return
      disposed = true
      timer?.()
      timer = undefined
      settleTimer?.()
      settleTimer = undefined
      unsubscribe()
      await closeExchange?.()
    },
  }
}
