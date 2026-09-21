/** R5 跨 state DB 的实验注册、日预算与 request reservation 控制账本。 */

import type Database from 'better-sqlite3'
import { DecisionJournal } from '../exec/journal.js'
import { Statements } from '../db/statements.js'
import { dayKey } from '../cost-ledger.js'
import { fingerprint } from '../util/canonical.js'
import type { Clock } from '../clock.js'
import { validateR5BudgetAuthorization, type R5BudgetAuthorization } from './r5.js'

interface ControlAuditRow {
  readonly kind: string
  readonly payload_json: string
}

interface R5ControlEvents {
  readonly policy: Record<string, unknown> | undefined
  readonly starts: readonly Record<string, unknown>[]
  readonly reservations: readonly Record<string, unknown>[]
  readonly settlements: readonly Record<string, unknown>[]
  readonly budgetOverruns: readonly Record<string, unknown>[]
}

function record(payloadJson: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(payloadJson) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch { return undefined }
}

export interface R5ControlExperiment {
  readonly experimentId: string
  readonly manifestHash: string
  readonly split: 'development' | 'validation'
  readonly datasetId: string
  readonly datasetHash: string
  readonly pitDataHash: string
  readonly pitWindowHashes: readonly string[]
  readonly routeHash: string
  /** hash of canonical realpath; raw local paths do not leave the process */
  readonly stateDbId: string
  readonly credentialRef: 'TRADER_R5_API_KEY'
  readonly keyIsolationAcknowledged: boolean
  readonly budgets: R5BudgetAuthorization
  readonly priceTableVersion: string
}

export interface R5ControlSnapshot {
  readonly reservedUsd: number
  readonly reservedTokens: number
  readonly callsReserved: number
  readonly callsSettled: number
  readonly abandonedCalls: number
  readonly costUnknownCalls: number
  readonly unresolvedRequestHashes: readonly string[]
  readonly blocker: string | null
}

export interface R5CallReservation {
  readonly experimentId: string
  readonly stateDbId: string
  readonly requestHash: string
  readonly runId: string
  readonly sampleId: string
  readonly model: string
  readonly symbol: string
  readonly strategy: 'single' | 'critique'
  readonly stage: string
  readonly at: number
  readonly estimatedTokens: number
  readonly reservedUsd: number
  readonly owner: R5ProcessIdentity
}

export interface R5ProcessIdentity {
  readonly pid: number
  readonly bootId: string
  readonly startTicks: string
}

export interface R5CallSettlement {
  readonly experimentId: string
  readonly requestHash: string
  readonly at: number
  readonly actualTokens: number
  readonly actualUsd: number | null
  readonly costKnown: boolean
  readonly failed: boolean
}

/**
 * 全局控制账本固定在同一 DSH_HOME 私有目录，与每实验 state DB 分离。
 * 这样更换输出 DB 不会重置实验身份、日预算或请求 reservation。
 */
export class R5ControlRegistry {
  readonly #journal: DecisionJournal
  readonly #statements: Statements

  constructor(private readonly db: Database.Database, private readonly clock: Clock) {
    this.#journal = new DecisionJournal(db)
    this.#statements = new Statements(db)
  }

  registerExperiment(input: R5ControlExperiment, options: { readonly requireExisting?: boolean } = {}): void {
    const budgets = validateR5BudgetAuthorization(input.budgets)
    const validHash = (value: string): boolean => /^sha256:[a-f0-9]{64}$/.test(value)
    if (input.experimentId.trim() === '' || !validHash(input.manifestHash) || !validHash(input.datasetHash) ||
        !validHash(input.pitDataHash) || !validHash(input.routeHash) ||
        !validHash(input.stateDbId) || !validHash(input.priceTableVersion) ||
        !Array.isArray(input.pitWindowHashes) || input.pitWindowHashes.length === 0 ||
        input.pitWindowHashes.some((hash) => !validHash(hash)) ||
        new Set(input.pitWindowHashes).size !== input.pitWindowHashes.length) {
      throw new Error('R5 control registration identity/version 不完整')
    }
    if (input.credentialRef !== 'TRADER_R5_API_KEY' || input.keyIsolationAcknowledged !== true) {
      throw new Error('R5 control registry 要求专用 key 引用与显式隔离确认')
    }
    const now = this.clock.now()
    const budgetHash = fingerprint(budgets)
    const tx = this.db.transaction(() => {
      const events = this.#readEvents()
      const latestPolicy = events.policy
      const policyHash = fingerprint({
        dailyBudgetUsd: budgets.dailyBudgetUsd,
        dailyTokenCap: budgets.dailyTokenCap,
      })
      if (latestPolicy === undefined) {
        this.#journal.appendAudit({
          actor: 'human', kind: 'r5_global_budget_policy_set',
          payload: {
            dailyBudgetUsd: budgets.dailyBudgetUsd,
            dailyTokenCap: budgets.dailyTokenCap,
            policyHash,
          },
          ts: now,
        })
      } else if (latestPolicy['policyHash'] !== policyHash) {
        throw new Error('R5 control DB 的每日美元/token caps 已冻结；不同 caps 必须使用显式的新 control registry')
      }

      const existing = events.starts.find((item) => item['experimentId'] === input.experimentId)
      if (existing !== undefined) {
        if (existing['manifestHash'] !== input.manifestHash || existing['pitDataHash'] !== input.pitDataHash ||
            !sameStringSet(existing['pitWindowHashes'], input.pitWindowHashes) ||
            existing['routeHash'] !== input.routeHash ||
            existing['stateDbId'] !== input.stateDbId || existing['datasetHash'] !== input.datasetHash ||
            existing['split'] !== input.split || existing['credentialRef'] !== input.credentialRef ||
            existing['keyIsolationAcknowledged'] !== true) {
          throw new Error('R5 experimentId 已绑定另一 state DB、manifest 或 route')
        }
        if (existing['budgetHash'] !== budgetHash || existing['priceTableVersion'] !== input.priceTableVersion ||
            existing['totalBudgetUsd'] !== budgets.totalBudgetUsd) {
          throw new Error('R5 experiment 的预算上限或价目表版本已冻结且不可变；请建立新 experimentId')
        }
        return
      }
      if (options.requireExisting === true) {
        throw new Error('resume control registry 中缺少该 experimentId；拒绝重新初始化/重置预算')
      }
      if (events.starts.some((item) => item['manifestHash'] === input.manifestHash)) {
        throw new Error('同一 manifest 不得用新 experimentId 重复调用；续跑必须复用原 ID/state DB')
      }
      const overlappingValidation = events.starts.find((item) => {
        if (item['split'] !== 'validation' && input.split !== 'validation') return false
        const previousWindows = item['pitWindowHashes']
        if (!Array.isArray(previousWindows) || previousWindows.some((hash) => typeof hash !== 'string')) {
          // 旧账本没有逐窗口指纹时，无法证明 validation 数据独立，不能静默放行。
          return true
        }
        const previous = new Set(previousWindows as string[])
        return input.pitWindowHashes.some((hash) => previous.has(hash))
      })
      if (overlappingValidation !== undefined) {
        throw new Error('validation PIT window 与既有实验重叠或旧账本缺少逐窗口证据，禁止事后重用验证段')
      }
      const blocker = this.#blockingReason(events)
      if (blocker !== null) throw new Error(`R5 control registry fail-closed：${blocker}`)
      this.#journal.appendAudit({
        actor: 'human', kind: 'r5_experiment_started',
        payload: {
          experimentId: input.experimentId,
          manifestHash: input.manifestHash,
          split: input.split,
          datasetId: input.datasetId,
          datasetHash: input.datasetHash,
          pitDataHash: input.pitDataHash,
          pitWindowHashes: input.pitWindowHashes,
          routeHash: input.routeHash,
          stateDbId: input.stateDbId,
          credentialRef: input.credentialRef,
          keyIsolationAcknowledged: input.keyIsolationAcknowledged,
          budgetHash,
          dailyBudgetUsd: input.budgets.dailyBudgetUsd,
          dailyTokenCap: input.budgets.dailyTokenCap,
          totalBudgetUsd: budgets.totalBudgetUsd,
          priceTableVersion: input.priceTableVersion,
        },
        ts: now,
      })
    })
    tx.immediate()
  }

  /** reservation、重复请求与日/实验限额在同一 IMMEDIATE transaction 中跨进程原子判定。 */
  reserveCall(input: R5CallReservation): { readonly allow: true } | { readonly allow: false; readonly reason: string } {
    if (input.experimentId.trim() === '' || input.stateDbId.trim() === '' || input.requestHash.trim() === '' ||
        input.model.trim() === '' || input.symbol.trim() === '' ||
        !Number.isSafeInteger(input.at) || input.at < 0 || !Number.isSafeInteger(input.estimatedTokens) ||
        input.estimatedTokens <= 0 || !Number.isFinite(input.reservedUsd) || input.reservedUsd <= 0 ||
        !Number.isSafeInteger(input.owner?.pid) || input.owner.pid <= 0 || input.owner.bootId.trim() === '' ||
        input.owner.startTicks.trim() === '') {
      return { allow: false, reason: 'reservation 包含非法身份、token 上界或成本上界' }
    }
    const tx = this.db.transaction(() => {
      const events = this.#readEvents()
      const experiment = events.starts.find((item) => item['experimentId'] === input.experimentId)
      if (experiment === undefined || experiment['stateDbId'] !== input.stateDbId) {
        return { allow: false as const, reason: 'experiment 未注册或 state DB 身份不匹配' }
      }
      const blocker = this.#blockingReason(events)
      if (blocker !== null) return { allow: false as const, reason: blocker }
      if (events.reservations.some((item) => item['requestHash'] === input.requestHash)) {
        return { allow: false as const, reason: 'requestHash 已在共享 control registry 预留/结算，拒绝重复付费调用' }
      }

      const day = dayKey(input.at)
      let dailyUsd = 0
      let dailyTokens = 0
      let experimentUsd = 0
      for (const reservation of events.reservations) {
        const usd = Number(reservation['reservedUsd'] ?? 0)
        const tokens = Number(reservation['estimatedTokens'] ?? 0)
        if (!Number.isFinite(usd) || usd < 0 || !Number.isFinite(tokens) || tokens < 0) {
          return { allow: false as const, reason: 'control registry reservation 数据损坏' }
        }
        if (reservation['day'] === day) {
          dailyUsd += usd
          dailyTokens += tokens
        }
        if (reservation['experimentId'] === input.experimentId) experimentUsd += usd
      }
      if (dailyUsd + input.reservedUsd > Number(experiment['dailyBudgetUsd'])) {
        return { allow: false as const, reason: `共享 R5 日预算将超限：${dailyUsd + input.reservedUsd} > ${String(experiment['dailyBudgetUsd'])}` }
      }
      if (dailyTokens + input.estimatedTokens > Number(experiment['dailyTokenCap'])) {
        return { allow: false as const, reason: `共享 R5 日 token cap 将超限：${dailyTokens + input.estimatedTokens} > ${String(experiment['dailyTokenCap'])}` }
      }
      if (experimentUsd + input.reservedUsd > Number(experiment['totalBudgetUsd'])) {
        return { allow: false as const, reason: `R5 experiment 总预算将超限：${experimentUsd + input.reservedUsd} > ${String(experiment['totalBudgetUsd'])}` }
      }
      this.#journal.appendAudit({
        actor: 'system', kind: 'r5_model_call_reserved',
        payload: { ...input, day },
        ts: input.at,
      })
      return { allow: true as const }
    })
    return tx.immediate()
  }

  settleCall(input: R5CallSettlement): { readonly overrun: boolean } {
    if (!Number.isSafeInteger(input.at) || input.at < 0 || !Number.isSafeInteger(input.actualTokens) || input.actualTokens < 0 ||
        (input.actualUsd !== null && (!Number.isFinite(input.actualUsd) || input.actualUsd < 0))) {
      throw new Error('R5 settlement 含非法 usage/cost/time')
    }
    const tx = this.db.transaction(() => {
      const events = this.#readEvents()
      const reservation = events.reservations.find((item) => item['requestHash'] === input.requestHash)
      if (reservation === undefined || reservation['experimentId'] !== input.experimentId) {
        throw new Error(`R5 settle 缺少对应 reservation：${input.requestHash}`)
      }
      if (events.settlements.some((item) => item['requestHash'] === input.requestHash)) {
        throw new Error(`R5 requestHash 已结算：${input.requestHash}`)
      }
      const reservedUsd = Number(reservation['reservedUsd'])
      const reservedTokens = Number(reservation['estimatedTokens'])
      const overrun = (input.actualUsd !== null && input.actualUsd > reservedUsd + 1e-12) || input.actualTokens > reservedTokens
      this.#journal.appendAudit({
        actor: 'system', kind: 'r5_model_call_settled',
        payload: { ...input, reservedUsd, reservedTokens, overrun },
        ts: input.at,
      })
      if (overrun) {
        this.#journal.appendAudit({
          actor: 'system', kind: 'r5_model_budget_overrun',
          payload: { experimentId: input.experimentId, requestHash: input.requestHash, reservedUsd, actualUsd: input.actualUsd, reservedTokens, actualTokens: input.actualTokens },
          ts: input.at,
        })
      }
      return { overrun }
    })
    return tx.immediate()
  }

  /** SIGKILL 后凭 boot id/PID startTicks 回收 dead owner；身份无法确认时保持 fail-closed。 */
  recoverAbandonedCalls(isOwnerAlive: (owner: R5ProcessIdentity) => boolean | undefined): number {
    const now = this.clock.now()
    const tx = this.db.transaction(() => {
      const events = this.#readEvents()
      const settledHashes = new Set(events.settlements.map((item) => item['requestHash']))
      let recovered = 0
      for (const reservation of events.reservations) {
        const requestHash = reservation['requestHash']
        if (typeof requestHash !== 'string' || settledHashes.has(requestHash)) continue
        const owner = reservation['owner']
        if (typeof owner !== 'object' || owner === null || Array.isArray(owner)) continue
        const value = owner as Record<string, unknown>
        if (!Number.isSafeInteger(value['pid']) || typeof value['bootId'] !== 'string' || typeof value['startTicks'] !== 'string') continue
        const identity: R5ProcessIdentity = { pid: Number(value['pid']), bootId: value['bootId'], startTicks: value['startTicks'] }
        if (isOwnerAlive(identity) !== false) continue
        const estimatedTokens = Number(reservation['estimatedTokens'])
        const reservedUsd = Number(reservation['reservedUsd'])
        if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0 || !Number.isFinite(reservedUsd) || reservedUsd < 0) continue
        this.#journal.appendAudit({
          actor: 'system', kind: 'r5_model_call_settled',
          payload: {
            experimentId: reservation['experimentId'], requestHash, at: now,
            stateDbId: reservation['stateDbId'], runId: reservation['runId'],
            sampleId: reservation['sampleId'], model: reservation['model'], symbol: reservation['symbol'],
            actualTokens: estimatedTokens, actualUsd: null, reservedUsd, reservedTokens: estimatedTokens,
            costKnown: false, failed: true, abandoned: true,
            reason: 'provider outcome unresolved after owner process exited; reservation ceiling charged and request will not be resent',
          },
          ts: now,
        })
        settledHashes.add(requestHash)
        recovered += 1
      }
      return recovered
    })
    return tx.immediate()
  }

  snapshot(experimentId: string): R5ControlSnapshot {
    const events = this.#readEvents()
    const experimentReservations = events.reservations.filter((item) => item['experimentId'] === experimentId)
    const settled = events.settlements.filter((item) => item['experimentId'] === experimentId)
    const settledHashes = new Set(settled.map((item) => item['requestHash']))
    const unresolved = experimentReservations.filter((item) => !settledHashes.has(item['requestHash']))
      .map((item) => String(item['requestHash']))
    return {
      reservedUsd: experimentReservations.reduce((sum, item) => sum + Number(item['reservedUsd'] ?? 0), 0),
      reservedTokens: experimentReservations.reduce((sum, item) => sum + Number(item['estimatedTokens'] ?? 0), 0),
      callsReserved: experimentReservations.length,
      callsSettled: settled.filter((item) => item['abandoned'] !== true).length,
      abandonedCalls: settled.filter((item) => item['abandoned'] === true).length,
      costUnknownCalls: settled.filter((item) => item['costKnown'] !== true).length,
      unresolvedRequestHashes: unresolved,
      blocker: this.#blockingReason(events),
    }
  }

  #readEvents(): R5ControlEvents {
    const rows = this.#statements.get("SELECT kind, payload_json FROM audit_events WHERE kind GLOB 'r5_*' ORDER BY seq").all() as ControlAuditRow[]
    const payloads = rows.map((row) => ({ kind: row.kind, payload: record(row.payload_json) })).filter((row) => row.payload !== undefined) as {
      kind: string; payload: Record<string, unknown>
    }[]
    const policies = payloads.filter((item) => item.kind === 'r5_global_budget_policy_set')
    return {
      policy: policies.at(-1)?.payload,
      starts: payloads.filter((item) => item.kind === 'r5_experiment_started').map((item) => item.payload),
      reservations: payloads.filter((item) => item.kind === 'r5_model_call_reserved').map((item) => item.payload),
      settlements: payloads.filter((item) => item.kind === 'r5_model_call_settled').map((item) => item.payload),
      budgetOverruns: payloads.filter((item) => item.kind === 'r5_model_budget_overrun').map((item) => item.payload),
    }
  }

  #blockingReason(events: R5ControlEvents): string | null {
    const settledHashes = new Set(events.settlements.map((item) => item['requestHash']))
    const pending = events.reservations.filter((item) => !settledHashes.has(item['requestHash']))
    if (pending.length > 0) return `存在 ${pending.length} 个未结算 reservation；核验 provider 账单前停止所有 R5 调用`
    if (events.budgetOverruns.length > 0) return '共享 R5 control registry 记录到预算预留超限；停止后续 provider 调用'
    // 已结算但 usage 未知的调用按最坏 reservation 消耗日/总预算与 token cap；静态运行可继续，
    // 其 outcome 仍是 REVIEW/失败，cost_known=false，不能作为经济闸通过证据。
    return null
  }
}

function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || value.length !== expected.length) {
    return false
  }
  const actual = new Set(value as string[])
  return actual.size === expected.length && expected.every((item) => actual.has(item))
}
