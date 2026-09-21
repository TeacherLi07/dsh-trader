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
import { createFeatureContext } from '../market/context.js'
import type { CcxtExchangeLike } from '../market/ccxt-source.js'
import { FeatureArchive } from '../market/feature-archive.js'
import { MarketObservationStore } from '../market/observations.js'
import {
  FEATURE_WARMUP_BARS,
  FeaturePipeline,
  type FeatureDerivatives,
} from '../market/features.js'
import { createMarketRuntime, type MarketRuntime } from '../market/runtime.js'
import type { Candle } from '../market/types.js'
import { createLiveEngine, type LiveEngine } from '../exec/live-engine.js'
import { getTriggerRuntime } from '../trigger/runtime.js'
import { TriggerQueue } from '../trigger/queue.js'
import { getExecPorts } from './exec.js'
import { DecisionJournal } from '../exec/journal.js'

export const name = 'trade-market'

export const Config = z.object({
  venue: z.union(['htx']).required(),
  symbols: z.array(z.string()).required(),
  timeframes: z.array(z.string()).required(),
  enabled: z.boolean().default(false),
  pollMs: z.number().default(60000),
  recentLimit: z.number().default(3),
  derivativesEnabled: z.boolean().default(true),
})

export interface MarketConfig {
  venue: 'htx'
  symbols: readonly string[]
  timeframes: readonly string[]
  enabled?: boolean
  pollMs?: number
  recentLimit?: number
  derivativesEnabled?: boolean
  /** 可选注入点；插件本身不主动请求衍生品，避免改变既有行情轮询行为。 */
  derivativesForCandle?: (candle: Candle) => FeatureDerivatives | undefined
}

type CcxtModule = Record<string, new (options: unknown) => CcxtExchangeLike>

/** ccxt 是 CJS：动态导入后取 `.default`。延迟到真正需要时才加载（减少启动开销）。 */
async function loadCcxt(): Promise<CcxtModule> {
  const mod = (await import('ccxt')) as unknown as { default?: unknown }
  return (mod.default ?? mod) as CcxtModule
}

export function apply(ctx: Context, config: MarketConfig): void {
  const logger = ctx.logger('trade-market')
  let runtime: MarketRuntime | undefined
  /** 懒建：组合根（trade-exec）可能在 market 之后才 apply，因此每根 bar 现查端口。 */
  let liveEngine: LiveEngine | undefined
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
      const featureArchive = new FeatureArchive(database)
      const observations = new MarketObservationStore(database)
      const pipeline = new FeaturePipeline(featureArchive)
      const clock = systemClock()

      runtime = await createMarketRuntime({
        venue: config.venue,
        symbols: config.symbols,
        timeframes: config.timeframes,
        pollMs: config.pollMs ?? 60_000,
        recentLimit: config.recentLimit ?? 3,
        archive: bars,
        observations,
        clock,
        createExchange: () => new Exchange({ enableRateLimit: true }),
        onClosedCandle: async (candle) => {
          // 衍生品端点是可选能力；每根 bar 取一次同一 closeTime 的 observation，
          // 失败字段由 source 归一为缺失，不能用上一根值填洞。
          const spotSymbol = candle.symbol.includes(':') ? candle.symbol.split(':')[0] : undefined
          const derivatives =
            config.derivativesForCandle?.(candle) ??
            (config.derivativesEnabled === false || runtime === undefined
              ? undefined
              : await runtime.derivatives.fetch(candle.symbol, candle.closeTime, spotSymbol))
          const processedAt = clock.now()
          if (derivatives !== undefined && 'timestamp' in derivatives &&
              typeof derivatives.timestamp === 'number' && Number.isSafeInteger(derivatives.timestamp)) {
            observations.record({
              kind: 'derivatives', symbol: candle.symbol, timeframe: '',
              eventTime: derivatives.timestamp, availableAt: processedAt,
              source: 'htx.derivatives', value: derivatives,
            })
          }
          const snapshot = pipeline.onClosedCandle(candle, derivatives, processedAt)
          // 行情 → 特征 → 规则 → 触发；rules 插件未启用时静默跳过（不是错误）
          getTriggerRuntime()?.onBar({
            symbol: candle.symbol,
            timeframe: candle.timeframe,
            barTs: candle.openTime,
            context: createFeatureContext(snapshot),
          })
          // ★ 机械执行（无人值守的核心一环）：每根已收盘 bar 匹配 active 计划卡并执行。
          // 与回放共用同一份 execute-action；组合根未就绪时跳过（不静默假装执行）。
          const ports = getExecPorts()
          if (ports === undefined) throw new Error('执行组合根尚未就绪，保留 bar 等待下一轮重试')
          // paper 模式的保护单是"挂单"，必须靠 bar 推进才可能触发；真实 broker 没有 onBar
          // （它的止损在交易所侧），因此这里是可选的、不改变实盘语义。
          const paperLike = ports.broker as typeof ports.broker & {
            onBar?: (symbol: string, candle: { high: number; low: number; close: number }) => unknown
          }
          paperLike.onBar?.(candle.symbol, {
            high: candle.high,
            low: candle.low,
            close: candle.close,
          })
          liveEngine ??= createLiveEngine({
            journal: ports.journal,
            plans: ports.plans,
            bars: ports.bars,
            features: ports.features,
            broker: ports.broker,
            clock: ports.clock,
            mode: ports.mode,
            liveArmed: ports.liveArmed,
            limits: ports.limits,
            waiver: ports.waiver,
            riskPct: ports.riskPct,
            queue: new TriggerQueue(ports.db),
            ...(ports.frozenSymbols === undefined ? {} : { frozenSymbols: ports.frozenSymbols }),
            ...(ports.freezeSymbol === undefined ? {} : { freezeSymbol: ports.freezeSymbol }),
            ...(ports.halt === undefined ? {} : { halt: ports.halt }),
          })
          try {
            const outcome = await liveEngine.onClosedBar({
              symbol: candle.symbol,
              timeframe: candle.timeframe,
              barTs: candle.openTime,
            })
            if (outcome.kind === 'noop') return
            logger.info(
              `live-engine ${candle.symbol} ${candle.timeframe} ${candle.openTime}: ` +
                `${outcome.kind}${outcome.reason === undefined ? '' : `（${outcome.reason}）`}`,
            )
          } catch (error) {
            // 单根 bar 执行失败不得让行情循环崩溃；如实告警（审计优先，不擦掉失败）
            logger.error(`live-engine 执行失败：${String(error)}`)
          }
        },
        onError: (error, info) => {
          // 数据源失败只跳过本轮，绝不让主循环崩溃（plan §4.3）——但**绝不静默**：
          // 失败要能被看见（审计优先）。落审计 + 日志，便于事后回答"为什么没有行情"。
          logger.error(`行情源失败 ${info.symbol}/${info.timeframe} kind=${info.kind}：${String(error)}`)
          try {
            new DecisionJournal(getDatabase()).appendAudit({
              actor: 'system',
              kind: 'market_source_error',
              payload: {
                symbol: info.symbol,
                timeframe: info.timeframe,
                kind: info.kind,
                attempt: info.attempt,
                error: String(error),
              },
              ts: systemClock().now(),
            })
          } catch (auditError) {
            logger.error(`行情错误落审计失败：${String(auditError)}`)
          }
        },
      })

      // 先修复归档尾部/内部缺口，再从“成功处理”游标恢复特征；归档成功不等于下游成功。
      try {
        await runtime.backfill()
      } catch (error) {
        logger.error(`行情启动回补失败（后续轮询将继续重试）：${String(error)}`)
      }
      for (const symbol of config.symbols) {
        for (const timeframe of config.timeframes) {
          const processed = bars.recentProcessedClosedBars(symbol, timeframe, FEATURE_WARMUP_BARS)
          const snapshots = featureArchive.recent(symbol, timeframe, FEATURE_WARMUP_BARS)
          pipeline.warmUp(processed, snapshots)
        }
      }

      if (disposed) {
        await runtime.close()
        return
      }
      // 首次轮询立即处理回补后的待处理队列，不等待一个完整 pollMs；single-flight 仍由 feed 保证。
      await runtime.feed.pollOnce()
      runtime.start()
    } catch (error) {
      // 数据源不可达或配置错误不应让 profile 启动失败；按 plan §4.3 跳过并告警。
      // 但必须**如实记录**：静默 catch 会让"没行情"变成不可诊断的空白（实测踩过）。
      logger.error(`行情运行时启动失败：${String(error)}`)
      try {
        new DecisionJournal(getDatabase()).appendAudit({
          actor: 'system',
          kind: 'market_runtime_start_failed',
          payload: { error: String(error) },
          ts: systemClock().now(),
        })
      } catch (auditError) {
        logger.error(`行情启动失败落审计失败：${String(auditError)}`)
      }
    }
  })()
}
