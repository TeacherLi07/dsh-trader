import { computeContentHash, type PlanCard } from '../../src/plan/schema.js'

/** 构造一张**结构合法且 contentHash 自洽**的计划卡（`validatePlanCard` / `PlanStore.save` 都要求）。 */
export function makeCard(over: Partial<PlanCard> = {}): PlanCard {
  const base: Omit<PlanCard, 'contentHash'> = {
    planId: 'pc-btc-1',
    symbol: 'BTC/USDT',
    createdAt: 1_000,
    windowEndsAt: 100_000,
    thesis: '区间下沿做多，失守则离场',
    confidence: 0.5,
    keyLevels: [{ kind: 'support', price: 90 }],
    invalidation: [
      { id: 'inv-1', tf: '15m', when: 'bar.close < 90', then: { action: 'reduce', fraction: 0.5 } },
    ],
    commitments: [
      {
        id: 'c-1',
        seq: 1,
        tf: '15m',
        when: 'bar.close > 110',
        then: { action: 'reduce', fraction: 0.25 },
      },
    ],
    forbidden: [],
    noTrade: false,
    author: 'model',
    authority: 'model',
  }
  const merged = { ...base, ...over } as Omit<PlanCard, 'contentHash'>
  return { ...merged, contentHash: computeContentHash(merged) }
}
