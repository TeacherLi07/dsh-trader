/**
 * `trade-exec` —— 执行层与硬闸。
 *
 * 硬闸纯函数在 `src/exec/gate.ts`；CCXT broker 通过组合根注入 exchange。
 *
 * 安全：`apiKey`/`apiSecret` 只从环境注入（Docker secret/env-file 或 DSH 的 `$DSH_HOME/.env`，0600），
 * **绝不**写进仓库、配置或 prompt；插件只输出"已注入/未注入"布尔，**不打印密钥**。
 *
 * 第①步只读预检（plan §12.2 A）：`preflightEnabled: true` 时用真实 venue 读账户/持仓/挂单，
 * 与本地库对账并**只报告不执行**；没有这个开关就完全不打网络。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { StartupParamsError, startupLimitsError, type RiskLimits } from '../config.js'
import { getDatabase } from '../db/runtime.js'
import { applyProxyAwareFetch } from '../market/ccxt-source.js'
import { CcxtBroker, type CcxtProExchangeLike } from '../exec/ccxt-broker.js'
import { DecisionJournal } from '../exec/journal.js'
import { LocalStateReader, runReadOnlyPreflight } from '../exec/preflight.js'
import {
  assertExecRuntimeMode,
  createExecRuntime,
  type ExecRuntime,
} from '../exec/runtime.js'
import type { ExecRuntimeConfig, TradePorts } from '../exec/ports.js'

export const name = 'trade-exec'

export const Config = z.object({
  mode: z.union(['paper', 'live_confirm', 'live_auto']).required(),
  perOrderCapUsd: z.number(),
  maxExposureUsd: z.number(),
  maxLeverage: z.number(),
  dailyLossLimitUsd: z.number(),
  maxDrawdownUsd: z.number(),
  maxConsecutiveLosses: z.number(),
  maxSpreadBps: z.number(),
  maxOpenOrders: z.number(),
  apiKey: z.string(),
  apiSecret: z.string(),
  /** 只读预检开关；默认关闭 ⇒ 插件加载时完全不触网。 */
  preflightEnabled: z.boolean(),
  /** 只读预检的 venue（htx 生产 / okx 用于交叉校验与 sandbox）。 */
  preflightVenue: z.string(),
  /** 只读预检的参考标的（用于点差重取）；省略时由 broker 自行推断。 */
  preflightSymbol: z.string(),
  /** OKX sandbox；HTX 没有该端点，不应打开。 */
  sandbox: z.boolean(),
  /** 读余额的账户类型（HTX 现货与 USDT 永续分离）；跑永续必须是 `swap`。 */
  accountType: z.string().default('swap'),
  /** HTX 线性永续算法保护单必需（单向模式 both）。 */
  positionSide: z.string().default('both'),
  /** 执行组合根与周期对账；默认关闭以保持旧 profile 不触网。 */
  reconcileEnabled: z.boolean().default(false),
  /** 启动对账是否执行孤儿撤单；默认只报告（plan §12.2 A 第①步）。 */
  liveAckOrphans: z.boolean().default(false),
  paperInitialEquityQuote: z.number().default(10_000),
  paperSlippageBps: z.number().default(5),
  paperFeeBps: z.number().default(5),
  reconcileMs: z.number().default(60_000),
  /** 结算扫描周期；必须和 runtime config 一起转发，避免 patch 看似可热改但实际被忽略。 */
  settleMs: z.number().default(60_000),
  /** 组合根启动所需的运行时参数；未齐全时拒绝启动 runtime，不猜默认值。 */
  riskPct: z.number(),
  symbols: z.array(z.string()),
  timeframes: z.array(z.string()),
  benchmark: z.string(),
  venue: z.string().default('htx'),
})

export interface ExecConfig {
  mode: 'paper' | 'live_confirm' | 'live_auto'
  perOrderCapUsd?: number
  maxExposureUsd?: number
  maxLeverage?: number
  dailyLossLimitUsd?: number
  maxDrawdownUsd?: number
  maxConsecutiveLosses?: number
  maxSpreadBps?: number
  maxOpenOrders?: number
  apiKey?: string
  apiSecret?: string
  preflightEnabled?: boolean
  preflightVenue?: string
  preflightSymbol?: string
  sandbox?: boolean
  accountType?: string
  positionSide?: string
  reconcileEnabled?: boolean
  liveAckOrphans?: boolean
  paperInitialEquityQuote?: number
  paperSlippageBps?: number
  paperFeeBps?: number
  reconcileMs?: number
  settleMs?: number
  riskPct?: number
  symbols?: readonly string[]
  timeframes?: readonly string[]
  benchmark?: string
  venue?: string
}

export type ExecBrokerKind = 'paper' | 'ccxt'

function hasCredential(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 纯函数：只有非 paper 模式且两把凭据都存在，才允许组合根选择 CcxtBroker。
 * 没有凭据时保持 paper 是安全默认；返回值只包含路由，不携带任何密钥。
 */
export function shouldUseLiveBroker(config: ExecConfig): boolean {
  return config.mode !== 'paper' && hasCredential(config.apiKey) && hasCredential(config.apiSecret)
}

/** 供组合根/测试使用的 broker 路由；缺凭据的 live 配置安全降级为 paper。 */
export function resolveExecBroker(config: ExecConfig): ExecBrokerKind {
  return shouldUseLiveBroker(config) ? 'ccxt' : 'paper'
}

/** 凭据"已注入/未注入"——**只有布尔**，可安全地写日志/落审计（plan §6.4）。 */
export interface CredentialStatus {
  readonly keyInjected: boolean
  readonly secretInjected: boolean
  /** 非 paper 且凭据齐全 = 允许走真实下单路由。 */
  readonly liveCapable: boolean
  readonly route: ExecBrokerKind
}

export function credentialStatus(config: ExecConfig): CredentialStatus {
  const keyInjected = hasCredential(config.apiKey)
  const secretInjected = hasCredential(config.apiSecret)
  return {
    keyInjected,
    secretInjected,
    liveCapable: config.mode !== 'paper' && keyInjected && secretInjected,
    route: resolveExecBroker(config),
  }
}

/** 从配置组装硬闸阈值。任一缺失即视为"未提供"——由启动参数流程决定是否 waiver。 */
export function limitsFromConfig(config: ExecConfig): RiskLimits | null {
  const values = [
    config.perOrderCapUsd,
    config.maxExposureUsd,
    config.maxLeverage,
    config.dailyLossLimitUsd,
    config.maxDrawdownUsd,
    config.maxConsecutiveLosses,
    config.maxSpreadBps,
    config.maxOpenOrders,
  ]
  if (values.some((value) => value === undefined)) return null
  return {
    perOrderCapUsd: config.perOrderCapUsd as number,
    maxExposureUsd: config.maxExposureUsd as number,
    maxLeverage: config.maxLeverage as number,
    dailyLossLimitUsd: config.dailyLossLimitUsd as number,
    maxDrawdownUsd: config.maxDrawdownUsd as number,
    maxConsecutiveLosses: config.maxConsecutiveLosses as number,
    maxSpreadBps: config.maxSpreadBps as number,
    maxOpenOrders: config.maxOpenOrders as number,
  }
}

let currentExecPorts: TradePorts | undefined

/**
 * 模块级端口注册是插件间最小依赖面：tools 插件可以直接读取同一组 ports，
 * 不必依赖 Cordis 的异步 service resolve 顺序；卸载时由持有者按同一引用清理。
 */
export function setExecPorts(ports: TradePorts | undefined): void {
  currentExecPorts = ports
}

export function getExecPorts(): TradePorts | undefined {
  return currentExecPorts
}

function runtimeConfigFromExecConfig(config: ExecConfig): ExecRuntimeConfig | undefined {
  if (
    config.riskPct === undefined ||
    config.symbols === undefined ||
    config.timeframes === undefined ||
    config.benchmark === undefined
  ) {
    return undefined
  }
  const limits = limitsFromConfig(config)
  // 本插件没有 waiver 配置；缺限额时拒绝启动 runtime，避免把配置遗漏当成显式放弃。
  if (limits === null) return undefined
  return {
    mode: config.mode,
    riskPct: config.riskPct,
    symbols: config.symbols,
    timeframes: config.timeframes,
    benchmark: config.benchmark,
    venue: (config.venue ?? 'htx') as ExecRuntimeConfig['venue'],
    accountType: config.accountType ?? 'swap',
    positionSide: config.positionSide ?? 'both',
    perOrderCapUsd: limits.perOrderCapUsd,
    maxExposureUsd: limits.maxExposureUsd,
    maxLeverage: limits.maxLeverage,
    dailyLossLimitUsd: limits.dailyLossLimitUsd,
    maxDrawdownUsd: limits.maxDrawdownUsd,
    maxConsecutiveLosses: limits.maxConsecutiveLosses,
    maxSpreadBps: limits.maxSpreadBps,
    maxOpenOrders: limits.maxOpenOrders,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    sandbox: config.sandbox,
    reconcileMs: config.reconcileMs ?? 60_000,
    settleMs: config.settleMs ?? 60_000,
    liveAckOrphans: config.liveAckOrphans ?? false,
    paperInitialEquityQuote: config.paperInitialEquityQuote ?? 10_000,
    paperSlippageBps: config.paperSlippageBps ?? 5,
    paperFeeBps: config.paperFeeBps ?? 5,
  }
}

type CcxtModule = Record<string, new (options: unknown) => CcxtProExchangeLike>

/** ccxt 是 CJS：动态导入后取 `.default`。延迟到真正需要时才加载（避免关闭预检时的启动开销）。 */
async function loadCcxt(): Promise<CcxtModule> {
  const mod = (await import('ccxt')) as unknown as { default?: unknown }
  return (mod.default ?? mod) as CcxtModule
}

function isCcxtVenue(value: string): value is 'htx' | 'okx' {
  return value === 'htx' || value === 'okx'
}

export function apply(ctx: Context, config: ExecConfig): void {
  const logger = ctx.logger('trade-exec')
  const status = credentialStatus(config)

  // 只输出布尔，绝不输出密钥本身（plan §6.4）。
  logger.info(
    `凭据状态：keyInjected=${String(status.keyInjected)} secretInjected=${String(status.secretInjected)} ` +
      `liveCapable=${String(status.liveCapable)} route=${status.route}（mode=${config.mode}）`,
  )

  if (config.reconcileEnabled === true) {
    // apply 内的 runtime 创建是异步的，单纯在 Promise catch 里记录日志会让
    // profile 看似启动成功；当前没有逐单 ask 通道，live_confirm 必须在注册
    // 任何执行 runtime 之前同步拒绝。只读预检不创建 runtime，仍可独立运行。
    assertExecRuntimeMode(config.mode)
  }

  // plan §12 #17：风控参数自洽校验。paper 模式权益已知 ⇒ **启动即校验，不自洽就拒绝启动**；
  // live 模式的权益要等首次 getAccount()，由 live-engine 做一次性校验并落审计。
  // 不自洽会让每一单都在 perOrderCapUsd 处被打回 —— 系统"看起来在跑"却永远不成交。
  const startupLimits = limitsFromConfig(config)
  if (startupLimits !== null && config.riskPct !== undefined) {
    const inconsistent = startupLimitsError({
      mode: config.mode,
      equityQuoteUsd: config.paperInitialEquityQuote ?? 10_000,
      riskPct: config.riskPct,
      perOrderCapUsd: startupLimits.perOrderCapUsd,
    })
    if (inconsistent !== null) {
      logger.error(`风控自洽校验失败：${inconsistent}`)
      throw new StartupParamsError([inconsistent])
    }
  }

  let disposed = false
  let runtime: ExecRuntime | undefined
  ctx.effect(
    () => () => {
      disposed = true
      const owned = runtime
      if (owned !== undefined && getExecPorts() === owned.getPorts()) setExecPorts(undefined)
      void owned?.dispose()
    },
    'trade.exec.close',
  )

  // 组合根是懒启动的：默认不创建交易所、不触发对账；异步完成后仍检查 disposed，
  // 防止插件卸载与动态加载竞态把旧 ports 暴露给其它插件。
  if (config.reconcileEnabled === true) {
    const runtimeConfig = runtimeConfigFromExecConfig(config)
    if (runtimeConfig === undefined) {
      logger.error('执行 runtime 参数不完整：需要 riskPct、symbols、timeframes、benchmark 与完整 limits')
    } else {
      void (async () => {
        try {
          const created = await createExecRuntime(runtimeConfig, {
            db: getDatabase(),
            clock: systemClock(),
          })
          if (disposed) {
            await created.dispose()
            return
          }
          runtime = created
          setExecPorts(created.getPorts())
          logger.info(
            '执行 runtime 已启动：broker=' +
              created.broker.venue +
              ' symbols=' +
              String(runtimeConfig.symbols.length) +
              ' timeframes=' +
              String(runtimeConfig.timeframes.length) +
              ' reconcileMs=' +
              String(runtimeConfig.reconcileMs),
          )
        } catch (error) {
          // 启动对账失败时不暴露半成品 ports；错误交给运行日志/外部告警处理。
          if (!disposed) logger.error('执行 runtime 启动失败：' + String(error))
        }
      })()
    }
  }

  // 只读预检：显式打开才打网络；全程只读，不撤单、不下单。
  if (config.preflightEnabled !== true) return

  void (async () => {
    try {
      const venue = config.preflightVenue ?? 'htx'
      if (!isCcxtVenue(venue)) throw new Error(`不支持的预检 venue：${venue}（只允许 htx | okx）`)
      const ccxt = await loadCcxt()
      const Exchange = ccxt[venue]
      if (Exchange === undefined) throw new Error(`未知交易所：${venue}`)

      const accountType = config.accountType ?? 'swap'
      // defaultType 让 ccxt 的行情/持仓解析也落在永续账户上；只读余额再显式带 type。
      const exchange = new Exchange({ enableRateLimit: true, defaultType: accountType })
      applyProxyAwareFetch(exchange)
      if (disposed) return

      const clock = systemClock()
      const broker = new CcxtBroker({
        exchange,
        venue,
        clock,
        apiKey: config.apiKey ?? '',
        apiSecret: config.apiSecret ?? '',
        sandbox: config.sandbox === true,
        accountType,
        ...(config.preflightSymbol === undefined ? {} : { symbol: config.preflightSymbol }),
      })

      const database = getDatabase()
      const local = new LocalStateReader(database)
      const report = await runReadOnlyPreflight({
        broker,
        clock,
        localOrders: local.orders(),
        localPositions: local.positions(),
      })
      if (disposed) return

      logger.info(
        `只读预检 ${report.venue}：equity=${report.equityQuote === null ? 'unknown' : report.equityQuote} ` +
          `远端持仓=${report.remote.positions} 远端挂单=${report.remote.openOrders} ` +
          `本地挂单=${report.local.orders} 本地持仓=${report.local.positions} ` +
          `一致=${String(report.consistent)} 冻结=${String(report.freezeTrading)} ` +
          `动作=${JSON.stringify(report.actionKinds)}`,
      )
      if (!report.consistent) {
        logger.warn(`只读预检发现不一致（不自动处理）：${JSON.stringify(report.actions)}`)
      }

      // 审计优先：预检结论落库（不含任何密钥），便于事后解释"当时账户长什么样"。
      new DecisionJournal(database).appendAudit({
        actor: 'system',
        kind: 'htx_readonly_preflight',
        payload: {
          venue: report.venue,
          equityQuote: report.equityQuote,
          remote: report.remote,
          local: report.local,
          consistent: report.consistent,
          freezeTrading: report.freezeTrading,
          actionKinds: report.actionKinds,
        },
        ts: report.ranAt,
      })
    } catch (error) {
      // 预检失败不能让 profile 启动失败（只读、可选）；如实告警。
      logger.error(`只读预检失败：${String(error)}`)
    }
  })()
}
