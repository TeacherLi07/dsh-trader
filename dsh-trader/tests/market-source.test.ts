import { describe, expect, it } from 'vitest'
import {
  applyProxyAwareFetch,
  createCcxtSource,
  toRawCandle,
  type CcxtExchangeLike,
} from '../src/market/ccxt-source.js'
import { MarketSourceError, classifyError } from '../src/market/types.js'

describe('classifyError', () => {
  it('classifies by behaviour, not by provider', () => {
    expect(classifyError(Object.assign(new Error('x'), { name: 'RateLimitExceeded' }))).toBe('rate_limit')
    expect(classifyError(Object.assign(new Error('x'), { name: 'DDoSProtection' }))).toBe('rate_limit')
    expect(classifyError(new Error('Too many requests'))).toBe('rate_limit')
    expect(classifyError(Object.assign(new Error('x'), { name: 'BadSymbol' }))).toBe('no_data')
    expect(classifyError(new Error('does not have market symbol BTC/USDT'))).toBe('no_data')
    expect(classifyError(Object.assign(new Error('x'), { name: 'AuthenticationError' }))).toBe(
      'not_configured',
    )
    expect(classifyError(new Error('socket hang up'))).toBe('other')
    expect(classifyError('not even an error')).toBe('other')
    expect(classifyError(undefined)).toBe('other')
  })
})

describe('toRawCandle', () => {
  it('accepts numeric rows and numeric strings', () => {
    const expected = { openTime: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }
    expect(toRawCandle([1000, 1, 2, 0.5, 1.5, 10])).toEqual(expected)
    expect(toRawCandle(['1000', '1', '2', '0.5', '1.5', '10'])).toEqual(expected)
    expect(toRawCandle([1000, 1, 2, 0.5, 1.5, 10, 'ignored-extra'])).toEqual(expected)
  })

  it('rejects short, non-array, or non-finite rows', () => {
    expect(toRawCandle([1, 2, 3])).toBeUndefined()
    expect(toRawCandle([1000, 1, 2, 0.5, Number.NaN, 10])).toBeUndefined()
    expect(toRawCandle([1000, 1, 2, 0.5, '', 10])).toBeUndefined()
    expect(toRawCandle('nope')).toBeUndefined()
    expect(toRawCandle(null)).toBeUndefined()
  })
})

class FakeExchange implements CcxtExchangeLike {
  readonly id = 'htx'
  readonly has: Record<string, unknown> = { fetchOHLCV: true }
  readonly rateLimit = 100
  fetchImplementation?: unknown
  loads = 0
  closed = false
  error: unknown
  rows: readonly unknown[] = [
    [1000, 1, 2, 0.5, 1.5, 10],
    'garbage',
    [2000, 1, 2, 0.5, 1.5, 11],
  ]

  async loadMarkets(): Promise<unknown> {
    this.loads += 1
    return {}
  }

  async fetchOHLCV(): Promise<readonly unknown[]> {
    if (this.error !== undefined) throw this.error
    return this.rows
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

describe('createCcxtSource', () => {
  it('does not claim WebSocket capability that free ccxt lacks', () => {
    const exchange = new FakeExchange()
    expect(createCcxtSource(exchange).capabilities.watchOHLCV).toBe(false)
    exchange.has['watchOHLCV'] = true
    expect(createCcxtSource(exchange).capabilities.watchOHLCV).toBe(true)
  })

  it('loads markets once and drops malformed rows', async () => {
    const exchange = new FakeExchange()
    const source = createCcxtSource(exchange)

    const first = await source.fetchOHLCV('BTC/USDT', '1h', 0, 100)
    const second = await source.fetchOHLCV('BTC/USDT', '1h', 0, 100)

    expect(exchange.loads).toBe(1)
    expect(first).toHaveLength(2)
    expect(first[0]).toEqual({ openTime: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })
    expect(second).toHaveLength(2)
    expect(source.id).toBe('htx')
  })

  it('wraps provider errors as a behavioural MarketSourceError', async () => {
    const exchange = new FakeExchange()
    exchange.error = Object.assign(new Error('429 Too Many Requests'), { name: 'RateLimitExceeded' })
    const source = createCcxtSource(exchange)

    await expect(source.fetchOHLCV('BTC/USDT', '1h')).rejects.toThrow(MarketSourceError)
    try {
      await source.fetchOHLCV('BTC/USDT', '1h')
    } catch (error) {
      expect((error as MarketSourceError).kind).toBe('rate_limit')
      expect((error as MarketSourceError).message).toContain('htx fetchOHLCV')
    }
  })

  it('delegates close', async () => {
    const exchange = new FakeExchange()
    await createCcxtSource(exchange).close?.()
    expect(exchange.closed).toBe(true)
  })
})

describe('applyProxyAwareFetch', () => {
  it('injects the given fetch implementation into the exchange', () => {
    const exchange = new FakeExchange()
    const impl = (() => Promise.resolve(new Response('{}'))) as unknown as typeof fetch
    applyProxyAwareFetch(exchange, impl)
    expect(exchange.fetchImplementation).toBe(impl)
  })

  it('defaults to the Node global fetch (the one that honours HTTP(S)_PROXY)', () => {
    const exchange = new FakeExchange()
    applyProxyAwareFetch(exchange)
    expect(exchange.fetchImplementation).toBe(globalThis.fetch)
  })

  it('refuses a non-function instead of silently leaving ccxt on the proxy-blind path', () => {
    const exchange = new FakeExchange()
    expect(() => applyProxyAwareFetch(exchange, null)).toThrow(MarketSourceError)
    expect(() => applyProxyAwareFetch(exchange, 'nope')).toThrow(MarketSourceError)
    expect(exchange.fetchImplementation).toBeUndefined()
  })
})

describe('classifyError：保留已分类的行为标签（审计修复）', () => {
  it('★ MarketSourceError.kind 不再被消息文本覆盖成 other', () => {
    for (const kind of ['no_data', 'rate_limit', 'not_configured', 'other'] as const) {
      // 中文消息里没有 "rate limit"/"not configured" 等关键词，旧实现一律降级为 other
      expect(classifyError(new MarketSourceError(kind, '不支持的时间框架：3m'))).toBe(kind)
    }
  })
})
