/**
 * 判断流程的数据形状（plan §5.4 / T2.7）。
 *
 * 模型只能提交可验证的工件。自然语言仍可落到 artifact，但进入下一阶段的
 * 只有这里声明的结构化字段；证据路径由 pack.ts 的纯校验器裁决。
 */

export type Verdict = 'bullish' | 'bearish' | 'neutral' | 'unknown'

export type ClaimKind = 'observation' | 'inference' | 'assumption'

export interface EvidenceClaim {
  readonly kind: ClaimKind
  readonly statement: string
  readonly evidencePaths: readonly string[]
}

export interface EvidenceReport {
  readonly agent: string
  readonly contextHash: string
  readonly verdict: Verdict
  /** 键必须是 pack.features 中实际存在且非 null 的规范路径。 */
  readonly keyNumbers: Readonly<Record<string, number>>
  readonly claims: readonly EvidenceClaim[]
  readonly missingPaths: readonly string[]
  readonly summary: string
  /** 全文落库后的引用（只作审计指针，不作为事实来源）。 */
  readonly artifactRef: string
}

/** 旧名称保留为类型别名，避免下游插件在迁移期间产生两套报告协议。 */
export type AnalystReport = EvidenceReport

export type EvidenceIssueStage = 'analyst' | 'debate' | 'risk' | 'workflow'
export type EvidenceIssueCode =
  | 'invalid_shape'
  | 'context_mismatch'
  | 'unknown_path'
  | 'missing_value'
  | 'value_mismatch'
  | 'non_finite'
  | 'missing_evidence'
  | 'invalid_claim'
  | 'invalid_argument'
  | 'invalid_risk'
  | 'no_valid_reports'
  | 'no_valid_debate'
  | 'no_valid_risk'

export interface EvidenceIssue {
  readonly stage: EvidenceIssueStage
  readonly code: EvidenceIssueCode
  /** code 的可读同义字段，便于审计消费者按“issue kind”聚合。 */
  readonly kind: EvidenceIssueCode
  readonly message: string
  readonly agent?: string
  readonly path?: string
}

export interface DebatePoint {
  readonly statement: string
  readonly evidencePaths: readonly string[]
  /** 说明什么事实/条件会推翻本点；其中路径仍须引用规范证据。 */
  readonly invalidatedBy: {
    readonly statement: string
    readonly evidencePaths: readonly string[]
  }
}

export interface DebateArgument {
  readonly contextHash: string
  readonly points: readonly DebatePoint[]
  /** 论据收敛：为真时辩论提前结束。 */
  readonly concede: boolean
}

export type RiskDisposition = 'proceed' | 'revise' | 'no_trade'
export type RiskSeverity = 'P0' | 'P1' | 'P2'

export interface FailureMode {
  readonly statement: string
  readonly severity: RiskSeverity
  readonly evidencePaths: readonly string[]
}

export interface RiskAssessment {
  readonly contextHash: string
  readonly disposition: RiskDisposition
  readonly failureModes: readonly FailureMode[]
  readonly missingEvidence: readonly string[]
}

export interface DeskStateSnapshot {
  readonly equityQuote: number
  readonly positions: readonly { readonly symbol: string; readonly qty: number; readonly avgPrice: number }[]
  readonly openOrders: number
}

export interface JudgmentPackInput {
  readonly symbol: string
  readonly timeframe: string
  /** 本 pack 冻结的时刻。 */
  readonly asOf: number
  readonly features: Readonly<Record<string, number | null>>
  /** 最新特征快照的内容指纹；没有快照时为 null，便于审计数据血缘。 */
  readonly featureFingerprint?: string | null
  readonly deskState: DeskStateSnapshot
  readonly plan?: { readonly planId: string; readonly contentHash: string }
  readonly lessons: readonly { readonly lessonId: string }[]
}

export interface JudgmentPack extends JudgmentPackInput {
  readonly packId: string
  /** 内容指纹：所有并行分析师必须拿到**同一个**哈希（plan §5.3 铁律 A）。 */
  readonly contextHash: string
}

export interface FactConflict {
  readonly key: string
  readonly values: readonly { readonly agent: string; readonly value: number }[]
}

export interface JudgmentResult {
  readonly packId: string
  readonly contextHash: string
  readonly reports: readonly EvidenceReport[]
  readonly evidenceIssues: readonly EvidenceIssue[]
  readonly conflicts: readonly FactConflict[]
  readonly debate: {
    readonly bull: DebateArgument | null
    readonly bear: DebateArgument | null
    readonly rounds: number
    readonly evidenceIssues: readonly EvidenceIssue[]
  }
  readonly risk: RiskAssessment | null
  /** 未被解决的分歧：裁决者据此可以选择 NO_TRADE，而不是被迫拍板。 */
  readonly openDisagreements: readonly string[]
}
