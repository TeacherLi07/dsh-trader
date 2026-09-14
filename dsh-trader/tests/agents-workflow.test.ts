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
  features: { 'bar.close': 100, rsi14: 55, atr14: 2 },
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

/** 记录调用的假 agent；按 label 返回脚本化响应。 */
function fakeAgent(handlers: Record<string, unknown>): { hooks: WorkflowHooks; calls: Call[] } {
  const calls: Call[] = []
  const agent: WorkflowHooks['agent'] = async (prompt, options) => {
    const label = options?.label ?? 'unknown'
    calls.push({ label, prompt })
    return handlers[label] ?? null
  }
  return { hooks: { agent }, calls }
}

const happyHandlers = {
  market: { agent: 'market', verdict: 'bullish', keyNumbers: { price: 100 }, summary: 'm', artifactRef: 'a://market' },
  flow: { agent: 'flow', verdict: 'bullish', keyNumbers: { funding: 0.01 }, summary: 'f', artifactRef: 'a://flow' },
  news: { agent: 'news', verdict: 'neutral', keyNumbers: {}, summary: 'n', artifactRef: 'a://news' },
  onchain: { agent: 'onchain', verdict: 'bearish', keyNumbers: { netflow: -5 }, summary: 'o', artifactRef: 'a://onchain' },
  bull: { points: ['up'], concede: false },
  bear: { points: ['down'], concede: false },
  aggressive: { stance: 'favor', concerns: ['c1'] },
  conservative: { stance: 'oppose', concerns: ['c2'] },
  neutral: { stance: 'neutral', concerns: ['c3'] },
}

describe('judgment workflow script', () => {
  it('is syntactically valid and runs with only the sandbox hooks', async () => {
    const { hooks } = fakeAgent(happyHandlers)
    const result = (await executeWorkflowScript(
      buildJudgmentWorkflowScript(),
      buildWorkflowArgs(pack),
      hooks,
    )) as JudgmentResult

    expect(result.packId).toBe(pack.packId)
    expect(result.contextHash).toBe(pack.contextHash)
  })

  it('refuses to run when the declared contextHash does not match the pack (铁律 A)', async () => {
    const { hooks } = fakeAgent(happyHandlers)
    const args = { ...buildWorkflowArgs(pack), contextHash: 'sha256:tampered' }
    await expect(executeWorkflowScript(buildJudgmentWorkflowScript(), args, hooks)).rejects.toThrow(
      /context pack mismatch/,
    )
  })

  it('sends the same frozen contextHash to all four analysts and returns structured fields only', async () => {
    const { hooks, calls } = fakeAgent(happyHandlers)
    const result = (await executeWorkflowScript(
      buildJudgmentWorkflowScript(),
      buildWorkflowArgs(pack),
      hooks,
    )) as JudgmentResult

    const analystCalls = calls.filter((call) => ['market', 'flow', 'news', 'onchain'].includes(call.label))
    expect(analystCalls).toHaveLength(4)
    for (const call of analystCalls) expect(call.prompt).toContain(pack.contextHash)

    // 只回结构化字段 + 工件指针：不把散文摘要带回来
    expect(result.reports).toHaveLength(4)
    for (const report of result.reports) {
      expect(report.artifactRef).toMatch(/^a:\/\//)
      expect(report).not.toHaveProperty('summary')
    }
  })

  it('runs counter-terminated debate and risk rounds when nobody concedes', async () => {
    const { hooks } = fakeAgent(happyHandlers)
    const result = (await executeWorkflowScript(
      buildJudgmentWorkflowScript(),
      buildWorkflowArgs(pack, { maxRounds: 3, maxRiskRounds: 2 }),
      hooks,
    )) as JudgmentResult

    expect(result.debate.rounds).toBe(3)
    expect(result.risk.rounds).toBe(2)
    expect(result.openDisagreements.some((line) => line.includes('未收敛'))).toBe(true)
    expect(result.openDisagreements.some((line) => line.includes('风控两方立场相反'))).toBe(true)
    expect(result.openDisagreements.some((line) => line.includes('分析师结论不一致'))).toBe(true)
  })

  it('stops the debate as soon as one side concedes', async () => {
    const { hooks, calls } = fakeAgent({
      ...happyHandlers,
      bull: { points: ['up'], concede: true },
    })
    const result = (await executeWorkflowScript(
      buildJudgmentWorkflowScript(),
      buildWorkflowArgs(pack, { maxRounds: 5 }),
      hooks,
    )) as JudgmentResult

    expect(result.debate.rounds).toBe(1)
    expect(calls.filter((call) => call.label === 'bull')).toHaveLength(1)
    expect(result.openDisagreements.some((line) => line.includes('未收敛'))).toBe(false)
  })

  it('detects a factual conflict, reconciles it, and supersedes the wrong values', async () => {
    const { hooks, calls } = fakeAgent({
      ...happyHandlers,
      market: { agent: 'market', verdict: 'bullish', keyNumbers: { price: 100 }, summary: 'm', artifactRef: 'a://market' },
      flow: { agent: 'flow', verdict: 'bullish', keyNumbers: { price: 130 }, summary: 'f', artifactRef: 'a://flow' },
      reconcile: { agent: 'reconcile', verdict: 'neutral', keyNumbers: { price: 100 }, summary: 'r', artifactRef: 'a://reconcile' },
    })

    const result = (await executeWorkflowScript(
      buildJudgmentWorkflowScript(),
      buildWorkflowArgs(pack),
      hooks,
    )) as JudgmentResult

    expect(calls.some((call) => call.label === 'reconcile')).toBe(true)
    // 消解成功后冲突不再残留（且不会因为保留旧值而"永远冲突"）
    expect(result.conflicts).toEqual([])
    expect(result.openDisagreements.some((line) => line.includes('事实冲突'))).toBe(false)
    expect(result.reports.some((report) => report.agent === 'reconcile')).toBe(true)
  })

  it('keeps the conflict open when reconciliation fails to supply the disputed value', async () => {
    const { hooks } = fakeAgent({
      ...happyHandlers,
      market: { agent: 'market', verdict: 'bullish', keyNumbers: { price: 100 }, summary: 'm', artifactRef: 'a://market' },
      flow: { agent: 'flow', verdict: 'bullish', keyNumbers: { price: 130 }, summary: 'f', artifactRef: 'a://flow' },
      reconcile: { agent: 'reconcile', verdict: 'unknown', keyNumbers: {}, summary: 'r', artifactRef: 'a://reconcile' },
    })

    const result = (await executeWorkflowScript(
      buildJudgmentWorkflowScript(),
      buildWorkflowArgs(pack),
      hooks,
    )) as JudgmentResult

    expect(result.conflicts.map((conflict) => conflict.key)).toEqual(['price'])
    expect(result.openDisagreements.some((line) => line.includes('事实冲突：price'))).toBe(true)
  })

  it('returns an explicit error instead of fabricating a judgment when no analyst answered', async () => {
    const { hooks } = fakeAgent({})
    const result = await executeWorkflowScript(
      buildJudgmentWorkflowScript(),
      buildWorkflowArgs(pack),
      hooks,
    )
    expect(result).toEqual({ error: 'no analyst report', contextHash: pack.contextHash })
  })
})
