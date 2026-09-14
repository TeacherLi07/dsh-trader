import type { MarketDataSource, RawCandle } from '../../src/market/types.js'

export interface FakeSourceOptions {
  /** 依次返回的页；用完后返回空数组。 */
  readonly pages?: readonly (readonly RawCandle[])[]
  /** 非 undefined 时每次调用都抛出它。 */
  readonly error?: unknown
  readonly id?: string
  readonly watchOHLCV?: boolean
}

export interface SourceCall {
  readonly symbol: string
  readonly timeframe: string
  readonly since: number | undefined
  readonly limit: number | undefined
}

export class FakeSource implements MarketDataSource {
  readonly calls: SourceCall[] = []
  #index = 0

  constructor(private readonly options: FakeSourceOptions = {}) {}

  get id(): string {
    return this.options.id ?? 'fake'
  }

  get capabilities(): { readonly watchOHLCV: boolean } {
    return { watchOHLCV: this.options.watchOHLCV ?? false }
  }

  async fetchOHLCV(
    symbol: string,
    timeframe: string,
    since?: number,
    limit?: number,
  ): Promise<readonly RawCandle[]> {
    this.calls.push({ symbol, timeframe, since, limit })
    if (this.options.error !== undefined) throw this.options.error
    const pages = this.options.pages ?? []
    const page = pages[this.#index]
    this.#index += 1
    return page ?? []
  }
}

/** 构造一根自洽的 K 线（high ≥ open/close ≥ low，volume ≥ 0）。 */
export function raw(openTime: number, close = 100, over: Partial<RawCandle> = {}): RawCandle {
  return { openTime, open: close - 1, high: close + 1, low: close - 2, close, volume: 10, ...over }
}

/** 生成连续 n 根 1h K 线。 */
export function series(startOpenTime: number, count: number, stepMs = 3_600_000): RawCandle[] {
  return Array.from({ length: count }, (_, i) => raw(startOpenTime + i * stepMs, 100 + i))
}
