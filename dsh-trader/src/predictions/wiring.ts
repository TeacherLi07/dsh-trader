/**
 * pm 信号 → W3 的接线（plan §4.4「pm 规则族」/ §6.5 治理 / T1.10）。
 *
 * 顺序与场内规则**完全一致**：去重 → 冷却 → 限流 → 分级。
 * 复用同一个 `TriggerGovernor`，因此 pm 的 novelty 与行情 novelty 共享同一份小时/日额度 ——
 * 否则"预测市场"会变成一条绕过限流的旁路（这正是 plan 要避免的）。
 *
 * 分级（plan §2 / §4.4 表）：
 *   · `novelty` → **W3 唤醒**（走限流，且必须先过流动性门槛）；
 *   · `info`    → **不唤醒**，只落库 + 通知（结算/成交额/点差）。
 * `commitment` 不经这里：它由计划卡的 `when` 自己承担（见 `rules.ts` 顶部说明）。
 */

import type { Clock } from '../clock.js'
import { TriggerGovernor, type GovernorDecision, type Severity } from '../trigger/engine.js'
import type { TriggerQueue } from '../trigger/queue.js'
import type { PmSignal } from './rules.js'
import type { PmStore } from './store.js'

export interface PmRoutedSignal {
  readonly ruleId: string
  readonly alias: string
  readonly severity: Severity
  /** `W3` = 会唤醒审议；`none` = 只落库通知。 */
  readonly wake: 'W3' | 'none'
  readonly disposition: GovernorDecision['disposition']
  readonly persisted: boolean
  /** watch 治理（冷却/额度）是否放行；false 时 disposition 为 `cooldown`。 */
  readonly watchAllowed: boolean
}

export interface PmSignalRouterOptions {
  readonly store: PmStore
  readonly queue: TriggerQueue
  readonly clock: Clock
  /** 信号有效期：超过就作废，避免处理陈旧信号。 */
  readonly ttlMs?: number
}

export class PmSignalRouter {
  readonly #governor: TriggerGovernor

  constructor(private readonly options: PmSignalRouterOptions) {
    this.#governor = new TriggerGovernor(options.queue, options.clock)
  }

  /**
   * 路由一批信号。
   * watch 治理不通过（冷却中 / 额度用尽）时**仍然落库**（`state='done'`，payload 标注原因），
   * 因为"超限一律落库 + 可审计"是硬要求；只有重复项不写（唯一键物理上写不进去）。
   */
  route(signals: readonly PmSignal[], now = this.options.clock.now()): readonly PmRoutedSignal[] {
    const routed: PmRoutedSignal[] = []
    for (const signal of signals) {
      const wake: 'W3' | 'none' = signal.purpose === 'novelty' ? 'W3' : 'none'
      // watch 治理只对**已登记关注**的信号生效。`pm_new_market` 的信号 alias 是市场 slug，
      // 没有对应的 watch —— 若也去 `recordWatchFire(slug)`，它会永远返回 false，
      // 结果是"白名单新市场"永远被静默压掉（实测）。这类信号由 governor 的 novelty 限流把关。
      const watch = this.options.store.watchByAlias(signal.alias)
      const watchAllowed = watch === undefined ? true : this.options.store.recordWatchFire(signal.alias, now)

      if (!watchAllowed) {
        // 治理拒绝：落库但不唤醒
        const lastFiredAt = watch?.lastFiredAt ?? now
        const until = lastFiredAt + (watch?.cooldownMs ?? 0)
        this.options.queue.enqueue({
          triggerId: `pm-suppressed:${signal.dedupKey}`,
          dedupKey: `pm-suppressed:${signal.dedupKey}`,
          symbol: `pm:${signal.alias}`,
          ruleId: signal.ruleId,
          purpose: signal.purpose === 'novelty' ? 'novelty' : 'info',
          payload: { ...signal.payload, suppressedBy: 'watch_governance', ruleId: signal.ruleId },
          // 合法去向里没有 'suppressed'：watch 治理的拒绝就是冷却/额度拒绝 ⇒ 'cooldown'
          disposition: 'cooldown',
          state: 'done',
          createdAt: now,
          ...(this.options.ttlMs === undefined ? {} : { expiresAt: now + this.options.ttlMs }),
        })
        routed.push({
          ruleId: signal.ruleId,
          alias: signal.alias,
          severity: signal.severity,
          wake: 'none',
          // 返回的 disposition 必须与落库的一致（旧实现写 'cooldown' 却报 rate_limited）
          disposition: { kind: 'cooldown', until },
          persisted: true,
          watchAllowed: false,
        })
        continue
      }

      const decision = this.#governor.submit(
        {
          ruleId: signal.ruleId,
          purpose: signal.purpose === 'novelty' ? 'novelty' : 'info',
          symbol: `pm:${signal.alias}`,
          timeframe: 'pm',
          barTs: now,
          severity: signal.severity,
          expression: signal.reason,
          dedupKey: signal.dedupKey,
        },
        {
          payload: {
            ...signal.payload,
            alias: signal.alias,
            tokenId: signal.tokenId,
            ...(watch?.planId === undefined ? {} : { planId: watch.planId }),
          },
          ...(this.options.ttlMs === undefined ? {} : { ttlMs: this.options.ttlMs }),
          cooldownMs: cooldownOf(signal),
        },
      )

      // 只有**真的排进 novelty 队列**才算唤醒；被冷却/限流压掉的不唤醒
      const effectiveWake: 'W3' | 'none' =
        wake === 'W3' && decision.disposition.kind === 'novelty' ? 'W3' : 'none'
      routed.push({
        ruleId: signal.ruleId,
        alias: signal.alias,
        severity: decision.severity,
        wake: effectiveWake,
        disposition: decision.disposition,
        persisted: decision.persisted,
        watchAllowed: true,
      })
    }
    return routed
  }
}

/** 每条规则的冷却取自信号 payload（规则族把配置写进去了），保证单点定义。 */
function cooldownOf(signal: PmSignal): number {
  const value = signal.payload.cooldownMs
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
