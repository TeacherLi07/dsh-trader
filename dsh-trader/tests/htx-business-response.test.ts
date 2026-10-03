import ccxt from 'ccxt'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { HtxBroker, type CcxtProExchangeLike } from '../src/exec/ccxt-broker.js'

describe('HTX 原始业务错误经过实际 ccxt 解码', () => {
  it.each(['readOnlyBalance', 'getPositions'] as const)('%s 拒绝 HTTP200/code401，不把解码结果当余额或空仓', async (method) => {
    const exchange = new ccxt.htx({ apiKey: 'fixture-key', secret: 'fixture-secret', enableRateLimit: false,
      options: { defaultType: 'swap', adjustForTimeDifference: false } })
    exchange.markets = {}
    exchange.loadMarkets = async () => ({})
    const requests: string[] = []
    // 只替换网络层，保留签名、handleErrors 和 CCXT 原始解析，复现未知业务码被解析为空的故障。
    exchange.fetchImplementation = async (url: string) => {
      requests.push(String(url))
      return new Response(JSON.stringify({ code: 401, message: 'Incorrect IP address [IP地址错误]; fixture-key; fixture-secret' }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const broker = new HtxBroker({ exchange: exchange as unknown as CcxtProExchangeLike,
      clock: new ReplayClock(1_700_000_000_000), venue: 'htx', apiKey: 'fixture-key', apiSecret: 'fixture-secret', accountType: 'swap' })
    try {
      await expect(broker[method]()).rejects.toThrow('Incorrect IP address [IP地址错误]; [REDACTED]; [REDACTED]')
      expect(requests).toHaveLength(method === 'getPositions' ? 2 : 1)
      expect(requests.some(url => url.includes(method === 'readOnlyBalance' ? '/v5/account/balance' : '/v5/trade/position/opens'))).toBe(true)
    } finally { await exchange.close() }
  })
})
