/**
 * `trade-market` —— L1 数据层：WS 行情接入 + bar 归档 + 特征快照 + 回补。
 *
 * 状态：骨架（T0.1）。T0.4/T0.5 实现；本节**不允许**出现 `Date.now()`，
 * 一律走注入的 `Clock`（plan §7）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'trade-market'

export const Config = z.object({
  venue: z.string().required(),
  crossCheckVenue: z.string(),
  symbols: z.array(z.string()).required(),
  timeframes: z.array(z.string()).required(),
})

export interface MarketConfig {
  venue: string
  crossCheckVenue?: string
  symbols: readonly string[]
  timeframes: readonly string[]
}

export function apply(ctx: Context, config: MarketConfig): void {
  // TODO(T0.4): CCXT Pro WS（主 + 交叉校验）、断线重连、只落已收盘 bar、upsert 归档、30 天回补。
  // TODO(T0.5): 增量指标（纯函数，可单测）。
  ctx.effect(
    () => () => {
      /* T0.4: 断开 WS 订阅 */
    },
    'trade.market.close',
  )
  void config
}
