/**
 * 上下文组装（plan §5.1 / T1.5）。
 *
 * 六类上下文里只有五类会进模型，但**每一类都要有确定的落点**：
 *
 * | # | 类别 | form | 可压缩 |
 * |---|---|---|---|
 * | C1 | 宪法 | `system` | ✗ 逐字 |
 * | C2 | 配置 | `instructions` | ✗ |
 * | C3 | 状态 | `snapshot` | ✗（**取代**语义，不追加） |
 * | C4 | 承诺 | `snapshot`（与 C3 同一条） | ✗ 绝不压缩 |
 * | C5 | 情节 | `recall` | ✓ 可摘要，数值须精确 |
 * | C6 | 原始 | **不进入** | — |
 *
 * 两条硬不变量：
 *   · `ctxHash = sha256(canonical(可复现的组装结果))` —— 同样入参必须得到同样哈希；
 *   · **遮蔽而非删除**：工具返回体超预算时，只把**批量字段**换成带指路的占位符，
 *     信封里的 id / 金额 / 价位**逐字保留**（`maskToolResult` 会自检这一点）。
 */

import { canonicalJson, sha256Hex } from '../util/canonical.js'
import { constitutionWithVersion, PROMPT_VERSION } from './prompts.js'

export const CONTEXT_KINDS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'] as const
export type ContextKind = (typeof CONTEXT_KINDS)[number]

export const CONTEXT_FORMS: Readonly<Record<ContextKind, string>> = {
  C1: 'system',
  C2: 'instructions',
  C3: 'snapshot',
  C4: 'snapshot',
  C5: 'recall',
  C6: 'none',
}

/** C5 是唯一允许被压缩的一类；C1/C4 绝不能压缩（plan §5.1）。 */
export const COMPRESSIBLE: Readonly<Record<ContextKind, boolean>> = {
  C1: false,
  C2: false,
  C3: false,
  C4: false,
  C5: true,
  C6: false,
}

export const DEFAULT_BLOCK_BUDGETS: Readonly<Record<ContextKind, number>> = {
  C1: 8_000,
  C2: 4_000,
  C3: 4_000,
  C4: 4_000,
  C5: 6_000,
  C6: 0,
}

/** 唤醒消息硬上限（plan §5.1）。 */
export const MAX_NOTICE_CHARS = 120

export interface ContextInput {
  /** C1：纪律/禁则/动作词汇表，逐字注入。 */
  readonly constitution: string
  readonly configuration: Readonly<Record<string, unknown>>
  readonly state: Readonly<Record<string, unknown>>
  readonly commitments: readonly unknown[]
  readonly episodes: readonly unknown[]
  readonly budgets?: Partial<Record<ContextKind, number>>
  /** C1 使用的提示词版本；为什么需要：版本变化必须进入哈希，省略时沿用当前 PROMPT_VERSION。 */
  readonly promptVersion?: string
}

export type PartHashes = Readonly<Partial<Record<ContextKind, string>>>

export interface ContextBlock {
  readonly kind: ContextKind
  readonly label: string
  readonly form: string
  readonly text: string
  readonly chars: number
  readonly hash: string
  readonly compressible: boolean
  /** 因超预算而被摘要（只在 C5 可能为真）。 */
  readonly summarized: boolean
}

export interface AssembledContext {
  /** 真正进入模型的消息块：C1、C2、C3+C4 合并的一条 snapshot、C5。**没有 C6**。 */
  readonly blocks: readonly ContextBlock[]
  readonly ctxHash: string
  readonly partHashes: Readonly<Record<ContextKind, string>>
  /** 与上一次组装相比内容发生变化的类别（首次组装 = 全部有五类）。 */
  readonly changedParts: readonly ContextKind[]
  /** 超出预算但**不允许压缩**的类别 —— 必须让上层看见，而不是悄悄截断。 */
  readonly overflow: readonly ContextKind[]
}

function partOf(value: unknown): { text: string; hash: string } {
  const text = canonicalJson(value)
  return { text, hash: `sha256:${sha256Hex(text)}` }
}

/** C1 的 canonical 文本同时是模型输入和哈希输入，避免版本只进指纹而未进宪法正文。 */
function constitutionPart(base: string, version: string): { text: string; hash: string } {
  return partOf({ version, constitution: constitutionWithVersion(base, version) })
}

/** C5 摘要：保留精确数值与 id，只截断散文。 */
function summarizeEpisodes(episodes: readonly unknown[], budget: number): string {
  const full = canonicalJson(episodes)
  if (full.length <= budget) return full
  const kept: unknown[] = []
  let used = 0
  for (const episode of episodes) {
    const rendered = canonicalJson(episode)
    if (used + rendered.length > budget) break
    kept.push(episode)
    used += rendered.length
  }
  return canonicalJson({
    summarized: true,
    omitted: episodes.length - kept.length,
    refetch: { tool: 'trade_recall', reason: '上下文预算：情节摘要，数值请用工具重取' },
    episodes: kept,
  })
}

export function assembleContext(input: ContextInput, previous?: PartHashes): AssembledContext {
  const budgets = { ...DEFAULT_BLOCK_BUDGETS, ...(input.budgets ?? {}) }

  const c1 = constitutionPart(input.constitution, input.promptVersion ?? PROMPT_VERSION)
  const c2 = partOf(input.configuration)
  const c3 = partOf(input.state)
  const c4 = partOf(input.commitments)
  const episodesText = summarizeEpisodes(input.episodes, budgets.C5)
  const c5 = partOf(JSON.parse(episodesText) as unknown)

  const partHashes = {
    C1: c1.hash,
    C2: c2.hash,
    C3: c3.hash,
    C4: c4.hash,
    C5: c5.hash,
    // C6 永不进入上下文：它的"哈希"是空内容的哈希，用于让 changedParts 的键集合完整
    C6: `sha256:${sha256Hex('C6:never-in-context')}`,
  } as const

  const rawPartText: Readonly<Record<ContextKind, string>> = {
    C1: c1.text,
    C2: c2.text,
    C3: c3.text,
    C4: c4.text,
    C5: c5.text,
    C6: '',
  }

  // 超预算但**不允许压缩**的类别：上层必须看见（C6 不进入上下文，无所谓预算）
  const overflow = CONTEXT_KINDS.filter(
    (kind) => kind !== 'C6' && !COMPRESSIBLE[kind] && budgets[kind] > 0 && rawPartText[kind].length > budgets[kind],
  )

  const blocks: ContextBlock[] = [
    block('C1', '宪法', c1.text, false, budgets.C1),
    block('C2', '配置', c2.text, false, budgets.C2),
    // C3 与 C4 合并为**一条** snapshot：状态用取代语义，承诺绝不被追加式淹没
    block(
      'C3',
      '状态+承诺',
      canonicalJson({ state: input.state, commitments: input.commitments, merged: ['C3', 'C4'] }),
      false,
      budgets.C3 + budgets.C4,
    ),
    block(
      'C5',
      '情节',
      episodesText,
      episodesText !== canonicalJson(input.episodes),
      budgets.C5,
    ),
  ]

  const ctxHash = `sha256:${sha256Hex(canonicalJson({ partHashes, blocks: blocks.map((item) => item.text) }))}`
  const changedParts = CONTEXT_KINDS.filter((kind) => previous?.[kind] !== partHashes[kind])

  return { blocks, ctxHash, partHashes, changedParts, overflow }
}

function block(
  kind: ContextKind,
  label: string,
  text: string,
  summarized: boolean,
  budget: number,
): ContextBlock {
  if (!COMPRESSIBLE[kind] && budget > 0 && text.length > budget) {
    // 不允许压缩的类别超预算 = 配置错误，必须显式失败而不是静默截断
    return {
      kind,
      label,
      form: CONTEXT_FORMS[kind],
      text,
      chars: text.length,
      hash: `sha256:${sha256Hex(text)}`,
      compressible: false,
      summarized: false,
    }
  }
  return {
    kind,
    label,
    form: CONTEXT_FORMS[kind],
    text,
    chars: text.length,
    hash: `sha256:${sha256Hex(text)}`,
    compressible: COMPRESSIBLE[kind],
    summarized,
  }
}

// ── 唤醒消息 ─────────────────────────────────────────────────────────────────

export interface Notice {
  readonly form: 'notice'
  /** ≤ 120 字符硬上限；超长直接**截断并标记**，而不是让框架丢弃整条消息。 */
  readonly summary: string
  readonly truncated: boolean
  readonly refetch?: Readonly<Record<string, unknown>>
}

export function makeNotice(
  summary: string,
  refetch?: Readonly<Record<string, unknown>>,
): Notice {
  const clean = summary.replace(/\s+/g, ' ').trim()
  const truncated = clean.length > MAX_NOTICE_CHARS
  return {
    form: 'notice',
    summary: truncated ? `${clean.slice(0, MAX_NOTICE_CHARS - 1)}…` : clean,
    truncated,
    ...(refetch === undefined ? {} : { refetch }),
  }
}

// ── 遮蔽（masking）────────────────────────────────────────────────────────

/**
 * 批量字段：这些字段只允许以"占位符 + 重取指路"的形式进入上下文。
 * 只覆盖**原始/批量**数据（K 线、逐笔、市场清单、全文）—— 它们正是 C6 的材质。
 * 其余字段（id、金额、价位、状态）逐字保留。
 */
export const BULK_FIELDS = [
  'candles',
  'bars',
  'ohlcv',
  'trades',
  'markets',
  'articles',
  'history',
  'points',
] as const

/**
 * **绝不允许**被当成批量字段遮蔽的字段：未平仓头寸与未成交订单（plan §5.1「绝不可丢」）。
 * 它们一旦进了 `BULK_FIELDS`，id/数量/价位就会从上下文里消失 —— 那是事故。
 */
export const PROTECTED_FIELDS = [
  'orders',
  'positions',
  'openOrders',
  'orderIntents',
  'fills',
] as const

/** 遮蔽时**必须逐字存活**的字段名（plan §5.1「绝不可丢」）。 */
export const CRITICAL_FIELDS = [
  'clientOrderId',
  'decisionId',
  'contentHash',
  'orderId',
  'intentId',
  'qty',
  'price',
  'stopPrice',
  'notionalUsd',
  'equityQuote',
  'limit',
  'used',
] as const

/** 工具返回体的默认字符预算；超过才动用遮蔽。 */
export const DEFAULT_TOOL_RESULT_BUDGET = 4_000

export interface MaskOptions {
  readonly tool: string
  /** 重取需要的参数，写进占位符让模型能自己取回。 */
  readonly args?: Readonly<Record<string, unknown>>
  /** 单个批量字段允许保留的元素数；超出部分被遮蔽。 */
  readonly keep?: number
  /** 返回体字符预算；不超过则**原样**返回（遮蔽不是默认行为）。 */
  readonly budgetChars?: number
}

export interface MaskedResult {
  readonly tool: string
  readonly masked: boolean
  readonly omitted: Readonly<Record<string, number>>
  readonly payload: Readonly<Record<string, unknown>>
}

/**
 * 信封（envelope）里的 `key: value` 对 —— **跳过**批量字段的内容。
 * 遮蔽必须让这些对一个不少地存活；批量字段内部的逐笔价格不属于"绝不可丢"清单。
 */
function envelopeCriticalPairs(value: Readonly<Record<string, unknown>>): readonly string[] {
  const pairs: string[] = []
  const walk = (node: unknown, key: string): void => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      if ((BULK_FIELDS as readonly string[]).includes(key)) return
      for (const item of node) walk(item, key)
      return
    }
    if (typeof node !== 'object') {
      if ((CRITICAL_FIELDS as readonly string[]).includes(key)) {
        pairs.push(`${key}=${JSON.stringify(node)}`)
      }
      return
    }
    for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, childKey)
    }
  }
  walk(value, '')
  return pairs
}

/**
 * 遮蔽批量字段，并**自检**信封里的关键字段一个都没丢。
 * 自检失败抛错 —— 宁可让组装失败，也不能让 id/金额在上下文里消失。
 */
export function maskToolResult(
  result: Readonly<Record<string, unknown>>,
  options: MaskOptions,
): MaskedResult {
  const keep = options.keep ?? 0
  const budgetChars = options.budgetChars ?? DEFAULT_TOOL_RESULT_BUDGET
  const oversized = canonicalJson(result).length > budgetChars
  const omitted: Record<string, number> = {}
  const payload: Record<string, unknown> = {}
  let masked = false

  for (const [key, value] of Object.entries(result)) {
    if (
      oversized &&
      (BULK_FIELDS as readonly string[]).includes(key) &&
      Array.isArray(value) &&
      value.length > keep
    ) {
      omitted[key] = value.length - keep
      masked = true
      if (keep > 0) payload[key] = value.slice(0, keep)
      payload[`${key}__masked`] = {
        omitted: value.length - keep,
        refetch: { tool: options.tool, args: options.args ?? {}, field: key },
      }
      continue
    }
    payload[key] = value
  }

  const before = envelopeCriticalPairs(result)
  const after = new Set(envelopeCriticalPairs(payload))
  const lost = before.filter((pair) => !after.has(pair))
  if (lost.length > 0) {
    throw new Error(`遮蔽丢失了不可丢字段：${lost.join(', ')}`)
  }

  return { tool: options.tool, masked, omitted, payload }
}
