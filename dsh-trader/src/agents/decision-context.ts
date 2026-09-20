/**
 * 判断链唯一使用的冻结上下文（plan.md §5）。
 *
 * 上下文不是 prompt 的临时字符串：它是一次判断的事实根。每个分区都带
 * asOf/source/hash/missing，整份 canonical 内容再取 contextHash；这样模型重试、
 * 运行回放和事故复盘都能判断自己看到的是否是同一份事实。
 */

import { canonicalJson, fingerprint } from '../util/canonical.js'

export const DECISION_CONTEXT_VERSION = 1 as const

export const DECISION_CONTEXT_SECTIONS = [
  'mandate',
  'market',
  'derivatives',
  'benchmark',
  'portfolio',
  'activePlan',
  'history',
  'lessons',
  'predictions',
] as const

export type DecisionContextSectionName = (typeof DECISION_CONTEXT_SECTIONS)[number]

export type DecisionJson =
  | null
  | boolean
  | number
  | string
  | readonly DecisionJson[]
  | { readonly [key: string]: DecisionJson }

export interface DecisionContextSection<T = unknown> {
  /** 该分区事实的观测时刻；没有可用事实时为 null，而不是伪造当前时间。 */
  readonly asOf: number | null
  /** 可审计的数据来源标识，不放密钥。 */
  readonly source: string
  /** 由 value/asOf/source/missing 计算出的分区指纹。 */
  readonly hash: string
  /** 缺失路径必须显式保留，空数组表示该分区没有已知缺口。 */
  readonly missing: readonly string[]
  readonly value: T | null
}

export type DecisionContextSections = Readonly<{
  [K in DecisionContextSectionName]: DecisionContextSection
}>

export interface DecisionContextInput {
  readonly symbol: string
  readonly primaryTimeframe: '1h'
  readonly asOf: number
  readonly sections: Readonly<{
    [K in DecisionContextSectionName]: Omit<DecisionContextSection, 'hash'> & { readonly hash?: string }
  }>
}

export interface DecisionContext extends DecisionContextInput {
  readonly version: typeof DECISION_CONTEXT_VERSION
  readonly contextId: string
  readonly contextHash: string
  readonly sections: DecisionContextSections
}

function assertFiniteTimestamp(name: string, value: number | null): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} 必须是非负有限毫秒时间戳或 null`)
  }
}

function assertSectionName(name: string, value: string): void {
  if (value.trim() === '') throw new Error(`${name}.source 不能为空`)
}

function sectionPayload(section: Omit<DecisionContextSection, 'hash'>): Omit<DecisionContextSection, 'hash'> {
  return {
    asOf: section.asOf,
    source: section.source,
    missing: [...section.missing],
    value: section.value,
  }
}

function freezeSection(
  name: DecisionContextSectionName,
  section: Omit<DecisionContextSection, 'hash'> & { readonly hash?: string },
): DecisionContextSection {
  if (!Array.isArray(section.missing) || section.missing.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${name}.missing 必须是非空字符串数组`)
  }
  assertFiniteTimestamp(`${name}.asOf`, section.asOf)
  assertSectionName(name, section.source)
  const payload = sectionPayload(section)
  const hash = fingerprint(payload)
  if (section.hash !== undefined && section.hash !== hash) {
    throw new Error(`${name}.hash 与分区内容不一致：期望 ${hash}，收到 ${section.hash}`)
  }
  return { ...payload, hash }
}

function contextPayload(context: {
  readonly version: typeof DECISION_CONTEXT_VERSION
  readonly symbol: string
  readonly primaryTimeframe: '1h'
  readonly asOf: number
  readonly sections: DecisionContextSections
}): unknown {
  return {
    version: context.version,
    symbol: context.symbol,
    primaryTimeframe: context.primaryTimeframe,
    asOf: context.asOf,
    sections: context.sections,
  }
}

/** 冻结并计算唯一 hash；调用方不能把模型提供的 contextHash 当作事实根。 */
export function freezeDecisionContext(input: DecisionContextInput): DecisionContext {
  if (input.symbol.trim() === '') throw new Error('DecisionContext.symbol 不能为空')
  if (!Number.isFinite(input.asOf) || input.asOf < 0) throw new Error('DecisionContext.asOf 必须是非负有限毫秒时间戳')

  const sections = {} as Record<DecisionContextSectionName, DecisionContextSection>
  for (const name of DECISION_CONTEXT_SECTIONS) {
    const candidate = input.sections[name]
    if (candidate === undefined) throw new Error(`DecisionContext 缺少分区：${name}`)
    sections[name] = freezeSection(name, candidate)
  }

  const payload = {
    version: DECISION_CONTEXT_VERSION,
    symbol: input.symbol,
    primaryTimeframe: input.primaryTimeframe,
    asOf: input.asOf,
    sections,
  } as const
  const contextHash = fingerprint(payload)
  return {
    ...payload,
    contextId: `ctx-${contextHash.slice(7, 23)}`,
    contextHash,
  }
}

/** 重新计算哈希并校验每个分区，防止 store 或 workflow 内篡改冻结内容。 */
export function assertDecisionContext(context: DecisionContext): void {
  const frozen = freezeDecisionContext({
    symbol: context.symbol,
    primaryTimeframe: context.primaryTimeframe,
    asOf: context.asOf,
    sections: context.sections,
  })
  if (context.version !== DECISION_CONTEXT_VERSION) throw new Error(`不支持的 DecisionContext 版本：${String(context.version)}`)
  if (context.contextId !== frozen.contextId || context.contextHash !== frozen.contextHash) {
    throw new Error('DecisionContext 内容已被修改（contextId/contextHash 重算不一致）')
  }
}

/** DB 中保存的全文；统一从 canonicalJson 生成，禁止 JSON.stringify 的键序漂移。 */
export function canonicalDecisionContext(context: DecisionContext): string {
  assertDecisionContext(context)
  return canonicalJson(context)
}
