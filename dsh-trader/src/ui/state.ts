/**
 * Trade Console 的服务端状态投影基础（docs/ui-design.md §3.3–§4.3）。
 *
 * 这里故意只做纯函数：交易 runtime 仍是权威状态来源，UI 只消费带来源、时点和可信度
 * 的读数。所有“现在”都由调用方传入 `asOf`，避免浏览器/服务端各自读取墙钟后出现两套
 * 新鲜度口径。
 */

import type { AccountSnapshot, OrderAck, PositionSnapshot, Venue } from '../exec/broker.js'
import type { RunMode } from '../config.js'

export type UiCredibility = 'exchange-live' | 'exchange-stale' | 'local-audit' | 'derived' | 'unknown'

export interface UiReading<T> {
  readonly value: T | null
  readonly source: 'exchange' | 'local-audit' | 'derived'
  readonly asOf: number | null
  readonly credibility: UiCredibility
  readonly error?: string
}

export interface ExchangeReadingInput<T> {
  readonly value: T | null | undefined
  readonly observedAt: number | null | undefined
  readonly asOf: number
  readonly staleAfterMs: number
  readonly rebuilding: boolean
  readonly error?: string
}

/**
 * 给交易所读数统一打可信度标签。
 *
 * “重建中/读失败”必须返回 null，而不是把旧值或 0 伪装成当前真相；数据存在但过期
 * 才保留 value 并降级为 exchange-stale，方便 UI 显式展示 asOf。
 */
export function classifyExchangeReading<T>(input: ExchangeReadingInput<T>): UiReading<T> {
  const observedAt = input.observedAt
  const base = {
    source: 'exchange' as const,
    asOf: typeof observedAt === 'number' && Number.isFinite(observedAt) ? observedAt : null,
  }

  if (input.rebuilding) {
    return { ...base, value: null, credibility: 'unknown', ...(input.error === undefined ? {} : { error: input.error }) }
  }
  if (input.value === null || input.value === undefined) {
    return { ...base, value: null, credibility: 'unknown', ...(input.error === undefined ? {} : { error: input.error }) }
  }
  if (
    typeof observedAt !== 'number' ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(input.asOf) ||
    !Number.isFinite(input.staleAfterMs) ||
    input.staleAfterMs < 0 ||
    observedAt > input.asOf
  ) {
    return {
      ...base,
      value: null,
      credibility: 'unknown',
      error: input.error ?? '交易所读数的时间戳不可验证',
    }
  }

  const ageMs = input.asOf - observedAt
  return {
    ...base,
    value: input.value,
    credibility: ageMs <= input.staleAfterMs ? 'exchange-live' : 'exchange-stale',
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

export function localAuditReading<T>(value: T | null | undefined, asOf: number): UiReading<T> {
  return {
    value: value ?? null,
    source: 'local-audit',
    asOf,
    credibility: 'local-audit',
  }
}

export function derivedReading<T>(value: T | null | undefined, asOf: number): UiReading<T> {
  return {
    value: value ?? null,
    source: 'derived',
    asOf,
    credibility: 'derived',
  }
}

export type StartupStepId =
  | 'boot'
  | 'database'
  | 'exchange'
  | 'recovery'
  | 'reconcile'
  | 'ready'

export type StartupStepStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface StartupStep {
  readonly id: StartupStepId
  readonly status: StartupStepStatus
  readonly startedAt?: number
  readonly finishedAt?: number
  readonly error?: string
}

export interface StartupProjectionInput {
  readonly bootAt: number
  readonly steps: readonly StartupStep[]
  readonly restartCount1h: number
  readonly restartCount24h: number
  readonly lastFailure?: string
}

export interface StartupProjection {
  readonly bootAt: number
  readonly phase: 'rebuilding' | 'ready' | 'failed'
  readonly currentStep: StartupStepId | null
  readonly steps: readonly StartupStep[]
  readonly restartCount1h: number
  readonly restartCount24h: number
  readonly lastFailure: string | null
}

/** 把启动状态压成 UI 只需消费的一份投影；不替 runtime 宣布 ready。 */
export function projectStartupState(input: StartupProjectionInput): StartupProjection {
  const failed = input.steps.find((step) => step.status === 'failed')
  const current = input.steps.find((step) => step.status === 'running')
  const ready = input.steps.some((step) => step.id === 'ready' && step.status === 'succeeded')
  return {
    bootAt: input.bootAt,
    phase: failed === undefined ? (ready ? 'ready' : 'rebuilding') : 'failed',
    currentStep: current?.id ?? (failed?.id ?? null),
    steps: input.steps,
    restartCount1h: input.restartCount1h,
    restartCount24h: input.restartCount24h,
    lastFailure: input.lastFailure ?? failed?.error ?? null,
  }
}

export interface StateProjectionInput {
  readonly mode: RunMode
  readonly venue: Venue
  readonly halted: boolean
  readonly rebuilding: boolean
  readonly asOf: number
  readonly account: AccountSnapshot | null
  readonly positions: readonly PositionSnapshot[] | null
  readonly openOrders: readonly OrderAck[] | null
  readonly staleAfterMs: number
  readonly error?: string
}

export interface StateProjection {
  readonly mode: RunMode
  readonly venue: Venue
  readonly halted: boolean
  readonly account: UiReading<AccountSnapshot>
  readonly positions: UiReading<readonly PositionSnapshot[]>
  readonly openOrders: UiReading<readonly OrderAck[]>
}

/** 当前状态面最小投影；后续周期投影可在此边界旁独立增加，不侵入执行链。 */
export function projectState(input: StateProjectionInput): StateProjection {
  const accountObservedAt = input.account?.observedAt ?? null
  return {
    mode: input.mode,
    venue: input.venue,
    halted: input.halted,
    account: classifyExchangeReading({
      value: input.account,
      observedAt: accountObservedAt,
      asOf: input.asOf,
      staleAfterMs: input.staleAfterMs,
      rebuilding: input.rebuilding,
      ...(input.error === undefined ? {} : { error: input.error }),
    }),
    positions: classifyExchangeReading({
      value: input.positions,
      observedAt: accountObservedAt,
      asOf: input.asOf,
      staleAfterMs: input.staleAfterMs,
      rebuilding: input.rebuilding,
      ...(input.error === undefined ? {} : { error: input.error }),
    }),
    openOrders: classifyExchangeReading({
      value: input.openOrders,
      observedAt: accountObservedAt,
      asOf: input.asOf,
      staleAfterMs: input.staleAfterMs,
      rebuilding: input.rebuilding,
      ...(input.error === undefined ? {} : { error: input.error }),
    }),
  }
}
