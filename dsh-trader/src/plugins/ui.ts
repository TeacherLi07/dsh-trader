/**
 * trade-ui —— Trade Console 的只读服务端入口（docs/ui-design.md §4.1 / S1）。
 *
 * 这里只挂经过 DSH connection 认证的 GET Fetch route；不注册下单、撤单、模式切换或
 * 任意写接口。交易真值仍从当前 TradePorts 的 broker 重取，UI 只得到 state projection。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import z from '@deepseek-ai/schemastery'
import { Statements } from '../db/statements.js'
import { HeartbeatStore } from '../supervisor/heartbeat.js'
import { getExecPorts } from './exec.js'
import { projectState, type StateProjection } from '../ui/state.js'
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
}

export interface TradeStateUnavailableResponse {
  readonly ok: false
  readonly rebuilding: true
  readonly error: string
}

export type TradeStateHttpBody = TradeStateResponse | TradeStateUnavailableResponse

function jsonResponse(body: TradeStateHttpBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** 供 route 与单测共用；没有 ports 时明确返回“重建中”，绝不返回空账户。 */
export async function readTradeState(
  ports: TradePorts | undefined,
  staleAfterMs: number,
): Promise<TradeStateHttpBody> {
  if (ports === undefined) {
    return { ok: false, rebuilding: true, error: '交易组合根尚未就绪，状态仍在重建中' }
  }

  const asOf = ports.clock.now()
  try {
    const [account, positions, openOrders] = await Promise.all([
      ports.broker.getAccount(),
      ports.broker.getPositions(),
      ports.broker.getOpenOrders(),
    ])
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
        positions,
        openOrders,
        staleAfterMs,
      }),
    }
  } catch (error) {
    return { ok: false, rebuilding: true, error: String(error) }
  }
}

export function apply(ctx: Context, config: UiConfig): void {
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/trade/state',
      methods: ['GET'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        const body = await readTradeState(getExecPorts(), config.staleAfterMs ?? 120_000)
        return jsonResponse(body, body.ok ? 200 : 503)
      },
    })
    return () => {
      void dispose()
    }
  }, 'trade.ui.close')
}
