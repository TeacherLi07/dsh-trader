/**
 * 计划卡 v0（plan.md §3）。
 *
 * 四条不可协商性质：可判定 · 有期限 · 幂等根 · 不可事后改写。
 * 模型只表达"判断与方法"，**数字由代码推导**：`open` 的 qty/止损/止盈一律由
 * `stop` + `riskPct` 算出（plan §3.4），模型给不出危险的数量。
 */

import { canonicalJson, fingerprint } from '../util/canonical.js'

export { canonicalJson }

export const ACTION_KINDS = [
  'noop',
  'open',
  'reduce',
  'close',
  'set_stop',
  'set_target',
  'set_trailing',
  'cancel_all',
  'halt',
  'escalate',
] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

/** v0 支持的时间框架。承诺/失效条件**声明自己的 tf**，因此表达式里不需要（也不允许）比较 `bar.tf`。 */
export const TIMEFRAMES = ['1m', '15m', '1h', '4h', '1d'] as const
export type Timeframe = (typeof TIMEFRAMES)[number]

export type StopSpec =
  | { readonly method: 'atr'; readonly k: number }
  | { readonly method: 'structure'; readonly level: number }

export interface OpenAction {
  readonly action: 'open'
  readonly side: 'long' | 'short'
  readonly method: 'market' | 'limit'
  readonly limitOffsetBps?: number
  readonly stop: StopSpec
  readonly target?: { readonly rMultiple: number }
  /** 省略则取启动参数 riskPct；模型不得给绝对数量。 */
  readonly riskPct?: number
}

export interface ReduceAction {
  readonly action: 'reduce'
  readonly fraction: number
  readonly method?: 'market' | 'limit'
}

export interface LevelAction {
  readonly action: 'set_stop' | 'set_target'
  readonly price: number
}

export interface TrailingAction {
  readonly action: 'set_trailing'
  readonly percent: number
}

export interface CancelAction {
  readonly action: 'cancel_all'
  readonly scope: 'symbol' | 'all'
}

export interface HaltAction {
  readonly action: 'halt'
  readonly reason?: string
}

export interface EscalateAction {
  /** REVIEW：拿不准 → 记决策 + 告警，不产生新动作；在 live_auto 下不得阻塞（plan §6.1）。 */
  readonly action: 'escalate'
  readonly reason: string
}

export interface NoopAction {
  readonly action: 'noop' | 'close'
}

export type PlanAction =
  | OpenAction
  | ReduceAction
  | LevelAction
  | TrailingAction
  | CancelAction
  | HaltAction
  | EscalateAction
  | NoopAction

export interface Commitment {
  readonly id: string
  /** 在同一根 bar 上多条命中时的裁决顺序，小者优先。 */
  readonly seq: number
  /** 本承诺在哪个时间框架上求值（每根该 tf 的已收盘 bar 求值一次）。 */
  readonly tf: Timeframe
  /** v0 DSL 表达式，见 `./dsl.js`；必须是布尔值。 */
  readonly when: string
  readonly then: PlanAction
  readonly maxSlippageBps?: number
  readonly cooldownMs?: number
}

export interface Invalidation {
  readonly id: string
  readonly tf: Timeframe
  readonly when: string
  readonly then: PlanAction
}

export interface PlanCard {
  readonly planId: string
  readonly symbol: string
  readonly createdAt: number
  /** 到期即失效；过期后规则命中一律走"未覆盖"（W2）路径。 */
  readonly windowEndsAt: number
  /** 只供复盘引用，**不参与执行判定**。 */
  readonly thesis: string
  readonly confidence: number
  readonly keyLevels: readonly { readonly kind: 'support' | 'resistance' | 'pivot'; readonly price: number }[]
  readonly invalidation: readonly Invalidation[]
  readonly commitments: readonly Commitment[]
  /** 本窗口禁则。 */
  readonly forbidden: readonly ActionKind[]
  /** true = 本窗口明确不做任何入场。 */
  readonly noTrade: boolean
  readonly contentHash: string
  readonly author: 'model' | 'human'
  readonly authority: 'model' | 'store' | 'external'
}

export type PlanValidation =
  | { readonly ok: true; readonly card: PlanCard }
  | { readonly ok: false; readonly errors: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateAction(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path}: 动作必须是对象`)
    return
  }
  const action = value['action']
  if (typeof action !== 'string' || !(ACTION_KINDS as readonly string[]).includes(action)) {
    errors.push(`${path}.action 非法：${JSON.stringify(action)}`)
    return
  }
  switch (action) {
    case 'open': {
      const side = value['side']
      if (side !== 'long' && side !== 'short') errors.push(`${path}.side 必须是 long|short`)
      const method = value['method']
      if (method !== 'market' && method !== 'limit') errors.push(`${path}.method 必须是 market|limit`)
      const stop = value['stop']
      if (!isRecord(stop)) {
        errors.push(`${path}.stop 缺失（模型必须说明用哪种止损方法）`)
      } else if (stop['method'] === 'atr') {
        const k = stop['k']
        if (typeof k !== 'number' || !(k > 0)) errors.push(`${path}.stop.k 必须是正数`)
      } else if (stop['method'] === 'structure') {
        const level = stop['level']
        if (typeof level !== 'number' || !Number.isFinite(level)) errors.push(`${path}.stop.level 必须是有限数`)
      } else {
        errors.push(`${path}.stop.method 必须是 atr|structure`)
      }
      break
    }
    case 'reduce': {
      const fraction = value['fraction']
      if (typeof fraction !== 'number' || !(fraction > 0) || !(fraction < 1)) {
        errors.push(`${path}.fraction 必须在 (0,1) 内`)
      }
      break
    }
    case 'set_stop':
    case 'set_target': {
      const price = value['price']
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        errors.push(`${path}.price 必须是正的有限数`)
      }
      break
    }
    case 'set_trailing': {
      const percent = value['percent']
      if (typeof percent !== 'number' || !(percent > 0)) errors.push(`${path}.percent 必须是正数`)
      break
    }
    case 'cancel_all': {
      const scope = value['scope']
      if (scope !== 'symbol' && scope !== 'all') errors.push(`${path}.scope 必须是 symbol|all`)
      break
    }
    case 'escalate': {
      if (typeof value['reason'] !== 'string' || value['reason'].length === 0) {
        errors.push(`${path}.reason 不能为空`)
      }
      break
    }
    default:
      break
  }
}

/** 结构 + 语义校验。校验失败一律拒绝执行，**绝不**回退成散文再正则解析（plan §11.4）。 */
export function validatePlanCard(value: unknown): PlanValidation {
  if (!isRecord(value)) return { ok: false, errors: ['计划卡必须是对象'] }

  const errors: string[] = []

  for (const key of ['planId', 'symbol', 'contentHash'] as const) {
    if (typeof value[key] !== 'string' || value[key] === '') errors.push(`${key} 不能为空`)
  }
  if (typeof value['thesis'] !== 'string') errors.push('thesis 必须是字符串（可为空串）')

  const createdAt = value['createdAt']
  const windowEndsAt = value['windowEndsAt']
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) errors.push('createdAt 必须是毫秒时间戳')
  if (typeof windowEndsAt !== 'number' || !Number.isFinite(windowEndsAt)) errors.push('windowEndsAt 必须是毫秒时间戳')
  if (typeof createdAt === 'number' && typeof windowEndsAt === 'number' && windowEndsAt <= createdAt) {
    errors.push('windowEndsAt 必须晚于 createdAt（计划卡不能一出生就过期）')
  }

  const confidence = value['confidence']
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    errors.push('confidence 必须在 [0,1] 内')
  }

  if (typeof value['noTrade'] !== 'boolean') errors.push('noTrade 必须是布尔值')

  const forbidden = value['forbidden']
  if (!Array.isArray(forbidden)) errors.push('forbidden 必须是数组')
  else {
    for (const item of forbidden) {
      if (typeof item !== 'string' || !(ACTION_KINDS as readonly string[]).includes(item)) {
        errors.push(`forbidden 含非法动作：${JSON.stringify(item)}`)
      }
    }
  }

  const seenIds = new Set<string>()
  for (const key of ['invalidation', 'commitments'] as const) {
    const list = value[key]
    if (!Array.isArray(list)) {
      errors.push(`${key} 必须是数组`)
      continue
    }
    if (key === 'invalidation' && list.length === 0) {
      errors.push('invalidation 不能为空：逼不出可判定的失效条件，说明论点还没想清楚')
    }
    list.forEach((entry, index) => {
      const path = `${key}[${index}]`
      if (!isRecord(entry)) {
        errors.push(`${path} 必须是对象`)
        return
      }
      const id = entry['id']
      if (typeof id !== 'string' || id === '') errors.push(`${path}.id 不能为空`)
      else if (seenIds.has(id)) errors.push(`${path}.id 重复：${id}`)
      else seenIds.add(id)

      const when = entry['when']
      if (typeof when !== 'string' || when.trim() === '') {
        errors.push(`${path}.when 不能为空（必须能被求值器执行）`)
      }
      const tf = entry['tf']
      if (typeof tf !== 'string' || !(TIMEFRAMES as readonly string[]).includes(tf)) {
        errors.push(`${path}.tf 必须是 ${TIMEFRAMES.join('|')} 之一`)
      }
      if (key === 'commitments') {
        const seq = entry['seq']
        if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
          errors.push(`${path}.seq 必须是 >=1 的整数`)
        }
        const cooldown = entry['cooldownMs']
        if (cooldown !== undefined && (typeof cooldown !== 'number' || cooldown < 0)) {
          errors.push(`${path}.cooldownMs 必须是非负数`)
        }
      }
      validateAction(entry['then'], `${path}.then`, errors)
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, card: value as unknown as PlanCard }
}

/** 幂等根：对除 `contentHash` 自身以外的全部内容取哈希。 */
export function computeContentHash(card: Omit<PlanCard, 'contentHash'> & { contentHash?: string }): string {
  const { contentHash: _ignored, ...rest } = card as Record<string, unknown> & { contentHash?: string }
  return fingerprint(rest)
}

/** 计划卡是否已过期。过期后不得用三小时前的判断处理三小时后的市场。 */
export function isExpired(card: Pick<PlanCard, 'windowEndsAt'>, now: number): boolean {
  return now > card.windowEndsAt
}
