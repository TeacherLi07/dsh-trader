/**
 * trade-supervisor —— 循环的发动机：会话恢复 + followup 投递 + 心跳。
 *
 * 状态：骨架（T0.1）。T1.x 实现 ctx.agents.resume() / agent.followup() 回路。
 *
 * ⚠️ 心跳的撤单动作不能只放在进程内：进程死亡时 HeartbeatGuard 自己也死了（plan §6.3）。
 * 本插件只负责写心跳 + 检测内部卡死；真正的撤单由进程外 watchdog 或交易所原生
 * dead-man 机制执行。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { dayKey, PriceTableStore, priceTableStaleAlert } from '../cost-ledger.js'
import { getDatabase } from '../db/runtime.js'
import { Statements } from '../db/statements.js'
import { DecisionJournal } from '../exec/journal.js'
import { HeartbeatStore } from '../supervisor/heartbeat.js'

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
  // 心跳由本进程写；撤单由**进程外** watchdog 执行（进程死亡时本进程自己也死了，plan §6.3）。
  const clock = systemClock()
  const database = getDatabase()
  const journal = new DecisionJournal(database)
  const heartbeat = new HeartbeatStore(new Statements(database), (event) => {
    journal.appendAudit(event)
  })
  const heartbeatMs = config.heartbeatMs ?? 15_000

  // 价目表年龄检查（plan §12 #19）：>90 天 ⇒ P2 告警，**不阻塞**。
  // 按天节流：15s 心跳若每次都写审计会把 append-only 表刷爆，而价目表天级才变化。
  const prices = new PriceTableStore(database)
  let lastStaleDay: string | null = null
  const checkPriceTableAge = (): void => {
    const now = clock.now()
    const alert = priceTableStaleAlert(prices.ageDays(now), now)
    if (alert === null) {
      lastStaleDay = null
      return
    }
    const day = dayKey(now)
    if (day === lastStaleDay) return
    lastStaleDay = day
    journal.appendAudit({
      actor: 'system',
      kind: 'price_table_stale',
      payload: { alert, ageDays: prices.ageDays(now) },
      ts: now,
    })
  }

  // 先写一条初始心跳，避免刚启动时 watchdog 把"尚未开始循环"误判成数据库缺失。
  heartbeat.beat(clock.now())
  checkPriceTableAge()
  const stopHeartbeat = clock.setInterval(() => {
    heartbeat.beat(clock.now())
    checkPriceTableAge()
  }, heartbeatMs)

  ctx.effect(
    () => () => {
      stopHeartbeat()
      /* T1.x: 清理定时器 / 解除会话绑定 */
    },
    'trade.supervisor.close',
  )
  void config
}
