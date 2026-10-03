import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import type { DecisionEnvelopeCandidate } from '../src/agents/decision-envelope.js'
import { compileExpression } from '../src/plan/dsl.js'
import { runDecisionWorkflowStages, toLedgerUsage, type DecisionModel, type DecisionWorkflowResume } from '../src/agents/decision-workflow.js'

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
  it('发给模型的 DSL 示例可由实际编译器求值，不要求 JavaScript 布尔语法', async () => {
    const model = new FakeDecisionModel([envelope()])
    await runDecisionWorkflowStages({ strategy: 'single', context: context(), model, route })
    const request = JSON.stringify(model.requests[0])
    const example = 'position.qty == 0 and rsi14 < 30'
    expect(request).toContain(example)
    const evaluate = compileExpression(example)
    expect(evaluate({ get: (path) => path === 'position.qty' ? 0 : path === 'rsi14' ? 20 : undefined, call: () => undefined })).toEqual({ ok: true, value: true })
  })

  it('保留 provider finish 的原始错误码与诊断，不能只留下泛化 error', async () => {
    const model: DecisionModel = { async *stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: 'fixture provider credential ref unavailable' } } } as StreamChunk
    } }
    const result = await runDecisionWorkflowStages({ strategy: 'single', context: context(), model, route })
    expect(result.calls).toHaveLength(1)
    expect(result.failure).toContain('MISSING_CREDENTIAL')
    expect(result.failure).toContain('fixture provider credential ref unavailable')
    expect(result.calls[0]?.response['finish']).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
  })

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

  it.each([
    { when: '下一根收盘突破阻力时', seq: 1 },
    { when: 'unknown.metric > 1', seq: 1 },
    { when: 'bar.close > 110', seq: 0 },
  ])('不可执行的计划在阶段提交前拒绝并进入一次结构修复：%j', async ({ when, seq }) => {
    const invalid = envelope({ outcome: 'review', immediateAction: undefined, plan: {
      thesis: '等待', confidence: 0.5, keyLevels: [], forbidden: [], noTrade: true,
      invalidation: [{ id: 'invalidate', tf: '1h', when: 'bar.close < 90', then: { action: 'noop' } }],
      commitments: [{ id: 'wait', seq, tf: '1h', when, then: { action: 'noop' } }],
    } })
    const fixed = envelope({ outcome: 'no_trade', immediateAction: undefined })
    const model = new FakeDecisionModel([invalid, fixed])
    const persisted: unknown[] = []
    const result = await runDecisionWorkflowStages({
      strategy: 'single', context: context(), model, route,
      onStage: async (_stage, artifact) => { persisted.push(artifact) },
    })
    expect(result.failure).toBeUndefined()
    expect(model.requests).toHaveLength(2)
    expect(result.repairCalls).toBe(1)
    expect(persisted).toHaveLength(1)
    expect(result.final?.outcome).toBe('no_trade')
    expect(result.final?.plan).toBeUndefined()
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

  it('恢复时不能重新获得已经消耗的结构修复额度', async () => {
    let savedDraft: DecisionWorkflowResume['draft']
    const beforeCrash = await runDecisionWorkflowStages({
      strategy: 'critique', context: context(), model: new FakeDecisionModel([{}, envelope()]), route,
      onStage: async (stage, artifact) => {
        if (stage === 'draft') savedDraft = artifact as NonNullable<DecisionWorkflowResume['draft']>
        throw new Error('模拟 draft 持久化后的进程退出')
      },
    })
    expect(beforeCrash.calls).toHaveLength(2)
    expect(savedDraft).toMatchObject({ repairCalls: 1 })
    const model = new FakeDecisionModel([{}, envelope()])
    const result = await runDecisionWorkflowStages({
      strategy: 'critique', context: context(), model, route,
      resume: { draft: savedDraft },
    })
    expect(result.failure).toContain('RiskCritic shape')
    expect(model.requests).toHaveLength(1)
    expect(result.repairCalls).toBe(1)
    expect(result.final).toBeUndefined()
  })

  it('恢复的 final 仍须逐项回应已经持久化的 critique', async () => {
    const model = new FakeDecisionModel([])
    const result = await runDecisionWorkflowStages({
      strategy: 'critique', context: context(), model, route,
      resume: {
        draft: { candidate: envelope() as DecisionEnvelopeCandidate },
        critique: { issues: [{ critiqueId: 'required', severity: 'P2', statement: '考虑等待', evidencePaths: [] }], uncertainties: [] },
        final: { candidate: envelope() as DecisionEnvelopeCandidate },
      },
    })
    expect(model.requests).toHaveLength(0)
    expect(result.failure).toContain('critiqueResponses')
    expect(result.final).toBeUndefined()
  })

  it.each([
    { issues: [], uncertainties: [], unauthorized: true },
    { issues: [], uncertainties: Array.from({ length: 41 }, () => '缺口') },
    { issues: [{ critiqueId: 'bad', severity: 'P2', statement: 'x'.repeat(2001), evidencePaths: [] }], uncertainties: [] },
    { issues: [{ critiqueId: 'bad', severity: 'P2', statement: '问题', evidencePaths: [], authorize: true }], uncertainties: [] },
  ])('RiskCritic 输出违反已声明的形状/长度时拒绝：%j', async (critic) => {
    const model = new FakeDecisionModel([envelope(), critic, critic, envelope()])
    const result = await runDecisionWorkflowStages({ strategy: 'critique', context: context(), model, route })
    expect(result.calls).toHaveLength(3)
    expect(result.failure).toContain('RiskCritic')
    expect(result.final).toBeUndefined()
  })
})

describe('模型 usage 归一', () => {
  it('互斥输入、缓存读写只累计一次，省略缓存计数允许为零', () => {
    expect(toLedgerUsage({ inputTokens: 100, outputTokens: 40, totalTokens: 140 })).toEqual({ tokensIn: 100, tokensOut: 40, tokensCached: 0 })
    expect(toLedgerUsage({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 170 })).toEqual({ tokensIn: 130, tokensOut: 40, tokensCached: 20 })
    expect(toLedgerUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER })).toBeNull()
  })

  it.each(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const)('拒绝 %s 的无效计数，保留成本未知', (field) => {
    for (const invalid of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(toLedgerUsage({ inputTokens: 100, outputTokens: 40, totalTokens: 140, [field]: invalid })).toBeNull()
    }
  })
})
