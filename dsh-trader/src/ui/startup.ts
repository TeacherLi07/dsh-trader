/**
 * 从 append-only audit_events 重建 Trade Console 的启动投影。
 *
 * 不新增一张“监控状态表”：启动记录本身就是审计事实，复用它能避免状态表与审计链
 * 分叉；Statements 缓存查询也符合数据库热路径纪律。
 */

import type Database from 'better-sqlite3'
import { Statements } from '../db/statements.js'
import {
  projectStartupState,
  type StartupProjection,
  type StartupStep,
  type StartupStepId,
  type StartupStepStatus,
} from './state.js'

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
const STARTUP_STEPS: readonly StartupStepId[] = [
  'boot',
  'database',
  'exchange',
  'recovery',
  'reconcile',
  'ready',
]

interface AuditRow {
  readonly seq: number
  readonly ts: number
  readonly kind: string
  readonly payload_json: string
}

interface CountRow {
  readonly count: number
}

interface ParsedPayload {
  readonly step?: unknown
  readonly status?: unknown
  readonly startedAt?: unknown
  readonly finishedAt?: unknown
  readonly error?: unknown
}

function statementsFor(input: Statements | Database.Database): Statements {
  return input instanceof Statements ? input : new Statements(input)
}

function parsePayload(raw: string): ParsedPayload {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed as ParsedPayload : {}
  } catch {
    // 审计正文损坏时不能让状态路由一起崩掉；未知字段保留为 unknown，而不是猜成成功。
    return {}
  }
}

function isStepId(value: unknown): value is StartupStepId {
  return typeof value === 'string' && STARTUP_STEPS.includes(value as StartupStepId)
}

function isStepStatus(value: unknown): value is StartupStepStatus {
  return value === 'pending' || value === 'running' || value === 'succeeded' || value === 'failed'
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function countBoots(statements: Statements, from: number, asOf: number): number {
  const row = statements
    .get("SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'startup_boot' AND ts > ? AND ts <= ?")
    .get(from, asOf) as CountRow
  return row.count
}

function latestFailure(statements: Statements): string | undefined {
  const row = statements
    .get("SELECT payload_json FROM audit_events WHERE kind = 'startup_failed' ORDER BY seq DESC LIMIT 1")
    .get() as { payload_json: string } | undefined
  if (row === undefined) return undefined
  const error = parsePayload(row.payload_json).error
  return typeof error === 'string' ? error : undefined
}

/** 没有启动事实时返回 null；调用方必须把它显示为未知/未初始化，而不是 ready。 */
export function readStartupState(
  input: Statements | Database.Database,
  asOf: number,
): StartupProjection | null {
  if (!Number.isFinite(asOf)) return null
  const statements = statementsFor(input)
  const boot = statements
    .get("SELECT seq, ts FROM audit_events WHERE kind = 'startup_boot' ORDER BY seq DESC LIMIT 1")
    .get() as { seq: number; ts: number } | undefined
  if (boot === undefined) return null

  const steps = new Map<StartupStepId, StartupStep>()
  for (const id of STARTUP_STEPS) steps.set(id, { id, status: 'pending' })

  const rows = statements
    .get('SELECT seq, ts, kind, payload_json FROM audit_events WHERE seq >= ? ORDER BY seq ASC')
    .all(boot.seq) as AuditRow[]
  for (const row of rows) {
    if (row.kind !== 'startup_step') continue
    const payload = parsePayload(row.payload_json)
    if (!isStepId(payload.step) || !isStepStatus(payload.status)) continue
    const startedAt = finiteNumber(payload.startedAt)
    const finishedAt = finiteNumber(payload.finishedAt)
    const error = typeof payload.error === 'string' ? payload.error : undefined
    steps.set(payload.step, {
      id: payload.step,
      status: payload.status,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(error === undefined ? {} : { error }),
    })
  }

  const failure = latestFailure(statements)
  return projectStartupState({
    bootAt: boot.ts,
    asOf,
    steps: STARTUP_STEPS.map((id) => steps.get(id) as StartupStep),
    restartCount1h: countBoots(statements, asOf - HOUR_MS, asOf),
    restartCount24h: countBoots(statements, asOf - DAY_MS, asOf),
    ...(failure === undefined ? {} : { lastFailure: failure }),
  })
}
