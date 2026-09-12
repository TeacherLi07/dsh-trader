/**
 * `trade-supervisor` —— 循环的发动机：会话恢复 + followup 投递 + 心跳。
 *
 * 状态：骨架（T0.1）。T1.x 实现 `ctx.agents.resume()` / `agent.followup()` 回路。
 *
 * ⚠️ 心跳的撤单动作**不能**只放在进程内：进程死亡时 HeartbeatGuard 自己也死了（plan §6.3）。
 * 本插件只负责"写心跳 + 检测内部卡死"；真正的撤单由**进程外** watchdog 或交易所原生
 * dead-man 机制执行。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'trade-supervisor'

export const Config = z.object({
  deskSessionId: z.string().required(),
  l2: z.object({ provider: z.string(), model: z.string() }),
  l3: z.object({ provider: z.string(), model: z.string() }),
  l3MinIntervalMs: z.number(),
  dailyBudgetUsd: z.number(),
  heartbeatMs: z.number(),
})

export interface SupervisorConfig {
  deskSessionId: string
  l2?: { provider?: string; model?: string }
  l3?: { provider?: string; model?: string }
  l3MinIntervalMs?: number
  dailyBudgetUsd?: number
  heartbeatMs?: number
}

export function apply(ctx: Context, config: SupervisorConfig): void {
  // TODO(T1.x): ctx.agents.resume({ resumeSessionId: config.deskSessionId, setup }) + agent.followup(pack)
  // TODO(T1.x): W1 窗口定时器；W2/W3 仅在限流与预算允许时唤醒（无新信息不唤醒 → 零 token）。
  // TODO(P2):  写 heartbeat 表；外部 watchdog 读表并在超时后 cancelAll()。
  ctx.effect(
    () => () => {
      /* T1.x: 清理定时器 / 解除会话绑定 */
    },
    'trade.supervisor.close',
  )
  void config
}
