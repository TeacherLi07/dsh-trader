/**
 * 预测市场运行时注册点（与 `db/runtime.ts`、`trigger/runtime.ts` 同构）。
 *
 * 插件之间不直接互相依赖：`trade-predictions` 注册，工具层按需取。
 * 没注册时工具返回 `available:false`（而不是抛错），这样"没开预测市场"与"预测市场坏了"
 * 在行为上可以区分。
 */

import type { PmStore } from './store.js'
import type { PmPoller } from './poller.js'
import type { PmSignalRouter } from './wiring.js'

export interface PmRuntime {
  readonly store: PmStore
  readonly poller?: PmPoller
  readonly router?: PmSignalRouter
}

let current: PmRuntime | undefined

export function setPmRuntime(runtime: PmRuntime | undefined): void {
  current = runtime
}

export function getPmRuntime(): PmRuntime | undefined {
  return current
}

export function hasPmRuntime(): boolean {
  return current !== undefined
}
