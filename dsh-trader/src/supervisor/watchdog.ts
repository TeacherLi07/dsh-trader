/**
 * 历史的进程外心跳 watchdog 实现（保留供旧验收证据与迁移参考）。
 *
 * 当前部署是 Docker 单进程：dsh 退出后由容器 restart policy 重启，状态收敛交给启动时
 * CrashRecovery + reconcile。watchdog 不再属于生产运行路径，且由 ExternalWatchdog
 * 的硬闸阻止任何独立调用触碰交易所。
 */

import type { Clock } from '../clock.js'
import type { Broker } from '../exec/broker.js'
import type { HeartbeatAudit, HeartbeatPort } from './heartbeat.js'

export const WATCHDOG_ENABLED = false as const
export const WATCHDOG_DISABLED_REASON =
  '外部 watchdog 已禁用：Docker restart 负责进程存活，启动恢复负责交易状态收敛'

export interface WatchdogDecisionInput {
  readonly now: number
  readonly beatAt: number | undefined
  readonly intervalMs: number
  readonly multiple?: number
  readonly halted: boolean
}

export type WatchdogDecision =
  | { readonly action: 'halt_cancel'; readonly reason: 'missing_beat' | 'stale_heartbeat' }
  | { readonly action: 'none'; readonly reason: 'already_halted' | 'healthy' }

export function watchdogDecision(input: WatchdogDecisionInput): WatchdogDecision {
  if (input.halted) return { action: 'none', reason: 'already_halted' }
  if (input.beatAt === undefined || !Number.isFinite(input.beatAt)) {
    return { action: 'halt_cancel', reason: 'missing_beat' }
  }

  const multiple = input.multiple ?? 3
  const staleAfter = multiple * input.intervalMs
  return input.now - input.beatAt > staleAfter
    ? { action: 'halt_cancel', reason: 'stale_heartbeat' }
    : { action: 'none', reason: 'healthy' }
}

export interface WatchdogAlert {
  readonly level: 'critical'
  readonly code: 'watchdog_halted' | 'watchdog_cancel_failed'
  readonly message: string
  readonly at: number
}

export interface WatchdogCheckResult {
  readonly decision: WatchdogDecision
  readonly halted: boolean
  readonly cancelAttempted: boolean
  readonly cancelSucceeded: boolean
}

export interface ExternalWatchdogDeps {
  readonly heartbeat: HeartbeatPort
  readonly broker: Pick<Broker, 'cancelAll'>
  readonly clock: Clock
  readonly intervalMs: number
  readonly multiple?: number
  readonly onAlert?: (alert: WatchdogAlert) => void
  readonly audit?: HeartbeatAudit
}

export class ExternalWatchdog {
  constructor(private readonly deps: ExternalWatchdogDeps) {}

  async checkOnce(): Promise<WatchdogCheckResult> {
    if (!WATCHDOG_ENABLED) throw new Error(WATCHDOG_DISABLED_REASON)

    const now = this.deps.clock.now()
    const heartbeat = this.deps.heartbeat.read()
    const decision = watchdogDecision({
      now,
      beatAt: heartbeat?.beatAt,
      intervalMs: this.deps.intervalMs,
      ...(this.deps.multiple === undefined ? {} : { multiple: this.deps.multiple }),
      halted: heartbeat?.halted ?? false,
    })

    if (decision.action === 'none') {
      return {
        decision,
        halted: heartbeat?.halted ?? false,
        cancelAttempted: false,
        cancelSucceeded: false,
      }
    }

    try {
      // 先撤单再置 halted：失败时保留 unhalted，下一轮才能继续尝试，避免状态与交易所背离。
      await this.deps.broker.cancelAll()
    } catch (error) {
      const message = 'watchdog 撤单失败，保持未熔断并等待下一轮重试：' + String(error)
      this.deps.audit?.({
        actor: 'system',
        kind: 'watchdog.cancel_failed',
        payload: { reason: decision.reason, error: String(error) },
        ts: now,
      })
      this.deps.onAlert?.({ level: 'critical', code: 'watchdog_cancel_failed', message, at: now })
      return { decision, halted: false, cancelAttempted: true, cancelSucceeded: false }
    }

    this.deps.heartbeat.halt(now)
    this.deps.audit?.({
      actor: 'system',
      kind: 'watchdog.halt',
      payload: { reason: decision.reason, beatAt: heartbeat?.beatAt ?? null },
      ts: now,
    })
    this.deps.onAlert?.({
      level: 'critical',
      code: 'watchdog_halted',
      message: '心跳 ' + decision.reason + '：已撤销全部挂单并熔断交易，恢复必须人工执行 /resume。',
      at: now,
    })
    return { decision, halted: true, cancelAttempted: true, cancelSucceeded: true }
  }
}
