import { expect, it } from 'vitest'
import { lunaGatewayReferencePrice } from '../src/cost.js'
// 验收入口是纯 ESM JavaScript，与其它配置探针同样经动态 URL 导入。
const { referenceProbeCost } = await import(new URL('../scripts/model-connection-config.mjs', import.meta.url).href)

it('探针输出校验失败仍核算非空权威 usage；无终态请求继续保留上界预留', () => {
  const price = lunaGatewayReferencePrice(1)
  const result = referenceProbeCost([{ usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 } }],
    [{ upperUsd: .01 }, { upperUsd: .02 }], price, 'sub2api:gpt-6-luna', 1)
  expect(result.knownUsageCalls).toBe(1)
  expect(result.referenceEstimateUsd).toBeGreaterThan(0)
  expect(result.unresolvedUpperReservationUsd).toBe(.02)
})
it('无权威 usage 不能将未知预留核销为零，两个终态的读写缓存只记一次', () => {
  const price = lunaGatewayReferencePrice(1), reservations = [{ upperUsd: .01 }, { upperUsd: .02 }]
  expect(referenceProbeCost([], reservations, price, 'sub2api:gpt-6-luna', 1).unresolvedUpperReservationUsd).toBe(.03)
  const rounds = Array(2).fill({ usage: { inputTokens: 1000, cacheReadTokens: 100, cacheWriteTokens: 200, outputTokens: 100, totalTokens: 1400 } })
  const result = referenceProbeCost(rounds, reservations, price, 'sub2api:gpt-6-luna', 1)
  expect(result.knownUsageCalls).toBe(2)
  expect(result.referenceEstimateUsd).toBeCloseTo(2 * (1200 * .25 + 100 * .02 + 100 * .75) / 1_000_000)
  expect(result.unresolvedUpperReservationUsd).toBe(0)
})
