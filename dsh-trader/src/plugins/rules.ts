/**
 * `trade-rules` —— 规则引擎与触发治理（plan §2 / T0.7）。
 *
 * 规则是**纯函数**（不调模型、不读时钟、不写状态）；治理是有状态闸门（去重/冷却/限流/分级），
 * 全部经 `TriggerQueue` 幂等落库，因此"同一根 bar 重复回放零重复触发"是数据库层面的性质。
 *
 * 规则包名写错必须**立刻报错**：静默跳过等于让用户以为在盯盘、实际什么都没盯。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { getDatabase } from '../db/runtime.js'
import { DecisionJournal } from '../exec/journal.js'
import {
  DEFAULT_TRIGGER_LIMITS,
  RULE_PACKS,
  RuleWatch,
  TriggerGovernor,
  buildRules,
  type TriggerLimits,
} from '../trigger/engine.js'
import { TriggerQueue } from '../trigger/queue.js'
import { setTriggerRuntime } from '../trigger/runtime.js'
import { assertWiredRulesConfig } from '../supervisor/config-guard.js'

export const name = 'trade-rules'

const windowSchema = z.object({
  id: z.string().required(),
  at: z.string(),
  everyMs: z.number(),
})

export const Config = z.object({
  rulePacks: z.array(z.string()).required(),
  cooldownMs: z.number().required(),
  windows: z.array(windowSchema),
  escape: z.object({ maxPerHour: z.number(), maxPerDay: z.number() }),
  judgment: z.object({
    maxPerHour: z.number(),
    maxPerDay: z.number(),
    provider: z.string(),
    model: z.string(),
  }),
})

export interface RulesConfig {
  rulePacks: readonly string[]
  cooldownMs: number
  windows?: readonly { id: string; at?: string; everyMs?: number }[]
  escape?: { maxPerHour?: number; maxPerDay?: number }
  judgment?: { maxPerHour?: number; maxPerDay?: number; provider?: string; model?: string }
}

export function apply(ctx: Context, config: RulesConfig): void {
  // `windows` 与 `judgment.provider/model` 目前不生效（W2/W3 未接线）：配了就拒绝启动，
  // 而不是静默忽略 —— "配了但不生效"比"没配"更危险（会让人误以为在起作用）。
  assertWiredRulesConfig({ windows: config.windows, judgment: config.judgment })
  const built = buildRules(config.rulePacks, { cooldownMs: config.cooldownMs })
  if (built.unknownPacks.length > 0) {
    throw new Error(
      `未知规则包：${built.unknownPacks.join(', ')}；可用规则包：${Object.keys(RULE_PACKS).join(', ')}`,
    )
  }

  const limits: TriggerLimits = {
    noveltyPerHour: config.escape?.maxPerHour ?? DEFAULT_TRIGGER_LIMITS.noveltyPerHour,
    noveltyPerDay: config.escape?.maxPerDay ?? DEFAULT_TRIGGER_LIMITS.noveltyPerDay,
    judgmentPerHour: config.judgment?.maxPerHour ?? DEFAULT_TRIGGER_LIMITS.judgmentPerHour,
    judgmentPerDay: config.judgment?.maxPerDay ?? DEFAULT_TRIGGER_LIMITS.judgmentPerDay,
  }

  const queue = new TriggerQueue(getDatabase())
  const journal = new DecisionJournal(getDatabase())
  const watch = new RuleWatch(built.rules, new TriggerGovernor(queue, systemClock(), limits), {
    onFailure: (failure) => {
      try {
        journal.appendAudit({
          actor: 'system',
          kind: 'rule_uncovered',
          payload: failure,
          ts: systemClock().now(),
        })
      } catch {
        // 审计失败不能让行情回调中断；原始 failure 仍由 onBar 返回给调用方。
      }
    },
  })
  setTriggerRuntime(watch)

  ctx.effect(
    () => () => {
      setTriggerRuntime(undefined)
    },
    'trade.rules.close',
  )
}
