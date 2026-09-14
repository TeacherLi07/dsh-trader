/**
 * `trade-predictions` —— 预测市场事件源（plan §4.4 / T1.11）。
 *
 * 默认 `enabled: false`：**只读、永不交易**的事件源不该在没人配置时自己开始打网络。
 * 打开后它做三件事：
 *   1. 按注入时钟轮询（`pollMs`）刷新关注市场的元数据、盘口与概率序列；
 *   2. 求值 pm 规则族，把信号交给 `PmSignalRouter` 走**同一套**触发治理（去重→冷却→限流→分级）；
 *   3. 把 `PmStore` 注册到运行时，供 `trade_predictions` / `trade_prediction_watch` 使用。
 *
 * 三条红线在插件层再确认一次：
 *   · 不注册任何 pm 下单工具（这里根本没有下单代码）；
 *   · 永不作为开仓的唯一理由（信号 `isTradeTrigger` 写死 false，novelty 只进 W3）；
 *   · 市场文本按不可信数据注入（`untrustedText`）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { getDatabase } from '../db/runtime.js'
import { createPmClients, type PmFetchLike, type PmInterval } from '../predictions/client.js'
import { PmPoller } from '../predictions/poller.js'
import { DEFAULT_PM_RULE_CONFIG, assertPmRuleConfig, evaluatePmRules, type PmRuleConfig } from '../predictions/rules.js'
import { setPmRuntime } from '../predictions/runtime.js'
import { PmStore } from '../predictions/store.js'
import { PmSignalRouter } from '../predictions/wiring.js'
import { TriggerQueue } from '../trigger/queue.js'
import { newMarketInputFromRow } from '../predictions/rules.js'

export const name = 'trade-predictions'

export const Config = z.object({
  enabled: z.boolean(),
  pollMs: z.number(),
  liquidityFloorQuote: z.number(),
  spreadCeilBps: z.number(),
  historyInterval: z.string(),
  marketPageSize: z.number(),
  newMarketEventWhitelist: z.array(z.string()),
  probJumpAbs: z.number(),
  probJumpVolMultiple: z.number(),
  probJumpCooldownMs: z.number(),
  volumeSpikeMultiple: z.number(),
  signalTtlMs: z.number(),
})

export interface PredictionsConfig {
  enabled?: boolean
  pollMs?: number
  liquidityFloorQuote?: number
  spreadCeilBps?: number
  historyInterval?: '1d' | '1w'
  marketPageSize?: number
  newMarketEventWhitelist?: readonly string[]
  probJumpAbs?: number
  probJumpVolMultiple?: number
  probJumpCooldownMs?: number
  volumeSpikeMultiple?: number
  signalTtlMs?: number
  /** 取数实现可注入（测试不打网络）。 */
  fetchImpl?: PmFetchLike
}

/** Node 全局 fetch → `PmFetchLike`。代理由 `NODE_USE_ENV_PROXY` + 全局 fetch 处理。 */
export function defaultPmFetch(): PmFetchLike {
  return async (url, init) => {
    const response = await fetch(url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.signal === undefined ? {} : { signal: init.signal }),
    })
    return { status: response.status, text: () => response.text() }
  }
}

export function apply(ctx: Context, config: PredictionsConfig = {}): void {
  const enabled = config.enabled === true
  const liquidity = {
    liquidityFloorQuote: config.liquidityFloorQuote ?? 1_000,
    spreadCeilBps: config.spreadCeilBps ?? 300,
  }

  // 规则配置即使未启用也要自检：配置写错是**启动期**错误，不该等到打开才发现
  const ruleConfig: PmRuleConfig = {
    ...DEFAULT_PM_RULE_CONFIG,
    ...liquidity,
    ...(config.newMarketEventWhitelist === undefined
      ? {}
      : { newMarketEventWhitelist: config.newMarketEventWhitelist }),
    ...(config.probJumpAbs === undefined ? {} : { probJumpAbs: config.probJumpAbs }),
    ...(config.probJumpVolMultiple === undefined
      ? {}
      : { probJumpVolMultiple: config.probJumpVolMultiple }),
    ...(config.probJumpCooldownMs === undefined
      ? {}
      : { probJumpCooldownMs: config.probJumpCooldownMs }),
    ...(config.volumeSpikeMultiple === undefined
      ? {}
      : { volumeSpikeMultiple: config.volumeSpikeMultiple }),
  }
  assertPmRuleConfig(ruleConfig)

  const store = new PmStore(getDatabase(), { liquidity })

  if (!enabled) {
    // 未启用：只注册 store（工具可用但会因没有数据而返回空），不起轮询、不打网络
    setPmRuntime({ store })
    ctx.effect(
      () => () => {
        setPmRuntime(undefined)
      },
      'trade.predictions.close',
    )
    return
  }

  const clients = createPmClients({
    fetch: config.fetchImpl ?? defaultPmFetch(),
    clock: systemClock(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  const poller = new PmPoller({
    clients,
    store,
    clock: systemClock(),
    intervalMs: config.pollMs ?? 60_000,
    ...(config.historyInterval === undefined ? {} : { historyInterval: config.historyInterval }),
    ...(config.marketPageSize === undefined ? {} : { marketPageSize: config.marketPageSize }),
  })

  // 自建一个 `TriggerQueue`：它只是 DB 的薄包装，而**去重与额度都在数据库层面**
  // （`triggers.dedup_key` 唯一 + `countFiredSince` 按表统计），
  // 所以 pm 的 novelty 与行情 novelty 共享同一份小时/日预算 —— 这正是我们要的，
  // 同时也就没有必要去反向依赖 trigger 插件的运行时对象。
  const router = new PmSignalRouter({
    store,
    queue: new TriggerQueue(getDatabase()),
    clock: systemClock(),
    ...(config.signalTtlMs === undefined ? {} : { ttlMs: config.signalTtlMs }),
  })

  setPmRuntime({ store, poller, router })

  /**
   * 轮询 → 规则族 → 治理。
   * 所有异常都在 `runOnce` 内收敛；这里不再 try/catch，因为**没有**可抛出的路径，
   * 多一层 catch 只会掩盖"轮询器真的坏了"。
   */
  const dispose = poller.start((result) => {
    const signals = evaluatePmRules(
      {
        now: result.asOf,
        snapshots: result.snapshots,
        newMarkets: store
          .marketsFirstSeenSince(result.asOf - (config.pollMs ?? 60_000))
          .map(newMarketInputFromRow),
      },
      ruleConfig,
    )
    router.route(signals, result.asOf)
  })

  ctx.effect(
    () => () => {
      dispose()
      setPmRuntime(undefined)
    },
    'trade.predictions.close',
  )
}
