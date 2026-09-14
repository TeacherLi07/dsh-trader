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
import { timeframeMs } from '../market/normalize.js'
import { fingerprint } from '../util/canonical.js'
import type { DecisionJournal, FillView, OutcomeRecord, PendingSettlement } from '../exec/journal.js'

// ── 结算 ─────────────────────────────────────────────────────────────────────

export type { FillView }

export interface SettlementInputs {
  readonly decision: PendingSettlement
  readonly fills: readonly FillView[]
  readonly entryPrice: number
  readonly direction: 1 | -1
  readonly bars: readonly { readonly openTime: number; readonly high: number; readonly low: number; readonly close: number }[]
  readonly benchmarkBars: readonly { readonly openTime: number; readonly close: number }[]
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

  const feesQuote = fills.reduce((sum, fill) => sum + (Number.isFinite(fill.fee) ? fill.fee : 0), 0)
  const qty = fills.reduce((sum, fill) => sum + Math.abs(fill.qty), 0)
  const notional = entryPrice * (qty > 0 ? qty : 1)
  const feesPct = notional > 0 ? (feesQuote / notional) * 100 : 0
  const slippagePct = 2 * (options.slippageBps / 10_000) * 100

  const exitPrice = bars.length > 0 ? (bars[bars.length - 1] as { close: number }).close : entryPrice
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
  readonly horizonMs: number
  readonly benchmarkSymbol: string
  readonly slippageBps: number
  readonly reflector?: Reflector
  readonly gates?: ReflectionGateConfig
}

export interface SettlementRunResult {
  readonly scanned: number
  readonly settled: number
  readonly skipped: number
  readonly reflectionsWritten: number
  readonly reflectionsRejected: readonly { readonly decisionId: string; readonly reason: string }[]
  readonly errors: readonly { readonly decisionId: string; readonly reason: string }[]
}

export class SettlementScheduler {
  constructor(private readonly deps: SettlementDeps) {}

  /** 扫描**全部**到期的 pending 并结算。可重复调用（幂等）。 */
  async runOnce(now: number, limit = 20): Promise<SettlementRunResult> {
    const gates = this.deps.gates ?? DEFAULT_REFLECTION_GATES
    const pending = this.deps.journal.pendingSettlements(now, limit)

    let settled = 0
    let skipped = 0
    let reflectionsWritten = 0
    const reflectionsRejected: { decisionId: string; reason: string }[] = []
    const errors: { decisionId: string; reason: string }[] = []

    for (const decision of pending) {
      try {
        const fills = this.deps.journal.fillsForDecision(decision.decisionId)
        const entry = fills.length > 0 ? (fills[0] as FillView) : undefined
        const direction: 1 | -1 = entry?.side === 'sell' ? -1 : 1
        const entryPrice = entry?.price ?? this.entryFromBars(decision)

        const horizonEnd = decision.decidedAt + this.deps.horizonMs
        const bars = this.deps.bars.closedBars(decision.symbol, this.deps.timeframe, {
          since: decision.decidedAt,
          until: horizonEnd + timeframeMs(this.deps.timeframe),
        })
        const benchmarkBars = this.deps.bars.closedBars(
          this.deps.benchmarkSymbol,
          this.deps.timeframe,
          { since: decision.decidedAt, until: horizonEnd + timeframeMs(this.deps.timeframe) },
        )

        const computation = computeSettlement(
          { decision, fills, entryPrice, direction, bars, benchmarkBars },
          { slippageBps: this.deps.slippageBps },
        )

        const outcome: OutcomeRecord = {
          outcomeId: `outcome:${fingerprint({ decisionId: decision.decisionId, settledAt: now }).slice(7, 23)}`,
          decisionId: decision.decisionId,
          symbol: decision.symbol,
          settledAt: now,
          horizonMs: this.deps.horizonMs,
          entryPrice,
          ...computation,
        }

        const inserted = this.deps.journal.recordOutcome(outcome)
        this.deps.journal.markDecisionOutcome(decision.decisionId, outcome.outcomeId)
        if (!inserted) {
          skipped += 1
          continue
        }
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

    return { scanned: pending.length, settled, skipped, reflectionsWritten, reflectionsRejected, errors }
  }

  /** 没有成交的决策（例如 no_trade）：用决策后的第一根 bar 收盘价作为参考入场价。 */
  private entryFromBars(decision: PendingSettlement): number {
    const bars = this.deps.bars.closedBars(decision.symbol, this.deps.timeframe, {
      since: decision.decidedAt,
      until: decision.decidedAt + this.deps.horizonMs + timeframeMs(this.deps.timeframe),
    })
    return bars.length > 0 ? (bars[0] as { close: number }).close : 0
  }
}
