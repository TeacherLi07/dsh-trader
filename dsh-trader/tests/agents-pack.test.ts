import { describe, expect, it } from 'vitest'
import {
  PackMismatchError,
  assertPackIntegrity,
  collectOpenDisagreements,
  detectFactConflicts,
  freezeContextPack,
  validateDebateArgument,
  validateEvidenceReports,
  validateRiskAssessment,
} from '../src/agents/pack.js'
import type { AnalystReport, JudgmentPackInput } from '../src/agents/types.js'

const input = (over: Partial<JudgmentPackInput> = {}): JudgmentPackInput => ({
  symbol: 'BTC/USDT',
  timeframe: '1h',
  asOf: 1_700_000_000_000,
  features: { 'bar.close': 100, rsi14: 55, 'flow.missing': null },
  deskState: { equityQuote: 10_000, positions: [], openOrders: 0 },
  plan: { planId: 'pc-1', contentHash: 'sha256:abc' },
  lessons: [{ lessonId: 'l1' }],
  ...over,
})

const pack = () => freezeContextPack(input())

const report = (p: ReturnType<typeof pack>, over: Partial<AnalystReport> = {}): AnalystReport => ({
  agent: 'market',
  contextHash: p.contextHash,
  verdict: 'bullish',
  keyNumbers: { 'bar.close': 100 },
  claims: [{ kind: 'observation', statement: '收盘价可核验', evidencePaths: ['bar.close'] }],
  missingPaths: [],
  summary: 'summary',
  artifactRef: 'artifact://market',
  ...over,
})

describe('freezeContextPack', () => {
  it('is deterministic and derives a stable packId', () => {
    const a = pack()
    const b = pack()
    expect(a.contextHash).toBe(b.contextHash)
    expect(a.packId).toMatch(/^pack-[0-9a-f]{16}$/)
  })

  it('refuses a mismatched or tampered pack', () => {
    const p = pack()
    expect(() => assertPackIntegrity('sha256:deadbeef', p)).toThrow(PackMismatchError)
    expect(() => assertPackIntegrity(p.contextHash, { ...p, features: { 'bar.close': 999 } })).toThrow(PackMismatchError)
  })
})

describe('validateEvidenceReports', () => {
  it('accepts exact pack numbers and claims, but never accepts fabricated paths or values', () => {
    const p = pack()
    const valid = validateEvidenceReports(p, [report(p)])
    expect(valid.accepted).toHaveLength(1)
    expect(valid.evidenceIssues).toEqual([])

    const invalid = validateEvidenceReports(p, [
      report(p, { keyNumbers: { forged: 1 } }),
      report(p, { keyNumbers: { 'bar.close': 101 } }),
      report(p, { contextHash: 'sha256:wrong' }),
    ])
    expect(invalid.accepted).toHaveLength(0)
    expect(invalid.evidenceIssues.some((issue) => issue.code === 'unknown_path')).toBe(true)
    expect(invalid.evidenceIssues.some((issue) => issue.code === 'value_mismatch')).toBe(true)
    expect(invalid.evidenceIssues.some((issue) => issue.code === 'context_mismatch')).toBe(true)
  })

  it('guards against vacuous bullish/unknown reports', () => {
    const p = pack()
    expect(validateEvidenceReports(p, [report(p, { keyNumbers: {}, claims: [] })]).accepted).toHaveLength(0)
    expect(validateEvidenceReports(p, [report(p, { verdict: 'unknown', keyNumbers: {}, claims: [], missingPaths: [] })]).accepted).toHaveLength(0)
    expect(validateEvidenceReports(p, [report(p, { verdict: 'unknown', keyNumbers: {}, claims: [], missingPaths: ['flow.missing'] })]).accepted).toHaveLength(1)
  })

  it('is self-contained when embedded into a sandbox', () => {
    const p = pack()
    const revived = new Function(`return (${validateEvidenceReports.toString()})`)() as typeof validateEvidenceReports
    expect(revived(p, [report(p)])).toEqual(validateEvidenceReports(p, [report(p)]))
  })
})

describe('debate and risk evidence guards', () => {
  const argument = (p: ReturnType<typeof pack>) => ({
    contextHash: p.contextHash,
    points: [{
      statement: '趋势证据支持多头',
      evidencePaths: ['bar.close'],
      invalidatedBy: { statement: '收盘价跌破观察值', evidencePaths: ['bar.close'] },
    }],
    concede: false,
  })

  it('requires structured invalidatedBy and only accepted evidence paths', () => {
    const p = pack()
    expect(validateDebateArgument(p, argument(p), ['bar.close']).accepted).not.toBeNull()
    expect(validateDebateArgument(p, { ...argument(p), contextHash: 'wrong' }, ['bar.close']).accepted).toBeNull()
    expect(validateDebateArgument(p, { ...argument(p), points: [{ ...argument(p).points[0], invalidatedBy: ['bar.close'] }] }, ['bar.close']).accepted).toBeNull()
    expect(validateDebateArgument(p, argument(p), ['rsi14']).accepted).toBeNull()
  })

  it('validates a single structured RiskCritic output', () => {
    const p = pack()
    const valid = validateRiskAssessment(p, {
      contextHash: p.contextHash,
      disposition: 'proceed',
      failureModes: [{ statement: '失效', severity: 'P1', evidencePaths: ['bar.close'] }],
      missingEvidence: [],
    }, ['bar.close'])
    expect(valid.accepted?.disposition).toBe('proceed')
    expect(validateRiskAssessment(p, {
      contextHash: p.contextHash,
      disposition: 'proceed',
      failureModes: [{ statement: '失效', severity: 'P1', evidencePaths: ['forged'] }],
      missingEvidence: [],
    }, ['bar.close']).accepted).toBeNull()
  })
})

describe('collectOpenDisagreements and legacy conflict detector', () => {
  it('exposes evidence issues, incomplete debate, and absent risk instead of hiding them', () => {
    const p = pack()
    const result = collectOpenDisagreements([report(p)], [{ stage: 'analyst', code: 'unknown_path', kind: 'unknown_path', message: 'bad' }], { bull: null, bear: null, rounds: 0 }, null)
    expect(result.some((line) => line.includes('证据问题'))).toBe(true)
    expect(result.some((line) => line.includes('没有完整有效'))).toBe(true)
    expect(result.some((line) => line.includes('没有有效的 RiskCritic'))).toBe(true)
  })

  it('keeps conflict detection self-contained for already-materialized reports', () => {
    const p = pack()
    const a = report(p, { keyNumbers: { 'bar.close': 100 } })
    const b = report(p, { agent: 'flow', keyNumbers: { 'bar.close': 130 } })
    expect(detectFactConflicts([a, b])).toHaveLength(1)
    const revived = new Function(`return (${detectFactConflicts.toString()})`)() as typeof detectFactConflicts
    expect(revived([a, b])).toEqual(detectFactConflicts([a, b]))
  })
})
