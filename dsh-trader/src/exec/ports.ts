/**
 * 执行组合根的端口。
 *
 * 单一生产执行边界：判断、机械计划与恢复都使用同一组 broker/journal 引用。
 */

import type Database from 'better-sqlite3'
import type { Clock } from '../clock.js'
import type { RiskLimits, RunMode } from '../config.js'
import type { DecisionContextConfig } from '../agents/context-config.js'
import type { Broker, Venue } from './broker.js'
import type { CcxtProExchangeLike } from './ccxt-broker.js'
import type { BarArchive } from '../market/archive.js'
import type { FeatureArchive } from '../market/feature-archive.js'
import type { PlanStore } from '../plan/store.js'
import type { PmStore } from '../predictions/store.js'
import type { DecisionJournal } from './journal.js'

export interface TradePorts {
  readonly db: Database.Database
  readonly bars: BarArchive
  readonly features: FeatureArchive
  readonly plans: PlanStore
  readonly journal: DecisionJournal
  readonly broker: Broker
  readonly clock: Clock
  readonly limits: RiskLimits | null
  readonly mode: RunMode
  readonly riskPct: number
  readonly reflectionHorizonMs?: number
  readonly pm?: PmStore
  readonly frozenSymbols?: () => ReadonlySet<string>
  readonly freezeSymbol?: (symbol: string) => void
  readonly halt?: () => void
  readonly symbols: readonly string[]
  readonly timeframes: readonly string[]
  readonly benchmark: string
  readonly decisionContextConfig?: DecisionContextConfig
}

/**
 * 交易执行运行时配置。
 *
 * 限额保留扁平字段是为了能直接承接插件 Config；`limits` 作为可选的显式
 * 组合形式只用于测试/调用方已经完成参数解析的场景，不会在缺字段时猜默认值。
 */
export interface ExecRuntimeConfig {
  readonly mode: RunMode
  readonly riskPct: number
  readonly symbols: readonly string[]
  readonly timeframes: readonly string[]
  readonly benchmark: string
  readonly decisionContext?: Partial<DecisionContextConfig>
  readonly venue: Venue
  /** HTX 现货与永续分账户；实盘路径必须显式提供。 */
  readonly accountType: string
  /** HTX 线性永续算法保护单必需（单向模式 'both'）。 */
  readonly positionSide?: string

  readonly perOrderCapUsd?: number
  readonly maxExposureUsd?: number
  readonly maxLeverage?: number
  readonly dailyLossLimitUsd?: number
  readonly maxDrawdownUsd?: number
  readonly maxConsecutiveLosses?: number
  readonly maxSpreadBps?: number
  readonly maxOpenOrders?: number
  readonly limits?: RiskLimits | null

  readonly apiKey?: string
  readonly apiSecret?: string
  readonly sandbox?: boolean
  readonly reconcileMs: number
  /**
   * 结算扫描周期（plan §5.3）：独立任务扫 `reflection_due_at` 到期的决策。
   * 缺省 60s；不配也有默认值，避免"结算闭环没接起来"这种静默缺口。
   */
  readonly settleMs?: number
  /** true 时才执行孤儿撤单；默认只报告，启动第①步不能改变远端状态。 */
  readonly liveAckOrphans?: boolean
  /** 语义别名，便于非插件调用方表达 §4.2 的 acknowledgeOrphans。 */
  readonly acknowledgeOrphans?: boolean

  readonly paperInitialEquityQuote?: number
  readonly paperSlippageBps?: number
  readonly paperFeeBps?: number
  /** 测试/回放可直接注入价格；未给出时由 BarArchive 最近收盘价提供。 */
  readonly priceOf?: (symbol: string) => number | undefined

  readonly reflectionHorizonMs?: number
  readonly pm?: PmStore
}

export interface ExecRuntimeDeps {
  readonly db: Database.Database
  readonly clock: Clock
  /** 生产环境传 ccxt 构造器，测试传无网络 fake；返回值可以同步或异步。 */
  readonly createExchange?: (
    venue: Exclude<Venue, 'paper'>,
    options?: Readonly<Record<string, unknown>>,
  ) => CcxtProExchangeLike | Promise<CcxtProExchangeLike>
  /** 优先级高于 config.priceOf，便于回放替换价格源而不改运行配置。 */
  readonly priceOf?: (symbol: string) => number | undefined
}
