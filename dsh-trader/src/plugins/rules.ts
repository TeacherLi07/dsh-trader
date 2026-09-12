/**
 * `trade-rules` —— 规则引擎与唤醒治理（W1/W2/W3）。
 *
 * 状态：骨架（T0.1）。规则实现为**纯函数** `(features, plan, position, config) => Hit[]`，
 * 不调用模型、不读时钟、不写状态（plan §6.6）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

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
  // TODO(T0.6/T0.7): 计划卡匹配（承诺优先，未覆盖才入 W2）、去重/冷却/限流/分级、TriggerQueue。
  ctx.effect(
    () => () => {
      /* T0.7: 释放定时器 */
    },
    'trade.rules.close',
  )
  void config
}
