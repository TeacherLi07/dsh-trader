import { describe, expect, it } from 'vitest'
import { freezeContextPack } from '../src/agents/pack.js'
import type { JudgmentPackInput, JudgmentResult } from '../src/agents/types.js'
import {
  buildJudgmentWorkflowScript,
  buildWorkflowArgs,
  executeWorkflowScript,
  type WorkflowHooks,
} from '../src/agents/workflow.js'

const pack = freezeContextPack({
  symbol: 'BTC/USDT',
  timeframe: '1h',
  asOf: 1_700_000_000_000,
  features: { 'bar.close': 100, rsi14: 55, atr14: 2, 'account.leverage': 3, 'flow.missing': null },
  deskState: {
    equityQuote: 10_000,
    positions: [{ symbol: 'BTC/USDT', qty: 0, avgPrice: 0 }],
    openOrders: 0,
  },
  plan: { planId: 'pc-1', contentHash: 'sha256:abc' },
  lessons: [{ lessonId: 'l1' }],
} satisfies JudgmentPackInput)

interface Call {
  readonly label: string
  readonly prompt: string
}

function fakeAgent(handlers: Record<string, unknown>): { hooks: WorkflowHooks; calls: Call[] } {
  const calls: Call[] = []
  const agent: WorkflowHooks['agent'] = async (prompt, options) => {
    const label = options?.label ?? 'unknown'
    calls.push({ label, prompt })
    return handlers[label] ?? null
  }
  return { hooks: { agent }, calls }
}

const makeReport = (agent: string, key = 'bar.close', verdict: 'bullish' | 'bearish' | 'neutral' = 'bullish') => ({
  agent,
  contextHash: pack.contextHash,
  verdict,
  keyNumbers: { [key]: pack.features[key] },
  claims: [{ kind: 'observation', statement: `${key} 已核验`, evidencePaths: [key] }],
  missingPaths: [],
  summary: `${agent} summary`,
  artifactRef: `a://${agent}`,
})

const makeArgument = (concede = false) => ({
  contextHash: pack.contextHash,
  points: [{
    statement: '证据支持该方向',
    evidencePaths: ['bar.close'],
    invalidatedBy: { statement: '价格失效', evidencePaths: ['bar.close'] },
  }],
  concede,
})

const happyHandlers = {
  market: makeReport('market'),
  flow: makeReport('flow', 'rsi14'),
  news: makeReport('news', 'atr14', 'neutral'),
  onchain: makeReport('onchain', 'bar.close', 'bearish'),
  bull: makeArgument(),
  bear: makeArgument(),
  riskCritic: { contextHash: pack.contextHash, disposition: 'proceed', failureModes: [], missingEvidence: [] },
}

describe('judgment workflow script', () => {
  it('is syntactically valid and returns structured accepted material', async () => {
    const { hooks } = fakeAgent(happyHandlers)
    const result = (await executeWorkflowScript(buildJudgmentWorkflowScript(), buildWorkflowArgs(pack), hooks)) as JudgmentResult
    expect(result.packId).toBe(pack.packId)
    expect(result.contextHash).toBe(pack.contextHash)
    expect(result.reports).toHaveLength(4)
    expect(result.evidenceIssues).toEqual([])
    expect(result.risk?.disposition).toBe('proceed')
  })

  it('refuses a mismatched contextHash before calling any model', async () => {
    const { hooks, calls } = fakeAgent(happyHandlers)
    const args = { ...buildWorkflowArgs(pack), contextHash: 'sha256:tampered' }
    await expect(executeWorkflowScript(buildJudgmentWorkflowScript(), args, hooks)).rejects.toThrow(/context pack mismatch/)
    expect(calls).toHaveLength(0)
  })

  it('lets RiskCritic cite a frozen account path even when analysts did not cite it', async () => {
    const { hooks } = fakeAgent({
      ...happyHandlers,
      riskCritic: {
        contextHash: pack.contextHash,
        disposition: 'revise',
        failureModes: [{ statement: '杠杆过高', severity: 'P1', evidencePaths: ['account.leverage'] }],
        missingEvidence: [],
      },
    })
    const result = (await executeWorkflowScript(buildJudgmentWorkflowScript(), buildWorkflowArgs(pack), hooks)) as JudgmentResult
    expect(result.risk?.disposition).toBe('revise')
    expect(result.risk?.failureModes[0]?.evidencePaths).toEqual(['account.leverage'])
    expect(result.evidenceIssues).toEqual([])
  })

  it('uses one shared frozen hash, caps debate at two rounds, and calls one RiskCritic', async () => {
    const { hooks, calls } = fakeAgent(happyHandlers)
    const result = (await executeWorkflowScript(buildJudgmentWorkflowScript(), buildWorkflowArgs(pack, { maxRounds: 9 }), hooks)) as JudgmentResult
    const analystCalls = calls.filter((call) => ['market', 'flow', 'news', 'onchain'].includes(call.label))
    expect(analystCalls).toHaveLength(4)
    for (const call of analystCalls) expect(call.prompt).toContain(pack.contextHash)
    expect(result.debate.rounds).toBe(2)
    expect(result.risk).not.toBeNull()
    expect(calls.filter((call) => call.label === 'riskCritic')).toHaveLength(1)
    expect(calls.filter((call) => call.label === 'aggressive' || call.label === 'conservative' || call.label === 'neutral')).toHaveLength(0)
    expect(calls.filter((call) => call.label === 'reconcile')).toHaveLength(0)
    expect(result.openDisagreements.some((line) => line.includes('未收敛'))).toBe(true)
  })

  it('stops debate as soon as either valid side concedes', async () => {
    const { hooks, calls } = fakeAgent({ ...happyHandlers, bull: makeArgument(true) })
    const result = (await executeWorkflowScript(buildJudgmentWorkflowScript(), buildWorkflowArgs(pack, { maxRounds: 2 }), hooks)) as JudgmentResult
    expect(result.debate.rounds).toBe(1)
    expect(calls.filter((call) => call.label === 'bull')).toHaveLength(1)
    expect(result.openDisagreements.some((line) => line.includes('未收敛'))).toBe(false)
  })

  it('rejects forged reports and keeps the issue visible to the later stages', async () => {
    const { hooks, calls } = fakeAgent({
      ...happyHandlers,
      flow: { ...makeReport('flow'), keyNumbers: { forged: 999 } },
      bull: makeArgument(),
    })
    const result = (await executeWorkflowScript(buildJudgmentWorkflowScript(), buildWorkflowArgs(pack), hooks)) as JudgmentResult
    expect(result.reports).toHaveLength(3)
    expect(result.evidenceIssues.some((issue) => issue.code === 'unknown_path')).toBe(true)
    expect(calls.filter((call) => call.label === 'riskCritic')).toHaveLength(1)
  })

  it('does not fabricate a judgment when no analyst report is valid', async () => {
    const { hooks, calls } = fakeAgent({
      market: { agent: 'market', contextHash: 'wrong', verdict: 'bullish', keyNumbers: {}, claims: [], missingPaths: [], summary: 'x', artifactRef: 'a://x' },
      flow: null,
      news: null,
      onchain: null,
    })
    const result = (await executeWorkflowScript(buildJudgmentWorkflowScript(), buildWorkflowArgs(pack), hooks)) as JudgmentResult
    expect(result.reports).toHaveLength(0)
    expect(result.debate.bull).toBeNull()
    expect(result.risk).toBeNull()
    expect(result.evidenceIssues.some((issue) => issue.code === 'no_valid_reports')).toBe(true)
    expect(result.openDisagreements.some((line) => line.includes('没有有效分析师报告'))).toBe(true)
    expect(calls.filter((call) => call.label === 'bull' || call.label === 'bear' || call.label === 'riskCritic')).toHaveLength(0)
  })

  it('marks invalid debate and invalid RiskCritic rather than silently accepting them', async () => {
    const { hooks } = fakeAgent({
      ...happyHandlers,
      bull: { contextHash: pack.contextHash, points: ['not structured'], concede: false },
      bear: makeArgument(),
      riskCritic: { contextHash: pack.contextHash, disposition: 'proceed', failureModes: [{ statement: 'bad', severity: 'P1', evidencePaths: ['forged'] }], missingEvidence: [] },
    })
    const result = (await executeWorkflowScript(buildJudgmentWorkflowScript(), buildWorkflowArgs(pack, { maxRounds: 1 }), hooks)) as JudgmentResult
    expect(result.debate.bull).toBeNull()
    expect(result.risk).toBeNull()
    expect(result.evidenceIssues.some((issue) => issue.stage === 'debate')).toBe(true)
    expect(result.evidenceIssues.some((issue) => issue.stage === 'risk')).toBe(true)
    expect(result.openDisagreements.some((line) => line.includes('没有完整有效'))).toBe(true)
  })
})
