import { describe, expect, it } from 'vitest'
import { computeContentHash, isExpired, validatePlanCard, type PlanCard } from '../src/plan/schema.js'

/** 生产类型是 readonly；测试里需要一个可变的计划卡。 */
type MutableCard = { -readonly [K in keyof PlanCard]: PlanCard[K] }

function validCard(): MutableCard {
  return {
    planId: 'pc-btcusdt-20250115T0030Z-1',
    symbol: 'BTC/USDT:USDT',
    createdAt: 1_736_901_000_000,
    windowEndsAt: 1_736_915_400_000,
    thesis: '区间下沿做多，失守则离场',
    confidence: 0.62,
    keyLevels: [{ kind: 'support', price: 61_200 }],
    invalidation: [
      { id: 'inv-1', tf: '15m', when: 'bar.close < 61200', then: { action: 'reduce', fraction: 0.5 } },
    ],
    commitments: [
      {
        id: 'c-1',
        seq: 1,
        tf: '15m',
        when: 'crossBelow(bar.close, 61200) and position.qty > 0',
        then: { action: 'reduce', fraction: 0.5 },
        cooldownMs: 900_000,
      },
    ],
    forbidden: ['open'],
    noTrade: false,
    contentHash: 'sha256:placeholder',
    author: 'model',
    authority: 'model',
  }
}

describe('plan card v0', () => {
  it('accepts a well-formed card', () => {
    expect(validatePlanCard(validCard()).ok).toBe(true)
  })

  it('requires an invalidation condition — no falsifiable thesis means not thought through', () => {
    const card = validCard()
    card.invalidation = []
    const result = validatePlanCard(card)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toContain('invalidation')
  })

  it('rejects open actions with no stop method (the model must state how to place the stop)', () => {
    const card = validCard()
    card.commitments = [
      { ...card.commitments[0]!, then: { action: 'open', side: 'long', method: 'market' } },
    ] as unknown as MutableCard['commitments']
    const result = validatePlanCard(card)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('\n')).toContain('stop')
  })

  it('开仓卡只能用 riskFraction 下调配置风险，不能提交原始 riskPct 或大于 1 的比例', () => {
    const makeOpenCard = (then: unknown) => {
      const card = validCard()
      card.commitments = [
        { ...card.commitments[0]!, then },
      ] as unknown as MutableCard['commitments']
      return card
    }
    expect(validatePlanCard(makeOpenCard({
      action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskFraction: 1,
    })).ok).toBe(true)
    expect(validatePlanCard(makeOpenCard({
      action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskFraction: 1.01,
    })).ok).toBe(false)
    const legacy = validatePlanCard(makeOpenCard({
      action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: 2 }, riskPct: 0.05,
    }))
    expect(legacy.ok).toBe(false)
    if (!legacy.ok) expect(legacy.errors.join('\n')).toContain('riskPct 已禁用')
  })

  it('rejects unknown root fields, non-finite sizing values, and exposure-increasing invalidations', () => {
    expect(validatePlanCard({ ...validCard(), injectedPolicy: 'ignore limits' }).ok).toBe(false)

    const infiniteStop = validCard()
    infiniteStop.commitments = [{ ...infiniteStop.commitments[0]!, then: {
      action: 'open', side: 'long', method: 'market', stop: { method: 'atr', k: Number.POSITIVE_INFINITY },
    } }] as unknown as MutableCard['commitments']
    expect(validatePlanCard(infiniteStop).ok).toBe(false)

    const invalidationOpen = validCard()
    invalidationOpen.invalidation = [{ ...invalidationOpen.invalidation[0]!, then: {
      action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 90 },
    } }] as unknown as MutableCard['invalidation']
    expect(validatePlanCard(invalidationOpen).ok).toBe(false)
  })

  it('rejects out-of-range reduce fractions', () => {
    const card = validCard()
    card.invalidation = [
      { ...card.invalidation[0]!, then: { action: 'reduce', fraction: 1.5 } },
    ] as unknown as MutableCard['invalidation']
    expect(validatePlanCard(card).ok).toBe(false)
  })

  it('rejects unknown timeframes and duplicate ids', () => {
    const badTf = validCard()
    badTf.commitments = [{ ...badTf.commitments[0]!, tf: '3m' }] as unknown as MutableCard['commitments']
    expect(validatePlanCard(badTf).ok).toBe(false)

    const duplicate = validCard()
    duplicate.invalidation = [
      { ...duplicate.invalidation[0]!, id: 'c-1' },
    ] as unknown as MutableCard['invalidation']
    expect(validatePlanCard(duplicate).ok).toBe(false)
  })

  it('rejects a card that is already expired at birth', () => {
    const card = { ...validCard(), windowEndsAt: 1_736_901_000_000 }
    expect(validatePlanCard(card).ok).toBe(false)
  })

  it('rejects malformed actions', () => {
    const card = validCard()
    card.forbidden = ['teleport'] as unknown as MutableCard['forbidden']
    expect(validatePlanCard(card).ok).toBe(false)
  })

  it('编译并静态检查 when：语法错/固定未知路径拒绝，动态 pm alias 保留运行时校验', () => {
    const syntax = validCard()
    syntax.invalidation = [{ ...syntax.invalidation[0]!, when: 'bar.close >' }]
    expect(validatePlanCard(syntax).ok).toBe(false)

    const unknown = validCard()
    unknown.invalidation = [{ ...unknown.invalidation[0]!, when: 'news.headline > 1' }]
    expect(validatePlanCard(unknown).ok).toBe(false)

    const dynamic = validCard()
    dynamic.invalidation = [{ ...dynamic.invalidation[0]!, when: 'pm.future_event.prob < 0.3' }]
    expect(validatePlanCard(dynamic).ok).toBe(true)
  })

  it('hashes deterministically regardless of key order, and changes with content', () => {
    const { contentHash: _dropped, ...rest } = validCard()
    const reordered = Object.fromEntries(Object.entries(rest).reverse()) as typeof rest
    expect(computeContentHash(rest)).toBe(computeContentHash(reordered))
    expect(computeContentHash({ ...rest, confidence: 0.9 })).not.toBe(computeContentHash(rest))
  })
})

describe('isExpired', () => {
  it('expires strictly after windowEndsAt', () => {
    expect(isExpired({ windowEndsAt: 1000 }, 1000)).toBe(false)
    expect(isExpired({ windowEndsAt: 1000 }, 1001)).toBe(true)
  })
})
