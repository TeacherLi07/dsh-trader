import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import { runDecisionWorkflowStages, type DecisionModel } from '../src/agents/decision-workflow.js'

const AS_OF = 1_700_000_000_000
const SYMBOL = 'BTC/USDT:USDT'

function context() {
  return freezeDecisionContext({
    symbol: SYMBOL,
    primaryTimeframe: '1h',
    asOf: AS_OF,
    sections: {
      mandate: { asOf: AS_OF, source: 'fixture', missing: [], value: { mode: 'paper' } },
      market: { asOf: AS_OF, source: 'fixture', missing: [], value: { close: 100 } },
      derivatives: { asOf: AS_OF, source: 'fixture', missing: [], value: {} },
      benchmark: { asOf: AS_OF, source: 'fixture', missing: [], value: {} },
      portfolio: { asOf: AS_OF, source: 'fixture', missing: [], value: {} },
      activePlan: { asOf: AS_OF, source: 'fixture', missing: [], value: null },
      history: { asOf: AS_OF, source: 'fixture', missing: [], value: [] },
      lessons: { asOf: null, source: 'fixture', missing: [], value: null },
      predictions: { asOf: null, source: 'fixture', missing: ['disabled'], value: null },
    },
  })
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    outcome: 'act',
    thesis: '使用冻结价格事实提交测试判断',
    rejectedAlternatives: ['等待'],
    claims: [{ kind: 'observation', statement: '最新 close 为 100', evidencePaths: ['/sections/market/value/close'] }],
    uncertainties: [], confidence: 0.5, riskFraction: 0.5,
    immediateAction: { action: 'open', side: 'long', method: 'market', stop: { method: 'structure', level: 95 } },
    ...over,
  }
}

class FakeDecisionModel implements DecisionModel {
  readonly requests: GenerateOptions[] = []
  constructor(readonly replies: readonly unknown[]) {}
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const reply = this.replies[this.requests.length - 1]
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 } } as StreamChunk
    yield {
      type: 'block-end', index: 0,
      block: { type: 'tool-call', id: 'call-r3', name: String(options.tools?.[0]?.name), arguments: JSON.stringify(reply) },
    } as unknown as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as StreamChunk
  }
}

const route = { provider: 'test-provider', model: 'test-model', maxTokens: 512, maxChars: 50_000 }

describe('R3 Decision workflow', () => {
  it('single submits one structured request using the frozen R2 request renderer', async () => {
    const model = new FakeDecisionModel([envelope()])
    const result = await runDecisionWorkflowStages({ strategy: 'single', context: context(), model, route })
    expect(result.failure).toBeUndefined()
    expect(result.final?.riskFraction).toBe(0.5)
    expect(result.calls).toHaveLength(1)
    expect(result.calls[0]?.usage).toMatchObject({ inputTokens: 100, outputTokens: 40 })
    expect(result.calls[0]?.requestHash).toMatch(/^sha256:/)
    expect(model.requests[0]?.tools?.[0]?.name).toBe('submit_decision_envelope')
    expect(model.requests[0]?.messages.some((message) => message.role === 'user')).toBe(true)
  })

  it('critique runs Strategist→RiskCritic→Strategist and requires a response for each critic id', async () => {
    const draft = envelope({ outcome: 'review', immediateAction: undefined })
    const critic = { issues: [{ critiqueId: 'crit-stop', severity: 'P1', statement: '检查失效条件', evidencePaths: ['/sections/market/value/close'] }], uncertainties: [] }
    const final = envelope({ critiqueResponses: [{ critiqueId: 'crit-stop', disposition: 'accept', reason: '已收紧 stop 条件' }] })
    const model = new FakeDecisionModel([draft, critic, final])
    const result = await runDecisionWorkflowStages({ strategy: 'critique', context: context(), model, route })
    expect(result.failure).toBeUndefined()
    expect(result.calls.map((call) => call.stage)).toEqual(['strategist', 'risk-critic', 'strategist'])
    expect(result.critique?.issues[0]?.critiqueId).toBe('crit-stop')
    expect(result.final?.critiqueResponses).toMatchObject([{ critiqueId: 'crit-stop', disposition: 'accept' }])
  })

  it('结构错误最多触发一次 repair，仍错误则返回 failure 而不生成 final', async () => {
    const model = new FakeDecisionModel([{}, { outcome: 'act' }])
    const result = await runDecisionWorkflowStages({ strategy: 'single', context: context(), model, route })
    expect(result.repairCalls).toBe(1)
    expect(result.calls).toHaveLength(2)
    expect(result.final).toBeUndefined()
    expect(result.failure).toContain('thesis')
  })

  it('持久阶段可恢复：已有 critique 的 run 只重跑 final', async () => {
    const draft = envelope({ outcome: 'review', immediateAction: undefined })
    const critic = { issues: [{ critiqueId: 'crit-1', severity: 'P2', statement: '考虑等待', evidencePaths: ['/sections/market/value/close'] }], uncertainties: [] }
    const final = envelope({ critiqueResponses: [{ critiqueId: 'crit-1', disposition: 'reject', reason: '该风险已有配置限额覆盖' }] })
    const saved: Record<string, unknown> = {}
    const first = await runDecisionWorkflowStages({
      strategy: 'critique', context: context(), model: new FakeDecisionModel([draft, critic, final]), route,
      onStage: async (stage, artifact) => { saved[stage] = artifact },
    })
    expect(first.failure).toBeUndefined()
    const retryModel = new FakeDecisionModel([final])
    const resumed = await runDecisionWorkflowStages({
      strategy: 'critique', context: context(), model: retryModel, route,
      resume: {
        draft: saved['draft'] as never,
        critique: saved['critique'] as never,
      },
    })
    expect(resumed.failure).toBeUndefined()
    expect(retryModel.requests).toHaveLength(1)
    expect(resumed.final?.critiqueResponses).toHaveLength(1)
  })
})
