/**
 * P1.5 通道有效性闸门（plan §10 / T1.7）。
 *
 * 问题：W2/W3 这套"判断通道"到底值不值得留？
 * 判据是**预注册**的（避免事后挑指标）：
 *
 *   · 回放 ≥ 90 天或 ≥ 200 次触发；
 *   · 指标 = 扣费净 PnL（taker + 资金费 + 滑点模型）+ 执行偏离次数；
 *   · 保留条件：净 PnL 差值 **bootstrap 95% CI 下界 > 0**
 *     **且** B 的最大回撤 ≤ A × 1.2；
 *   · 否则关闭 W2/W3，退化为"纯窗口 + 机械执行"（仍是完整可用系统）。
 *
 * 两臂的**唯一**差异是判断通道是否经手；其余（数据、规则、风控、成本模型）逐字相同，
 * 否则 CI 里混进了别的变量。bootstrap 用**固定种子**的 PRNG，同一输入必然同一结论。
 */

import type {
  JudgmentChannel,
  JudgmentCounters,
  JudgmentInput,
  JudgmentVerdict,
} from '../exec/replay.js'

export interface ArmInput {
  /** 每笔已实现净盈亏（USD，已扣费/滑点）。 */
  readonly tradePnl: readonly number[]
  /** 执行偏离次数：下单意图与最终成交不一致、被风控拒绝、撤单重挂等。 */
  readonly executionDeviations: number
  readonly judgment?: JudgmentCounters
  /** 回放覆盖的 bar 数与被评估的触发次数（判断"样本够不够"）。 */
  readonly bars: number
  readonly triggers: number
}

export interface ArmMetrics {
  readonly trades: number
  readonly netPnlUsd: number
  readonly maxDrawdownUsd: number
  readonly executionDeviations: number
  readonly bars: number
  readonly triggers: number
  readonly judgment: JudgmentCounters
}

/** 由逐笔盈亏构造权益曲线并取最大回撤（USD，正数表示回撤幅度）。 */
export function maxDrawdown(tradePnl: readonly number[]): number {
  let equity = 0
  let peak = 0
  let worst = 0
  for (const pnl of tradePnl) {
    equity += pnl
    peak = Math.max(peak, equity)
    worst = Math.max(worst, peak - equity)
  }
  return worst
}

export function computeArmMetrics(input: ArmInput): ArmMetrics {
  return {
    trades: input.tradePnl.length,
    netPnlUsd: input.tradePnl.reduce((sum, pnl) => sum + pnl, 0),
    maxDrawdownUsd: maxDrawdown(input.tradePnl),
    executionDeviations: input.executionDeviations,
    bars: input.bars,
    triggers: input.triggers,
    judgment: input.judgment ?? { reviewed: 0, approved: 0, vetoed: 0 },
  }
}

// ── bootstrap ────────────────────────────────────────────────────────────────

/** 确定性 PRNG（mulberry32）：同一 seed ⇒ 同一 CI，回放可复算。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export interface BootstrapOptions {
  readonly iterations?: number
  /** 置信水平，默认 0.95 ⇒ 取 2.5% / 97.5% 分位。 */
  readonly confidence?: number
  readonly seed?: number
}

export interface ConfidenceInterval {
  readonly mean: number
  readonly lower: number
  readonly upper: number
  readonly samples: number
  readonly iterations: number
  readonly confidence: number
}

/**
 * 对**配对差值**（B 减去 A，逐笔对齐）做 bootstrap：
 * 有放回重采样差值序列，取分位数区间。
 *
 * 用配对身体而非独立两样本：两臂在同一段行情上跑，逐笔是可配对的，
 * 配对能消掉市场整体涨跌这个共同项，CI 明显更窄也更有意义。
 */
export function pairedBootstrapCi(
  differences: readonly number[],
  options: BootstrapOptions = {},
): ConfidenceInterval {
  const iterations = options.iterations ?? 10_000
  const confidence = options.confidence ?? 0.95
  const random = mulberry32(options.seed ?? 20_260_914)

  if (differences.length === 0) {
    return { mean: 0, lower: 0, upper: 0, samples: 0, iterations, confidence }
  }

  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length
  const means = new Array<number>(iterations)
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0
    for (let j = 0; j < differences.length; j += 1) {
      const index = Math.floor(random() * differences.length)
      sum += differences[index] as number
    }
    means[i] = sum / differences.length
  }
  means.sort((a, b) => a - b)
  const alpha = (1 - confidence) / 2
  const lowerIndex = Math.max(0, Math.floor(alpha * iterations))
  const upperIndex = Math.min(iterations - 1, Math.ceil((1 - alpha) * iterations) - 1)

  return {
    mean,
    lower: means[lowerIndex] as number,
    upper: means[upperIndex] as number,
    samples: differences.length,
    iterations,
    confidence,
  }
}

/** 把两臂的逐笔盈亏按**共同前缀**配对成差值（样本量不同时取较短者）。 */
export function pairDifferences(a: readonly number[], b: readonly number[]): readonly number[] {
  const length = Math.min(a.length, b.length)
  const out = new Array<number>(length)
  for (let i = 0; i < length; i += 1) {
    out[i] = (b[i] as number) - (a[i] as number)
  }
  return out
}

// ── 闸门 ─────────────────────────────────────────────────────────────────────

export interface GateThresholds {
  readonly iterations: number
  readonly confidence: number
  readonly seed: number
  /** B 的最大回撤上限 = A 的回撤 × 该系数（净 PnL 为负/为零时的绝对下限另计）。 */
  readonly maxDrawdownRatio: number
  readonly minBars: number
  readonly minTriggers: number
  /** 判断通道确实经手过的最小次数 —— 否则"B 臂"根本没被检验。 */
  readonly minReviewed: number
  /**
   * 可配对逐笔的最小条数。
   * bootstrap 在 n=1/2 上是**退化**的（重采样只能取到原样本），
   * 拿这种 CI 去下"保留/关闭"的结论等于把噪声当证据 ⇒ 样本太薄只报"结论无效"。
   */
  readonly minPairedSamples: number
}

export const DEFAULT_GATE_THRESHOLDS: GateThresholds = {
  iterations: 10_000,
  confidence: 0.95,
  seed: 20_260_914,
  maxDrawdownRatio: 1.2,
  minBars: 90 * 24,
  minTriggers: 200,
  minReviewed: 1,
  minPairedSamples: 20,
}

export interface GateVerdict {
  /** true = 保留 W2/W3；false = 关闭，退化为纯窗口 + 机械执行。 */
  readonly keep: boolean
  readonly a: ArmMetrics
  readonly b: ArmMetrics
  readonly ci: ConfidenceInterval
  readonly drawdownRatio: number
  /** 未满足的条件（`keep=false` 时至少一条）。 */
  readonly failures: readonly string[]
  /** 样本量不足等"结论无效"的原因（与 failures 区分：这不是判据不达标，是没法判）。 */
  readonly inconclusive: readonly string[]
}

export function evaluateChannelGate(
  a: ArmMetrics,
  b: ArmMetrics,
  ci: ConfidenceInterval,
  thresholds: GateThresholds = DEFAULT_GATE_THRESHOLDS,
): GateVerdict {
  const inconclusive: string[] = []
  // plan §10 的样本量要求是「≥ 90 天 **或** ≥ 200 次触发」—— 二者之一成立即可
  if (a.bars < thresholds.minBars && a.triggers < thresholds.minTriggers) {
    inconclusive.push(
      `样本不足：回放 ${a.bars} 根 bar（要求 ${thresholds.minBars}）且 触发 ${a.triggers} 次（要求 ${thresholds.minTriggers}）—— 两者需至少满足其一`,
    )
  }
  if (b.judgment.reviewed < thresholds.minReviewed) {
    inconclusive.push(`判断通道经手 ${b.judgment.reviewed} 次 —— B 臂实际没被检验`)
  }
  if (ci.samples < thresholds.minPairedSamples) {
    inconclusive.push(
      `可配对逐笔 ${ci.samples} < 要求 ${thresholds.minPairedSamples} —— bootstrap 在此样本量上退化`,
    )
  }

  const aDrawdown = a.maxDrawdownUsd
  const ratio = aDrawdown > 0 ? b.maxDrawdownUsd / aDrawdown : b.maxDrawdownUsd > 0 ? Infinity : 1

  const failures: string[] = []
  if (!(ci.lower > 0)) {
    failures.push(`净 PnL 差值 bootstrap ${Math.round(ci.confidence * 100)}% CI 下界 ${ci.lower.toFixed(4)} ≤ 0`)
  }
  if (!(ratio <= thresholds.maxDrawdownRatio)) {
    failures.push(
      `B 最大回撤 ${b.maxDrawdownUsd.toFixed(2)} 是 A ${aDrawdown.toFixed(2)} 的 ${ratio.toFixed(2)}× > ${thresholds.maxDrawdownRatio}×`,
    )
  }

  // 样本不足时不允许"保留" —— 样本不够就没有证据，没有证据就不升级信任
  const keep = inconclusive.length === 0 && failures.length === 0
  return { keep, a, b, ci, drawdownRatio: ratio, failures, inconclusive }
}

// ── 判断通道的**替身**（stand-in）────────────────────────────────────────────

export interface StandInJudgeOptions {
  /**
   * 开仓所需的最小止损距离（占价格比例）。
   * 低于它时，风险公式推出来的名义金额会远超单笔上限 ⇒ 必然被硬闸拒绝，
   * 与其让硬闸拒绝，不如判断层直接不发这一单（这就是"判断通道"的价值所在）。
   */
  readonly minStopDistancePct?: number
}

/**
 * ⚠️ 这**不是** W2/W3 的 LLM 判断通道，而是一个**确定性的替身**：
 * 用来在**没有模型凭据**的情况下，让 P1.5 闸门的整条流水线（回放 → 指标 → bootstrap → 判定）
 * 真正跑通并被检验。报告里会显式标注 `judge: 'stand-in'`。
 *
 * 真正的 LLM 判断臂需要模型凭据（plan §12 第 20 项）；换掉这个函数即可复用同一套闸门。
 *
 * 两条规则（都是可复现的机械判断，不含随机性）：
 *   1. 已有持仓时不再开仓（避免加仓把风险放大到止损之外）；
 *   2. ATR 止损距离过窄时不开仓（注定被单笔上限拒绝的单子不发）。
 */
export function standInJudge(options: StandInJudgeOptions = {}): JudgmentChannel {
  const minStopDistancePct = options.minStopDistancePct ?? 0.002
  return (input: JudgmentInput): Promise<JudgmentVerdict> => {
    if (input.action.action === 'open') {
      if (input.positionQty !== 0) {
        return Promise.resolve({ approve: false, reason: 'stand-in:已有仓位，拒绝加仓' })
      }
      if (input.atr !== null && input.referencePrice > 0) {
        const distance = input.atr / input.referencePrice
        if (distance < minStopDistancePct) {
          return Promise.resolve({
            approve: false,
            reason: `stand-in:止损距离 ${(distance * 100).toFixed(3)}% < ${(minStopDistancePct * 100).toFixed(3)}%`,
          })
        }
      }
    }
    return Promise.resolve({ approve: true, reason: 'stand-in:通过' })
  }
}

/** 人类可读的门禁报告（脚本与审计共用一份渲染，避免两处口径漂移）。 */export function renderGateReport(verdict: GateVerdict, meta: { readonly judge: string }): string {
  const lines: string[] = []
  lines.push(`# P1.5 通道有效性闸门（plan §10）`)
  lines.push(`判断通道实现：${meta.judge}`)
  lines.push('')
  lines.push(`| 指标 | A（纯机械） | B（+判断通道） |`)
  lines.push(`|---|---|---|`)
  lines.push(`| 成交笔数 | ${verdict.a.trades} | ${verdict.b.trades} |`)
  lines.push(`| 净 PnL (USD) | ${verdict.a.netPnlUsd.toFixed(4)} | ${verdict.b.netPnlUsd.toFixed(4)} |`)
  lines.push(
    `| 最大回撤 (USD) | ${verdict.a.maxDrawdownUsd.toFixed(4)} | ${verdict.b.maxDrawdownUsd.toFixed(4)} |`,
  )
  lines.push(
    `| 执行偏离次数 | ${verdict.a.executionDeviations} | ${verdict.b.executionDeviations} |`,
  )
  lines.push(`| bar 数 | ${verdict.a.bars} | ${verdict.b.bars} |`)
  lines.push(`| 触发次数 | ${verdict.a.triggers} | ${verdict.b.triggers} |`)
  lines.push(
    `| 判断经手/通过/否决 | — | ${verdict.b.judgment.reviewed}/${verdict.b.judgment.approved}/${verdict.b.judgment.vetoed} |`,
  )
  lines.push('')
  lines.push(
    `配对差值 bootstrap：mean=${verdict.ci.mean.toFixed(4)}，` +
      `${Math.round(verdict.ci.confidence * 100)}% CI = [${verdict.ci.lower.toFixed(4)}, ${verdict.ci.upper.toFixed(4)}]，` +
      `n=${verdict.ci.samples}，迭代=${verdict.ci.iterations}`,
  )
  lines.push(`回撤比 = ${verdict.drawdownRatio.toFixed(3)}×（上限 1.2×）`)
  lines.push('')
  if (verdict.inconclusive.length > 0) {
    lines.push('**结论无效（样本不足）**：')
    for (const item of verdict.inconclusive) lines.push(`- ${item}`)
  }
  if (verdict.failures.length > 0) {
    lines.push('**未达标**：')
    for (const item of verdict.failures) lines.push(`- ${item}`)
  }
  lines.push('')
  lines.push(
    verdict.keep
      ? '**判定：保留 W2/W3。**'
      : '**判定：关闭 W2/W3，退化为「纯窗口 + 机械执行」（完整可用）。**',
  )
  return `${lines.join('\n')}\n`
}
