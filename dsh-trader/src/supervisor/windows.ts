/**
 * W1 窗口调度与 W2/W3 唤醒路由（plan §2、§3.5、§8）。
 *
 * 这里刻意只接收时间戳与计数：supervisor 可以用 ReplayClock 驱动同一套逻辑，
 * 回放不会因为读取墙钟或隐藏的调度状态而产生不同结果。
 */

import type { BudgetDecision } from '../cost.js'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const UTC_TIME = /^(?:[01]\d|2[0-3]):[0-5]\dZ$/

export interface WindowSpec {
  readonly id: string
  readonly at?: string
  readonly everyMs?: number
}

export interface WindowFire {
  readonly id: string
  readonly fireTs: number
}

/** 返回配置错误而不是替调用方猜一个窗口，避免非法窗口静默停止调度。 */
export function validateWindowSpec(spec: WindowSpec): readonly string[] {
  const errors: string[] = []
  if (typeof spec.id !== 'string' || spec.id.trim() === '') errors.push('id 不能为空')

  if (spec.at !== undefined && (typeof spec.at !== 'string' || !UTC_TIME.test(spec.at))) {
    errors.push(`at 必须是合法 UTC 时刻 HH:MMZ，收到 ${String(spec.at)}`)
  }
  if (spec.everyMs !== undefined && (typeof spec.everyMs !== 'number' || !Number.isFinite(spec.everyMs) || spec.everyMs <= 0)) {
    errors.push(`everyMs 必须是正有限数，收到 ${String(spec.everyMs)}`)
  }
  if (spec.at === undefined && spec.everyMs === undefined) errors.push('at 与 everyMs 至少要提供一个')
  return errors
}

function assertValidWindowSpec(spec: WindowSpec): void {
  const errors = validateWindowSpec(spec)
  if (errors.length > 0) throw new Error(`非法窗口 ${String(spec.id)}：${errors.join('；')}`)
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`${name} 必须是有限时间戳，收到 ${String(value)}`)
}

function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS
}

function atMinutes(at: string): number {
  // 调用方先通过 UTC_TIME 校验；按固定位置解析可避免引入本地时区语义。
  return Number(at.slice(0, 2)) * 60 + Number(at.slice(3, 5))
}

function nextAtFireAt(at: string, now: number): number {
  let fireTs = utcDayStart(now) + atMinutes(at) * MINUTE_MS
  if (fireTs <= now) fireTs += DAY_MS
  if (!Number.isFinite(fireTs)) throw new Error(`at 计算出的下一次窗口时间无效：${String(now)}`)
  return fireTs
}

/**
 * 求窗口下一次触发时间；同时配置时 `at` 优先，保证固定审议窗不会被轮询间隔改写。
 * W1 由窗口调度直接产生，不经过 decideWake；后者只负责已有信息的 W2/W3 分流。
 */
export function nextFireAt(spec: WindowSpec, now: number): number {
  assertValidWindowSpec(spec)
  assertTimestamp('now', now)

  if (spec.at !== undefined) return nextAtFireAt(spec.at, now)

  // everyMs 的语义是从本次观察时刻安排下一发；它不依赖未注入的墙钟锚点。
  const fireTs = now + (spec.everyMs as number)
  if (!Number.isFinite(fireTs)) throw new Error(`everyMs 计算出的下一次窗口时间无效：${String(now)}`)
  return fireTs
}

/** 窗口审计/触发共用的稳定幂等键。 */
export function windowDedupKey(id: string, fireTs: number): string {
  return `${id}|${fireTs}`
}

/**
 * 列出 `(sinceExclusive, nowInclusive]` 内的所有窗口触发，并按时间排序。
 * 扫描边界本身是 everyMs 的锚点，因此每次重复扫描同一区间会得到同一组键；Map 再兜底去掉
 * 重复配置造成的同一 `(id, fireTs)`，让 supervisor 重试不会重复入队或审计。
 */
export function dueWindows(specs: readonly WindowSpec[], sinceExclusive: number, nowInclusive: number): WindowFire[] {
  assertTimestamp('sinceExclusive', sinceExclusive)
  assertTimestamp('nowInclusive', nowInclusive)

  // 先校验全部配置，即使区间为空也不能让非法窗口被静默掩盖。
  for (const spec of specs) assertValidWindowSpec(spec)
  if (sinceExclusive >= nowInclusive) return []

  const unique = new Map<string, WindowFire>()
  for (const spec of specs) {
    let fireTs = nextFireAt(spec, sinceExclusive)
    while (fireTs <= nowInclusive) {
      const fire = { id: spec.id, fireTs }
      unique.set(windowDedupKey(fire.id, fire.fireTs), fire)

      const next = spec.at !== undefined ? fireTs + DAY_MS : fireTs + (spec.everyMs as number)
      if (!Number.isFinite(next) || next <= fireTs) {
        throw new Error(`窗口 ${spec.id} 无法推进到下一次触发：${String(fireTs)}`)
      }
      fireTs = next
    }
  }

  return [...unique.values()].sort((left, right) => left.fireTs - right.fireTs || left.id.localeCompare(right.id))
}

export type Wake = 'W1' | 'W2' | 'W3' | 'none'

export type WakeDisposition = 'executed' | 'rate_limited' | 'budget_limited' | 'info' | 'novelty' | 'judgment'

export interface WakeLimits {
  readonly judgmentPerHour: number
  readonly judgmentPerDay: number
  readonly noveltyPerHour: number
  readonly noveltyPerDay: number
}

export interface WakeDecisionInput {
  readonly purpose: 'invalidation' | 'commitment' | 'novelty' | 'info'
  readonly matchedCommitment: boolean
  readonly judgmentFiredLastHour: number
  readonly judgmentFiredToday: number
  readonly noveltyFiredLastHour: number
  readonly noveltyFiredToday: number
  readonly limits: WakeLimits
  readonly budget: BudgetDecision
}

export interface WakeDecision {
  readonly wake: Wake
  readonly reason: string
  readonly disposition: WakeDisposition
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须是非负有限数，收到 ${String(value)}`)
}

function assertWakeInput(input: WakeDecisionInput): void {
  if (!['invalidation', 'commitment', 'novelty', 'info'].includes(input.purpose)) {
    throw new Error(`purpose 非法：${String(input.purpose)}`)
  }
  const counts: readonly [string, number][] = [
    ['judgmentFiredLastHour', input.judgmentFiredLastHour],
    ['judgmentFiredToday', input.judgmentFiredToday],
    ['noveltyFiredLastHour', input.noveltyFiredLastHour],
    ['noveltyFiredToday', input.noveltyFiredToday],
    ['judgmentPerHour', input.limits.judgmentPerHour],
    ['judgmentPerDay', input.limits.judgmentPerDay],
    ['noveltyPerHour', input.limits.noveltyPerHour],
    ['noveltyPerDay', input.limits.noveltyPerDay],
  ]
  for (const [name, value] of counts) assertNonNegativeFinite(name, value)
}

function budgetReason(input: WakeDecisionInput, wake: 'W2' | 'W3', hourCount: number, hourLimit: number, dayCount: number, dayLimit: number): string {
  const detail = input.budget.allow ? '预算允许' : input.budget.reason
  return `${wake} 预算拒绝（小时 ${hourCount}/${hourLimit}，今日 ${dayCount}/${dayLimit}）：${detail}`
}

/**
 * 纯函数唤醒路由：计划卡命中与 invalidation 都在代码侧直接执行，info 只留痕；只有未覆盖的判断与
 * 结构化新颖性信号才可能唤醒模型。W1 是时钟窗口的直接产物，职责上不应从这里绕行。
 */
export function decideWake(input: WakeDecisionInput): WakeDecision {
  assertWakeInput(input)

  if (input.matchedCommitment) {
    return { wake: 'none', reason: '命中承诺，直接执行，不唤醒', disposition: 'executed' }
  }
  if (input.purpose === 'invalidation') {
    return { wake: 'none', reason: '命中失效条件，执行降险，不唤醒', disposition: 'executed' }
  }
  if (input.purpose === 'info') {
    return { wake: 'none', reason: '信息类触发只落库，不唤醒（零 token）', disposition: 'info' }
  }

  if (input.purpose === 'novelty') {
    if (input.noveltyFiredLastHour >= input.limits.noveltyPerHour) {
      return {
        wake: 'none',
        reason: `W3 新颖性小时上限已达（最近 1 小时 ${input.noveltyFiredLastHour}/${input.limits.noveltyPerHour}）`,
        disposition: 'rate_limited',
      }
    }
    if (input.noveltyFiredToday >= input.limits.noveltyPerDay) {
      return {
        wake: 'none',
        reason: `W3 新颖性日上限已达（今日 ${input.noveltyFiredToday}/${input.limits.noveltyPerDay}）`,
        disposition: 'rate_limited',
      }
    }
    if (!input.budget.allow) {
      return {
        wake: 'none',
        reason: budgetReason(
          input,
          'W3',
          input.noveltyFiredLastHour,
          input.limits.noveltyPerHour,
          input.noveltyFiredToday,
          input.limits.noveltyPerDay,
        ),
        disposition: 'budget_limited',
      }
    }
    return { wake: 'W3', reason: '结构化新颖性信号，唤醒 W3', disposition: 'novelty' }
  }

  if (input.judgmentFiredLastHour >= input.limits.judgmentPerHour) {
    return {
      wake: 'none',
      reason: `W2 判断小时上限已达（最近 1 小时 ${input.judgmentFiredLastHour}/${input.limits.judgmentPerHour}）`,
      disposition: 'rate_limited',
    }
  }
  if (input.judgmentFiredToday >= input.limits.judgmentPerDay) {
    return {
      wake: 'none',
      reason: `W2 判断日上限已达（今日 ${input.judgmentFiredToday}/${input.limits.judgmentPerDay}）`,
      disposition: 'rate_limited',
    }
  }
  if (!input.budget.allow) {
    return {
      wake: 'none',
      reason: budgetReason(
        input,
        'W2',
        input.judgmentFiredLastHour,
        input.limits.judgmentPerHour,
        input.judgmentFiredToday,
        input.limits.judgmentPerDay,
      ),
      disposition: 'budget_limited',
    }
  }
  return { wake: 'W2', reason: '判断类条件未被计划卡覆盖，唤醒 W2', disposition: 'judgment' }
}
