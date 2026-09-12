/**
 * 时间来源必须可注入 —— 这是"30 天离线回放、跑两遍结果完全一致"的前提（plan.md §7）。
 *
 * 纪律：`src/market/`、`src/trigger/`、`src/exec/gate.ts`、`src/supervisor/` 里
 * **禁止**出现 `Date.now()` / `new Date()`，一律通过 `Clock`；由 CI 的 grep 测试强制。
 */

export type Disposer = () => void

export interface Clock {
  /** 当前时间（毫秒 Unix 时间戳）。 */
  now(): number
  /** 注册周期任务；返回取消函数。 */
  setInterval(fn: () => void, ms: number): Disposer
}

export class ClockError extends Error {}

/** 生产用时钟。 */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    setInterval: (fn, ms) => {
      assertPeriod(ms)
      const timer = setInterval(fn, ms)
      return () => clearInterval(timer)
    },
  }
}

/**
 * 回放时钟：时间只在显式 `advanceTo` 时前进，且周期任务按虚拟时间顺序触发。
 * 回放只替换 Clock 与 Broker，规则/计划卡匹配/硬闸/落库全部走生产同一份代码。
 */
export class ReplayClock implements Clock {
  #now: number
  #tasks: { next: number; ms: number; fn: () => void }[] = []

  constructor(start: number) {
    if (!Number.isFinite(start)) throw new ClockError(`ReplayClock 起点非法：${start}`)
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setInterval(fn: () => void, ms: number): Disposer {
    assertPeriod(ms)
    const task = { next: this.#now + ms, ms, fn }
    this.#tasks.push(task)
    return () => {
      this.#tasks = this.#tasks.filter((t) => t !== task)
    }
  }

  /** 推进到 `ts`（必须单调不减），沿途触发所有到期的周期任务。 */
  advanceTo(ts: number): void {
    if (!Number.isFinite(ts)) throw new ClockError(`advanceTo 目标非法：${ts}`)
    if (ts < this.#now) throw new ClockError(`时间不能倒流：${this.#now} → ${ts}`)

    for (;;) {
      let due: { next: number; ms: number; fn: () => void } | undefined
      for (const task of this.#tasks) {
        if (task.next <= ts && (due === undefined || task.next < due.next)) due = task
      }
      if (due === undefined) break
      this.#now = due.next
      due.next += due.ms
      due.fn()
    }

    this.#now = ts
  }

  /** 诊断用：仍在挂起的周期任务数。 */
  pendingTimers(): number {
    return this.#tasks.length
  }
}

function assertPeriod(ms: number): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new ClockError(`周期必须是有限正数，收到 ${String(ms)}`)
  }
}
