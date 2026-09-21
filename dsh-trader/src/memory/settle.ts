/**
 * 结算与反思（plan §7.9 / T1.4）。
 *
 * 四条硬性设计：
 *   1. **交易级**结算：用**实际成交**（fills）取入场，按归因数量计算 gross 与可核验成本 ——
 *      不是"5 根 bar 的收盘到收盘"那种弱代理；基准用 BTC/ETH，**不是 SPY**；
 *   2. **独立扫描全部 pending**：不依赖"下次恰好重跑同一标的"，一次性标的也不会悬空；
 *   3. **反思闸门是机械的**：只在外部结算之后写、每条反思必须带**证据指针**、有 TTL 与字数上限；
 *   4. **反思器看不到历史反思**：入参只有 { decision, outcome }（结构上排除"自己给自己打分"）。
 *
 * 结算幂等由 `outcomes.decision_id UNIQUE` 保证；反思幂等由 `lessons.decision_id UNIQUE` 保证。
 */

import type { Clock } from '../clock.js'
import type { BarArchive } from '../market/archive.js'
import { fingerprint } from '../util/canonical.js'
import type {
  DecisionJournal,
  FillView,
  OutcomeRecord,
  PendingSettlement,
  SettlementKind,
  SettlementValuationBasis,
} from '../exec/journal.js'

const MIN_HORIZON_MS = 4 * 3_600_000
const MAX_HORIZON_MS = 24 * 3_600_000
const BAR_MS_BY_TIMEFRAME: Readonly<Record<string, number>> = {
  '1m': 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '1d': 24 * 3_600_000,
}

/**
 * 按四根 bar 推导结算视界并夹在 4h–24h；未知 tf 直接报错，避免静默污染结算样本。
 */
export function horizonMsForTimeframe(tf: string): number {
  const barMs = BAR_MS_BY_TIMEFRAME[tf]
  if (barMs === undefined) throw new Error(`未知结算时间框架：${tf}`)
  return Math.min(Math.max(4 * barMs, MIN_HORIZON_MS), MAX_HORIZON_MS)
}

/** 反思已由 §5.3 闸门限制为短、可检索，用 quick tier 足够（§12 #18）。 */
export const REFLECTOR_TIER = 'quick' as const

export function reflectorRoute(routing: { readonly deep: unknown; readonly quick: unknown }): unknown {
  return routing.quick
}

// ── 结算 ─────────────────────────────────────────────────────────────────────

export type { FillView }

export interface FundingCost {
  /** 正数为支付、负数为收入；必须来自明确核验的资金费记录。 */
  readonly amountQuote: number
  readonly source: string
}

export interface FundingCostRequest {
  readonly decision: PendingSettlement
  readonly from: number
  readonly until: number
  readonly quantity: number | null
  readonly direction: 1 | -1
  /** 相关历史入场/出场成交；多次减仓的资金费归因需据此重建区间敞口。 */
  readonly fills: readonly FillView[]
}

export type FundingCostResolver = (
  request: FundingCostRequest,
) => FundingCost | null | Promise<FundingCost | null>

export interface SettlementInputs {
  readonly decision: PendingSettlement
  readonly fills: readonly FillView[]
  readonly entryPrice: number
  readonly direction: 1 | -1
  readonly bars: readonly { readonly openTime: number; readonly high: number; readonly low: number; readonly close: number }[]
  readonly benchmarkBars: readonly { readonly openTime: number; readonly close: number }[]
  /** 已确认的真实出场成交；缺失时才使用 horizon mark。 */
  readonly exitPrice?: number
  /** 已归因的成交数量与手续费；close/reduce 会按实际平仓量分摊原始入场费。 */
  readonly attributedQty?: number | null
  readonly attributedFeesQuote?: number | null
  /** 多次部分出场与 horizon residual 混合时，按 quote PnL/初始名义计算的总收益率。 */
  readonly grossPctOverride?: number
  /** 默认由是否传入 exitPrice 推导；混合实际减仓与剩余 mark 时显式标记 horizon_mark。 */
  readonly valuationBasis?: SettlementValuationBasis
  /** 未取得资金费时不传；结果中的 net 保持 unknown，而非按零成本处理。 */
  readonly fundingCost?: FundingCost | null
}

export interface SettlementComputation {
  readonly exitPrice: number
  readonly realizedGrossPct: number
  readonly realizedNetPct: number | null
  readonly benchmarkPct: number | null
  readonly alphaPct: number | null
  readonly mfePct: number
  readonly maePct: number
  readonly stopHit: boolean
  readonly feesQuote: number | null
  readonly fundingFeeQuote: number | null
  readonly fundingSource: string | null
  readonly settlementKind: SettlementKind
  readonly valuationBasis: SettlementValuationBasis
  readonly attributedQty: number | null
  readonly evidenceRefs: readonly string[]
}

/**
 * 成交价是权威成交值；paper 撮合已经把滑点写进 fill.price，结算不能再次扣估算值。
 * options 保留旧调用形状，但 slippageBps 不再用于覆盖真实成交或 horizon mark。
 */
export function computeSettlement(
  inputs: SettlementInputs,
  _options: { readonly slippageBps: number },
): SettlementComputation {
  const { decision, fills, entryPrice, direction, bars, benchmarkBars } = inputs
  const feesQuote = inputs.attributedFeesQuote !== undefined
    ? inputs.attributedFeesQuote
    : fills.every((fill) => fill.fee !== null && Number.isFinite(fill.fee))
      ? fills.reduce((sum, fill) => sum + (fill.fee as number), 0)
      : null
  const attributedQty = inputs.attributedQty !== undefined
    ? inputs.attributedQty
    : fills.length > 0
      ? fills.reduce((sum, fill) => sum + Math.abs(fill.qty), 0)
      : null
  const notional = attributedQty !== null && Number.isFinite(attributedQty) && attributedQty > 0
    ? entryPrice * attributedQty
    : null
  const feesPct = feesQuote === null || notional === null ? null : notional > 0 ? (feesQuote / notional) * 100 : null
  const fundingCost = inputs.fundingCost ?? null
  if (fundingCost !== null && (!Number.isFinite(fundingCost.amountQuote) || fundingCost.source.trim() === '')) {
    throw new Error('资金费必须包含有限金额和非空来源')
  }
  const fundingPct = fundingCost === null || notional === null ? null : (fundingCost.amountQuote / notional) * 100

  const exitPrice = inputs.exitPrice ?? (bars.length > 0 ? (bars[bars.length - 1] as { close: number }).close : entryPrice)
  const calculatedGrossPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 * direction : 0
  const grossPct = inputs.grossPctOverride ?? calculatedGrossPct
  if (!Number.isFinite(grossPct)) throw new Error('结算 grossPct 非有限数')
  const netPct = feesPct === null || fundingPct === null ? null : grossPct - feesPct - fundingPct

  let mfePct = 0
  let maePct = 0
  let stopHit = false
  for (const bar of bars) {
    const favourable = direction === 1 ? (bar.high - entryPrice) / entryPrice : (entryPrice - bar.low) / entryPrice
    const adverse = direction === 1 ? (bar.low - entryPrice) / entryPrice : (entryPrice - bar.high) / entryPrice
    mfePct = Math.max(mfePct, favourable * 100)
    maePct = Math.min(maePct, adverse * 100)
    if (decision.stopPrice !== null && decision.stopPrice !== undefined) {
      if (direction === 1 && bar.low <= decision.stopPrice) stopHit = true
      if (direction === -1 && bar.high >= decision.stopPrice) stopHit = true
    }
  }

  const firstBenchmarkBar = benchmarkBars[0]
  const lastBenchmarkBar = benchmarkBars[benchmarkBars.length - 1]
  const benchmarkCoversWindow = benchmarkBars.length >= 2 && bars.length >= 2 &&
    firstBenchmarkBar?.openTime === (bars[0] as { openTime: number }).openTime &&
    lastBenchmarkBar?.openTime === (bars[bars.length - 1] as { openTime: number }).openTime
  const firstBenchmark = benchmarkCoversWindow ? (firstBenchmarkBar as { close: number }).close : null
  const lastBenchmark = benchmarkCoversWindow
    ? (benchmarkBars[benchmarkBars.length - 1] as { close: number }).close
    : null
  const benchmarkPct = firstBenchmark !== null && lastBenchmark !== null &&
      Number.isFinite(firstBenchmark) && Number.isFinite(lastBenchmark) && firstBenchmark > 0 && lastBenchmark > 0
    ? ((lastBenchmark - firstBenchmark) / firstBenchmark) * 100
    : null
  const valuationBasis: SettlementValuationBasis = inputs.valuationBasis ??
    (inputs.exitPrice === undefined ? 'horizon_mark' : 'actual_exit_fills')
  const isPaperSimulation = fills.some((fill) => fill.venue === 'paper')
  const settlementKind: SettlementKind = isPaperSimulation
    ? 'paper_simulation'
    : valuationBasis === 'actual_exit_fills'
      ? 'realized'
      : 'horizon_mark'

  const evidenceRefs = [
    `decision:${decision.decisionId}`,
    ...fills.map((fill) => `fill:${fill.fillId}`),
    ...(bars.length > 0
      ? [`bar:${decision.symbol}:${(bars[0] as { openTime: number }).openTime}`,
         `bar:${decision.symbol}:${(bars[bars.length - 1] as { openTime: number }).openTime}`]
      : []),
    ...(benchmarkPct !== null
      ? [
          `bar:benchmark:${(benchmarkBars[0] as { openTime: number }).openTime}`,
          `bar:benchmark:${(benchmarkBars[benchmarkBars.length - 1] as { openTime: number }).openTime}`,
        ]
      : ['benchmark:unavailable']),
    ...(fundingCost === null ? ['funding:unavailable'] : [`funding:${fundingCost.source}`]),
  ]

  return {
    exitPrice,
    realizedGrossPct: grossPct,
    realizedNetPct: netPct,
    benchmarkPct,
    alphaPct: netPct === null || benchmarkPct === null ? null : netPct - benchmarkPct,
    mfePct,
    maePct,
    stopHit,
    feesQuote,
    fundingFeeQuote: fundingCost?.amountQuote ?? null,
    fundingSource: fundingCost?.source ?? null,
    settlementKind,
    valuationBasis,
    attributedQty,
    evidenceRefs,
  }
}

/**
 * 由一串成交重建持仓（数量 + 均价）—— 用于给 `reduce`/`close` 决策找回**真实入场**。
 * 与 `PaperBroker.#fill` 同一套均价规则：加仓按量加权，减仓不改均价，反向不会"翻仓
 * 却留着旧均价"（数量符号翻转时均价归零）。
 */
export function reconstructPosition(
  fills: readonly { readonly qty: number; readonly price: number; readonly side: string }[],
): { readonly qty: number; readonly avgPrice: number } {
  let qty = 0
  let avgPrice = 0
  for (const fill of fills) {
    const signed = fill.side === 'sell' ? -Math.abs(fill.qty) : Math.abs(fill.qty)
    if (qty === 0 || Math.sign(qty) === Math.sign(signed)) {
      const next = qty + signed
      avgPrice = next === 0 ? 0 : (avgPrice * Math.abs(qty) + fill.price * Math.abs(signed)) / Math.abs(next)
      qty = next
    } else {
      qty += signed
      if (qty === 0) avgPrice = 0
      // 部分平仓不改剩余持仓的均价
    }
  }
  return { qty, avgPrice }
}

interface PositionAccounting {
  readonly qty: number
  readonly avgPrice: number
  /** 当前剩余仓位对应的入场手续费；null 表示历史成本有缺口。 */
  readonly entryFeesQuote: number | null
  readonly openedAt: number | null
}

/** 同时重建均价、未平仓入场费和仓位起点，供部分减仓按实际数量分摊成本。 */
function reconstructPositionAccounting(fills: readonly FillView[]): PositionAccounting {
  let qty = 0
  let avgPrice = 0
  let entryFeesQuote: number | null = 0
  let openedAt: number | null = null

  for (const fill of fills) {
    const size = Math.abs(fill.qty)
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(fill.price) || fill.price <= 0) {
      throw new Error(`成交数量或价格无效：${fill.fillId}`)
    }
    const side = fill.side.toLowerCase()
    if (side !== 'buy' && side !== 'sell') throw new Error(`成交方向无效：${fill.fillId}`)
    if (fill.fee !== null && !Number.isFinite(fill.fee)) throw new Error(`成交手续费无效：${fill.fillId}`)
    const signed = side === 'sell' ? -size : size

    if (qty === 0 || Math.sign(qty) === Math.sign(signed)) {
      const previousSize = Math.abs(qty)
      const next = qty + signed
      avgPrice = next === 0 ? 0 : (avgPrice * previousSize + fill.price * size) / Math.abs(next)
      qty = next
      entryFeesQuote = entryFeesQuote === null || fill.fee === null ? null : entryFeesQuote + fill.fee
      openedAt = openedAt === null ? fill.ts : Math.min(openedAt, fill.ts)
      continue
    }

    const previousSize = Math.abs(qty)
    const closedSize = Math.min(previousSize, size)
    const remainingSize = previousSize - closedSize
    const next = qty + signed
    if (remainingSize > 0) {
      qty = Math.sign(qty) * remainingSize
      if (entryFeesQuote !== null) entryFeesQuote *= remainingSize / previousSize
      continue
    }

    if (next === 0) {
      qty = 0
      avgPrice = 0
      entryFeesQuote = 0
      openedAt = null
      continue
    }

    // 单笔反向成交超过旧仓位时，旧仓完全平掉，超出部分才构成新仓。
    const openedSize = Math.abs(next)
    qty = next
    avgPrice = fill.price
    entryFeesQuote = fill.fee === null ? null : fill.fee * (openedSize / size)
    openedAt = fill.ts
  }

  return { qty, avgPrice, entryFeesQuote, openedAt }
}

function weightedFillPrice(fills: readonly FillView[], expectedSide?: 'buy' | 'sell'): {
  readonly qty: number
  readonly price: number
} {
  if (fills.length === 0) throw new Error('没有可归因的成交')
  const firstSide = fills[0]?.side.toLowerCase()
  if (firstSide !== 'buy' && firstSide !== 'sell') throw new Error('成交方向缺失或无效')
  const side = expectedSide ?? firstSide
  let qty = 0
  let notional = 0
  for (const fill of fills) {
    if (fill.side.toLowerCase() !== side) throw new Error('同一决策的成交方向不一致，拒绝净额归因')
    const size = Math.abs(fill.qty)
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(fill.price) || fill.price <= 0) {
      throw new Error(`成交数量或价格无效：${fill.fillId}`)
    }
    qty += size
    notional += size * fill.price
  }
  if (expectedSide !== undefined && side !== expectedSide) throw new Error('平仓成交方向与持仓方向冲突')
  return { qty, price: notional / qty }
}

function knownFees(fills: readonly FillView[]): number | null {
  if (fills.some((fill) => fill.fee === null || !Number.isFinite(fill.fee))) return null
  return fills.reduce((sum, fill) => sum + (fill.fee as number), 0)
}

interface OpenDecisionAccounting {
  readonly direction: 1 | -1
  readonly entryPrice: number
  readonly attributedQty: number
  readonly attributedFeesQuote: number | null
  readonly positionQty: number
  readonly positionAvgPrice: number
  readonly realizedGrossQuote: number
  readonly pathStart: number
  readonly horizonEnd: number
  readonly evidenceFills: readonly FillView[]
}

/** 将开仓与其 reduce-only 保护腿按时序合并，避免把保护单成交误当成第二次入场。 */
function accountOpenDecisionFills(
  previousFills: readonly FillView[],
  decisionFills: readonly FillView[],
  horizonMs: number,
): OpenDecisionAccounting {
  const entryFills = decisionFills.filter((fill) => fill.reduceOnly !== true)
  if (entryFills.length === 0) throw new Error('开仓决策缺少非 reduce-only 入场成交')
  const entry = weightedFillPrice(entryFills)
  const firstSide = entryFills[0]?.side.toLowerCase()
  if (firstSide !== 'buy' && firstSide !== 'sell') throw new Error('开仓成交方向缺失或无效')
  const direction: 1 | -1 = firstSide === 'buy' ? 1 : -1
  const before = reconstructPositionAccounting(previousFills)
  if (before.qty !== 0 && Math.sign(before.qty) !== direction) {
    throw new Error('开仓决策与成交前持仓方向相反，拒绝混合归因')
  }

  let positionQty = before.qty
  let positionAvgPrice = before.avgPrice
  let realizedGrossQuote = 0
  let totalQty = Math.abs(before.qty)
  let totalNotional = totalQty * before.avgPrice
  let feesQuote = before.entryFeesQuote
  let openedAt = before.openedAt
  const ordered = [...decisionFills].sort((left, right) =>
    left.ts - right.ts || Number(left.reduceOnly === true) - Number(right.reduceOnly === true) ||
    left.fillId.localeCompare(right.fillId))

  for (const fill of ordered) {
    const size = Math.abs(fill.qty)
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(fill.price) || fill.price <= 0) {
      throw new Error(`成交数量或价格无效：${fill.fillId}`)
    }
    const side = fill.side.toLowerCase()
    if (side !== 'buy' && side !== 'sell') throw new Error(`成交方向无效：${fill.fillId}`)
    if (fill.fee !== null && !Number.isFinite(fill.fee)) throw new Error(`成交手续费无效：${fill.fillId}`)
    const signed = side === 'buy' ? size : -size

    if (fill.reduceOnly === true) {
      if (positionQty === 0 || Math.sign(signed) === Math.sign(positionQty) || Math.sign(positionQty) !== direction) {
        throw new Error(`reduce-only 成交不能关闭当前归因仓位：${fill.fillId}`)
      }
      if (size > Math.abs(positionQty) + 1e-10) {
        throw new Error(`保护成交量超过当前归因仓位：${size} > ${Math.abs(positionQty)}`)
      }
      realizedGrossQuote += (fill.price - positionAvgPrice) * Math.min(size, Math.abs(positionQty)) * direction
      positionQty += signed
      if (feesQuote !== null) feesQuote = fill.fee === null ? null : feesQuote + fill.fee
      if (Math.abs(positionQty) <= 1e-10) {
        positionQty = 0
        positionAvgPrice = 0
        openedAt = null
      }
      continue
    }

    if (Math.sign(signed) !== direction || (positionQty !== 0 && Math.sign(positionQty) !== direction)) {
      throw new Error(`开仓成交方向不一致：${fill.fillId}`)
    }
    const nextQty = positionQty + signed
    const oldSize = Math.abs(positionQty)
    positionAvgPrice = nextQty === 0
      ? 0
      : (positionAvgPrice * oldSize + fill.price * size) / Math.abs(nextQty)
    positionQty = nextQty
    totalQty += size
    totalNotional += size * fill.price
    openedAt = openedAt === null ? fill.ts : Math.min(openedAt, fill.ts)
    if (feesQuote !== null) feesQuote = fill.fee === null ? null : feesQuote + fill.fee
  }

  if (totalQty <= 0 || totalNotional <= 0) throw new Error('开仓决策无有效归因名义')
  const firstEntryAt = Math.min(...entryFills.map((fill) => fill.ts))
  return {
    direction,
    entryPrice: totalNotional / totalQty,
    attributedQty: totalQty,
    attributedFeesQuote: feesQuote,
    positionQty,
    positionAvgPrice,
    realizedGrossQuote,
    pathStart: before.openedAt ?? firstEntryAt,
    horizonEnd: firstEntryAt + horizonMs,
    evidenceFills: [...previousFills, ...decisionFills],
  }
}

// ── 反思闸门 ─────────────────────────────────────────────────────────────────
export interface ReflectionCandidate {
  readonly text: string
  readonly evidenceRefs: readonly string[]
}

export interface ReflectionGateConfig {
  /** 单条反思的字数上限（仿 Reflexion 的 Ω=1–3 思路：短、少、可检索）。 */
  readonly maxCharsPerLesson: number
  /** 反思的存活时间 —— 过期的教训不应继续影响判断。 */
  readonly ttlMs: number
}

export const DEFAULT_REFLECTION_GATES: ReflectionGateConfig = {
  maxCharsPerLesson: 600,
  ttlMs: 30 * 24 * 3_600_000,
}

export type ReflectionVerdict =
  | {
      readonly ok: true
      readonly text: string
      readonly evidenceRefs: readonly string[]
      readonly expiresAt: number
    }
  | { readonly ok: false; readonly reason: string }

/**
 * 反思准入（四条闸门里的三条在这里落地；"只在外部结算后写"由调用位置保证）：
 *   · 必须有证据指针，且**只能引用结算真实产生过的证据**；
 *   · 有字数上限；
 *   · 有 TTL。
 */
export function acceptReflection(
  candidate: ReflectionCandidate,
  outcome: OutcomeRecord,
  gates: ReflectionGateConfig,
): ReflectionVerdict {
  const text = typeof candidate.text === 'string' ? candidate.text.trim() : ''
  if (text === '') return { ok: false, reason: '反思文本为空' }
  if (text.length > gates.maxCharsPerLesson) {
    return { ok: false, reason: `反思超出字数上限 ${gates.maxCharsPerLesson}（收到 ${text.length}）` }
  }
  const refs = Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : []
  if (refs.length === 0) return { ok: false, reason: '反思没有携带证据指针（不可证伪）' }
  const known = new Set(outcome.evidenceRefs)
  const unknown = refs.filter((ref) => !known.has(ref))
  if (unknown.length > 0) {
    return { ok: false, reason: `反思引用了结算未产生的证据：${unknown.join(', ')}` }
  }
  return {
    ok: true,
    text,
    evidenceRefs: refs,
    expiresAt: outcome.settledAt + gates.ttlMs,
  }
}

// ── 反思器（模型侧的唯一接口）────────────────────────────────────────────────

/**
 * 反思器入参**只有** decision 与 outcome。
 * 结构上不可能把"过去的反思"喂回来 —— 那正是 Reflexion 消融里 0.60 → 0.52 的那条路径。
 */
export interface ReflectionInput {
  readonly decision: {
    readonly decisionId: string
    readonly symbol: string
    readonly action: string
    readonly sizeQty: number | null
    readonly stopPrice: number | null
    readonly takeProfit: number | null
    readonly confidence: number | null
    readonly rationale: string | null
  }
  readonly outcome: OutcomeRecord
}

export type Reflector = (input: ReflectionInput) => Promise<ReflectionCandidate>

// ── 调度 ─────────────────────────────────────────────────────────────────────

export interface SettlementDeps {
  readonly journal: DecisionJournal
  readonly bars: BarArchive
  readonly clock: Clock
  readonly timeframe: string
  /** 结算视界：决策后多久结算。 */
  readonly horizonMs?: number
  readonly benchmarkSymbol: string
  /** 旧配置保留供组合根兼容；成交价已含撮合/交易执行滑点，结算不重复扣估算值。 */
  readonly slippageBps: number
  /** 不接资金费数据时返回/保持 null；不能用默认 0 伪造净收益。 */
  readonly resolveFundingCost?: FundingCostResolver
  readonly reflector?: Reflector
  readonly gates?: ReflectionGateConfig
}

export interface SettlementRunResult {
  readonly scanned: number
  readonly settled: number
  readonly skipped: number
  /**
   * 因**数据不足**而推迟的条数（保持 pending，下一轮重试）。
   *
   * 为什么必须显式区分"没结算"和"不能结算"：没有价格基准时写一条
   * `entry_price = 0` 的 outcome 会污染 lessons 与 alpha 统计 —— 那是**编造数据**。
   */
  readonly deferred: number
  /** 被推迟的决策 id（可操作：缺的是哪个标的的行情一眼可见）。 */
  readonly deferredIds: readonly string[]
  readonly reflectionsWritten: number
  readonly reflectionsRejected: readonly { readonly decisionId: string; readonly reason: string }[]
  readonly errors: readonly { readonly decisionId: string; readonly reason: string }[]
}

export class SettlementScheduler {
  constructor(private readonly deps: SettlementDeps) {}

  /** 扫描**全部**到期的 pending 并结算。可重复调用（幂等）。 */
  async runOnce(now: number, limit = 20): Promise<SettlementRunResult> {
    const gates = this.deps.gates ?? DEFAULT_REFLECTION_GATES
    const horizonMs = this.deps.horizonMs ?? horizonMsForTimeframe(this.deps.timeframe)
    // 按 tf 过滤：每个 scheduler 只结算自己时间框的决策。否则多 tf 下会用错 bar 窗口
    //（`horizonEnd = decidedAt + horizonMs(this.deps.timeframe)` 对别的 tf 是错的）。
    const pending = this.deps.journal.pendingSettlements(now, limit, this.deps.timeframe)

    let settled = 0
    let skipped = 0
    const deferredIds: string[] = []
    let reflectionsWritten = 0
    const reflectionsRejected: { decisionId: string; reason: string }[] = []
    const errors: { decisionId: string; reason: string }[] = []

    for (const decision of pending) {
      try {
        // 旧版本曾把 outcome 与 decisions.outcome_id 分两次写；先修复该 crash gap，
        // 避免数据源暂时不可用时已存在的结算仍永久留在 pending。
        if (this.deps.journal.repairOutcomeAssociation(decision.decisionId)) {
          skipped += 1
          continue
        }

        const fills = this.deps.journal.fillsForDecision(decision.decisionId)
        // reflection_due_at 只应由终态成交设置；若成交明细缺失，拒绝构造“无仓位”的收益样本。
        if (fills.length === 0) {
          deferredIds.push(decision.decisionId)
          continue
        }
        const isExit = decision.action === 'reduce' || decision.action === 'close'
        let decisionFills = fills
        if (!isExit) {
          const entryFills = fills.filter((fill) => fill.reduceOnly !== true)
          if (entryFills.length === 0) {
            deferredIds.push(decision.decisionId)
            continue
          }
          // 开仓的 horizon 从首笔实际成交起算；视界之后才成交的保护腿不能改写该 outcome。
          const horizonEnd = Math.min(...entryFills.map((fill) => fill.ts)) + horizonMs
          decisionFills = fills.filter((fill) => fill.ts <= horizonEnd)
        }
        if (decisionFills.some((fill) => fill.fee === null || !Number.isFinite(fill.fee))) {
          deferredIds.push(decision.decisionId)
          continue
        }

        let direction: 1 | -1
        let entryPrice: number
        let attributedQty: number | null
        let attributedFeesQuote: number | null
        let exitPrice: number | undefined
        let grossPctOverride: number | undefined
        let valuationBasis: SettlementValuationBasis | undefined
        let openAccounting: OpenDecisionAccounting | undefined
        let evidenceFills: readonly FillView[] = decisionFills
        let pathStart: number
        let pathEnd: number
        let fundingFrom = decision.decidedAt
        let fundingUntil: number

        if (isExit) {
          if (decisionFills.length === 0) {
            deferredIds.push(decision.decisionId)
            continue
          }
          // ★ 平/减仓必须对齐**真实入场**：用该标的在此次成交之前的全部成交重建持仓。
          // 平仓是部分成交时，入场费按实际退出量占当前仓位的比例分摊。
          const venue = (decisionFills[0] as FillView).venue
          if (decisionFills.some((fill) => fill.venue !== venue)) {
            throw new Error('同一决策跨执行场所成交，拒绝混合账户归因')
          }
          const before = Math.min(...decisionFills.map((fill) => fill.ts))
          const previousFills = this.deps.journal.fillsForSymbolBefore(decision.symbol, before, venue)
          const position = reconstructPositionAccounting(previousFills)
          if (position.qty === 0) {
            // 找不到入场成交 ⇒ 缺数据，推迟而不是编造一个 0 收益的交易（plan §12 #20）
            deferredIds.push(decision.decisionId)
            continue
          }
          direction = position.qty > 0 ? 1 : -1
          entryPrice = position.avgPrice
          const expectedExitSide = direction === 1 ? 'sell' : 'buy'
          const exit = weightedFillPrice(decisionFills, expectedExitSide)
          if (exit.qty > Math.abs(position.qty) + 1e-10) {
            throw new Error(`平仓成交量超过成交前持仓：${exit.qty} > ${Math.abs(position.qty)}`)
          }
          exitPrice = exit.price
          attributedQty = exit.qty
          const exitFees = knownFees(decisionFills)
          const allocatedEntryFees = position.entryFeesQuote === null
            ? null
            : position.entryFeesQuote * (exit.qty / Math.abs(position.qty))
          attributedFeesQuote = exitFees === null || allocatedEntryFees === null
            ? null
            : exitFees + allocatedEntryFees
          evidenceFills = [...previousFills, ...decisionFills]
          pathStart = position.openedAt ?? before
          pathEnd = Math.max(...decisionFills.map((fill) => fill.ts))
          fundingFrom = pathStart
          fundingUntil = pathEnd
        } else {
          const entryFills = decisionFills.filter((fill) => fill.reduceOnly !== true)
          const protectiveFills = decisionFills.filter((fill) => fill.reduceOnly === true)
          const venue = (entryFills[0] as FillView).venue
          if (decisionFills.some((fill) => fill.venue !== venue)) {
            throw new Error('同一决策跨执行场所成交，拒绝混合账户归因')
          }
          if (protectiveFills.length === 0) {
            const entry = weightedFillPrice(entryFills)
            direction = (entryFills[0] as FillView).side.toLowerCase() === 'sell' ? -1 : 1
            entryPrice = entry.price
            attributedQty = entry.qty
            attributedFeesQuote = knownFees(entryFills)
            pathStart = Math.min(...entryFills.map((fill) => fill.ts))
            pathEnd = pathStart + horizonMs
            fundingFrom = pathStart
            fundingUntil = pathEnd
          } else {
            const before = Math.min(...entryFills.map((fill) => fill.ts))
            const previousFills = this.deps.journal.fillsForSymbolBefore(decision.symbol, before, venue)
            const accounting = accountOpenDecisionFills(previousFills, decisionFills, horizonMs)
            openAccounting = accounting
            direction = accounting.direction
            entryPrice = accounting.entryPrice
            attributedQty = accounting.attributedQty
            attributedFeesQuote = accounting.attributedFeesQuote
            evidenceFills = accounting.evidenceFills
            pathStart = accounting.pathStart
            pathEnd = accounting.positionQty === 0
              ? Math.max(...protectiveFills.map((fill) => fill.ts))
              : accounting.horizonEnd
            fundingFrom = pathStart
            fundingUntil = pathEnd
            valuationBasis = accounting.positionQty === 0 ? 'actual_exit_fills' : 'horizon_mark'
          }
        }

        const timeframeMs = BAR_MS_BY_TIMEFRAME[this.deps.timeframe]
        if (timeframeMs === undefined) throw new Error(`未知结算时间框架：${this.deps.timeframe}`)
        // 只用完全落在“实际持仓开始 → 出场/视界结束”内的已收盘 bar；出场后行情不能参与 MFE/MAE/止损或基准。
        const loadPathBars = (symbol: string) => this.deps.bars.closedBars(symbol, this.deps.timeframe, {
          since: pathStart,
          until: pathEnd,
        }).filter((bar) => bar.openTime >= pathStart &&
          bar.closeTime === bar.openTime + timeframeMs && bar.closeTime <= pathEnd)
        const bars = loadPathBars(decision.symbol)
        // 没有完整持仓路径 bar 时保留 pending；不能拿出场后的 bar 补齐路径指标。
        if (bars.length === 0) {
          deferredIds.push(decision.decisionId)
          continue
        }
        if (openAccounting !== undefined) {
          const totalNotional = entryPrice * (attributedQty ?? 0)
          if (totalNotional <= 0) throw new Error('保护成交归因名义无效')
          if (openAccounting.positionQty === 0) {
            const exit = weightedFillPrice(
              decisionFills.filter((fill) => fill.reduceOnly === true),
              direction === 1 ? 'sell' : 'buy',
            )
            exitPrice = exit.price
            valuationBasis = 'actual_exit_fills'
            grossPctOverride = (openAccounting.realizedGrossQuote / totalNotional) * 100
          } else {
            const markPrice = (bars[bars.length - 1] as { close: number }).close
            const totalGrossQuote = openAccounting.realizedGrossQuote +
              openAccounting.positionQty * (markPrice - openAccounting.positionAvgPrice)
            exitPrice = markPrice
            valuationBasis = 'horizon_mark'
            grossPctOverride = (totalGrossQuote / totalNotional) * 100
          }
        }
        const benchmarkBars = loadPathBars(this.deps.benchmarkSymbol)
        const fundingCost = await this.deps.resolveFundingCost?.({
          decision,
          from: fundingFrom,
          until: fundingUntil,
          quantity: attributedQty,
          direction,
          fills: evidenceFills,
        }) ?? null
        const computation = computeSettlement(
          {
            decision,
            fills: evidenceFills,
            entryPrice,
            direction,
            bars,
            benchmarkBars,
            ...(exitPrice === undefined ? {} : { exitPrice }),
            attributedQty,
            attributedFeesQuote,
            ...(grossPctOverride === undefined ? {} : { grossPctOverride }),
            ...(valuationBasis === undefined ? {} : { valuationBasis }),
            fundingCost,
          },
          { slippageBps: this.deps.slippageBps },
        )

        const outcome: OutcomeRecord = {
          outcomeId: `outcome:${fingerprint({ decisionId: decision.decisionId, settledAt: now }).slice(7, 23)}`,
          decisionId: decision.decisionId,
          symbol: decision.symbol,
          settledAt: now,
          horizonMs,
          entryPrice,
          ...computation,
        }

        // 未平仓 mark、paper simulation 或成本/基准不全的结果都不能生成 lesson。
        const canReflect = this.deps.reflector !== undefined &&
          computation.settlementKind === 'realized' &&
          computation.realizedNetPct !== null &&
          computation.benchmarkPct !== null
        const inserted = this.deps.journal.recordOutcomeAndLink(
          outcome,
          canReflect ? 'reflection_configured' : 'settlement_only',
        )
        if (!inserted) {
          skipped += 1
          continue
        }
        settled += 1

        if (!canReflect || this.deps.reflector === undefined) continue
        const candidate = await this.deps.reflector({
          decision: {
            decisionId: decision.decisionId,
            symbol: decision.symbol,
            action: decision.action,
            sizeQty: decision.sizeQty,
            stopPrice: decision.stopPrice,
            takeProfit: decision.takeProfit,
            confidence: decision.confidence,
            rationale: decision.rationale,
          },
          outcome,
        })
        const verdict = acceptReflection(candidate, outcome, gates)
        if (!verdict.ok) {
          reflectionsRejected.push({ decisionId: decision.decisionId, reason: verdict.reason })
          continue
        }
        const written = this.deps.journal.recordLesson({
          lessonId: `lesson:${outcome.outcomeId}`,
          decisionId: decision.decisionId,
          text: verdict.text,
          evidenceRefs: verdict.evidenceRefs,
          createdAt: now,
          expiresAt: verdict.expiresAt,
        })
        if (written) reflectionsWritten += 1
      } catch (error) {
        errors.push({ decisionId: decision.decisionId, reason: String(error) })
      }
    }

    return {
      scanned: pending.length,
      settled,
      skipped,
      deferred: deferredIds.length,
      deferredIds,
      reflectionsWritten,
      reflectionsRejected,
      errors,
    }
  }
}
