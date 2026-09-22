/**
 * trade-ui —— Trade Console 的只读服务端入口（docs/ui-design.md §4.1 / S1）。
 *
 * 这里只挂经过 DSH connection 认证的 GET Fetch route；不注册下单、撤单、模式切换或
 * 任意写接口。交易真值仍从当前 TradePorts 的 broker 重取，UI 只得到 state projection。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type Database from 'better-sqlite3'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { getDatabase, hasDatabase } from '../db/runtime.js'
import { Statements } from '../db/statements.js'
import { HeartbeatStore } from '../supervisor/heartbeat.js'
import { getExecPorts } from './exec.js'
import { projectState, type StateProjection } from '../ui/state.js'
import { readStartupState } from '../ui/startup.js'
import type { StartupProjection } from '../ui/state.js'
import { readCycleDetail, readCycleList, type CycleDetail, type CycleSummary } from '../ui/cycles.js'
import type { TradePorts } from '../exec/ports.js'

export const name = 'trade-ui'
export const inject = ['connection']
export const Config = z.object({
  /** 只影响看板标签，不参与任何交易硬闸。 */
  staleAfterMs: z.number().default(120_000),
})

export interface UiConfig {
  readonly staleAfterMs?: number
}

export interface TradeStateResponse {
  readonly ok: true
  readonly asOf: number
  readonly state: StateProjection
  readonly startup: StartupProjection | null
}

export interface TradeStateUnavailableResponse {
  readonly ok: false
  readonly rebuilding: true
  readonly error: string
  readonly startup: StartupProjection | null
}

export type TradeStateHttpBody = TradeStateResponse | TradeStateUnavailableResponse

export interface TradeCyclesResponse {
  readonly ok: true
  readonly asOf: number
  readonly cycles: readonly CycleSummary[]
  readonly cycle?: CycleDetail
}

export interface TradeCyclesUnavailableResponse {
  readonly ok: false
  readonly rebuilding: boolean
  readonly error: string
}

export type TradeCyclesHttpBody = TradeCyclesResponse | TradeCyclesUnavailableResponse

function jsonResponse(body: TradeStateHttpBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function cyclesJsonResponse(body: TradeCyclesHttpBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 供 route 与单测共用；没有 ports 时明确返回“重建中”，绝不返回空账户。 */
export async function readTradeState(
  ports: TradePorts | undefined,
  staleAfterMs: number,
  startupOverride?: StartupProjection | null,
): Promise<TradeStateHttpBody> {
  const unavailableStartup = startupOverride === undefined
    ? ports === undefined
      ? null
      : readStartupState(ports.db, ports.clock.now())
    : startupOverride
  if (ports === undefined) {
    return { ok: false, rebuilding: true, error: '交易组合根尚未就绪，状态仍在重建中', startup: unavailableStartup }
  }

  try {
    const [accountRead, positionsRead, openOrdersRead] = await Promise.all([
      ports.broker.getAccount().then((value) => ({ value, observedAt: ports.clock.now() })),
      ports.broker.getPositions().then((value) => ({ value, observedAt: ports.clock.now() })),
      ports.broker.getOpenOrders().then((value) => ({ value, observedAt: ports.clock.now() })),
    ])
    const { value: account } = accountRead
    const { value: positions } = positionsRead
    const { value: openOrders } = openOrdersRead
    // 总 asOf 在整组请求结束后冻结；各项 freshness 保留各自成功完成时点，
    // 空数组也是一次成功查询，不能借用 account 的更新时间。
    const asOf = ports.clock.now()
    const heartbeat = new HeartbeatStore(new Statements(ports.db)).read()
    return {
      ok: true,
      asOf,
      state: projectState({
        mode: ports.mode,
        venue: account.venue,
        halted: heartbeat?.halted ?? false,
        rebuilding: false,
        asOf,
        account,
        accountObservedAt: accountRead.observedAt,
        positions,
        positionsObservedAt: positionsRead.observedAt,
        openOrders,
        openOrdersObservedAt: openOrdersRead.observedAt,
        staleAfterMs,
      }),
      startup: startupOverride === undefined ? readStartupState(ports.db, asOf) : startupOverride,
    }
  } catch (error) {
    return { ok: false, rebuilding: true, error: String(error), startup: unavailableStartup }
  }
}

/** 周期端点只读已有账本；缺少 cycleId 时返回台账，带 cycleId 时返回可下钻详情。 */
export function readTradeCycles(
  input: Database.Database,
  asOf: number,
  cycleId: string | null,
  limit: number,
): TradeCyclesHttpBody {
  try {
    if (cycleId !== null) {
      const cycle = readCycleDetail(input, cycleId)
      return cycle === undefined
        ? { ok: false, rebuilding: false, error: `找不到周期：${cycleId}` }
        : { ok: true, asOf, cycles: [], cycle }
    }
    return { ok: true, asOf, cycles: readCycleList(input, limit) }
  } catch (error) {
    return { ok: false, rebuilding: true, error: String(error) }
  }
}

export function apply(ctx: Context, config: UiConfig): void {
  ctx.effect(() => {
    const disposeState = ctx.connection.fetch.register({
      path: '/api/trade/state',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        const ports = getExecPorts()
        const startup = ports === undefined && hasDatabase()
          ? readStartupState(getDatabase(), systemClock().now())
          : undefined
        const body = await readTradeState(ports, config.staleAfterMs ?? 120_000, startup)
        return jsonResponse(body, body.ok ? 200 : 503)
      },
    })
    const disposeCycles = ctx.connection.fetch.register({
      path: '/api/trade/cycles',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        if (!hasDatabase()) return cyclesJsonResponse({ ok: false, rebuilding: true, error: '交易数据库尚未初始化' }, 503)
        const ports = getExecPorts()
        const asOf = ports?.clock.now() ?? systemClock().now()
        const url = new URL(request.url)
        const cycleId = url.searchParams.get('cycleId')
        const rawLimit = Number(url.searchParams.get('limit') ?? '20')
        const body = readTradeCycles(getDatabase(), asOf, cycleId, rawLimit)
        return new Response(JSON.stringify(body), {
          status: body.ok ? 200 : body.rebuilding ? 503 : 404,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      },
    })
    return () => {
      void disposeState()
      void disposeCycles()
    }
  }, 'trade.ui.close')
}
