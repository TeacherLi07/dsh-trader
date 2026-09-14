/**
 * 判断流程的数据形状（plan §5.3 / T1.1）。
 *
 * 一条铁律贯穿：**只回结构化字段 + 工件指针，不回散文摘要**。
 * 所以每个角色产出的都是可校验对象，且 `artifactRef` 指向落库的全文。
 */

export type Verdict = 'bullish' | 'bearish' | 'neutral' | 'unknown'

export interface AnalystReport {
  readonly agent: string
  readonly verdict: Verdict
  readonly keyNumbers: Readonly<Record<string, number>>
  readonly summary: string
  /** 全文落库后的引用（plan §5.3 的"工件指针"）。 */
  readonly artifactRef: string
}

export interface DebateArgument {
  readonly points: readonly string[]
  /** 论据收敛：为真时辩论提前结束（plan §5.3 的"新增收敛判据"）。 */
  readonly concede: boolean
}

export interface RiskView {
  readonly stance: 'favor' | 'oppose' | 'neutral'
  readonly concerns: readonly string[]
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
  readonly reports: readonly {
    readonly agent: string
    readonly verdict: Verdict
    readonly keyNumbers: Readonly<Record<string, number>>
    readonly artifactRef: string
  }[]
  readonly conflicts: readonly FactConflict[]
  readonly debate: {
    readonly bull: DebateArgument | null
    readonly bear: DebateArgument | null
    readonly rounds: number
  }
  readonly risk: {
    readonly aggressive: RiskView | null
    readonly conservative: RiskView | null
    readonly neutral: RiskView | null
    readonly rounds: number
  }
  /** 未被解决的分歧：裁决者据此可以选择 NO_TRADE，而不是被迫拍板。 */
  readonly openDisagreements: readonly string[]
}
