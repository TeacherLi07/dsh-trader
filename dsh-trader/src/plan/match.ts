/**
 * 计划卡匹配（plan §3.5）：把"判断"变成**确定性**的执行决定。
 *
 * 优先级：失效条件 → 承诺（按 `seq`）→ 无匹配。三条纪律：
 *   1. **fail-closed**：任何求值失败或非法动作都返回 `uncovered`，绝不静默当成"没命中"；
 *   2. **每根 bar 至多触发一次**（`alreadyFired` 去重），默认 edge 语义；
 *   3. `noTrade` 窗口只允许失效条件降险，**忽略承诺**（"本窗口不做入场"是硬承诺）。
 */

import { evaluateWhen } from './evaluate.js'
import type { DslContext } from './dsl.js'
import { isExpired, type PlanAction, type PlanCard } from './schema.js'

export interface MatchInput {
  readonly plan: PlanCard
  /** 当前正在求值的时间框架；只有 `tf` 相同的条件才参与（条件自带 tf）。 */
  readonly timeframe: string
  /** 本根已收盘 bar 的 `openTime`。 */
  readonly barTs: number
  readonly now: number
  readonly context: DslContext
  /** 去重查询：返回 true 表示该键已触发过。 */
  readonly alreadyFired?: (dedupKey: string) => boolean
}

export type MatchOutcome =
  | { readonly kind: 'expired' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'invalidation'
      readonly id: string
      readonly action: PlanAction
      readonly expression: string
      readonly dedupKey: string
    }
  | {
      readonly kind: 'commitment'
      readonly id: string
      readonly action: PlanAction
      readonly expression: string
      readonly dedupKey: string
    }
  /** 计划覆盖不了 / 无法求值 —— 这是 W2 唤醒的输入，不是"没事发生"。 */
  | {
      readonly kind: 'uncovered'
      readonly id: string
      readonly reason: string
      readonly dedupKey: string
    }

/**
 * 去重键：`planId|conditionId|symbol|barTs`。
 * 确定性、可读、可直接作为 `triggers.dedup_key` 的唯一键。
 */
export function planDedupKey(planId: string, id: string, symbol: string, barTs: number): string {
  return `${planId}|${id}|${symbol}|${barTs}`
}

function isForbidden(plan: PlanCard, action: PlanAction): boolean {
  return plan.forbidden.includes(action.action)
}

export function matchPlan(input: MatchInput): MatchOutcome {
  const { plan, timeframe, barTs, now, context } = input
  if (isExpired(plan, now)) return { kind: 'expired' }

  const alreadyFired = input.alreadyFired ?? ((): boolean => false)
  const failures: { readonly id: string; readonly reason: string; readonly dedupKey: string }[] = []

  let invalidationMatch: Extract<MatchOutcome, { kind: 'invalidation' }> | undefined

  // ── 1) 失效条件优先：论点被证伪 → 直接降险，不唤醒 LLM ──────────────────────
  for (const invalidation of plan.invalidation) {
    if (invalidation.tf !== timeframe) continue
    const dedupKey = planDedupKey(plan.planId, invalidation.id, plan.symbol, barTs)
    const result = evaluateWhen(invalidation.when, context)
    if (!result.ok) {
      failures.push({ id: invalidation.id, reason: result.reason, dedupKey })
      continue
    }
    if (!result.value || alreadyFired(dedupKey)) continue
    if (isForbidden(plan, invalidation.then)) {
      failures.push({ id: invalidation.id, reason: 'forbidden_action', dedupKey })
      continue
    }
    invalidationMatch ??= {
      kind: 'invalidation',
      id: invalidation.id,
      action: invalidation.then,
      expression: invalidation.when,
      dedupKey,
    }
  }

  // ── 1b) 失效条件求值失败 ⇒ 立刻 UNCOVERED（fail-closed）─────────────────────
  // 论点是否被证伪**未知**时，绝不能继续执行风险动作。旧实现先跑承诺，
  // 只要有一条承诺为真就返回 commitment，把"失效条件无法判定"吞掉了（实测）。
  const firstInvalidationFailure = failures[0]
  if (firstInvalidationFailure !== undefined) {
    return {
      kind: 'uncovered',
      id: firstInvalidationFailure.id,
      reason: firstInvalidationFailure.reason,
      dedupKey: firstInvalidationFailure.dedupKey,
    }
  }
  if (invalidationMatch !== undefined) return invalidationMatch

  // ── 2) 承诺：按 seq 升序，命中即执行（零 token、零延迟）──────────────────────
  if (!plan.noTrade) {
    const ordered = [...plan.commitments].sort((a, b) => a.seq - b.seq)
    let commitmentMatch: Extract<MatchOutcome, { kind: 'commitment' }> | undefined
    for (const commitment of ordered) {
      if (commitment.tf !== timeframe) continue
      const dedupKey = planDedupKey(plan.planId, commitment.id, plan.symbol, barTs)
      const result = evaluateWhen(commitment.when, context)
      if (!result.ok) {
        failures.push({ id: commitment.id, reason: result.reason, dedupKey })
        continue
      }
      if (!result.value || alreadyFired(dedupKey)) continue
      if (isForbidden(plan, commitment.then)) {
        failures.push({ id: commitment.id, reason: 'forbidden_action', dedupKey })
        continue
      }
      commitmentMatch ??= {
        kind: 'commitment',
        id: commitment.id,
        action: commitment.then,
        expression: commitment.when,
        dedupKey,
      }
    }
    if (failures.length > 0) {
      const first = failures[0]!
      return { kind: 'uncovered', id: first.id, reason: first.reason, dedupKey: first.dedupKey }
    }
    if (commitmentMatch !== undefined) return commitmentMatch
  }

  // ── 3) 有任何求值失败 → UNCOVERED（fail-closed，绝不当作"没命中"）──────────
  const first = failures[0]
  if (first !== undefined) {
    return { kind: 'uncovered', id: first.id, reason: first.reason, dedupKey: first.dedupKey }
  }
  return { kind: 'none' }
}
