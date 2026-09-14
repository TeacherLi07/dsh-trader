/**
 * 预测市场规则族（plan §4.4 表 / T1.10）。
 *
 * 纯函数：吃一轮快照，吐信号。不读时钟、不落库、不发通知 —— 于是可以逐条断言。
 *
 * 三条硬约束在这里落地：
 *   · **novelty 必须先过流动性门槛**（薄市场/宽价差一律不产生 novelty）——§10 专项 ④；
 *   · 每条信号都带 `estimator`（`mid` / `last_trade_price`）——"概率变了"不能只是换了口径；
 *   · **pm 永不作为开仓的唯一理由**：信号里 `isTradeTrigger: false` 是写死的，
 *     novelty 只能进 W3 唤醒（走限流），commitment 由计划卡 `when` 自己承担。
 *
 * `pm_level_cross` **不在这里实现**：它就是计划卡的 `when: "pm.<alias>.prob < 0.30"`，
 * 由 `matchPlan` 逐 bar 求值。再写一份代码规则等于制造两个事实来源。
 */

import type { PmAliasSnapshot } from './store.js'
import { watchDedupKey } from './pit.js'

export type PmSignalPurpose = 'novelty' | 'info'
export type PmSeverity = 'P1' | 'P2'

export interface PmSignal {
  readonly ruleId: string
  readonly alias: string
  readonly tokenId: string
  readonly purpose: PmSignalPurpose
  readonly severity: PmSeverity
  readonly reason: string
  readonly dedupKey: string
  /** 写死的 false：预测市场**永不**直接触发交易（§4.4 红线 2）。 */
  readonly isTradeTrigger: false
  readonly payload: Readonly<Record<string, unknown>>
}

/** 跳变窗口：plan §4.4 表只写"超窗口阈值"，没规定窗口长度 ⇒ 显式可配。 */
export const PM_JUMP_LOOKBACKS = ['1h', '24h'] as const
export type PmJumpLookback = (typeof PM_JUMP_LOOKBACKS)[number]

export interface PmRuleConfig {
  /** `pm_prob_jump`：|Δprob| 绝对阈值。 */
  readonly probJumpAbs: number
  /** `pm_prob_jump` 的窗口长度（`1h` 用 `change1h`、`24h` 用 `change24h`）。 */
  readonly jumpLookback: PmJumpLookback
  /** `pm_prob_jump`：或超过已实现波动的 k 倍。 */
  readonly probJumpVolMultiple: number
  /** `pm_prob_jump` 冷却；官方要求 ≥15min，配置校验会强制。 */
  readonly probJumpCooldownMs: number
  /** 已实现波动的地板：低于它就只用绝对阈值，避免"安静市场的噪声"被当成跳变。 */
  readonly volFloor: number
  /** `pm_volume_spike`：volume24h / 中位数 的倍数。 */
  readonly volumeSpikeMultiple: number
  /** `pm_volume_spike` 冷却。 */
  readonly volumeSpikeCooldownMs: number
  /** `pm_spread_blowout`：点差上限（bps）。 */
  readonly spreadCeilBps: number
  /** `pm_spread_blowout` 冷却。 */
  readonly spreadBlowoutCooldownMs: number
  /** `pm_spread_blowout` 时对该 alias 的置信度折扣。 */
  readonly spreadConfidencePenalty: number
  /** `pm_new_market`：白名单事件 slug（空数组 = 不产生该信号，宁可不发也不乱发）。 */
  readonly newMarketEventWhitelist: readonly string[]
  readonly newMarketCooldownMs: number
  /** `pm_resolution` 冷却（结算只应报一次，冷却兜底）。 */
  readonly resolutionCooldownMs: number
}

export const DEFAULT_PM_RULE_CONFIG: PmRuleConfig = {
  probJumpAbs: 0.08,
  jumpLookback: '1h',
  probJumpVolMultiple: 4,
  probJumpCooldownMs: 15 * 60_000,
  volFloor: 0.005,
  volumeSpikeMultiple: 5,
  volumeSpikeCooldownMs: 60 * 60_000,
  spreadCeilBps: 300,
  spreadBlowoutCooldownMs: 60 * 60_000,
  spreadConfidencePenalty: 0.5,
  newMarketEventWhitelist: [],
  newMarketCooldownMs: 60 * 60_000,
  resolutionCooldownMs: 6 * 60 * 60_000,
}

export class PmRuleConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PmRuleConfigError'
  }
}

/** 配置自检：冷却不得低于官方要求，阈值必须在合法区间。 */
export function assertPmRuleConfig(config: PmRuleConfig): void {
  const problems: string[] = []
  if (!(config.probJumpCooldownMs >= 15 * 60_000)) {
    problems.push(`pm_prob_jump 冷却 ${config.probJumpCooldownMs}ms < 官方下限 15min`)
  }
  if (!(config.probJumpAbs > 0 && config.probJumpAbs <= 1)) {
    problems.push(`probJumpAbs 必须在 (0,1]，收到 ${config.probJumpAbs}`)
  }
  if (!(config.probJumpVolMultiple >= 1)) problems.push('probJumpVolMultiple 必须 ≥1')
  if (!(PM_JUMP_LOOKBACKS as readonly string[]).includes(config.jumpLookback)) {
    problems.push(`jumpLookback 必须是 ${PM_JUMP_LOOKBACKS.join('|')}，收到 ${String(config.jumpLookback)}`)
  }
  if (!(config.spreadCeilBps > 0)) problems.push('spreadCeilBps 必须为正')
  if (!(config.spreadConfidencePenalty > 0 && config.spreadConfidencePenalty <= 1)) {
    problems.push('spreadConfidencePenalty 必须在 (0,1]')
  }
  if (!(config.volumeSpikeMultiple > 1)) problems.push('volumeSpikeMultiple 必须 >1')
  if (problems.length > 0) throw new PmRuleConfigError(problems.join('；'))
}

export interface PmNewMarketInput {
  readonly conditionId: string
  readonly slug: string
  readonly question: string
  readonly eventSlugs: readonly string[]
  readonly firstSeenAt: number
  readonly liquidity: number | null
}

export interface PmRuleInput {
  readonly now: number
  readonly snapshots: readonly PmAliasSnapshot[]
  readonly newMarkets?: readonly PmNewMarketInput[]
  /** 每个 alias 的时间桶（去重键用）；默认 15min。 */
  readonly bucketMs?: number
}

const NOVELTY_MIN_SEVERITY = 'P1' as const

/** 把 `pm_markets` 行映射成 `pm_new_market` 的输入（事件 slug 即白名单匹配用的 tag）。 */
export function newMarketInputFromRow(row: {
  readonly conditionId: string
  readonly slug: string
  readonly question: string
  readonly events: readonly { readonly slug: string }[]
  readonly firstSeenAt: number
  readonly liquidity: number | null
}): PmNewMarketInput {
  return {
    conditionId: row.conditionId,
    slug: row.slug,
    question: row.question,
    eventSlugs: row.events.map((event) => event.slug),
    firstSeenAt: row.firstSeenAt,
    liquidity: row.liquidity,
  }
}

/**
 * 求值规则族。
 *
 * `pm_prob_jump` 需要**流动性门槛通过**才会产生 —— 这是 §10 专项 ④ 的核心：
 * 薄市场的"概率跳变"可能只是一次 5 美元的成交。
 */
export function evaluatePmRules(
  input: PmRuleInput,
  config: PmRuleConfig = DEFAULT_PM_RULE_CONFIG,
): readonly PmSignal[] {
  assertPmRuleConfig(config)
  const bucketMs = input.bucketMs ?? 15 * 60_000
  const signals: PmSignal[] = []

  for (const snapshot of input.snapshots) {
    const jump = probJumpSignal(snapshot, input.now, bucketMs, config)
    if (jump !== undefined) signals.push(jump)

    const resolution = resolutionSignal(snapshot, input.now, bucketMs, config)
    if (resolution !== undefined) signals.push(resolution)

    const volume = volumeSpikeSignal(snapshot, input.now, bucketMs, config)
    if (volume !== undefined) signals.push(volume)

    const spread = spreadBlowoutSignal(snapshot, input.now, bucketMs, config)
    if (spread !== undefined) signals.push(spread)
  }

  for (const market of input.newMarkets ?? []) {
    const signal = newMarketSignal(market, input.now, bucketMs, config)
    if (signal !== undefined) signals.push(signal)
  }

  return signals
}

/** 概率跳变（novelty）：必须过流动性门槛 + ≥15min 冷却。 */
function probJumpSignal(
  snapshot: PmAliasSnapshot,
  now: number,
  bucketMs: number,
  config: PmRuleConfig,
): PmSignal | undefined {
  if (!snapshot.probability.ok) return undefined
  // ★ 流动性门槛：不过就一条 novelty 都不发
  if (!snapshot.liquidity.pass) return undefined
  // 窗口显式（与告警 payload 里写的是同一个名字，避免"到底哪个窗口"含糊）
  const change = config.jumpLookback === '24h' ? snapshot.change24h : snapshot.change1h
  if (change === null) return undefined

  const realized = snapshot.absChangeMean
  const dynamicThreshold =
    realized === null
      ? Number.POSITIVE_INFINITY
      : config.probJumpVolMultiple * Math.max(realized, config.volFloor)
  const magnitude = Math.abs(change)
  const crossedAbs = magnitude > config.probJumpAbs
  const crossedVol = magnitude > dynamicThreshold
  if (!crossedAbs && !crossedVol) return undefined

  return {
    ruleId: 'pm_prob_jump',
    alias: snapshot.alias,
    tokenId: snapshot.tokenId,
    purpose: 'novelty',
    severity: NOVELTY_MIN_SEVERITY,
    reason: crossedAbs
      ? `${config.jumpLookback} 概率变化 ${change.toFixed(4)} 超过绝对阈值 ${config.probJumpAbs}`
      : `${config.jumpLookback} 概率变化 ${change.toFixed(4)} 超过已实现波动 ${realized?.toFixed(4) ?? 'n/a'} 的 ${config.probJumpVolMultiple}×`,
    dedupKey: watchDedupKey(snapshot.watchId, snapshot.tokenId, now, bucketMs),
    isTradeTrigger: false,
    payload: {
      alias: snapshot.alias,
      tokenId: snapshot.tokenId,
      lookback: config.jumpLookback,
      change,
      change1h: snapshot.change1h,
      change24h: snapshot.change24h,
      prob: snapshot.probability.value,
      // ★ 估计量随信号一起落库：否则"概率变了"可能只是换了口径（专项 ③）
      estimator: snapshot.probability.estimator,
      liquidity: snapshot.liquidityQuote,
      spread: snapshot.spread,
      absChangeMean: realized,
      cooldownMs: config.probJumpCooldownMs,
    },
  }
}

/** 结算（info）：只落库 + 通知，作为复盘证据。 */
function resolutionSignal(
  snapshot: PmAliasSnapshot,
  now: number,
  bucketMs: number,
  config: PmRuleConfig,
): PmSignal | undefined {
  if (!snapshot.resolved) return undefined
  return {
    ruleId: 'pm_resolution',
    alias: snapshot.alias,
    tokenId: snapshot.tokenId,
    purpose: 'info',
    severity: 'P2',
    reason: `关注市场已结算：${snapshot.winningOutcome ?? '结果未知'}`,
    dedupKey: watchDedupKey(snapshot.watchId, snapshot.tokenId, now, bucketMs),
    isTradeTrigger: false,
    payload: {
      alias: snapshot.alias,
      tokenId: snapshot.tokenId,
      winningOutcome: snapshot.winningOutcome,
      estimator: snapshot.probability.ok ? snapshot.probability.estimator : null,
      cooldownMs: config.resolutionCooldownMs,
    },
  }
}

/** 成交额飙升（info）：volume24h 相对自身中位数的倍数。 */
function volumeSpikeSignal(
  snapshot: PmAliasSnapshot,
  now: number,
  bucketMs: number,
  config: PmRuleConfig,
): PmSignal | undefined {
  if (snapshot.volume24h === null || snapshot.volumeMedian === null || snapshot.volumeMedian <= 0) {
    return undefined
  }
  const ratio = snapshot.volume24h / snapshot.volumeMedian
  if (!(ratio >= config.volumeSpikeMultiple)) return undefined
  return {
    ruleId: 'pm_volume_spike',
    alias: snapshot.alias,
    tokenId: snapshot.tokenId,
    purpose: 'info',
    severity: 'P2',
    reason: `volume24h ${snapshot.volume24h.toFixed(0)} 是中位数 ${snapshot.volumeMedian.toFixed(0)} 的 ${ratio.toFixed(2)}×`,
    dedupKey: watchDedupKey(snapshot.watchId, snapshot.tokenId, now, bucketMs),
    isTradeTrigger: false,
    payload: {
      alias: snapshot.alias,
      tokenId: snapshot.tokenId,
      volume24h: snapshot.volume24h,
      volumeMedian: snapshot.volumeMedian,
      ratio,
      cooldownMs: config.volumeSpikeCooldownMs,
    },
  }
}

/** 点差炸开（info）：同时下调该 alias 的置信度（plan §4.4 表）。 */
function spreadBlowoutSignal(
  snapshot: PmAliasSnapshot,
  now: number,
  bucketMs: number,
  config: PmRuleConfig,
): PmSignal | undefined {
  if (snapshot.spread === null) return undefined
  const spreadBps = snapshot.spread * 10_000
  if (!(spreadBps > config.spreadCeilBps)) return undefined
  return {
    ruleId: 'pm_spread_blowout',
    alias: snapshot.alias,
    tokenId: snapshot.tokenId,
    purpose: 'info',
    severity: 'P2',
    reason: `点差 ${spreadBps.toFixed(1)}bps 超过上限 ${config.spreadCeilBps}bps`,
    dedupKey: watchDedupKey(snapshot.watchId, snapshot.tokenId, now, bucketMs),
    isTradeTrigger: false,
    payload: {
      alias: snapshot.alias,
      tokenId: snapshot.tokenId,
      spreadBps,
      /** 置信度折扣：Event Pack 必须标注，而不是悄悄打折 */
      confidencePenalty: config.spreadConfidencePenalty,
      estimator: snapshot.probability.ok ? snapshot.probability.estimator : null,
      cooldownMs: config.spreadBlowoutCooldownMs,
    },
  }
}

/** 新市场（novelty）：只在白名单事件内产生；白名单为空 ⇒ 一条都不发。 */
function newMarketSignal(
  market: PmNewMarketInput,
  now: number,
  bucketMs: number,
  config: PmRuleConfig,
): PmSignal | undefined {
  if (config.newMarketEventWhitelist.length === 0) return undefined
  const matched = market.eventSlugs.filter((slug) => config.newMarketEventWhitelist.includes(slug))
  if (matched.length === 0) return undefined
  // 薄市场的新市场通知同样要过流动性门槛 —— 否则会变成噪声源
  if (market.liquidity === null || market.liquidity <= 0) return undefined
  return {
    ruleId: 'pm_new_market',
    alias: market.slug,
    tokenId: '',
    purpose: 'novelty',
    severity: NOVELTY_MIN_SEVERITY,
    reason: `白名单事件 ${matched.join(',')} 下出现新市场：${market.slug}`,
    dedupKey: `pm:new:${market.conditionId}`,
    isTradeTrigger: false,
    payload: {
      conditionId: market.conditionId,
      slug: market.slug,
      eventSlugs: matched,
      liquidity: market.liquidity,
      firstSeenAt: market.firstSeenAt,
      // 市场标题是**不可信文本**：按数据注入，不参与授权
      untrustedQuestion: market.question,
      cooldownMs: config.newMarketCooldownMs,
    },
  }
}
