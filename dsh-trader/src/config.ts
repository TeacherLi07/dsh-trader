/**
 * 运行模式、风控限额与启动参数。
 *
 * 规则（plan.md §14.3）：
 *   · 风控参数是**运行时输入**，不是代码常量，也不是配置默认值；
 *   · **缺省即拒绝启动** —— 系统不替用户猜一个"安全的数"，那会制造虚假安全感；
 *   · 用户可**显式放弃**（一等公民路径），但放弃必须留痕、持续可见、且可随时补上；
 *   · 放弃风控**不等于**放弃安全机制：幂等、对账、心跳熔断不随风控参数一起消失（§6.3）。
 */

export type RunMode = 'paper' | 'live_confirm' | 'live_auto'

export const RUN_MODES = ['paper', 'live_confirm', 'live_auto'] as const

/** 硬闸读取的全部阈值；`null` 表示用户显式放弃了风控参数。 */
export interface RiskLimits {
  readonly perOrderCapUsd: number
  readonly maxExposureUsd: number
  readonly maxLeverage: number
  readonly dailyLossLimitUsd: number
  readonly maxDrawdownUsd: number
  readonly maxConsecutiveLosses: number
  readonly maxSpreadBps: number
  readonly maxOpenOrders: number
}

export interface StartupParams {
  readonly mode: RunMode
  /** 单笔风险占总权益比例，例如 0.01 = 1%。0 仅在有 waiver 时合法。 */
  readonly riskPct: number
  readonly symbols: readonly string[]
  /** 结算基准（crypto 用 BTC/ETH，绝不用 SPY）。 */
  readonly benchmark: string
  readonly limits: RiskLimits | null
  /** true = 用户明确知悉后果后放弃风控参数，风险自负。必须写进审计与启动摘要。 */
  readonly waiver: boolean
  readonly decidedAt: number
}

export interface StartupParamsInput {
  mode?: RunMode
  riskPct?: number
  symbols?: readonly string[]
  benchmark?: string
  limits?: Partial<RiskLimits>
  waiver?: boolean
  decidedAt?: number
  /** 账户报价币种权益；传入后才启用启动期自洽校验，省略以保持旧调用方行为。 */
  equityQuoteUsd?: number
  /** 最小止损距离的小数比例；用于自洽校验，省略时采用 BTC 1h 2×ATR 的实测中位值 0.005。 */
  minStopDistancePct?: number
}

export class StartupParamsError extends Error {
  readonly errors: readonly string[]
  constructor(errors: readonly string[]) {
    super(`启动参数不完整，拒绝启动：\n- ${errors.join('\n- ')}`)
    this.name = 'StartupParamsError'
    this.errors = errors
  }
}

/** **示例，非建议**；系统不替用户猜一个安全的数，也不会把示例静默套用。 */
export const EXAMPLE_LIMITS: RiskLimits = Object.freeze({
  perOrderCapUsd: 200,
  maxExposureUsd: 2000,
  maxLeverage: 2,
  dailyLossLimitUsd: 100,
  maxDrawdownUsd: 300,
  maxConsecutiveLosses: 4,
  maxSpreadBps: 25,
  maxOpenOrders: 10,
})

const LIMIT_KEYS: readonly (keyof RiskLimits)[] = [
  'perOrderCapUsd',
  'maxExposureUsd',
  'maxLeverage',
  'dailyLossLimitUsd',
  'maxDrawdownUsd',
  'maxConsecutiveLosses',
  'maxSpreadBps',
  'maxOpenOrders',
]

function positive(value: unknown, label: string, errors: string[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${label} 必须是有限正数，收到 ${JSON.stringify(value)}`)
  }
}

const DEFAULT_MIN_STOP_DISTANCE_PCT = 0.005

export interface LimitsConsistencyInput {
  /** 账户报价币种权益；用于判断最小止损下的理论名义金额。 */
  readonly equityQuoteUsd: number
  /** 单笔风险占权益比例；使用小数比例，例如 0.01 表示 1%。 */
  readonly riskPct: number
  /** 硬闸允许的单笔最大名义金额。 */
  readonly perOrderCapUsd: number
  /** 止损距离是小数比例；省略时使用 BTC 1h 2×ATR 的实测中位值。 */
  readonly minStopDistancePct?: number
}

function displayValue(value: unknown): string {
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN'
  return String(value)
}

/**
 * 检查权益、风险比例、止损距离与单笔上限是否能互相容纳，避免每单都在硬闸处失败。
 * 返回 null 表示自洽；所有数值先校验再计算，避免把 NaN 传播到启动错误或审计信息中。
 */
export function checkLimitsConsistency(input: LimitsConsistencyInput): string | null {
  const minStopDistancePct = input.minStopDistancePct === undefined
    ? DEFAULT_MIN_STOP_DISTANCE_PCT
    : input.minStopDistancePct
  const values: readonly [string, unknown][] = [
    ['equityQuoteUsd', input.equityQuoteUsd],
    ['riskPct', input.riskPct],
    ['perOrderCapUsd', input.perOrderCapUsd],
    ['minStopDistancePct', minStopDistancePct],
  ]

  for (const [label, value] of values) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return `风控自洽校验输入非法：${label} 必须是有限正数，收到 ${displayValue(value)}`
    }
  }

  const maxNotionalAtMinStop = input.equityQuoteUsd * input.riskPct / minStopDistancePct
  if (!Number.isFinite(maxNotionalAtMinStop)) {
    return '风控自洽校验结果非法：maxNotionalAtMinStop 无法表示为有限数，请调整输入规模'
  }
  if (input.perOrderCapUsd < maxNotionalAtMinStop) {
    return `风控参数不自洽：maxNotionalAtMinStop=${maxNotionalAtMinStop} USD（equityQuoteUsd=${input.equityQuoteUsd} × riskPct=${input.riskPct} ÷ minStopDistancePct=${minStopDistancePct}）超过 perOrderCapUsd=${input.perOrderCapUsd} USD；可选修法：调低 riskPct 或调高 perOrderCapUsd。实测 riskPct=1% 时 180 次命中全部被拒，名义约为权益的 2 倍，riskPct=0.2% 才成交。`
  }
  return null
}

/**
 * 启动期的风控自洽校验入口（plan §12 #17）。
 *
 * `paper` 模式权益已知（`paperInitialEquityQuote`）⇒ **启动即校验、不自洽就拒绝启动**；
 * `live*` 模式的权益要等首次 `getAccount()`（券商侧真值），启动时无从得知 ⇒ 这里返回 null，
 * 由 `live-engine` 在首次读到账户后做一次性校验并落审计（见 `limits_inconsistent`）。
 *
 * 为什么必须做：配置不自洽时，每一单都会在硬闸的 `perOrderCapUsd` 处被打回 ——
 * 系统"看起来在跑"，实际永远不成交。让它在启动时大声失败，比让它安静地空转好。
 */
export function startupLimitsError(input: {
  readonly mode: RunMode
  readonly equityQuoteUsd: number
  readonly riskPct: number
  readonly perOrderCapUsd: number
}): string | null {
  if (input.mode !== 'paper') return null
  return checkLimitsConsistency(input)
}

/**
 * 解析启动参数：缺省即抛 `StartupParamsError`；仅当 `waiver === true` 时返回受限参数集。
 * `now` 由注入的 Clock 提供，便于回放与测试。
 */
export function resolveStartupParams(input: StartupParamsInput, now: number): StartupParams {
  const decidedAt = input.decidedAt ?? now

  if (input.waiver === true) {
    return Object.freeze({
      mode: input.mode ?? 'paper',
      riskPct: input.riskPct ?? 0,
      symbols: Object.freeze([...(input.symbols ?? [])]),
      benchmark: input.benchmark ?? 'BTC/USDT:USDT',
      limits: null,
      waiver: true,
      decidedAt,
    })
  }

  const errors: string[] = []

  if (input.mode === undefined) {
    errors.push('mode 未提供（paper | live_confirm | live_auto）')
  } else if (!RUN_MODES.includes(input.mode)) {
    errors.push(`mode 非法：${String(input.mode)}`)
  }

  if (input.riskPct === undefined) {
    errors.push('riskPct 未提供（单笔风险占总权益比例，建议 0.005–0.02）')
  } else if (
    typeof input.riskPct !== 'number' ||
    !Number.isFinite(input.riskPct) ||
    input.riskPct <= 0 ||
    input.riskPct > 0.05
  ) {
    errors.push(`riskPct 必须在 (0, 0.05] 内，收到 ${JSON.stringify(input.riskPct)}`)
  }

  if (input.symbols === undefined || input.symbols.length === 0) {
    errors.push('symbols 未提供（标的范围，至少一个）')
  }

  if (input.benchmark === undefined) errors.push('benchmark 未提供（建议 BTC/USDT:USDT）')

  const limits = input.limits
  if (limits === undefined) {
    errors.push('limits 未提供（如需放弃风控，必须显式传 waiver: true）')
  } else {
    for (const key of LIMIT_KEYS) {
      const value = limits[key]
      if (value === undefined) errors.push(`limits.${key} 未提供`)
      else positive(value, `limits.${key}`, errors)
    }
  }

  if (input.equityQuoteUsd !== undefined) {
    const consistencyError = checkLimitsConsistency({
      equityQuoteUsd: input.equityQuoteUsd,
      riskPct: input.riskPct ?? Number.NaN,
      perOrderCapUsd: limits?.perOrderCapUsd ?? Number.NaN,
      minStopDistancePct: input.minStopDistancePct,
    })
    if (consistencyError !== null) errors.push(consistencyError)
  }

  if (errors.length > 0) throw new StartupParamsError(errors)

  return Object.freeze({
    mode: input.mode as RunMode,
    riskPct: input.riskPct as number,
    symbols: Object.freeze([...(input.symbols as readonly string[])]),
    benchmark: input.benchmark as string,
    limits: Object.freeze({ ...(limits as RiskLimits) }),
    waiver: false,
    decidedAt,
  })
}

/** 启动摘要：必须显式回显"当前无风控"，避免用户忘记自己关掉了它（plan §14.3）。 */
export function describeStartup(params: StartupParams): readonly string[] {
  const lines = [
    `模式：${params.mode}`,
    `标的：${params.symbols.length > 0 ? params.symbols.join(', ') : '（未限定）'}`,
    `基准：${params.benchmark}`,
  ]
  if (params.waiver || params.limits === null) {
    lines.push('⚠️ 风控参数已放弃（用户显式选择，风险自负）—— 幂等/对账/心跳熔断仍然生效')
  } else {
    lines.push(`单笔风险：${(params.riskPct * 100).toFixed(2)}%`)
    for (const key of LIMIT_KEYS) lines.push(`${key}：${params.limits[key]}`)
  }
  return lines
}
