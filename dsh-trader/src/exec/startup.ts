/**
 * 启动重建的审计化状态机（docs/ui-design.md §4.3）。
 *
 * 启动状态不能只放在内存里：Docker 重启后 UI 仍要能解释“刚才为什么又启动了”。
 * 因此这里把每次状态迁移追加到已有的 audit_events，读取侧再按最近一次 boot 重建投影。
 */

import type { Clock } from '../clock.js'
import type { DecisionJournal } from './journal.js'
import type { StartupStepId } from '../ui/state.js'

export class StartupTracker {
  readonly #journal: DecisionJournal
  readonly #clock: Clock
  readonly #bootAt: number
  readonly #startedAt = new Map<StartupStepId, number>()
  #active: StartupStepId | null = null

  constructor(journal: DecisionJournal, clock: Clock) {
    this.#journal = journal
    this.#clock = clock
    this.#bootAt = clock.now()
    journal.appendAudit({
      actor: 'system',
      kind: 'startup_boot',
      payload: { bootAt: this.#bootAt },
      ts: this.#bootAt,
    })
    // boot 不是“进程还活着”的猜测；只有审计写入成功后才把它标成已完成。
    this.#appendStep('boot', 'succeeded', this.#bootAt, this.#bootAt)
  }

  get bootAt(): number {
    return this.#bootAt
  }

  start(step: StartupStepId): void {
    this.#active = step
    const at = this.#clock.now()
    this.#startedAt.set(step, at)
    this.#appendStep(step, 'running', at, undefined)
  }

  succeed(step: StartupStepId): void {
    const at = this.#clock.now()
    this.#appendStep(step, 'succeeded', this.#startedAt.get(step), at)
    this.#startedAt.delete(step)
    if (this.#active === step) this.#active = null
  }

  fail(step: StartupStepId, error: unknown): void {
    const at = this.#clock.now()
    const message = String(error)
    this.#appendStep(step, 'failed', this.#startedAt.get(step), at, message)
    this.#startedAt.delete(step)
    this.#journal.appendAudit({
      actor: 'system',
      kind: 'startup_failed',
      payload: { bootAt: this.#bootAt, step, error: message },
      ts: at,
    })
    if (this.#active === step) this.#active = null
  }

  failActive(error: unknown): void {
    this.fail(this.#active ?? 'boot', error)
  }

  #appendStep(
    step: StartupStepId,
    status: 'running' | 'succeeded' | 'failed',
    startedAt: number | undefined,
    finishedAt: number | undefined,
    error?: string,
  ): void {
    this.#journal.appendAudit({
      actor: 'system',
      kind: 'startup_step',
      payload: {
        bootAt: this.#bootAt,
        step,
        status,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(error === undefined ? {} : { error }),
      },
      ts: this.#clock.now(),
    })
  }
}
