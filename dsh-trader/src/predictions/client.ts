/**
 * Polymarket 只读客户端（plan §4.4 / T1.8）。
 *
 * 三家 API、三条硬纪律：
 *   1. **只读，永不交易**：这里只有 GET，没有任何下单/撤单路径；
 *   2. **令牌桶 + 退避**：取官方限额的 **≤20%**，用排队而不是撞限额；连续失败要**降级**，
 *      降级只影响 pm 自身（返回 `PmUnavailableError`），绝不把异常抛进交易主循环；
 *   3. **PIT 三闸门**：`as_of`（点时刻）**只允许审计重建用** —— 实测约 20s，
 *      进热路径等于把主循环拖死。热路径走 `history`，由 `seriesAsOf` 按 `ts<=now` 过滤。
 *
 * 时间一律**毫秒整数**：源里的秒值必须经 `normalizeSourceSeconds`（拒绝把毫秒当秒）。
 */

import type { Clock } from '../clock.js'
import { bucketFromLimit, type TokenBucket } from '../market/ratelimit.js'
import { normalizeSourceMillis, normalizeSourceSeconds, seriesAsOf, type PmSeriesPoint } from './pit.js'

// ── 端点与限额（plan §4.4 实测表）────────────────────────────────────────────

export const PM_BASES = {
  gamma: 'https://gamma-api.polymarket.com',
  clob: 'https://clob.polymarket.com',
  dataApi: 'https://data-api.polymarket.com',
} as const

export type PmHost = keyof typeof PM_BASES

/**
 * 官方 IP 级限额（每 10s）。Cloudflare 是**排队**而不是拒绝，但排队会拖慢主循环，
 * 所以实际只用其中 20%（`bucketFromLimit` 的 share）。
 */
export const PM_OFFICIAL_LIMITS: Readonly<Record<PmHost, Readonly<Record<string, number>>>> = {
  gamma: { markets: 300, events: 500, 'public-search': 350 },
  clob: { 'prices-history': 1_000, book: 1_500 },
  dataApi: { 'prices-history': 200, trades: 200 },
}

export class PmHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'PmHttpError'
  }
}

/** 降级/不可用：调用方（轮询器）据此发 `info` 并继续，**绝不上抛到交易主循环**。 */
export class PmUnavailableError extends Error {
  constructor(
    message: string,
    readonly consecutiveFailures: number,
  ) {
    super(message)
    this.name = 'PmUnavailableError'
  }
}

/** 热路径碰到 `as_of` 一律拒绝 —— 这是 plan §10 专项验收 ⑦ 的机器化表达。 */
export class PmAsOfInHotPathError extends Error {
  constructor() {
    super('as_of（点时刻）只允许审计重建使用，禁止出现在热路径')
    this.name = 'PmAsOfInHotPathError'
  }
}

// ── 取数端口（可注入 ⇒ 单测不打网络）────────────────────────────────────────

export interface PmResponse {
  readonly status: number
  readonly text: () => Promise<string>
}

export type PmFetchLike = (
  url: string,
  init?: { readonly method?: string; readonly signal?: AbortSignal },
) => Promise<PmResponse>

export interface PmHttpOptions {
  readonly fetch: PmFetchLike
  readonly clock: Clock
  /** 退避等待；注入以便单测不真的 sleep。 */
  readonly sleep: (ms: number) => Promise<void>
  readonly maxRetries?: number
  readonly baseBackoffMs?: number
  readonly timeoutMs?: number
  /** 官方限额的使用比例，默认 0.2（plan §4.4）。 */
  readonly share?: number
  /** 连续失败达到该次数即降级。 */
  readonly degradeAfterFailures?: number
}

export interface PmHttpStats {
  readonly requests: number
  readonly retries: number
  readonly failures: number
  readonly consecutiveFailures: number
  readonly degraded: boolean
  readonly asOfCalls: number
  /** 各桶剩余令牌，便于验收"10s 窗口请求数 ≤ 限额 20%"。 */
  readonly tokens: Readonly<Record<string, number>>
}

function bucketKey(host: PmHost, kind: string): string {
  return `${host}:${kind}`
}

/**
 * 极薄的 HTTP 层：**只有 GET**、令牌桶、指数退避、超时、降级计数。
 * 业务语义（哪些端点、返回什么形状）在三个客户端里。
 */
export class PmHttp {
  readonly #buckets = new Map<string, TokenBucket>()
  #requests = 0
  #retries = 0
  #failures = 0
  #consecutiveFailures = 0
  #degraded = false
  #asOfCalls = 0

  constructor(private readonly options: PmHttpOptions) {}

  get degraded(): boolean {
    return this.#degraded
  }

  stats(): PmHttpStats {
    const tokens: Record<string, number> = {}
    for (const [key, bucket] of this.#buckets) tokens[key] = bucket.tokens()
    return {
      requests: this.#requests,
      retries: this.#retries,
      failures: this.#failures,
      consecutiveFailures: this.#consecutiveFailures,
      degraded: this.#degraded,
      asOfCalls: this.#asOfCalls,
      tokens,
    }
  }

  #bucket(host: PmHost, kind: string): TokenBucket {
    const key = bucketKey(host, kind)
    let bucket = this.#buckets.get(key)
    if (bucket === undefined) {
      const limit = PM_OFFICIAL_LIMITS[host][kind]
      if (limit === undefined) throw new PmHttpError(`未登记的限额：${host}/${kind}`)
      bucket = bucketFromLimit(this.options.clock, limit, this.options.share ?? 0.2)
      this.#buckets.set(key, bucket)
    }
    return bucket
  }

  /**
   * 取 JSON。
   * `hotPath: false` 时才允许传 `asOf`（点时刻）；热路径传了直接抛错。
   */
  async getJson(
    host: PmHost,
    kind: string,
    path: string,
    query: Readonly<Record<string, string | number | undefined>> = {},
    options: { readonly asOf?: number; readonly hotPath?: boolean } = {},
  ): Promise<unknown> {
    if (options.asOf !== undefined) {
      if (options.hotPath !== false) throw new PmAsOfInHotPathError()
      this.#asOfCalls += 1
    }

    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value))
    }
    if (options.asOf !== undefined) params.set('as_of', String(Math.floor(options.asOf / 1000)))
    const suffix = params.toString()
    const url = `${PM_BASES[host]}${path}${suffix === '' ? '' : `?${suffix}`}`

    const bucket = this.#bucket(host, kind)
    const maxRetries = options.asOf === undefined ? (this.options.maxRetries ?? 3) : 1
    const baseBackoffMs = this.options.baseBackoffMs ?? 250
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      // 排队：令牌不足就等，而不是撞限额
      const acquire = bucket.tryAcquire()
      if (!acquire.ok) await this.options.sleep(acquire.waitMs)

      this.#requests += 1
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
      try {
        const response = await this.options.fetch(url, { method: 'GET', signal: controller.signal })
        if (response.status === 429 || response.status >= 500) {
          throw new PmHttpError(`HTTP ${response.status}`, response.status)
        }
        if (response.status === 404) {
          // 端点上"这个资源不存在"是**正常数据状态**（实测：尚无盘口的 token 返回
          // `{"error":"No orderbook exists for the requested token id"}`），
          // 不是服务故障 ⇒ 不能计入降级计数，否则新市场会把客户端打到降级。
          this.#consecutiveFailures = 0
          return null
        }
        if (response.status < 200 || response.status >= 300) {
          // 其它 4xx 是请求本身的问题，重试没有意义
          throw new PmUnavailableError(`HTTP ${response.status}（不重试）`, this.#consecutiveFailures + 1)
        }
        const text = await response.text()
        this.#consecutiveFailures = 0
        this.#degraded = false
        return text === '' ? null : (JSON.parse(text) as unknown)
      } catch (error) {
        lastError = error
        this.#failures += 1
        this.#consecutiveFailures += 1
        const degradeAfter = this.options.degradeAfterFailures ?? 5
        if (this.#consecutiveFailures >= degradeAfter) {
          this.#degraded = true
          throw new PmUnavailableError(
            `连续 ${this.#consecutiveFailures} 次失败，已降级：${String(error)}`,
            this.#consecutiveFailures,
          )
        }
        if (attempt < maxRetries && !(error instanceof PmUnavailableError)) {
          this.#retries += 1
          await this.options.sleep(baseBackoffMs * 2 ** attempt)
          continue
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError instanceof Error ? lastError : new PmHttpError('未知取数失败')
  }
}

// ── Gamma：发现 / 元数据 ─────────────────────────────────────────────────────

export interface PmGammaMarket {
  readonly id: string
  readonly conditionId: string
  readonly slug: string
  readonly question: string
  readonly outcomes: readonly string[]
  readonly clobTokenIds: readonly string[]
  readonly outcomePrices: readonly number[]
  readonly bestBid: number | null
  readonly bestAsk: number | null
  readonly spread: number | null
  readonly volume24hr: number | null
  readonly liquidity: number | null
  readonly createdAt: number
  readonly endDate: number | null
  readonly closed: boolean
  readonly negRisk: boolean
  /** 所属事件（tags 挂在事件上，`/markets` 不返回顶层 tags）。 */
  readonly events: readonly { readonly id: string; readonly slug: string; readonly title: string }[]
  readonly lastTradePrice: number | null
  /**
   * 源自己给出的变化量（概率单位）。用来**挑选"真的动过"的样本**，
   * 不参与决策计算 —— 决策侧仍以我们自己的序列为准（口径必须单一）。
   */
  readonly oneDayPriceChange: number | null
  readonly oneWeekPriceChange: number | null
  /** 市场创建者书写的文本 ⇒ **不可信输入**，只当数据、绝不参与工具授权。 */
  readonly untrustedText: { readonly question: string; readonly description: string | null }
  readonly lifecycle: { readonly resolved: boolean; readonly winningOutcome: string | null }
}

export interface PmPage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}

interface RawGammaMarket {
  id?: string
  conditionId?: string
  slug?: string
  question?: string
  description?: string
  outcomes?: unknown
  clobTokenIds?: unknown
  outcomePrices?: unknown
  // ⚠️ 实测：Gamma 把数值型字段以**字符串**返回（`liquidity: "904179.3825"`），
  // 因此这里必须按 unknown 收再做数值归一；只认 number 会让流动性永远是 null。
  bestBid?: unknown
  bestAsk?: unknown
  spread?: unknown
  lastTradePrice?: unknown
  oneDayPriceChange?: unknown
  oneWeekPriceChange?: unknown
  volume24hr?: unknown
  volume24hrClob?: unknown
  volumeNum?: unknown
  liquidity?: unknown
  liquidityNum?: unknown
  createdAt?: string
  endDate?: string
  closed?: boolean
  negRisk?: boolean
  umaResolutionStatus?: string
  winner?: string
  events?: unknown
}

/**
 * 数值归一：接受 number 与**数字字符串**（Gamma 实测混用）。
 * 不可解析返回 `null` —— 绝不返回 0：0 会让流动性门槛"通过得莫名其妙"。
 * 优先取厂商提供的 `*Num` 数值字段。
 */
function numeric(...candidates: readonly unknown[]): number | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      const parsed = Number(candidate)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function parseStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

function parseNumberArray(value: unknown): readonly number[] {
  return parseStringArray(value).flatMap((item) => {
    const parsed = Number(item)
    return Number.isFinite(parsed) ? [parsed] : []
  })
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function normalizeGammaMarket(raw: RawGammaMarket): PmGammaMarket {
  const outcomes = parseStringArray(raw.outcomes)
  const winner = typeof raw.winner === 'string' && raw.winner !== '' ? raw.winner : null
  return {
    id: String(raw.id ?? raw.conditionId ?? raw.slug ?? ''),
    conditionId: String(raw.conditionId ?? ''),
    slug: String(raw.slug ?? ''),
    question: String(raw.question ?? ''),
    outcomes,
    clobTokenIds: parseStringArray(raw.clobTokenIds),
    outcomePrices: parseNumberArray(raw.outcomePrices),
    bestBid: numeric(raw.bestBid),
    bestAsk: numeric(raw.bestAsk),
    spread: numeric(raw.spread),
    lastTradePrice: numeric(raw.lastTradePrice),
    oneDayPriceChange: numeric(raw.oneDayPriceChange),
    oneWeekPriceChange: numeric(raw.oneWeekPriceChange),
    volume24hr: numeric(raw.volumeNum, raw.volume24hrClob, raw.volume24hr),
    liquidity: numeric(raw.liquidityNum, raw.liquidity),
    // 缺失的时间戳退化到 0（= 远古）而不是 now：宁可不引用，也不要"看起来刚创建"
    createdAt: parseTime(raw.createdAt) ?? 0,
    endDate: parseTime(raw.endDate),
    closed: raw.closed === true,
    negRisk: raw.negRisk === true,
    events: Array.isArray(raw.events)
      ? raw.events.flatMap((item) => {
          if (typeof item !== 'object' || item === null) return []
          const event = item as Record<string, unknown>
          return [
            {
              id: String(event.id ?? ''),
              slug: String(event.slug ?? ''),
              title: String(event.title ?? ''),
            },
          ]
        })
      : [],
    untrustedText: {
      question: String(raw.question ?? ''),
      description: typeof raw.description === 'string' ? raw.description : null,
    },
    lifecycle: {
      resolved: raw.closed === true || raw.umaResolutionStatus === 'resolved',
      winningOutcome: winner,
    },
  }
}

/** 实测可用的排序字段（`/markets?order=…`）。 */
export const GAMMA_ORDERS = ['startDate', 'volume24hr', 'oneDayPriceChange', 'liquidity'] as const
export type GammaOrder = (typeof GAMMA_ORDERS)[number]

export interface GammaListOptions {
  readonly limit?: number
  readonly tag?: string
  /** `startDate` 倒序 —— 用于"发现新市场"。 */
  readonly newestFirst?: boolean
  /** 按哪个字段排序；`oneDayPriceChange` 倒序 = "今天真的动过的市场"。 */
  readonly order?: GammaOrder
  readonly ascending?: boolean
  readonly cursor?: string
  readonly closed?: boolean
}

export class GammaClient {
  constructor(private readonly http: PmHttp) {}

  async marketsAsOf(_now: number): Promise<never> {
    // 明确不提供"点时刻市场清单"：v2 `as_of` 是审计专用（20s 级），热路径必须用 /markets 实时
    throw new PmAsOfInHotPathError()
  }

  async markets(options: GammaListOptions = {}): Promise<PmPage<PmGammaMarket>> {
    const order = options.order ?? (options.newestFirst === true ? 'startDate' : undefined)
    const body = await this.http.getJson('gamma', 'markets', '/markets', {
      limit: options.limit ?? 100,
      ...(options.tag === undefined ? {} : { tag_id: options.tag }),
      ...(order === undefined ? {} : { order, ascending: options.ascending === true ? 'true' : 'false' }),
      ...(options.closed === undefined ? {} : { closed: String(options.closed) }),
      ...(options.cursor === undefined ? {} : { after_cursor: options.cursor }),
    })
    return pageOf(body, normalizeGammaMarket)
  }

  async publicSearch(query: string, limit = 20): Promise<readonly PmGammaMarket[]> {
    const body = await this.http.getJson('gamma', 'public-search', '/public-search', {
      q: query,
      limit_per_type: limit,
    })
    return Array.isArray(body) ? (body as RawGammaMarket[]).map(normalizeGammaMarket) : []
  }
}

function pageOf<T>(body: unknown, map: (raw: never) => T): PmPage<T> {
  if (Array.isArray(body)) return { items: (body as never[]).map(map), nextCursor: null }
  const record = (body ?? {}) as Record<string, unknown>
  const items = Array.isArray(record.data) ? (record.data as never[]).map(map) : []
  const cursor = record.next_cursor
  return { items, nextCursor: typeof cursor === 'string' ? cursor : null }
}

// ── CLOB：盘口 / 价格 / 历史 ─────────────────────────────────────────────────

export interface PmBook {
  readonly tokenId: string
  readonly bids: readonly { readonly price: number; readonly size: number }[]
  readonly asks: readonly { readonly price: number; readonly size: number }[]
  readonly tickSize: number | null
  readonly minOrderSize: number | null
  readonly negRisk: boolean
  /** 源时间戳（归一为毫秒）。 */
  readonly observedAt: number
  readonly hash: string | null
}

function level(value: unknown): { price: number; size: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const price = Number(record.price)
  const size = Number(record.size)
  return Number.isFinite(price) && Number.isFinite(size) ? { price, size } : null
}

export class ClobClient {
  constructor(private readonly http: PmHttp) {}

  /** 返回 `null` 表示该 token **尚无盘口**（实测新市场如此），不是错误。 */
  async book(tokenId: string): Promise<PmBook | null> {
    const body = await this.http.getJson('clob', 'book', '/book', { token_id: tokenId })
    if (body === null) return null
    const record = body as Record<string, unknown>
    return {
      tokenId: String(record.asset_id ?? tokenId),
      bids: (Array.isArray(record.bids) ? record.bids : []).flatMap((item) => level(item) ?? []),
      asks: (Array.isArray(record.asks) ? record.asks : []).flatMap((item) => level(item) ?? []),
      tickSize: Number.isFinite(Number(record.tick_size)) ? Number(record.tick_size) : null,
      minOrderSize: Number.isFinite(Number(record.min_order_size)) ? Number(record.min_order_size) : null,
      negRisk: record.neg_risk === true,
      // ⚠️ book 的 timestamp 是**毫秒**（实测 1789399859695），与 history 的秒不同
      observedAt: normalizeSourceMillis(Number(record.timestamp)),
      hash: typeof record.hash === 'string' ? record.hash : null,
    }
  }

  /**
   * v1 历史：`{history:[{t,p}]}`，`t` 是**秒**、`fidelity` 单位是**分钟**。
   * `interval` 走白名单 —— 实测 `1h` 返回 0 行、`max` 超时（plan §4.4）。
   */
  async pricesHistory(options: {
    /** ⚠️ 是 **token id**，不是 `conditionId`（实测传 conditionId 会返回**空** history，静默骗人）。 */
    readonly tokenId: string
    readonly interval: PmInterval
    readonly fidelityMinutes?: number
  }): Promise<readonly PmSeriesPoint[]> {
    assertTokenId(options.tokenId, 'clob.pricesHistory')
    const body = await this.http.getJson(
      'clob',
      'prices-history',
      '/prices-history',
      { market: options.tokenId, interval: options.interval, fidelity: options.fidelityMinutes ?? 60 },
      { hotPath: true },
    )
    const record = (body ?? {}) as Record<string, unknown>
    const history = Array.isArray(record.history) ? record.history : []
    return history.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const point = item as Record<string, unknown>
      const ts = Number(point.t)
      const price = Number(point.p)
      if (!Number.isFinite(ts) || !Number.isFinite(price)) return []
      return [{ ts: normalizeSourceSeconds(ts), price }]
    })
  }
}

/**
 * 实测可用的取值白名单：
 *   · v1 `1d`/`1w` 可用；`1h` 返回 0 行；
 *   · v2 `1d`=1442 点/1 天、`1w`=2013 点/7 天、**`1m`=1441 点/30 天**（2026-09-14 实测，
 *     30 天覆盖是 PIT 回放需要的）；
 *   · `max` 行为**不一致**：plan §4.4 记的是"超时"，本次实测对某 token 返回 248 点/3 个月
 *     （分辨率很粗）⇒ 不放进白名单，需要时单独验证。
 * 禁止未验证取值：拿不到数据与"概率没变"在数据上无法区分。
 */
export const PM_INTERVALS = ['1d', '1w', '1m'] as const
export type PmInterval = (typeof PM_INTERVALS)[number]

// ── Data API v2：历史（含点时刻，仅审计）────────────────────────────────────

/**
 * v1/v2 的 `market`/`token_id` 都必须是 **CLOB token id**（十进制大整数）。
 * 传 `conditionId`（`0x…`）会返回**空序列而不是报错** —— 这种静默空值会让
 * "概率没变"和"我们查错了东西"看起来一样，所以这里直接拒。
 */
function assertTokenId(tokenId: string, where: string): void {
  if (!/^\d+$/.test(tokenId)) {
    throw new PmHttpError(`${where}：token_id 必须是十进制 token id，收到 ${JSON.stringify(tokenId)}（conditionId 会静默返回空序列）`)
  }
}

export class DataApiClient {
  constructor(private readonly http: PmHttp) {}

  /** 热路径可用的历史序列（不带 `as_of`）。 */
  async pricesHistory(options: {
    readonly tokenId: string
    readonly interval?: PmInterval
    readonly bucketSeconds?: number
  }): Promise<readonly PmSeriesPoint[]> {
    assertTokenId(options.tokenId, 'dataApi.pricesHistory')
    const body = await this.http.getJson(
      'dataApi',
      'prices-history',
      '/v2/prices-history',
      {
        token_id: options.tokenId,
        ...(options.interval === undefined ? {} : { interval: options.interval }),
        ...(options.bucketSeconds === undefined ? {} : { bucket_seconds: options.bucketSeconds }),
      },
      { hotPath: true },
    )
    return readV2Series(body)
  }

  /**
   * **审计重建专用**的点时刻序列。实测约 20s ⇒
   * 必须显式传 `hotPath: false`，任何热路径调用都会抛 `PmAsOfInHotPathError`。
   */
  async pricesHistoryAsOf(options: {
    readonly tokenId: string
    readonly asOf: number
    readonly bucketSeconds?: number
  }): Promise<readonly PmSeriesPoint[]> {
    assertTokenId(options.tokenId, 'dataApi.pricesHistoryAsOf')
    const body = await this.http.getJson(
      'dataApi',
      'prices-history',
      '/v2/prices-history',
      {
        token_id: options.tokenId,
        ...(options.bucketSeconds === undefined ? {} : { bucket_seconds: options.bucketSeconds }),
      },
      { asOf: options.asOf, hotPath: false },
    )
    return readV2Series(body)
  }
}

function readV2Series(body: unknown): readonly PmSeriesPoint[] {
  const record = (body ?? {}) as Record<string, unknown>
  const data = Array.isArray(record.data) ? record.data : []
  return data.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return []
    const point = item as Record<string, unknown>
    const ts = Number(point.timestamp)
    const price = Number(point.price)
    if (!Number.isFinite(ts) || !Number.isFinite(price)) return []
    return [{ ts: normalizeSourceSeconds(ts), price }]
  })
}

/** 把序列按 PIT 序列闸门（`ts <= now`）截断 —— 热路径取数后必须过这一道。 */
export function seriesUpTo(points: readonly PmSeriesPoint[], now: number): readonly PmSeriesPoint[] {
  return seriesAsOf(points, now)
}

// ── 门面 ─────────────────────────────────────────────────────────────────────

export class PmClients {
  readonly gamma: GammaClient
  readonly clob: ClobClient
  readonly dataApi: DataApiClient

  constructor(readonly http: PmHttp) {
    this.gamma = new GammaClient(http)
    this.clob = new ClobClient(http)
    this.dataApi = new DataApiClient(http)
  }

  get degraded(): boolean {
    return this.http.degraded
  }

  stats(): PmHttpStats {
    return this.http.stats()
  }
}

export function createPmClients(options: PmHttpOptions): PmClients {
  return new PmClients(new PmHttp(options))
}
