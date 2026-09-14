/**
 * 规则引擎与触发治理（plan §2、§6.5 / T0.7）。
 *
 * 分工：**规则是纯函数，治理是有状态的闸门**。
 *   · `evaluateRules` 只做"条件是否成立"，同样的输入永远给同样的输出；
 *   · `TriggerGovernor` 做去重 → 冷却 → 限流 → 分级，并把结果**幂等**落库。
 *
 * 每一个命中都必须能回答"命中之后做什么" —— `purpose` 是防止规则集无边界膨胀的闸门：
 *   · `invalidation` / `commitment` → 计划卡自己的条件；走到这里说明**计划没覆盖** ⇒ W2 待判断
 *   · `novelty` → W3 逃逸通道（强限流）
 *   · `info` → 只落库/告警，**永不唤醒**
 */

import type { Clock } from '../clock.js'
import type { DslContext } from '../plan/dsl.js'
import { evaluateWhen } from '../plan/evaluate.js'
import { TriggerQueue, type TriggerPurpose, type TriggerState } from './queue.js'

export type Severity = 'P0' | 'P1' | 'P2'
export type RulePurpose = TriggerPurpose

export const RULE_PURPOSES: readonly RulePurpose[] = ['invalidation', 'commitment', 'novelty', 'info']

export interface RuleSpec {
  readonly id: string
  readonly purpose: RulePurpose
  /** 只在该 tf 上求值；省略表示所有已配置的 tf 都求值。 */
  readonly tf?: string
  readonly symbol?: string
  readonly when: string
  readonly cooldownMs: number
  readonly severity?: Severity
}

export function severityFor(purpose: RulePurpose): Severity {
  switch (purpose) {
    case 'invalidation':
      return 'P0' // 持仓风险
    case 'commitment':
    case 'novelty':
      return 'P1' // 机会 / 重大新信息
    case 'info':
      return 'P2' // 信息
  }
}

/** 规则准入：答不出"命中之后做什么"的规则就是噪音，直接拒绝。 */
export function validateRuleSpec(rule: RuleSpec): readonly string[] {
  const errors: string[] = []
  if (typeof rule.id !== 'string' || rule.id.trim() === '') errors.push('id 不能为空')
  if (!RULE_PURPOSES.includes(rule.purpose)) errors.push(`purpose 非法：${String(rule.purpose)}`)
  if (typeof rule.when !== 'string' || rule.when.trim() === '') errors.push('when 不能为空')
  if (typeof rule.cooldownMs !== 'number' || !(rule.cooldownMs >= 0)) {
    errors.push(`cooldownMs 必须 >= 0，收到 ${String(rule.cooldownMs)}`)
  }
  return errors
}

export interface RuleHit {
  readonly ruleId: string
  readonly purpose: RulePurpose
  readonly symbol: string
  readonly timeframe: string
  readonly barTs: number
  readonly severity: Severity
  readonly expression: string
  readonly dedupKey: string
}

/** 无法求值的规则：**不是**"没命中"，必须单独暴露（fail-closed 的可观测面）。 */
export interface RuleFailure {
  readonly ruleId: string
  readonly symbol: string
  readonly timeframe: string
  readonly barTs: number
  readonly reason: string
}

/** 去重键：`ruleId|symbol|barTs`。plan §6.5 的 `hash(rule_id, symbol, bar_ts, 阈值桶)`。 */
export function ruleDedupKey(ruleId: string, symbol: string, barTs: number): string {
  return `${ruleId}|${symbol}|${barTs}`
}

export interface RuleEvaluationInput {
  readonly rules: readonly RuleSpec[]
  readonly symbol: string
  readonly timeframe: string
  readonly barTs: number
  readonly context: DslContext
}

export interface RuleEvaluation {
  readonly hits: readonly RuleHit[]
  readonly failures: readonly RuleFailure[]
}

/** 纯函数：只判断条件是否成立，不落库、不读时钟、不看历史。 */
export function evaluateRules(input: RuleEvaluationInput): RuleEvaluation {
  const hits: RuleHit[] = []
  const failures: RuleFailure[] = []

  for (const rule of input.rules) {
    if (rule.tf !== undefined && rule.tf !== input.timeframe) continue
    if (rule.symbol !== undefined && rule.symbol !== input.symbol) continue

    const result = evaluateWhen(rule.when, input.context)
    if (!result.ok) {
      failures.push({
        ruleId: rule.id,
        symbol: input.symbol,
        timeframe: input.timeframe,
        barTs: input.barTs,
        reason: result.reason,
      })
      continue
    }
    if (!result.value) continue

    hits.push({
      ruleId: rule.id,
      purpose: rule.purpose,
      symbol: input.symbol,
      timeframe: input.timeframe,
      barTs: input.barTs,
      severity: rule.severity ?? severityFor(rule.purpose),
      expression: rule.when,
      dedupKey: ruleDedupKey(rule.id, input.symbol, input.barTs),
    })
  }

  return { hits, failures }
}

// ── 触发治理 ──────────────────────────────────────────────────────────────────

export interface TriggerLimits {
  readonly noveltyPerHour: number
  readonly noveltyPerDay: number
  readonly judgmentPerHour: number
  readonly judgmentPerDay: number
}

/** 与 plan §2 的默认上限一致（W3：2/时、6/天；W2：3/时、8/天）。 */
export const DEFAULT_TRIGGER_LIMITS: TriggerLimits = {
  noveltyPerHour: 2,
  noveltyPerDay: 6,
  judgmentPerHour: 3,
  judgmentPerDay: 8,
}

export type Disposition =
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'cooldown'; readonly until: number }
  | { readonly kind: 'rate_limited'; readonly window: 'hour' | 'day'; readonly limit: number }
  | { readonly kind: 'info' }
  | { readonly kind: 'novelty' }
  | { readonly kind: 'judgment' }

/** 只有这些去向会落库 —— `duplicate` 物理上写不进去（`dedup_key` 唯一）。 */
export type PersistableDisposition = Exclude<Disposition, { readonly kind: 'duplicate' }>

export interface GovernorDecision {
  readonly dedupKey: string
  readonly ruleId: string
  readonly severity: Severity
  readonly disposition: Disposition
  /** 是否写入了 triggers 表（duplicate 一律不写）。 */
  readonly persisted: boolean
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface SubmitOptions {
  readonly payload?: unknown
  /** 触发多久后作废（避免处理陈旧信号）。 */
  readonly ttlMs?: number
  /** 冷却窗口；通常取自 `RuleSpec.cooldownMs`。 */
  readonly cooldownMs?: number
}

export class TriggerGovernor {
  constructor(
    private readonly queue: TriggerQueue,
    private readonly clock: Clock,
    private readonly limits: TriggerLimits = DEFAULT_TRIGGER_LIMITS,
  ) {}

  /**
   * 决定一条规则命中的去向。顺序严格按 plan §6.5：**去重 → 冷却 → 限流 → 分级**。
   * 被冷却/限流压掉的命中**仍然落库**（`state = 'done'` + payload 里标注原因），
   * 因为"超限一律落库 + 告警"是硬要求；只有重复项不写（物理上写不进去）。
   */
  submit(hit: RuleHit, options: SubmitOptions = {}): GovernorDecision {
    const now = this.clock.now()

    if (this.queue.has(hit.dedupKey)) {
      return {
        dedupKey: hit.dedupKey,
        ruleId: hit.ruleId,
        severity: hit.severity,
        disposition: { kind: 'duplicate' },
        persisted: false,
      }
    }

    const cooldownMs = options.cooldownMs ?? 0
    if (cooldownMs > 0) {
      const last = this.queue.latestFireAt(hit.ruleId, hit.symbol)
      if (last !== undefined && now - last < cooldownMs) {
        const until = last + cooldownMs
        return this.#persist(hit, now, { kind: 'cooldown', until }, 'done', options)
      }
    }

    const limited = this.#rateLimit(hit, now)
    if (limited !== undefined) {
      return this.#persist(hit, now, limited, 'done', options)
    }

    if (hit.purpose === 'novelty') {
      return this.#persist(hit, now, { kind: 'novelty' }, 'queued', options)
    }
    if (hit.purpose === 'commitment' || hit.purpose === 'invalidation') {
      // 走到治理层说明计划卡没有覆盖它 ⇒ 这正是 W2 的输入
      return this.#persist(hit, now, { kind: 'judgment' }, 'queued', options)
    }
    return this.#persist(hit, now, { kind: 'info' }, 'done', options)
  }

  #rateLimit(hit: RuleHit, now: number): PersistableDisposition | undefined {
    if (hit.purpose === 'novelty') {
      if (this.queue.countFiredSince(['novelty'], now - HOUR_MS) >= this.limits.noveltyPerHour) {
        return { kind: 'rate_limited', window: 'hour', limit: this.limits.noveltyPerHour }
      }
      if (this.queue.countFiredSince(['novelty'], now - DAY_MS) >= this.limits.noveltyPerDay) {
        return { kind: 'rate_limited', window: 'day', limit: this.limits.noveltyPerDay }
      }
      return undefined
    }
    if (hit.purpose === 'commitment' || hit.purpose === 'invalidation') {
      const purposes: readonly TriggerPurpose[] = ['commitment', 'invalidation']
      if (this.queue.countFiredSince(purposes, now - HOUR_MS) >= this.limits.judgmentPerHour) {
        return { kind: 'rate_limited', window: 'hour', limit: this.limits.judgmentPerHour }
      }
      if (this.queue.countFiredSince(purposes, now - DAY_MS) >= this.limits.judgmentPerDay) {
        return { kind: 'rate_limited', window: 'day', limit: this.limits.judgmentPerDay }
      }
    }
    return undefined
  }

  #persist(
    hit: RuleHit,
    now: number,
    disposition: PersistableDisposition,
    state: TriggerState,
    options: SubmitOptions,
  ): GovernorDecision {
    const persisted = this.queue.enqueue({
      triggerId: hit.dedupKey,
      dedupKey: hit.dedupKey,
      symbol: hit.symbol,
      ruleId: hit.ruleId,
      purpose: hit.purpose,
      barTs: hit.barTs,
      disposition: disposition.kind,
      state,
      createdAt: now,
      ...(options.ttlMs === undefined ? {} : { expiresAt: now + options.ttlMs }),
      payload: {
        disposition,
        severity: hit.severity,
        expression: hit.expression,
        timeframe: hit.timeframe,
        detail: options.payload ?? null,
      },
    })
    return {
      dedupKey: hit.dedupKey,
      ruleId: hit.ruleId,
      severity: hit.severity,
      disposition,
      persisted,
    }
  }
}

export interface BarInput {
  readonly symbol: string
  readonly timeframe: string
  readonly barTs: number
  readonly context: DslContext
}

export interface WatchOutcome {
  readonly hits: readonly RuleHit[]
  readonly failures: readonly RuleFailure[]
  readonly decisions: readonly GovernorDecision[]
}

/** 单根 bar 的盯盘入口：求值 + 治理。可以安全地对同一根 bar 重复调用（幂等）。 */
export class RuleWatch {
  constructor(
    private readonly rules: readonly RuleSpec[],
    private readonly governor: TriggerGovernor,
  ) {}

  onBar(input: BarInput): WatchOutcome {
    const evaluation = evaluateRules({
      rules: this.rules,
      symbol: input.symbol,
      timeframe: input.timeframe,
      barTs: input.barTs,
      context: input.context,
    })

    const decisions = evaluation.hits.map((hit) => {
      const rule = this.rules.find((candidate) => candidate.id === hit.ruleId)
      return this.governor.submit(hit, { cooldownMs: rule?.cooldownMs ?? 0 })
    })

    return { hits: evaluation.hits, failures: evaluation.failures, decisions }
  }

  get ruleCount(): number {
    return this.rules.length
  }
}

// ── 内置规则包 ────────────────────────────────────────────────────────────────

export interface RulePackOptions {
  readonly cooldownMs: number
}

export type RulePack = (options: RulePackOptions) => readonly RuleSpec[]

/** 只使用**已实现**的内核指标，因此不会在每根 bar 上产生无意义的 UNCOVERED。 */
export const RULE_PACKS: Readonly<Record<string, RulePack>> = {
  mean_reversion_v1: ({ cooldownMs }) => [
    { id: 'rsi_oversold', purpose: 'info', when: 'rsi14 < 30', cooldownMs },
    { id: 'rsi_overbought', purpose: 'info', when: 'rsi14 > 70', cooldownMs },
    { id: 'zscore_extreme', purpose: 'novelty', when: 'abs(zscore20) > 2', cooldownMs },
  ],
  breakout_v1: ({ cooldownMs }) => [
    { id: 'close_above_ema20', purpose: 'info', when: 'bar.close > ema20 * 1.01', cooldownMs },
    { id: 'close_below_ema20', purpose: 'info', when: 'bar.close < ema20 * 0.99', cooldownMs },
    {
      id: 'range_expansion',
      purpose: 'novelty',
      when: 'bar.high - bar.low > atr14 * 2',
      cooldownMs,
    },
  ],
}

export interface BuildRulesResult {
  readonly rules: readonly RuleSpec[]
  /** 无法识别的规则包名 —— 调用方必须**显式报错**，不能静默跳过。 */
  readonly unknownPacks: readonly string[]
}

export function buildRules(packNames: readonly string[], options: RulePackOptions): BuildRulesResult {
  const rules: RuleSpec[] = []
  const unknownPacks: string[] = []
  for (const name of packNames) {
    const pack = RULE_PACKS[name]
    if (pack === undefined) {
      unknownPacks.push(name)
      continue
    }
    rules.push(...pack(options))
  }
  return { rules, unknownPacks }
}
