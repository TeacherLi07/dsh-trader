/** R3 单次/三步工作流：所有阶段共用冻结 DecisionContext 和最终请求渲染器。 */

import {
  createSystemMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { renderDecisionRequest, type RenderedDecisionRequest } from './decision-request.js'
import type { DecisionContext } from './decision-context.js'
import {
  DECISION_ENVELOPE_TOOL,
  parseDecisionEnvelopeCandidate,
  type CritiqueIssue,
  type CritiqueResponse,
  type DecisionEnvelopeCandidate,
} from './decision-envelope.js'
import { fingerprint } from '../util/canonical.js'

export type DecisionStrategy = 'single' | 'critique'

export interface DecisionModel {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface DecisionModelRoute {
  readonly provider: string
  readonly model: string
  readonly maxTokens: number
  readonly maxChars: number
}

export interface DecisionModelCall {
  readonly stage: 'strategist' | 'risk-critic'
  readonly promptVersion: string
  readonly requestHash: string
  readonly requestChars: number
  readonly output: unknown
  readonly usage: TokenUsage | null
}

export interface DecisionWorkflowStages {
  readonly strategy: DecisionStrategy
  readonly draft?: DecisionEnvelopeCandidate
  readonly critique?: { readonly issues: readonly CritiqueIssue[]; readonly uncertainties: readonly string[]; readonly evidenceIssues: readonly string[] }
  readonly final?: DecisionEnvelopeCandidate
  readonly evidenceIssues: readonly string[]
  readonly calls: readonly DecisionModelCall[]
  readonly repairCalls: number
  readonly failure?: string
  readonly failureKind?: 'model' | 'output' | 'budget'
}

export interface DecisionWorkflowResume {
  readonly draft?: { readonly candidate: DecisionEnvelopeCandidate; readonly evidenceIssues?: readonly string[] }
  readonly critique?: { readonly issues: readonly CritiqueIssue[]; readonly uncertainties: readonly string[]; readonly evidenceIssues?: readonly string[] }
  readonly final?: { readonly candidate: DecisionEnvelopeCandidate; readonly evidenceIssues?: readonly string[] }
}

export type DecisionWorkflowStageName = 'draft' | 'critique' | 'final'

interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

const R3_PROMPT_VERSION = 'decision-r3-v1'
const ENVELOPE_NAME = DECISION_ENVELOPE_TOOL.name

const CRITIQUE_TOOL: ToolSchema = {
  name: 'submit_risk_critique',
  description: '提交只读风险批评；不授权、不否决交易，由代码 eligibility 独立裁定。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      issues: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false,
        properties: {
          critiqueId: { type: 'string', minLength: 1 },
          severity: { enum: ['P0', 'P1', 'P2'] },
          statement: { type: 'string', minLength: 1, maxLength: 2_000 },
          evidencePaths: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
        }, required: ['critiqueId', 'severity', 'statement', 'evidencePaths'],
      } },
      uncertainties: { type: 'array', items: { type: 'string', maxLength: 2_000 }, maxItems: 40 },
    }, required: ['issues', 'uncertainties'],
  },
}

const STAGE_INSTRUCTIONS = {
  single: [
    '本候选是 single Strategist：只提交一个最终 DecisionEnvelope，不调用也不模拟其它角色。',
    '以 submit_decision_envelope 工具提交结构化结果；不得在自由文本中声称动作已执行。',
    'runId/contextHash/symbol/timeframe 身份由代码绑定，不要在结果里输出这些字段。',
  ].join('\n'),
  draft: [
    '你是 R3 critique 候选的 Strategist。基于冻结事实先形成 draft DecisionEnvelope。',
    '只提交假设与可能动作，不声称执行；RiskCritic 随后会独立挑战。',
  ].join('\n'),
  critic: [
    '你是独立 RiskCritic，只指出可由冻结事实核验的缺口、反例、组合风险与执行风险。',
    '不得改写 draft、决定仓位或授权交易；只用 submit_risk_critique 返回带稳定 critiqueId 的问题。',
    'evidencePaths 使用 DecisionContext 的 JSON Pointer（例如 /sections/portfolio/value/account/equityQuote）。',
  ].join('\n'),
  final: [
    '你是 critique 候选的最终 Strategist。结合冻结事实、draft 与 RiskCritic 问题，提交唯一最终 DecisionEnvelope。',
    'critiqueResponses 必须对每个 critiqueId 恰好回应一次，accept/reject 均须说明理由；批评意见本身不授权或否决动作。',
    'runId/contextHash/symbol/timeframe 身份由代码绑定，不要在结果里输出这些字段。',
  ].join('\n'),
} as const

const REPAIR_INSTRUCTION = [
  '上一份结构化输出未通过代码校验。请只修复下列 shape/reference 问题，保留原判断；不要扩大风险或补造事实。',
  '若无法修复，使用 outcome=review，并把不确定性写入 uncertainties。',
].join('\n')

export class DecisionBudgetDenied extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionBudgetDenied'
  }
}

class DecisionModelCallFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionModelCallFailure'
  }
}

class DecisionOutputFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionOutputFailure'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeModelError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UnknownError'
  const raw = error instanceof Error ? error.message : String(error)
  return `${name}: ${raw.replace(/(api[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]').slice(0, 1_000)}`
}

function modelMessages(request: RenderedDecisionRequest) {
  return request.messages.map((message) => message.role === 'system'
    ? createSystemMessage(message.content, 'dsh-trader')
    : createUserMessage({
        content: [{ type: 'text', text: message.content }],
        source: { kind: 'plugin', plugin: 'trade-supervisor', form: 'notice', summary: 'R3 frozen decision request' },
      }))
}

async function callStructuredTool(input: {
  readonly model: DecisionModel
  readonly route: DecisionModelRoute
  readonly context: DecisionContext
  readonly stage: DecisionModelCall['stage']
  readonly tool: ToolSchema
  readonly instructions: string
  readonly materials?: readonly unknown[]
  readonly signal?: AbortSignal
  readonly beforeCall?: (request: RenderedDecisionRequest, stage: DecisionModelCall['stage']) => Promise<void>
  readonly onFailure?: (request: RenderedDecisionRequest, stage: DecisionModelCall['stage'], error: unknown) => Promise<void>
}): Promise<DecisionModelCall> {
  const promptVersion = `${R3_PROMPT_VERSION}:${input.stage}:${input.tool.name}`
  const request = renderDecisionRequest(input.context, {
    maxChars: input.route.maxChars,
    promptVersion,
    instructions: input.instructions,
    ...(input.materials === undefined ? {} : { materials: input.materials }),
    outputSchema: input.tool,
  })
  const options: GenerateOptions = {
    provider: input.route.provider,
    model: input.route.model,
    messages: modelMessages(request),
    tools: [{
      name: input.tool.name,
      description: input.tool.description,
      parameters: input.tool.parameters,
    }],
    maxTokens: input.route.maxTokens,
    temperature: 0,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  }
  await input.beforeCall?.(request, input.stage)
  let output: unknown
  let usage: TokenUsage | null = null
  let toolCallCount = 0
  try {
    for await (const chunk of input.model.stream(options)) {
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
        toolCallCount += 1
        if (chunk.block.name !== input.tool.name) {
          output = undefined
          continue
        }
        try {
          output = JSON.parse(chunk.block.arguments) as unknown
        } catch {
          output = undefined
        }
      }
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new DecisionModelCallFailure(`模型阶段失败：${chunk.reason.kind}`)
      }
    }
    if (toolCallCount > 1) output = undefined
    return {
      stage: input.stage,
      promptVersion,
      requestHash: request.requestHash,
      requestChars: request.requestChars,
      output,
      usage,
    }
  } catch (error) {
    await input.onFailure?.(request, input.stage, error)
    throw error instanceof DecisionModelCallFailure ? error : new DecisionModelCallFailure(safeModelError(error))
  }
}

function parseCritique(value: unknown, context: DecisionContext): {
  readonly ok: true
  readonly critique: { readonly issues: readonly CritiqueIssue[]; readonly uncertainties: readonly string[] }
  readonly evidenceIssues: readonly string[]
} | { readonly ok: false; readonly errors: readonly string[] } {
  if (!isRecord(value) || !Array.isArray(value['issues']) || !Array.isArray(value['uncertainties']) ||
      !value['uncertainties'].every((item) => typeof item === 'string')) return { ok: false, errors: ['RiskCritic shape 无效'] }
  const ids = new Set<string>()
  const evidenceIssues: string[] = []
  const issues: CritiqueIssue[] = []
  for (const [index, item] of value['issues'].entries()) {
    if (!isRecord(item) || typeof item['critiqueId'] !== 'string' || item['critiqueId'].trim() === '' ||
        (item['severity'] !== 'P0' && item['severity'] !== 'P1' && item['severity'] !== 'P2') ||
        typeof item['statement'] !== 'string' || item['statement'].trim() === '' ||
        !Array.isArray(item['evidencePaths']) || !item['evidencePaths'].every((path) => typeof path === 'string')) {
      return { ok: false, errors: [`RiskCritic issues[${index}] shape 无效`] }
    }
    if (ids.has(item['critiqueId'])) return { ok: false, errors: [`RiskCritic critiqueId 重复：${item['critiqueId']}`] }
    ids.add(item['critiqueId'])
    const paths = item['evidencePaths'] as string[]
    if (item['severity'] !== 'P2' && paths.length === 0) evidenceIssues.push(`RiskCritic ${item['critiqueId']} 缺少依据`)
    issues.push({
      critiqueId: item['critiqueId'],
      severity: item['severity'],
      statement: item['statement'],
      evidencePaths: paths,
    })
  }
  // Critic 的引用也必须在冻结 context 中存在，但它的主观意见不直接授权/否决执行。
  for (const issue of issues) {
    for (const path of issue.evidencePaths) {
      // 以一个临时 observation claim 复用同一 JSON Pointer 验证器。
      const checked = parseDecisionEnvelopeCandidate({
        outcome: 'no_trade', thesis: 'critique path check', rejectedAlternatives: [],
        claims: [{ kind: 'observation', statement: 'reference', evidencePaths: [path] }],
        uncertainties: [], confidence: 0, riskFraction: 1,
      }, context)
      if (!checked.ok || checked.evidenceIssues.length > 0) evidenceIssues.push(`RiskCritic ${issue.critiqueId} 引用无效：${path}`)
    }
  }
  return {
    ok: true,
    critique: { issues, uncertainties: value['uncertainties'] as string[] },
    evidenceIssues,
  }
}

function validateResponses(candidate: DecisionEnvelopeCandidate, issues: readonly CritiqueIssue[]): readonly string[] {
  const responses = candidate.critiqueResponses ?? []
  const ids = responses.map((response: CritiqueResponse) => response.critiqueId)
  const expected = issues.map((issue) => issue.critiqueId)
  const errors: string[] = []
  if (ids.length !== expected.length || new Set(ids).size !== ids.length || expected.some((id) => !ids.includes(id))) {
    errors.push('critiqueResponses 必须对每个 critiqueId 恰好回应一次')
  }
  return errors
}

/** 一轮最多一次结构修复；模型失败或仍无效时返回 REVIEW，不产生可执行工件。 */
export async function runDecisionWorkflowStages(input: {
  readonly strategy: DecisionStrategy
  readonly context: DecisionContext
  readonly model: DecisionModel
  readonly route: DecisionModelRoute
  readonly signal?: AbortSignal
  readonly resume?: DecisionWorkflowResume
  readonly beforeCall?: (request: RenderedDecisionRequest, stage: DecisionModelCall['stage']) => Promise<void>
  readonly onModelFailure?: (request: RenderedDecisionRequest, stage: DecisionModelCall['stage'], error: unknown) => Promise<void>
  readonly onModelCall?: (call: DecisionModelCall) => Promise<void>
  readonly onStage?: (stage: DecisionWorkflowStageName, artifact: unknown) => Promise<void>
}): Promise<DecisionWorkflowStages> {
  const calls: DecisionModelCall[] = []
  let repairs = 0
  let finalEvidenceIssues: string[] = []
  let draftResult: DecisionEnvelopeCandidate | undefined
  let critiqueResult: { readonly issues: readonly CritiqueIssue[]; readonly uncertainties: readonly string[]; readonly evidenceIssues: readonly string[] } | undefined
  let finalResult: DecisionEnvelopeCandidate | undefined
  const storedEnvelope = (artifact: DecisionWorkflowResume['draft'] | DecisionWorkflowResume['final']) => {
    if (artifact === undefined) return undefined
    const parsed = parseDecisionEnvelopeCandidate(artifact.candidate, input.context)
    if (!parsed.ok) throw new Error(`已持久化 envelope 无法重验：${parsed.errors.join('; ')}`)
    return { value: parsed.candidate, evidenceIssues: parsed.evidenceIssues }
  }
  const storedCritique = (artifact: DecisionWorkflowResume['critique']) => {
    if (artifact === undefined) return undefined
    const parsed = parseCritique(artifact, input.context)
    if (!parsed.ok) throw new Error(`已持久化 critique 无法重验：${parsed.errors.join('; ')}`)
    return {
      value: { ...parsed.critique, evidenceIssues: parsed.evidenceIssues },
      evidenceIssues: parsed.evidenceIssues,
    }
  }
  const callAndValidate = async <T>(stage: {
    readonly modelStage: DecisionModelCall['stage']
    readonly tool: ToolSchema
    readonly instructions: string
    readonly materials?: readonly unknown[]
    readonly validate: (raw: unknown) => { readonly ok: true; readonly value: T; readonly evidenceIssues?: readonly string[] } | { readonly ok: false; readonly errors: readonly string[] }
  }): Promise<{ readonly value: T; readonly evidenceIssues: readonly string[] }> => {
    let materials = stage.materials ?? []
    let instructions = stage.instructions
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const call = await callStructuredTool({
        model: input.model,
        route: input.route,
        context: input.context,
        stage: stage.modelStage,
        tool: stage.tool,
        instructions,
        materials,
        ...(input.beforeCall === undefined ? {} : { beforeCall: input.beforeCall }),
        ...(input.onModelFailure === undefined ? {} : { onFailure: input.onModelFailure }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      calls.push(call)
      await input.onModelCall?.(call)
      const result = stage.validate(call.output)
      if (result.ok) return { value: result.value, evidenceIssues: result.evidenceIssues ?? [] }
      if (repairs >= 1) throw new DecisionOutputFailure(result.errors.join('; '))
      repairs += 1
      instructions = `${stage.instructions}\n\n${REPAIR_INSTRUCTION}`
      materials = [...materials, { previousOutput: call.output, validationErrors: result.errors }]
    }
    throw new DecisionOutputFailure('单次结构修复未收敛')
  }

  try {
    if (input.strategy === 'single') {
      let final = storedEnvelope(input.resume?.final)
      if (final === undefined) {
        final = await callAndValidate({
          modelStage: 'strategist', tool: DECISION_ENVELOPE_TOOL,
          instructions: STAGE_INSTRUCTIONS.single,
          validate: (raw) => {
            const parsed = parseDecisionEnvelopeCandidate(raw, input.context)
            return parsed.ok
              ? { ok: true, value: parsed.candidate, evidenceIssues: parsed.evidenceIssues }
              : { ok: false, errors: parsed.errors }
          },
        })
        await input.onStage?.('final', { candidate: final.value, evidenceIssues: final.evidenceIssues })
      }
      if (final === undefined) throw new Error('single final stage 未产出')
      finalEvidenceIssues = [...final.evidenceIssues]
      finalResult = final.value
      return { strategy: 'single', final: final.value, evidenceIssues: finalEvidenceIssues, calls, repairCalls: repairs }
    }

    let draftArtifact = storedEnvelope(input.resume?.draft)
    if (draftArtifact === undefined) {
      draftArtifact = await callAndValidate({
        modelStage: 'strategist', tool: DECISION_ENVELOPE_TOOL,
        instructions: STAGE_INSTRUCTIONS.draft,
        validate: (raw) => {
          const parsed = parseDecisionEnvelopeCandidate(raw, input.context)
          return parsed.ok
            ? { ok: true, value: parsed.candidate, evidenceIssues: parsed.evidenceIssues }
            : { ok: false, errors: parsed.errors }
        },
      })
      await input.onStage?.('draft', { candidate: draftArtifact.value, evidenceIssues: draftArtifact.evidenceIssues })
    }
    if (draftArtifact === undefined) throw new Error('critique draft stage 未产出')
    const draft = draftArtifact.value
    draftResult = draft

    let critiqueArtifact = storedCritique(input.resume?.critique)
    if (critiqueArtifact === undefined) {
      critiqueArtifact = await callAndValidate({
        modelStage: 'risk-critic', tool: CRITIQUE_TOOL,
        instructions: STAGE_INSTRUCTIONS.critic,
        materials: [{ draft }],
        validate: (raw) => {
          const parsed = parseCritique(raw, input.context)
          return parsed.ok
            ? { ok: true, value: { ...parsed.critique, evidenceIssues: parsed.evidenceIssues }, evidenceIssues: parsed.evidenceIssues }
            : { ok: false, errors: parsed.errors }
        },
      })
      await input.onStage?.('critique', { ...critiqueArtifact.value, evidenceIssues: critiqueArtifact.evidenceIssues })
    }
    const critique = critiqueArtifact.value
    critiqueResult = critique

    let final = storedEnvelope(input.resume?.final)
    if (final === undefined) {
      final = await callAndValidate({
        modelStage: 'strategist', tool: DECISION_ENVELOPE_TOOL,
        instructions: STAGE_INSTRUCTIONS.final,
        materials: [{ draft }, { critique }],
        validate: (raw) => {
          const parsed = parseDecisionEnvelopeCandidate(raw, input.context)
          if (!parsed.ok) return { ok: false, errors: parsed.errors }
          const responseErrors = validateResponses(parsed.candidate, critique.issues)
          if (responseErrors.length > 0) return { ok: false, errors: responseErrors }
          return { ok: true, value: parsed.candidate, evidenceIssues: parsed.evidenceIssues }
        },
      })
      await input.onStage?.('final', { candidate: final.value, evidenceIssues: final.evidenceIssues })
    }
    if (final === undefined) throw new Error('critique final stage 未产出')
    finalEvidenceIssues = [...final.evidenceIssues]
    finalResult = final.value
    return { strategy: 'critique', draft, critique, final: final.value, evidenceIssues: finalEvidenceIssues, calls, repairCalls: repairs }
  } catch (error) {
    const failureKind = error instanceof DecisionBudgetDenied
      ? 'budget'
      : error instanceof DecisionModelCallFailure
        ? 'model'
        : 'output'
    return {
      strategy: input.strategy,
      ...(draftResult === undefined ? {} : { draft: draftResult }),
      ...(critiqueResult === undefined ? {} : { critique: critiqueResult }),
      ...(finalResult === undefined ? {} : { final: finalResult }),
      calls,
      repairCalls: repairs,
      evidenceIssues: finalEvidenceIssues,
      failure: safeModelError(error),
      failureKind,
    }
  }
}

/** Cost ledger 用：把 dsh-llm 的互斥缓存计数归一为入账 usage。 */
export function toLedgerUsage(usage: TokenUsage | null): { readonly tokensIn: number; readonly tokensOut: number; readonly tokensCached: number } | null {
  if (usage === null || !Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return null
  const cached = Math.max(0, usage.cacheReadTokens ?? 0)
  const write = Math.max(0, usage.cacheWriteTokens ?? 0)
  return {
    tokensIn: Math.max(0, usage.inputTokens) + cached + write,
    tokensOut: Math.max(0, usage.outputTokens),
    tokensCached: cached,
  }
}

/** 调试/审计时只存 JSON-safe 阶段摘要，不展开 provider 私有 payload。 */
export function decisionWorkflowSummary(stages: DecisionWorkflowStages): Readonly<Record<string, unknown>> {
  return {
    strategy: stages.strategy,
    repairCalls: stages.repairCalls,
    failure: stages.failure ?? null,
    calls: stages.calls.map((call) => ({
      stage: call.stage,
      promptVersion: call.promptVersion,
      requestHash: call.requestHash,
      requestChars: call.requestChars,
      usage: toLedgerUsage(call.usage),
    })),
    draftHash: stages.draft === undefined ? null : fingerprint(stages.draft),
    critiqueCount: stages.critique?.issues.length ?? 0,
    finalHash: stages.final === undefined ? null : fingerprint(stages.final),
  }
}
