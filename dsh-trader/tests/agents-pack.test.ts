import { describe, expect, it } from 'vitest'
import {
  PackMismatchError,
  assertPackIntegrity,
  collectOpenDisagreements,
  detectFactConflicts,
  freezeContextPack,
} from '../src/agents/pack.js'
import type { AnalystReport, JudgmentPackInput } from '../src/agents/types.js'

const input = (over: Partial<JudgmentPackInput> = {}): JudgmentPackInput => ({
  symbol: 'BTC/USDT',
  timeframe: '1h',
  asOf: 1_700_000_000_000,
  features: { 'bar.close': 100, rsi14: 55 },
  deskState: { equityQuote: 10_000, positions: [], openOrders: 0 },
  plan: { planId: 'pc-1', contentHash: 'sha256:abc' },
  lessons: [{ lessonId: 'l1' }],
  ...over,
})

const report = (
  agent: string,
  keyNumbers: Record<string, number>,
  verdict: AnalystReport['verdict'] = 'neutral',
): AnalystReport => ({
  agent,
  verdict,
  keyNumbers,
  summary: `${agent} summary`,
  artifactRef: `artifact://${agent}`,
})

describe('freezeContextPack', () => {
  it('is deterministic and derives a stable packId', () => {
    const a = freezeContextPack(input())
    const b = freezeContextPack(input())
    expect(a.contextHash).toBe(b.contextHash)
    expect(a.packId).toBe(b.packId)
    expect(a.contextHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(a.packId).toMatch(/^pack-[0-9a-f]{16}$/)
  })

  it('changes the hash when any frozen input changes', () => {
    const base = freezeContextPack(input()).contextHash
    expect(freezeContextPack(input({ features: { 'bar.close': 101 } })).contextHash).not.toBe(base)
    expect(freezeContextPack(input({ asOf: 1 })).contextHash).not.toBe(base)
    expect(
      freezeContextPack(input({ deskState: { equityQuote: 1, positions: [], openOrders: 0 } }))
        .contextHash,
    ).not.toBe(base)
    expect(freezeContextPack(input({ plan: { planId: 'pc-2', contentHash: 'x' } })).contextHash).not.toBe(base)
  })
})

describe('assertPackIntegrity', () => {
  it('accepts a matching declaration', () => {
    const pack = freezeContextPack(input())
    expect(() => assertPackIntegrity(pack.contextHash, pack)).not.toThrow()
  })

  it('refuses a mismatched declaration', () => {
    const pack = freezeContextPack(input())
    expect(() => assertPackIntegrity('sha256:deadbeef', pack)).toThrow(PackMismatchError)
  })

  it('refuses a pack whose content was changed after freezing', () => {
    const pack = freezeContextPack(input())
    const tampered = { ...pack, features: { 'bar.close': 999 } }
    expect(() => assertPackIntegrity(pack.contextHash, tampered)).toThrow(PackMismatchError)
  })
})

describe('detectFactConflicts (铁律 B)', () => {
  it('finds nothing when analysts agree within tolerance', () => {
    const conflicts = detectFactConflicts([
      report('market', { price: 100 }),
      report('flow', { price: 100.5 }),
    ])
    expect(conflicts).toEqual([])
  })

  it('finds the key and reports every asserted value when they diverge', () => {
    const conflicts = detectFactConflicts([
      report('market', { price: 100, funding: 0.01 }),
      report('flow', { price: 130, funding: 0.01 }),
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.key).toBe('price')
    expect(conflicts[0]?.values).toEqual([
      { agent: 'market', value: 100 },
      { agent: 'flow', value: 130 },
    ])
  })

  it('ignores single-source keys, non-numbers and null reports', () => {
    const conflicts = detectFactConflicts([
      report('market', { price: 100, only: 1 }),
      { ...report('flow', { price: 130 }), keyNumbers: { price: 130, bad: Number.NaN } },
      null as unknown as AnalystReport,
    ])
    expect(conflicts.map((conflict) => conflict.key)).toEqual(['price'])
  })

  it('honours a custom relative tolerance', () => {
    // 100 vs 101 ⇒ 相对差 1/101 ≈ 0.0099，默认 1% 容差内；收紧到 0.1% 就成为冲突
    const reports = [report('a', { price: 100 }), report('b', { price: 101 })]
    expect(detectFactConflicts(reports)).toHaveLength(0)
    expect(detectFactConflicts(reports, { relativeTolerance: 0.001 })).toHaveLength(1)
  })

  it('is self-contained — it survives being embedded as source in the workflow sandbox', () => {
    const revived = new Function(`return (${detectFactConflicts.toString()})`)() as typeof detectFactConflicts
    const reports = [report('a', { price: 100 }), report('b', { price: 130 })]
    expect(revived(reports)).toEqual(detectFactConflicts(reports))
  })
})

describe('collectOpenDisagreements', () => {
  it('reports nothing when everything is aligned and converged', () => {
    expect(
      collectOpenDisagreements(
        [report('a', { price: 1 }, 'bullish'), report('b', { price: 1 }, 'bullish')],
        [],
        { points: ['x'], concede: true },
        { points: ['y'], concede: false },
        { stance: 'favor', concerns: [] },
        { stance: 'neutral', concerns: [] },
      ),
    ).toEqual([])
  })

  it('lists unresolved conflicts, non-convergence, opposite risk stances and split verdicts', () => {
    const open = collectOpenDisagreements(
      [report('a', { price: 1 }, 'bullish'), report('b', { price: 9 }, 'bearish')],
      [{ key: 'price', values: [{ agent: 'a', value: 1 }, { agent: 'b', value: 9 }] }],
      { points: ['x'], concede: false },
      { points: ['y'], concede: false },
      { stance: 'favor', concerns: [] },
      { stance: 'oppose', concerns: [] },
    )
    expect(open.some((line) => line.includes('事实冲突：price'))).toBe(true)
    expect(open.some((line) => line.includes('未收敛'))).toBe(true)
    expect(open.some((line) => line.includes('风控两方立场相反'))).toBe(true)
    expect(open.some((line) => line.includes('分析师结论不一致'))).toBe(true)
  })

  it('is self-contained too', () => {
    const revived = new Function(`return (${collectOpenDisagreements.toString()})`)() as typeof collectOpenDisagreements
    expect(revived([], [], null, null, null, null)).toEqual([])
  })
})
