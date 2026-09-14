/**
 * `trade-market` —— L1 数据层：CCXT 行情接入 + bar 归档 + 回补（plan §4.3 / T0.4）。
 *
 * 时钟来源：插件是**组合根**，用 `systemClock()`；`src/market/` 内部只接受注入的 Clock
 * （plan §7 的 grep 纪律）。
 *
 * ⚠️ 代理：ccxt 自带的 fetch **不读** `HTTP_PROXY`/`HTTPS_PROXY`，必须把 Node 全局 fetch
 * 注入给它（`applyProxyAwareFetch`，在 `createMarketRuntime` 里默认完成）。本机实测：
 * 不注入 ⇒ ECONNREFUSED；注入后 HTX 正常。详见 plan §12 #14。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { getDatabase } from '../db/runtime.js'
import { BarArchive } from '../market/archive.js'
import type { CcxtExchangeLike } from '../market/ccxt-source.js'
import { FeatureArchive } from '../market/feature-archive.js'
import { FEATURE_WARMUP_BARS, FeaturePipeline } from '../market/features.js'
import { createMarketRuntime, type MarketRuntime } from '../market/runtime.js'

export const name = 'trade-market'

export const Config = z.object({
  venue: z.string().required(),
  crossCheckVenue: z.string(),
  symbols: z.array(z.string()).required(),
  timeframes: z.array(z.string()).required(),
  enabled: z.boolean().default(false),
  pollMs: z.number().default(60000),
  recentLimit: z.number().default(3),
})

export interface MarketConfig {
  venue: string
  crossCheckVenue?: string
  symbols: readonly string[]
  timeframes: readonly string[]
  enabled?: boolean
  pollMs?: number
  recentLimit?: number
}

type CcxtModule = Record<string, new (options: unknown) => CcxtExchangeLike>

/** ccxt 是 CJS：动态导入后取 `.default`。延迟到真正需要时才加载（减少启动开销）。 */
async function loadCcxt(): Promise<CcxtModule> {
  const mod = (await import('ccxt')) as unknown as { default?: unknown }
  return (mod.default ?? mod) as CcxtModule
}

export function apply(ctx: Context, config: MarketConfig): void {
  let runtime: MarketRuntime | undefined
  let disposed = false

  ctx.effect(
    () => () => {
      disposed = true
      runtime?.stop()
      void runtime?.close()
    },
    'trade.market.close',
  )

  if (config.enabled !== true) return

  void (async () => {
    try {
      const ccxt = await loadCcxt()
      const Exchange = ccxt[config.venue]
      if (Exchange === undefined) throw new Error(`未知交易所：${config.venue}`)

      const database = getDatabase()
      const bars = new BarArchive(database)
      const pipeline = new FeaturePipeline(new FeatureArchive(database))

      // 重启后回灌最近 N 根已收盘 bar，重建增量指标状态，避免特征长时间空窗
      for (const symbol of config.symbols) {
        for (const timeframe of config.timeframes) {
          pipeline.warmUp(bars.recentClosedBars(symbol, timeframe, FEATURE_WARMUP_BARS))
        }
      }

      runtime = await createMarketRuntime({
        venue: config.venue,
        symbols: config.symbols,
        timeframes: config.timeframes,
        pollMs: config.pollMs ?? 60_000,
        recentLimit: config.recentLimit ?? 3,
        archive: bars,
        clock: systemClock(),
        createExchange: () => new Exchange({ enableRateLimit: true }),
        onClosedCandle: (candle) => {
          pipeline.onClosedCandle(candle)
        },
        onError: () => {
          // TODO(OBS/T1.6): 写 audit_events + 接告警通道（plan §10.3）。
          // 数据源失败只跳过本轮，绝不让主循环崩溃（plan §4.3）。
        },
      })

      if (disposed) {
        await runtime.close()
        return
      }
      runtime.start()
    } catch (error) {
      // 数据源不可达或配置错误不应让 profile 启动失败；按 plan §4.3 跳过并告警
      // TODO(OBS): 落 audit_events + 告警
      void error
    }
  })()
}
