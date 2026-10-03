import { describe, expect, it } from 'vitest'
import { estimateCost, lunaGatewayReferencePrice, LUNA_GATEWAY_MODEL, selectPrice } from '../src/cost.js'

describe('Luna 网关官方参考上界', () => {
  const at = Date.UTC(2026, 9, 3)
  it('按来源 alias 与 any 档位保存，不套用 DeepSeek 峰谷或未报价模型', () => {
    const price = lunaGatewayReferencePrice(at)
    expect(selectPrice([price], LUNA_GATEWAY_MODEL, at)).toEqual(price)
    expect(selectPrice([price], 'deepseek-flash', at)).toBeUndefined()
    expect(selectPrice([price], 'sub2api:unknown', at)).toBeUndefined()
    expect(selectPrice([price], LUNA_GATEWAY_MODEL, at - 1)).toBeUndefined()
    expect(price.source).toContain('invoice unverified')
  })

  it('非空输入/写缓存、缓存读与输出按官方最高适用参考单价预留', () => {
    const usage = { tokensIn: 1000, tokensCached: 200, tokensOut: 100 }
    const cost = estimateCost(usage, [lunaGatewayReferencePrice(at)], LUNA_GATEWAY_MODEL, at)
    expect(cost).toEqual({ known: true, tier: 'any', usd: 800 / 1_000_000 * 0.25 + 200 / 1_000_000 * 0.02 + 100 / 1_000_000 * 0.75 })
    expect(usage.tokensIn).toBeGreaterThan(0)
    expect(usage.tokensOut).toBeGreaterThan(0)
  })

  it.each([-1, NaN, 0.5])('非法生效时点 %s 不能插入参考价', (at) => {
    expect(() => lunaGatewayReferencePrice(at)).toThrow('毫秒整数')
  })
})
