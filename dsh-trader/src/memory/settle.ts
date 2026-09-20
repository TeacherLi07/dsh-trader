/**
 * 结算与反思（plan §7.9 / T1.4）。
 *
 * 四条硬性设计：
 *   1. **交易级**结算：用**实际成交**（fills）取入场，按实际仓位算，扣手续费与滑点 ——
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
import type { DecisionJournal, FillView, OutcomeRecord, PendingSettlement } from '../exec/journal.js'

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

export interface SettlementInputs {
  readonly decision: PendingSettlement
  readonly fills: readonly FillView[]
  readonly entryPrice: number
  readonly direction: 1 | -1
  readonly bars: readonly { readonly openTime: number; readonly high: number; readonly low: number; readonly close: number }[]
  readonly benchmarkBars: readonly { readonly openTime: number; readonly close: number }[]
  /** 已确认的真实出场成交；缺失时才使用 horizon mark。 */
  readonly exitPrice?: number
}

export interface SettlementComputation {
  readonly exitPrice: number
  readonly realizedGrossPct: number
  readonly realizedNetPct: number
  readonly benchmarkPct: number
  readonly alphaPct: number
  readonly mfePct: number
  readonly maePct: number
  readonly stopHit: boolean
  readonly feesQuote: number
  readonly evidenceRefs: readonly string[]
}

/**
 * 纯函数：由实际成交 + 持有窗口内的 bar 算出交易级净额。
 * `slippageBps` 按**入场与出场各一次**计（这是我们对执行成本的显式假设，不是实测）。
 */
export function computeSettlement(
  inputs: SettlementInputs,
  options: { readonly slippageBps: number },
): SettlementComputation {
  const { decision, fills, entryPrice, direction, bars, benchmarkBars } = inputs

  if (fills.some((fill) => fill.fee === null || !Number.isFinite(fill.fee))) {
    throw new Error('成交手续费未知，不能按 0 结算')
  }
  const feesQuote = fills.reduce((sum, fill) => sum + (fill.fee as number), 0)
  // 仓位规模取**首笔（入场腿）**的数量，而不是所有成交之和：
  // 保护单成交现在也会归属到同一条决策，求和会把两条腿叠加成 2× 仓位。
  const qty = fills.length > 0 ? Math.abs((fills[0] as FillView).qty) : 0
  const notional = entryPrice * (qty > 0 ? qty : 1)
  const feesPct = notional > 0 ? (feesQuote / notional) * 100 : 0
  const slippagePct = 2 * (options.slippageBps / 10_000) * 100

  const exitPrice = inputs.exitPrice ?? (bars.length > 0 ? (bars[bars.length - 1] as { close: number }).close : entryPrice)
  const grossPct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 * direction : 0
  const netPct = grossPct - feesPct - slippagePct

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

  const firstBenchmark = benchmarkBars.length > 0 ? (benchmarkBars[0] as { close: number }).close : 0
  const lastBenchmark =
    benchmarkBars.length > 0 ? (benchmarkBars[benchmarkBars.length - 1] as { close: number }).close : 0
  const benchmarkPct =
    firstBenchmark > 0 ? ((lastBenchmark - firstBenchmark) / firstBenchmark) * 100 : 0

  const evidenceRefs = [
    `decision:${decision.decisionId}`,
    ...fills.map((fill) => `fill:${fill.fillId}`),
    ...(bars.length > 0
      ? [`bar:${decision.symbol}:${(bars[0] as { openTime: number }).openTime}`,
         `bar:${decision.symbol}:${(bars[bars.length - 1] as { openTime: number }).openTime}`]
      : []),
    ...(benchmarkBars.length > 0
      ? [`bar:benchmark:${(benchmarkBars[benchmarkBars.length - 1] as { openTime: number }).openTime}`]
      : ['benchmark:unavailable']),
  ]

  return {
    exitPrice,
    realizedGrossPct: grossPct,
    realizedNetPct: netPct,
    benchmarkPct,
    alphaPct: netPct - benchmarkPct,
    mfePct,
    maePct,
    stopHit,
    feesQuote,
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
  readonly slippageBps: number
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
        const fills = this.deps.journal.fillsForDecision(decision.decisionId)
        const entry = fills.length > 0 ? (fills[0] as FillView) : undefined

        if (fills.some((fill) => fill.fee === null || !Number.isFinite(fill.fee))) {
          deferredIds.push(decision.decisionId)
          continue
        }

        const horizonEnd = decision.decidedAt + horizonMs
        // `until` 是**开区间**：`open_time < horizonEnd` ⇒ 只取在 horizon 内收盘的 bar。
        // 旧实现写 `horizonEnd + timeframeMs`，会多算一根"在结算时点之后才收盘"的 bar，
        // 把未来价格算进 exitPrice / MFE / MAE（实测 exitPrice 取自未来 bar）。
        const bars = this.deps.bars.closedBars(decision.symbol, this.deps.timeframe, {
          since: decision.decidedAt,
          until: horizonEnd,
        })

        // 数据可用性闸门：没有成交**也没有**行情 ⇒ 没有价格基准。
        // 有成交但没有 bar ⇒ 算不出出场价。两种都不许"编"一个结算，
        // 保持 pending 等下一轮重试（行情回补完成后自然能结算）。
        if (bars.length === 0 && entry === undefined) {
          deferredIds.push(decision.decisionId)
          continue
        }
        if (bars.length === 0) {
          deferredIds.push(decision.decisionId)
          continue
        }

        const isExit = decision.action === 'reduce' || decision.action === 'close'
        let direction: 1 | -1
        let entryPrice: number
        if (isExit) {
          // ★ 平/减仓必须对齐**真实入场**：用该标的在此次成交之前的全部成交重建持仓。
          // 旧实现把平仓成交当入场 → 一笔 +20% 的回合被记成 ~0%（净额只剩成本）。
          const before = entry?.ts ?? decision.decidedAt
          const position = reconstructPosition(
            this.deps.journal.fillsForSymbolBefore(decision.symbol, before),
          )
          if (position.qty === 0) {
            // 找不到入场成交 ⇒ 缺数据，推迟而不是编造一个 0 收益的交易（plan §12 #20）
            deferredIds.push(decision.decisionId)
            continue
          }
          direction = position.qty > 0 ? 1 : -1
          entryPrice = position.avgPrice
        } else {
          direction = entry?.side === 'sell' ? -1 : 1
          entryPrice = entry?.price ?? (bars[0] as { close: number }).close
        }
        const benchmarkBars = this.deps.bars.closedBars(
          this.deps.benchmarkSymbol,
          this.deps.timeframe,
          { since: decision.decidedAt, until: horizonEnd },
        )

        const exitFill =
          (isExit || fills.length > 1) && fills.length > 0
            ? fills[fills.length - 1]
            : undefined
        const computation = computeSettlement(
          {
            decision,
            fills,
            entryPrice,
            direction,
            bars,
            benchmarkBars,
            ...(exitFill === undefined ? {} : { exitPrice: exitFill.price }),
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

        const inserted = this.deps.journal.recordOutcome(outcome)
        if (!inserted) {
          skipped += 1
          continue
        }
        this.deps.journal.markDecisionOutcome(decision.decisionId, outcome.outcomeId)
        settled += 1

        if (this.deps.reflector === undefined) continue
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
