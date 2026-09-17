/**
 * 冻结 context pack 与结构化证据账本（plan §5.4 / T2.7）。
 *
 * `detectFactConflicts` 与 `collectOpenDisagreements` 必须是**自包含纯函数** ——
 * 它们会被 `.toString()` 内嵌进 workflow 脚本（沙箱里没有 import），
 * 因此不能引用模块级作用域里的任何东西。这一点由测试守住。
 */

import { fingerprint } from '../util/canonical.js'
import type {
  AnalystReport,
  DebateArgument,
  EvidenceIssue,
  EvidenceReport,
  DebatePoint,
  FactConflict,
  JudgmentPack,
  JudgmentPackInput,
  RiskAssessment,
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
    featureFingerprint: input.featureFingerprint ?? null,
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

export interface EvidenceValidationResult<T> {
  readonly accepted: readonly T[]
  readonly evidenceIssues: readonly EvidenceIssue[]
}

export interface NullableEvidenceValidationResult<T> {
  readonly accepted: T | null
  readonly evidenceIssues: readonly EvidenceIssue[]
}

/**
 * 校验分析师报告并建立本轮证据账本。
 *
 * 这个函数刻意不调用其它模块函数：workflow 工具运行在无 import 的沙箱中，
 * 会直接以 toString() 嵌入它。报告只要有一处伪造，整份报告都不进入辩论，
 * 但每个问题仍保留在 evidenceIssues 供裁决者看见。
 */
export function validateEvidenceReports(
  pack: { readonly contextHash: string; readonly features: Readonly<Record<string, number | null>> },
  rawReports: readonly unknown[],
): EvidenceValidationResult<EvidenceReport> {
  const accepted: EvidenceReport[] = []
  const evidenceIssues: EvidenceIssue[] = []
  const makeIssue = (
    code: EvidenceIssue['code'],
    message: string,
    agent?: string,
    path?: string,
  ): EvidenceIssue => ({ stage: 'analyst', code, kind: code, message, ...(agent === undefined ? {} : { agent }), ...(path === undefined ? {} : { path }) })

  for (let i = 0; i < rawReports.length; i += 1) {
    const candidate = rawReports[i]
    const issues: EvidenceIssue[] = []
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      issues.push(makeIssue('invalid_shape', `分析师报告 ${i} 不是对象`))
      evidenceIssues.push(...issues)
      continue
    }
    const value = candidate as Record<string, unknown>
    const agent = typeof value.agent === 'string' ? value.agent : undefined
    if (agent === undefined || agent.length === 0) issues.push(makeIssue('invalid_shape', '缺少非空 agent', agent))
    if (value.contextHash !== pack.contextHash) {
      issues.push(makeIssue('context_mismatch', '报告 contextHash 与冻结 pack 不一致', agent))
    }
    const verdict = value.verdict
    if (verdict !== 'bullish' && verdict !== 'bearish' && verdict !== 'neutral' && verdict !== 'unknown') {
      issues.push(makeIssue('invalid_shape', 'verdict 不在封闭词汇表内', agent))
    }
    if (typeof value.summary !== 'string' || value.summary.length === 0) issues.push(makeIssue('invalid_shape', '缺少非空 summary', agent))
    if (typeof value.artifactRef !== 'string' || value.artifactRef.length === 0) issues.push(makeIssue('invalid_shape', '缺少非空 artifactRef', agent))

    const numbers = value.keyNumbers
    const validKeys = new Set<string>()
    if (numbers === null || typeof numbers !== 'object' || Array.isArray(numbers)) {
      issues.push(makeIssue('invalid_shape', 'keyNumbers 必须是对象', agent))
    } else {
      const featureValues = pack.features
      const keys = Object.keys(numbers as Record<string, unknown>)
      for (let k = 0; k < keys.length; k += 1) {
        const path = keys[k] as string
        const reported = (numbers as Record<string, unknown>)[path]
        if (!Object.prototype.hasOwnProperty.call(featureValues, path)) {
          issues.push(makeIssue('unknown_path', `keyNumbers 引用了 pack.features 外的路径：${path}`, agent, path))
          continue
        }
        const actual = featureValues[path]
        if (actual === null || actual === undefined) {
          issues.push(makeIssue('missing_value', `keyNumbers 引用了 pack 中缺失的值：${path}`, agent, path))
          continue
        }
        if (typeof actual !== 'number' || !Number.isFinite(actual) || typeof reported !== 'number' || !Number.isFinite(reported)) {
          issues.push(makeIssue('non_finite', `keyNumbers 必须是有限数字：${path}`, agent, path))
          continue
        }
        if (!Object.is(actual, reported)) {
          issues.push(makeIssue('value_mismatch', `keyNumbers 数值与 pack 不一致：${path}`, agent, path))
          continue
        }
        validKeys.add(path)
      }
    }

    const claims = value.claims
    if (!Array.isArray(claims)) {
      issues.push(makeIssue('invalid_shape', 'claims 必须是数组', agent))
    } else {
      for (let c = 0; c < claims.length; c += 1) {
        const claim = claims[c]
        if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
          issues.push(makeIssue('invalid_claim', `claim ${c} 不是对象`, agent))
          continue
        }
        const claimValue = claim as Record<string, unknown>
        if (claimValue.kind !== 'observation' && claimValue.kind !== 'inference' && claimValue.kind !== 'assumption') {
          issues.push(makeIssue('invalid_claim', `claim ${c} 的 kind 无效`, agent))
        }
        if (typeof claimValue.statement !== 'string' || claimValue.statement.length === 0) {
          issues.push(makeIssue('invalid_claim', `claim ${c} 缺少 statement`, agent))
        }
        const paths = claimValue.evidencePaths
        if (!Array.isArray(paths) || paths.length === 0) {
          issues.push(makeIssue('missing_evidence', `claim ${c} 必须引用至少一条证据路径`, agent))
        } else {
          for (let p = 0; p < paths.length; p += 1) {
            const path = paths[p]
            if (typeof path !== 'string' || !validKeys.has(path)) {
              issues.push(makeIssue('unknown_path', `claim ${c} 引用了未验证的证据路径`, agent, typeof path === 'string' ? path : undefined))
            }
          }
        }
      }
    }

    const missingPaths = value.missingPaths
    if (!Array.isArray(missingPaths)) {
      issues.push(makeIssue('invalid_shape', 'missingPaths 必须是数组', agent))
    } else {
      const featureValues = pack.features
      for (let m = 0; m < missingPaths.length; m += 1) {
        const path = missingPaths[m]
        if (typeof path !== 'string' || !Object.prototype.hasOwnProperty.call(featureValues, path)) {
          issues.push(makeIssue('unknown_path', 'missingPaths 必须引用 pack.features 中的规范路径', agent, typeof path === 'string' ? path : undefined))
        } else if (featureValues[path] !== null && featureValues[path] !== undefined) {
          issues.push(makeIssue('invalid_claim', `missingPaths 引用了并不缺失的路径：${path}`, agent, path))
        }
      }
    }

    // 防止空报告穿过账本：非 unknown 必须有可对拍数字和至少一条 claim；
    // unknown 必须把缺口落成路径，后续裁决才能区分“无信号”和“忘填字段”。
    if (verdict !== 'unknown') {
      if (validKeys.size === 0) issues.push(makeIssue('missing_evidence', '非 unknown 报告至少需要一条已验证 keyNumber', agent))
      if (Array.isArray(claims) && claims.length === 0) issues.push(makeIssue('missing_evidence', '非 unknown 报告至少需要一条 claim', agent))
    } else if (Array.isArray(missingPaths) && missingPaths.length === 0) {
      issues.push(makeIssue('missing_evidence', 'unknown 报告至少需要一条 missingPath', agent))
    }

    if (issues.length > 0) evidenceIssues.push(...issues)
    else {
      accepted.push({
        agent: agent as string,
        contextHash: pack.contextHash,
        verdict: verdict as EvidenceReport['verdict'],
        keyNumbers: numbers as Record<string, number>,
        claims: claims as EvidenceReport['claims'],
        missingPaths: missingPaths as string[],
        summary: value.summary as string,
        artifactRef: value.artifactRef as string,
      })
    }
  }
  if (accepted.length === 0 && rawReports.length > 0) {
    evidenceIssues.push(makeIssue('no_valid_reports', '没有通过证据账本校验的分析师报告'))
  }
  return { accepted, evidenceIssues }
}

/**
 * 校验一方辩论工件。acceptedEvidencePaths 是前一步账本的并集，不能由模型扩展。
 * 通过 toString() 嵌入 workflow，因此函数体内不依赖模块级符号。
 */
export function validateDebateArgument(
  pack: { readonly contextHash: string },
  rawArgument: unknown,
  acceptedEvidencePaths: readonly string[],
): NullableEvidenceValidationResult<DebateArgument> {
  const evidenceIssues: EvidenceIssue[] = []
  const makeIssue = (code: EvidenceIssue['code'], message: string, path?: string): EvidenceIssue => ({ stage: 'debate', code, kind: code, message, ...(path === undefined ? {} : { path }) })
  if (rawArgument === null || typeof rawArgument !== 'object' || Array.isArray(rawArgument)) {
    return { accepted: null, evidenceIssues: [makeIssue('invalid_argument', '辩论工件不是对象')] }
  }
  const value = rawArgument as Record<string, unknown>
  if (value.contextHash !== pack.contextHash) evidenceIssues.push(makeIssue('context_mismatch', '辩论工件 contextHash 与冻结 pack 不一致'))
  if (typeof value.concede !== 'boolean') evidenceIssues.push(makeIssue('invalid_argument', 'concede 必须是布尔值'))
  const points = value.points
  if (!Array.isArray(points)) evidenceIssues.push(makeIssue('invalid_argument', 'points 必须是结构化数组'))
  else {
    for (let i = 0; i < points.length; i += 1) {
      const point = points[i]
      if (point === null || typeof point !== 'object' || Array.isArray(point)) {
        evidenceIssues.push(makeIssue('invalid_argument', `point ${i} 不是对象`))
        continue
      }
      const pointValue = point as Record<string, unknown>
      if (typeof pointValue.statement !== 'string' || pointValue.statement.length === 0) evidenceIssues.push(makeIssue('invalid_argument', `point ${i} 缺少 statement`))
      const paths = pointValue.evidencePaths
      if (!Array.isArray(paths) || paths.length === 0) {
        evidenceIssues.push(makeIssue('missing_evidence', `point ${i} 的 evidencePaths 必须是非空路径数组`))
      } else {
        for (let p = 0; p < paths.length; p += 1) {
          const path = paths[p]
          if (typeof path !== 'string' || acceptedEvidencePaths.indexOf(path) === -1) evidenceIssues.push(makeIssue('unknown_path', `point ${i} 引用了未验证的证据路径`, typeof path === 'string' ? path : undefined))
        }
      }
      const invalidatedBy = pointValue.invalidatedBy
      if (invalidatedBy === null || typeof invalidatedBy !== 'object' || Array.isArray(invalidatedBy)) {
        evidenceIssues.push(makeIssue('invalid_argument', `point ${i} 的 invalidatedBy 必须是结构化对象`))
      } else {
        const invalidation = invalidatedBy as Record<string, unknown>
        if (typeof invalidation.statement !== 'string' || invalidation.statement.length === 0) evidenceIssues.push(makeIssue('invalid_argument', `point ${i} 的 invalidatedBy 缺少 statement`))
        const invalidationPaths = invalidation.evidencePaths
        if (!Array.isArray(invalidationPaths) || invalidationPaths.length === 0) evidenceIssues.push(makeIssue('missing_evidence', `point ${i} 的 invalidatedBy.evidencePaths 必须是非空路径数组`))
        else for (let p = 0; p < invalidationPaths.length; p += 1) { const path = invalidationPaths[p]; if (typeof path !== 'string' || acceptedEvidencePaths.indexOf(path) === -1) evidenceIssues.push(makeIssue('unknown_path', `point ${i} 的 invalidatedBy 引用了未验证的证据路径`, typeof path === 'string' ? path : undefined)) }
      }
    }
  }
  if (evidenceIssues.length > 0) return { accepted: null, evidenceIssues }
  return {
    accepted: {
      contextHash: pack.contextHash,
      points: points as DebatePoint[],
      concede: value.concede as boolean,
    },
    evidenceIssues,
  }
}

/** 单一 RiskCritic 的结构化输出校验；仓位与限额仍由确定性风控负责。 */
export function validateRiskAssessment(
  pack: { readonly contextHash: string },
  rawRisk: unknown,
  acceptedEvidencePaths: readonly string[],
): NullableEvidenceValidationResult<RiskAssessment> {
  const evidenceIssues: EvidenceIssue[] = []
  const makeIssue = (code: EvidenceIssue['code'], message: string, path?: string): EvidenceIssue => ({ stage: 'risk', code, kind: code, message, ...(path === undefined ? {} : { path }) })
  if (rawRisk === null || typeof rawRisk !== 'object' || Array.isArray(rawRisk)) return { accepted: null, evidenceIssues: [makeIssue('invalid_risk', 'RiskCritic 工件不是对象')] }
  const value = rawRisk as Record<string, unknown>
  if (value.contextHash !== pack.contextHash) evidenceIssues.push(makeIssue('context_mismatch', 'RiskCritic 工件 contextHash 与冻结 pack 不一致'))
  if (value.disposition !== 'proceed' && value.disposition !== 'revise' && value.disposition !== 'no_trade') evidenceIssues.push(makeIssue('invalid_risk', 'disposition 不在封闭词汇表内'))
  const modes = value.failureModes
  if (!Array.isArray(modes)) evidenceIssues.push(makeIssue('invalid_risk', 'failureModes 必须是数组'))
  else {
    for (let i = 0; i < modes.length; i += 1) {
      const mode = modes[i]
      if (mode === null || typeof mode !== 'object' || Array.isArray(mode)) { evidenceIssues.push(makeIssue('invalid_risk', `failureMode ${i} 不是对象`)); continue }
      const modeValue = mode as Record<string, unknown>
      if (typeof modeValue.statement !== 'string' || modeValue.statement.length === 0) evidenceIssues.push(makeIssue('invalid_risk', `failureMode ${i} 缺少 statement`))
      if (modeValue.severity !== 'P0' && modeValue.severity !== 'P1' && modeValue.severity !== 'P2') evidenceIssues.push(makeIssue('invalid_risk', `failureMode ${i} severity 无效`))
      const paths = modeValue.evidencePaths
      if (!Array.isArray(paths) || paths.length === 0) evidenceIssues.push(makeIssue('missing_evidence', `failureMode ${i} 必须引用至少一条证据路径`))
      else for (let p = 0; p < paths.length; p += 1) { const path = paths[p]; if (typeof path !== 'string' || acceptedEvidencePaths.indexOf(path) === -1) evidenceIssues.push(makeIssue('unknown_path', `failureMode ${i} 引用了未验证的证据路径`, typeof path === 'string' ? path : undefined)) }
    }
  }
  const missing = value.missingEvidence
  if (!Array.isArray(missing) || missing.some((item) => typeof item !== 'string' || item.length === 0)) evidenceIssues.push(makeIssue('invalid_risk', 'missingEvidence 必须是字符串数组'))
  if (evidenceIssues.length > 0) return { accepted: null, evidenceIssues }
  return { accepted: { contextHash: pack.contextHash, disposition: value.disposition as RiskAssessment['disposition'], failureModes: modes as RiskAssessment['failureModes'], missingEvidence: missing as string[] }, evidenceIssues }
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
 * 汇总必须显式呈现给裁决者的问题。它不替模型“调和”证据，也不把问题藏在
 * summary 中；任何问题都让上层可以选择 REVIEW/NO_TRADE。
 * 同样必须自包含（内嵌进 workflow 沙箱）。
 */
export function collectOpenDisagreements(
  reports: readonly AnalystReport[],
  evidenceIssues: readonly EvidenceIssue[],
  debate: { readonly bull: DebateArgument | null; readonly bear: DebateArgument | null; readonly rounds: number },
  risk: RiskAssessment | null,
): readonly string[] {
  const open: string[] = []
  for (let i = 0; i < evidenceIssues.length; i += 1) {
    const issue = evidenceIssues[i]
    if (issue !== undefined) open.push(`证据问题 [${issue.stage}/${issue.code}]：${issue.message}`)
  }
  if (reports.length === 0) open.push('没有有效分析师报告')
  if (debate.bull === null || debate.bear === null) open.push('没有完整有效的多空辩论')
  else if (debate.bull.concede !== true && debate.bear.concede !== true) open.push('多空辩论在轮次上限内未收敛')
  if (risk === null) open.push('没有有效的 RiskCritic 评估')
  else {
    if (risk.disposition === 'revise') open.push('RiskCritic 要求修订后再审')
    if (risk.disposition === 'no_trade') open.push('RiskCritic 判定 NO_TRADE')
    if (risk.missingEvidence.length > 0) open.push(`RiskCritic 缺少证据：${risk.missingEvidence.join(' / ')}`)
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
