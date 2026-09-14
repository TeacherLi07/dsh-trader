/**
 * 冻结 context pack 与冲突消解（plan §5.3 铁律 A/B）。
 *
 * `detectFactConflicts` 与 `collectOpenDisagreements` 必须是**自包含纯函数** ——
 * 它们会被 `.toString()` 内嵌进 workflow 脚本（沙箱里没有 import），
 * 因此不能引用模块级作用域里的任何东西。这一点由测试守住。
 */

import { fingerprint } from '../util/canonical.js'
import type {
  AnalystReport,
  DebateArgument,
  FactConflict,
  JudgmentPack,
  JudgmentPackInput,
  RiskView,
} from './types.js'

export class PackMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PackMismatchError'
  }
}

/** 冻结一份 pack：算出 `contextHash`，并给它一个稳定的 `packId`。 */
export function freezeContextPack(input: JudgmentPackInput): JudgmentPack {
  const contextHash = fingerprint({
    symbol: input.symbol,
    timeframe: input.timeframe,
    asOf: input.asOf,
    features: input.features,
    deskState: input.deskState,
    planId: input.plan?.planId ?? null,
    planHash: input.plan?.contentHash ?? null,
    lessonIds: input.lessons.map((lesson) => lesson.lessonId),
  })
  return { ...input, packId: `pack-${contextHash.slice(7, 23)}`, contextHash }
}

/**
 * 铁律 A 的守卫：调用方声明的哈希必须与 pack 自己的一致，且 pack 内容未被改动。
 * 任何不一致都直接抛错 —— 宁可让这一步炸，也不要让分析师基于不同的快照各自推理。
 */
export function assertPackIntegrity(declaredHash: string, pack: JudgmentPack): void {
  if (declaredHash !== pack.contextHash) {
    throw new PackMismatchError(
      `contextHash 不一致：声明 ${declaredHash}，pack ${pack.contextHash}`,
    )
  }
  const recomputed = freezeContextPack(pack).contextHash
  if (recomputed !== pack.contextHash) {
    throw new PackMismatchError('context pack 内容已被改动（重算哈希不一致）')
  }
}

/**
 * 铁律 B：把"两个分析师对同一事实给了不同数字"从**隐式矛盾**变成**显式修复步骤**。
 *
 * 自包含：只使用入参与字面量（会被内嵌进 workflow 脚本沙箱）。
 */
export function detectFactConflicts(
  reports: readonly AnalystReport[],
  options?: { readonly relativeTolerance?: number },
): readonly FactConflict[] {
  const tolerance =
    options !== undefined && typeof options.relativeTolerance === 'number'
      ? options.relativeTolerance
      : 0.01
  const byKey: Record<string, { agent: string; value: number }[]> = {}

  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i]
    if (report === null || report === undefined) continue
    const numbers = report.keyNumbers ?? {}
    const keys = Object.keys(numbers)
    for (let k = 0; k < keys.length; k += 1) {
      const key = keys[k] as string
      const value = numbers[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      const bucket = byKey[key]
      if (bucket === undefined) byKey[key] = [{ agent: String(report.agent), value }]
      else bucket.push({ agent: String(report.agent), value })
    }
  }

  const conflicts: FactConflict[] = []
  const keys = Object.keys(byKey).sort()
  for (let k = 0; k < keys.length; k += 1) {
    const key = keys[k] as string
    const values = byKey[key]
    if (values === undefined || values.length < 2) continue
    let min = values[0]!.value
    let max = values[0]!.value
    for (let v = 1; v < values.length; v += 1) {
      const current = values[v]!.value
      if (current < min) min = current
      if (current > max) max = current
    }
    const scale = Math.max(Math.abs(min), Math.abs(max), 1e-12)
    const spread = (max - min) / scale
    if (spread > tolerance) conflicts.push({ key, values })
  }
  return conflicts
}

/**
 * 汇总**未解决**的分歧：裁决者需要知道哪些矛盾没被消解，才能合法地选择 NO_TRADE。
 * 同样必须自包含（内嵌进脚本沙箱）。
 */
export function collectOpenDisagreements(
  reports: readonly AnalystReport[],
  conflicts: readonly FactConflict[],
  bull: DebateArgument | null,
  bear: DebateArgument | null,
  aggressive: RiskView | null,
  conservative: RiskView | null,
): readonly string[] {
  const open: string[] = []
  for (let i = 0; i < conflicts.length; i += 1) {
    const conflict = conflicts[i]
    if (conflict !== undefined) open.push(`未消解的事实冲突：${conflict.key}`)
  }
  if (bull !== null && bear !== null && bull.concede !== true && bear.concede !== true) {
    open.push('多空辩论在轮次上限内未收敛')
  }
  if (
    aggressive !== null &&
    conservative !== null &&
    aggressive.stance !== 'neutral' &&
    conservative.stance !== 'neutral' &&
    aggressive.stance !== conservative.stance
  ) {
    open.push('风控两方立场相反且均未让步')
  }
  const verdicts: Record<string, number> = {}
  for (let i = 0; i < reports.length; i += 1) {
    const report = reports[i]
    if (report === undefined) continue
    const verdict = String(report.verdict)
    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1
  }
  const distinct = Object.keys(verdicts)
  if (distinct.length > 1) open.push(`分析师结论不一致：${distinct.sort().join(' / ')}`)
  return open
}
