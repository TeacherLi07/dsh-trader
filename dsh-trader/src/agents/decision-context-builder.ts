/**
 * 从权威 DB 与 broker 快照构造唯一的 DecisionContext（plan §5）。
 * 市场事实只读双时间 observation；broker 错误仅暴露错误类型，避免把请求细节或密钥送进模型。
 */

import { ACTION_KINDS } from '../plan/schema.js'
import { PriceTableStore } from '../cost-ledger.js'
import { Statements } from '../db/statements.js'
import type { AccountSnapshot, OrderAck, PositionSnapshot } from '../exec/broker.js'
import type { TradePorts } from '../exec/ports.js'
import { MarketObservationStore } from '../market/observations.js'
import type { MarketSpecification } from '../market/specification.js'
import type { PmAliasSnapshot } from '../predictions/store.js'
import { canonicalJson, fingerprint } from '../util/canonical.js'
import { benchmarkSlice, CONTEXT_TIMEFRAMES, derivativesSlice, marketSlice } from './context-market.js'
import { decisionContextConfig, type DecisionContextConfig } from './context-config.js'
import { freezeDecisionContext, type DecisionContext } from './decision-context.js'

interface ConfigVersionRow {
  version: number
  ts: number
  author: string
}

interface HeartbeatRow {
  beat_at: number
  halted: number
}

interface AuditReportRow {
  ts: number
  payload_json: string
}

interface UnresolvedIntentRow {
  intent_id: string
  client_order_id: string
  exchange_order_id: string | null
  symbol: string
  state: string
  type: string | null
  side: string | null
  qty: number | null
  price: number | null
  stop_price: number | null
  notional_usd: number | null
  reduce_only: number
  created_at: number
}

interface ReadResult<T> {
  readonly value?: T
  readonly errorType?: string
}

interface UnresolvedIntentSnapshot {
  readonly items: readonly UnresolvedIntentRow[]
  readonly count: number
  readonly truncated: boolean
}

export interface DecisionContextBuildOptions {
  readonly config?: Partial<DecisionContextConfig>
  /** W3 预测市场触发只注入显式映射的一个 alias；不扫描或扩展整个 watch 池。 */
  readonly predictionAlias?: string
}

function safePrediction(snapshot: PmAliasSnapshot): Readonly<Record<string, unknown>> {
  return {
    alias: snapshot.alias,
    tokenId: snapshot.tokenId,
    observedAt: snapshot.quoteObservedAt,
    probability: snapshot.probability.ok
      ? { value: snapshot.probability.value, estimator: snapshot.probability.estimator, status: 'ok' }
      : { value: null, estimator: null, status: 'missing', reason: snapshot.probability.reason },
    liquidity: snapshot.liquidity.pass ? { pass: true } : { pass: false, reason: snapshot.liquidity.reason },
    mid: snapshot.mid,
    spread: snapshot.spread,
    volume24h: snapshot.volume24h,
    liquidityQuote: snapshot.liquidityQuote,
    ageMs: snapshot.ageMs,
    change1h: snapshot.change1h,
    change24h: snapshot.change24h,
    absChangeMean: snapshot.absChangeMean,
    quoteObservedAt: snapshot.quoteObservedAt,
    resolved: snapshot.resolved,
    winningOutcome: snapshot.winningOutcome,
    negRiskDeviation: snapshot.negRiskDeviation,
    negRiskDiscounted: snapshot.negRiskDiscounted,
    confidenceMultiplier: snapshot.confidenceMultiplier,
    question: snapshot.untrustedText === null ? null : { text: snapshot.untrustedText, untrustedText: true },
  }
}

function predictionSection(
  ports: TradePorts,
  alias: string | undefined,
  asOf: number,
): { readonly asOf: number | null; readonly source: string; readonly missing: readonly string[]; readonly value: unknown } {
  if (alias === undefined) {
    return { asOf: null, source: 'predictions.disabled-or-not-qualified', missing: [], value: { state: 'disabled', items: [], untrustedText: true } }
  }
  if (ports.pm === undefined) {
    return { asOf: null, source: 'pm-store', missing: ['prediction.store:unavailable'], value: { state: 'unavailable', alias, items: [] } }
  }
  const snapshots = ports.pm.snapshotAt(asOf).filter((snapshot) => snapshot.alias === alias).slice(0, 20)
  if (snapshots.length === 0) {
    return { asOf: null, source: 'pm-store', missing: [`prediction.${alias}:not-visible-at-asOf`], value: { state: 'unavailable', alias, items: [] } }
  }
  const predictionAsOf = latestTimestamp(snapshots.map((snapshot) => snapshot.quoteObservedAt))
  const missing = snapshots.flatMap((snapshot) => [
    ...(snapshot.probability.ok ? [] : [`prediction.${alias}.${snapshot.tokenId}.probability:missing`]),
    ...(snapshot.liquidity.pass ? [] : [`prediction.${alias}.${snapshot.tokenId}.liquidity:unqualified`]),
  ])
  return {
    asOf: predictionAsOf,
    source: 'pm-store.point-in-time',
    missing,
    value: { state: 'available', alias, items: snapshots.map(safePrediction) },
  }
}

function safeErrorType(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string') {
    return error.name.slice(0, 80)
  }
  return 'UnknownError'
}

async function read<T>(work: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { value: await work() }
  } catch (error) {
    return { errorType: safeErrorType(error) }
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function latestTimestamp(values: readonly (number | null | undefined)[]): number | null {
  const available = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
  return available.length === 0 ? null : Math.max(...available)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function factIssues(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => factIssues(item, `${path}[${index}]`))
  if (!isRecord(value)) return []
  if (typeof value.status === 'string' && ['ok', 'missing', 'stale', 'warming', 'invalid'].includes(value.status)) {
    return value.status === 'ok' ? [] : [`${path}:${value.status}`]
  }
  return Object.entries(value).flatMap(([key, item]) => factIssues(item, `${path}.${key}`))
}

function safeAccount(account: AccountSnapshot): Readonly<Record<string, unknown>> {
  return {
    venue: account.venue,
    observedAt: account.observedAt,
    equityQuote: finiteOrNull(account.equityQuote),
    freeMarginQuote: finiteOrNull(account.freeMarginQuote),
    totalExposureUsd: finiteOrNull(account.totalExposureUsd),
    pendingExposureUsd: finiteOrNull(account.pendingExposureUsd),
    openOrders: account.openOrders,
    leverage: finiteOrNull(account.leverage),
    dailyLossUsd: finiteOrNull(account.dailyLossUsd),
    drawdownUsd: finiteOrNull(account.drawdownUsd),
    consecutiveLosses: account.consecutiveLosses,
    spreadBps: finiteOrNull(account.spreadBps),
  }
}

function accountNumbersValid(account: AccountSnapshot): boolean {
  const pendingExposureValid = account.pendingExposureUsd === null ||
    (Number.isFinite(account.pendingExposureUsd) && account.pendingExposureUsd >= 0)
  return pendingExposureValid && [
    account.equityQuote, account.totalExposureUsd, account.openOrders, account.leverage,
    account.dailyLossUsd, account.drawdownUsd, account.consecutiveLosses, account.spreadBps,
  ].every((value) => typeof value === 'number' && Number.isFinite(value)) && account.equityQuote > 0
}

function safePosition(position: PositionSnapshot): Readonly<Record<string, unknown>> {
  const notional = Number.isFinite(position.qty * position.avgPrice)
    ? Math.abs(position.qty * position.avgPrice)
    : null
  return {
    symbol: position.symbol,
    observedAt: position.observedAt ?? null,
    qty: finiteOrNull(position.qty),
    avgPrice: finiteOrNull(position.avgPrice),
    unrealizedPnlUsd: finiteOrNull(position.unrealizedPnlUsd),
    estimatedNotionalUsd: notional,
    notionalSource: notional === null ? 'unknown' : 'abs(qty*avgPrice)',
    protectedStopPrice: finiteOrNull(position.protectedStopPrice),
    protectionState: position.qty === 0 ? 'flat' : position.protectedStopPrice === undefined ? 'unknown' : 'reported',
  }
}

function safeOrder(order: OrderAck): Readonly<Record<string, unknown>> {
  return {
    clientOrderId: order.clientOrderId,
    exchangeOrderId: order.exchangeOrderId ?? null,
    state: order.state,
    observedAt: order.observedAt ?? null,
    eventAt: order.ts,
    filledQty: finiteOrNull(order.filledQty),
    avgPrice: finiteOrNull(order.avgPrice),
    feeQuote: finiteOrNull(order.fee),
  }
}

function contractSpecification(
  observations: MarketObservationStore,
  symbol: string,
  asOf: number,
  config: DecisionContextConfig,
): { readonly value: MarketSpecification | null; readonly asOf: number | null; readonly availableAt: number | null; readonly source: string | null; readonly missing: readonly string[] } {
  const observation = observations.recent<MarketSpecification>('spec', symbol, '', asOf, 1).at(-1)
  if (observation === undefined) {
    return { value: null, asOf: null, availableAt: null, source: null, missing: ['contractSpecification:missing'] }
  }
  const missing: string[] = []
  if (asOf - observation.eventTime > config.specMaxAgeMs) missing.push('contractSpecification:stale')
  for (const field of ['linear', 'contractSize', 'amountStepContracts', 'priceStep', 'minAmountContracts', 'minNotionalQuote', 'takerFeeRate'] as const) {
    if (observation.value[field] === null) missing.push(`contractSpecification.${field}:missing`)
  }
  return {
    value: observation.value,
    asOf: observation.eventTime,
    availableAt: observation.availableAt,
    source: observation.source,
    missing,
  }
}

function unresolvedIntents(statements: Statements, asOf: number): UnresolvedIntentSnapshot {
  const countRow = statements.get(`SELECT COUNT(*) AS n FROM order_intents
    WHERE created_at <= ? AND state IN ('created', 'acked', 'unknown')`).get(asOf) as { n: number }
  const items = statements.get(`SELECT intent_id, client_order_id, exchange_order_id, symbol, state, type, side,
      qty, price, stop_price, notional_usd, reduce_only, created_at
    FROM order_intents WHERE created_at <= ? AND state IN ('created', 'acked', 'unknown')
    ORDER BY created_at DESC, client_order_id ASC LIMIT 100`).all(asOf) as UnresolvedIntentRow[]
  const count = Number(countRow.n)
  return { items, count, truncated: count > items.length }
}

function reconciliationAt(
  statements: Statements,
  asOf: number,
  maxAgeMs: number,
): Readonly<Record<string, unknown>> | null {
  const row = statements.get(`SELECT ts, payload_json FROM audit_events
    WHERE kind = 'reconcile_report' AND ts <= ? ORDER BY ts DESC, seq DESC LIMIT 1`).get(asOf) as AuditReportRow | undefined
  if (row === undefined) return null
  const payload: unknown = JSON.parse(row.payload_json)
  if (!isRecord(payload) || !isRecord(payload.result)) {
    return { state: 'invalid', observedAt: row.ts, consistent: null, freezeTrading: null, actions: null }
  }
  const result = payload.result
  const actions = Array.isArray(result.actions)
    ? result.actions.map((item) => {
        if (!isRecord(item)) return { kind: 'invalid' }
        return {
          kind: typeof item.kind === 'string' ? item.kind : 'unknown',
          symbol: typeof item.symbol === 'string' ? item.symbol : null,
          clientOrderId: typeof item.clientOrderId === 'string' ? item.clientOrderId : null,
          exchangeOrderId: typeof item.exchangeOrderId === 'string' ? item.exchangeOrderId : null,
          reason: typeof item.reason === 'string' ? { text: item.reason, untrustedText: true } : null,
        }
      })
    : null
  const consistent = typeof result.consistent === 'boolean' ? result.consistent : null
  const freezeTrading = typeof result.freezeTrading === 'boolean' ? result.freezeTrading : null
  const ageMs = asOf - row.ts
  const reportState = consistent === true ? 'consistent' : consistent === false ? 'inconsistent' : 'unknown'
  return {
    state: ageMs > maxAgeMs ? 'stale' : reportState,
    observedAt: row.ts,
    ageMs,
    consistent,
    freezeTrading,
    acknowledgeOrphans: typeof payload.acknowledgeOrphans === 'boolean' ? payload.acknowledgeOrphans : null,
    actions,
  }
}

function boundedHistoryText(text: string | null, maxChars: number): Readonly<Record<string, unknown>> | null {
  if (text === null) return null
  const truncated = text.length > maxChars
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    untrustedText: true,
    truncated,
    originalChars: text.length,
  }
}

/**
 * 构造可审计、PIT 且有界的模型输入。成功读取后的空数组/空仓是正常状态；读失败、过期和暖机
 * 则分别落入 missing/status，供 R3 eligibility 作动作依赖判断。
 */
export async function buildDecisionContext(
  ports: TradePorts,
  symbol: string,
  triggerTimeframe: string,
  options: DecisionContextBuildOptions = {},
): Promise<DecisionContext> {
  if (!ports.symbols.includes(symbol)) throw new Error(`symbol 不在配置标的池中：${symbol}`)
  if (!ports.timeframes.includes(triggerTimeframe)) throw new Error(`timeframe 不在配置时间框中：${triggerTimeframe}`)
  const config = decisionContextConfig(options.config ?? ports.decisionContextConfig)
  const statements = new Statements(ports.db)
  const observations = new MarketObservationStore(ports.db)

  const [accountRead, positionsRead, ordersRead] = await Promise.all([
    read(() => ports.broker.getAccount()),
    read(() => ports.broker.getPositions()),
    read(() => ports.broker.getOpenOrders()),
  ])
  // 必须在实时私有快照取回之后冻结，以免模型看到“未来于账户观察时点”的上下文年龄。
  const asOf = ports.clock.now()
  const account = accountRead.value
  const positions = positionsRead.value
  const openOrders = ordersRead.value
  const visibleAccount = account !== undefined && account.observedAt <= asOf ? account : undefined
  const visiblePositions = positions?.filter((position) => position.observedAt !== undefined && position.observedAt <= asOf)
  const hiddenPositionCount = (positions?.length ?? 0) - (visiblePositions?.length ?? 0)
  const visibleOpenOrders = openOrders?.filter((order) => order.observedAt !== undefined && order.observedAt <= asOf)
  const hiddenOrderCount = (openOrders?.length ?? 0) - (visibleOpenOrders?.length ?? 0)
  const activePlan = ports.plans.activeAt(symbol, asOf)
  const history = ports.journal.recentDecisionHistory({ asOf, limit: config.historyLimit })
  const specification = contractSpecification(observations, symbol, asOf, config)

  const slices = Object.fromEntries(CONTEXT_TIMEFRAMES.map((timeframe) => [
    timeframe,
    marketSlice(observations, symbol, timeframe, asOf, config),
  ])) as Record<(typeof CONTEXT_TIMEFRAMES)[number], ReturnType<typeof marketSlice>>
  const marketMissing = CONTEXT_TIMEFRAMES.flatMap((timeframe) => slices[timeframe].missing)
  const marketAsOf = latestTimestamp(CONTEXT_TIMEFRAMES.map((timeframe) => slices[timeframe].asOf))

  const benchmark = ports.benchmark.trim() === ''
    ? undefined
    : benchmarkSlice(observations, symbol, ports.benchmark, asOf, config)
  const benchmarkMissing = benchmark === undefined
    ? ['benchmark.configuration:missing']
    : [
        ...benchmark.series.missing.map((item) => `series.${item}`),
        ...factIssues(benchmark.correlation, 'correlation'),
        ...factIssues(benchmark.relativeStrength, 'relativeStrength'),
      ]

  const derivatives = derivativesSlice(observations, symbol, asOf, config)
  const derivativesMissing = factIssues(derivatives, 'derivatives')
  const predictions = predictionSection(ports, options.predictionAlias, asOf)

  const accountAgeMs = account === undefined ? null : asOf - account.observedAt
  const staleAccount = accountAgeMs !== null && accountAgeMs > config.accountMaxAgeMs
  const futureAccount = account !== undefined && account.observedAt > asOf
  const invalidAccount = account !== undefined && !accountNumbersValid(account)
  const portfolioMissing: string[] = []
  if (accountRead.errorType !== undefined) portfolioMissing.push(`account.read_failed:${accountRead.errorType}`)
  else if (staleAccount) portfolioMissing.push('account.stale')
  if (futureAccount) portfolioMissing.push('account.observedAt:future')
  if (invalidAccount) portfolioMissing.push('account.numeric_fields:invalid')
  if (account !== undefined && account.freeMarginQuote == null) portfolioMissing.push('account.freeMarginQuote:missing')
  if (account !== undefined) {
    const pendingExposure = account.pendingExposureUsd
    if (pendingExposure === null) portfolioMissing.push('account.pendingExposureUsd:unknown')
    else if (!Number.isFinite(pendingExposure) || pendingExposure < 0) {
      portfolioMissing.push('account.pendingExposureUsd:invalid')
    }
  }
  if (positionsRead.errorType !== undefined) portfolioMissing.push(`positions.read_failed:${positionsRead.errorType}`)
  if (ordersRead.errorType !== undefined) portfolioMissing.push(`openOrders.read_failed:${ordersRead.errorType}`)
  for (const position of positions ?? []) {
    if (position.observedAt === undefined) portfolioMissing.push(`positions.${position.symbol}.observedAt:missing`)
    else if (position.observedAt > asOf) portfolioMissing.push(`positions.${position.symbol}.observedAt:future`)
    else if (asOf - position.observedAt > config.accountMaxAgeMs) portfolioMissing.push(`positions.${position.symbol}.stale`)
    if (position.qty !== 0 && position.protectedStopPrice === undefined) {
      portfolioMissing.push(`positions.${position.symbol}.protectedStopPrice:missing`)
    }
  }
  for (const order of openOrders ?? []) {
    if (order.observedAt === undefined) portfolioMissing.push(`openOrders.${order.clientOrderId}.observedAt:missing`)
    else if (order.observedAt > asOf) portfolioMissing.push(`openOrders.${order.clientOrderId}.observedAt:future`)
  }
  let frozenSymbols: string[] = []
  try {
    if (ports.frozenSymbols !== undefined) frozenSymbols = [...ports.frozenSymbols()].sort()
  } catch {
    portfolioMissing.push('frozenSymbols.read_failed')
  }
  const heartbeat = statements.get('SELECT beat_at, halted FROM heartbeat WHERE id = 1 AND beat_at <= ?').get(asOf) as HeartbeatRow | undefined
  if (heartbeat === undefined) portfolioMissing.push('heartbeat.not_observed_at_asOf')
  const unresolved = unresolvedIntents(statements, asOf)
  const reconciliation = reconciliationAt(statements, asOf, config.reconciliationMaxAgeMs)
  if (reconciliation === null) portfolioMissing.push('reconciliation.not_reported_at_asOf')
  else if (reconciliation.state !== 'consistent') portfolioMissing.push(`reconciliation.${String(reconciliation.state)}`)
  if (unresolved.truncated) portfolioMissing.push('unresolvedIntents.truncated')

  const remainingLimits = visibleAccount === undefined || invalidAccount || visibleAccount.pendingExposureUsd === null || ports.limits === null
    ? null
    : {
        perOrderCapUsd: ports.limits.perOrderCapUsd,
        exposureUsd: ports.limits.maxExposureUsd - visibleAccount.totalExposureUsd - visibleAccount.pendingExposureUsd,
        dailyLossUsd: ports.limits.dailyLossLimitUsd - visibleAccount.dailyLossUsd,
        drawdownUsd: ports.limits.maxDrawdownUsd - visibleAccount.drawdownUsd,
        consecutiveLosses: ports.limits.maxConsecutiveLosses - visibleAccount.consecutiveLosses,
        spreadBps: ports.limits.maxSpreadBps - visibleAccount.spreadBps,
        openOrders: ports.limits.maxOpenOrders - visibleAccount.openOrders,
      }

  const latestConfig = statements.get('SELECT version, ts, author FROM config_versions WHERE ts <= ? ORDER BY version DESC LIMIT 1').get(asOf) as ConfigVersionRow | undefined
  const safeRuntimeConfig = {
    mode: ports.mode,
    riskPct: ports.riskPct,
    symbols: [...ports.symbols],
    timeframes: [...ports.timeframes],
    benchmark: ports.benchmark,
    limits: ports.limits,
    configVersion: latestConfig?.version ?? null,
  }
  const prices = new PriceTableStore(ports.db)
  const priceRows = prices.all().filter((price) => price.effectiveFrom <= asOf)
  const activePriceByKey = new Map<string, (typeof priceRows)[number]>()
  for (const price of priceRows) activePriceByKey.set(`${price.model}|${price.tier ?? 'any'}`, price)
  const mandateMissing = [...specification.missing]
  if (latestConfig === undefined) mandateMissing.push('configVersion.not_recorded')
  if (priceRows.length === 0) mandateMissing.push('modelPricing.unknown')
  mandateMissing.push('modelBudget.point_in_time_usage:unavailable')
  const contextConfig = { ...config }
  const costs = {
    makerFeeRate: specification.value?.makerFeeRate ?? null,
    takerFeeRate: specification.value?.takerFeeRate ?? null,
    spreadBps: visibleAccount === undefined ? null : finiteOrNull(visibleAccount.spreadBps),
    slippageBps: null,
    slippageStatus: 'unknown',
    fundingRate: derivatives.current.fundingRate,
    priceTableVersion: fingerprint(priceRows),
    activeModelPrices: [...activePriceByKey.values()],
    modelBudget: {
      status: 'unknown',
      spentUsd: null,
      costKnown: null,
      reason: 'budget_ledger aggregates by UTC day and cannot reconstruct an intraday point-in-time balance',
    },
  }
  if (costs.makerFeeRate === null) mandateMissing.push('costs.makerFeeRate:unknown')
  if (costs.takerFeeRate === null) mandateMissing.push('costs.takerFeeRate:unknown')
  if (costs.slippageBps === null) mandateMissing.push('costs.slippage:unknown')

  const historyValue = {
    asOf,
    limit: config.historyLimit,
    decisions: history.map((entry) => ({
      ...entry,
      rationale: boundedHistoryText(entry.rationale, config.historyTextChars),
    })),
    status: history.length === 0 ? 'empty' : 'ok',
  }
  const portfolioValue = {
    status: accountRead.errorType === undefined && positionsRead.errorType === undefined && ordersRead.errorType === undefined
      ? futureAccount || invalidAccount ? 'invalid' : staleAccount ? 'stale' : hiddenPositionCount > 0 || hiddenOrderCount > 0 || unresolved.truncated || portfolioMissing.length > 0 ? 'partial' : 'ok'
      : 'partial',
    account: visibleAccount === undefined ? null : safeAccount(visibleAccount),
    accountReadErrorType: accountRead.errorType ?? null,
    positions: positions === undefined ? null : (visiblePositions ?? []).map(safePosition),
    positionsReadErrorType: positionsRead.errorType ?? null,
    openOrders: openOrders === undefined ? null : (visibleOpenOrders ?? []).map(safeOrder),
    openOrdersReadErrorType: ordersRead.errorType ?? null,
    hiddenPositionCount,
    hiddenOpenOrderCount: hiddenOrderCount,
    unresolvedIntents: unresolved.items,
    unresolvedIntentCount: unresolved.count,
    unresolvedIntentsTruncated: unresolved.truncated,
    remainingLimits,
    frozenSymbols,
    reconciliation: reconciliation ?? { state: frozenSymbols.length > 0 ? 'frozen' : 'not_reported' },
    halted: heartbeat?.halted === undefined ? null : heartbeat.halted === 1,
    haltHeartbeatAt: heartbeat?.beat_at ?? null,
    accountAgeMs,
    observedAt: latestTimestamp([
      visibleAccount?.observedAt,
      ...(visiblePositions ?? []).map((position) => position.observedAt),
      ...(visibleOpenOrders ?? []).map((order) => order.observedAt),
    ]),
    protectionStatus: (visiblePositions ?? []).map((position) => ({
      symbol: position.symbol,
      state: position.qty === 0 ? 'flat' : position.protectedStopPrice === undefined ? 'missing' : 'reported',
      protectedStopPrice: finiteOrNull(position.protectedStopPrice),
    })),
  }

  const marketSpecValue = specification.value === null ? null : {
    observation: {
      eventTime: specification.asOf,
      availableAt: specification.availableAt,
      source: specification.source,
    },
    value: specification.value,
  }
  const context = freezeDecisionContext({
    symbol,
    primaryTimeframe: '1h',
    asOf,
    sections: {
      mandate: {
        asOf: latestConfig?.ts ?? asOf,
        source: 'trade-config+price-table+market-spec',
        missing: mandateMissing,
        value: {
          runtime: safeRuntimeConfig,
          runtimeFingerprint: fingerprint(safeRuntimeConfig),
          contextConfig,
          allowedPlanActions: ACTION_KINDS,
          allowedDecisionOutcomes: ['act', 'no_trade', 'review'],
          decisionOnlyOutcomes: ['no_trade', 'review'],
          riskReducingActionsStillRequiringVerification: ['reduce', 'close', 'set_stop', 'set_target', 'set_trailing', 'cancel_all'],
          remainingLimits,
          contractSpecification: marketSpecValue,
          costAssumptions: costs,
        },
      },
      market: {
        asOf: marketAsOf,
        source: 'market_observations',
        missing: marketMissing,
        value: { primaryTimeframe: triggerTimeframe, timeframes: slices },
      },
      derivatives: {
        asOf: derivatives.asOf,
        source: 'market_observations.derivatives',
        missing: derivativesMissing,
        value: derivatives,
      },
      benchmark: {
        asOf: benchmark?.series.asOf ?? null,
        source: benchmark === undefined ? 'trade-config' : 'market_observations',
        missing: benchmarkMissing,
        value: benchmark === undefined ? { symbol: ports.benchmark, status: 'missing' } : {
          symbol: ports.benchmark,
          series: benchmark.series,
          correlation: benchmark.correlation,
          relativeStrength: benchmark.relativeStrength,
        },
      },
      portfolio: {
        asOf: portfolioValue.observedAt as number | null,
        source: 'broker.getAccount+getPositions+getOpenOrders',
        missing: portfolioMissing,
        value: portfolioValue,
      },
      activePlan: {
        asOf: activePlan?.createdAt ?? asOf,
        source: 'plan-store',
        missing: [],
        value: activePlan === undefined ? { state: 'empty', card: null } : {
          state: 'active',
          card: { ...activePlan, thesis: { text: activePlan.thesis, untrustedText: true } },
        },
      },
      history: {
        asOf: history.at(0)?.decidedAt ?? asOf,
        source: 'decision-journal+outcomes',
        missing: [],
        value: historyValue,
      },
      lessons: {
        asOf: null,
        source: 'lessons.disabled-by-default',
        missing: [],
        value: { state: 'disabled', items: [], reason: 'R5 ablation has not enabled lesson injection' },
      },
      predictions,
    },
  })
  // 确认全文是可序列化 JSON；renderer 再按最终 request 的真实长度执行 maxChars 闸门。
  canonicalJson(context)
  return context
}
