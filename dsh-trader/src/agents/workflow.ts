/**
 * 判断流程的 workflow 脚本（plan §5.4 / T2.7）。
 *
 * workflow 工具在无 import 的沙箱中运行，所以证据报告、辩论和 RiskCritic
 * 的校验函数都以 toString() 嵌入。代码拒绝伪造/冲突材料，不再依赖 LLM
 * reconcile；这保证 pack 数字是唯一事实权威。
 */

import {
  collectOpenDisagreements,
  detectFactConflicts,
  validateDebateArgument,
  validateEvidenceReports,
  validateRiskAssessment,
} from './pack.js'
import { buildWorkflowPrompts, type WorkflowPrompts } from './prompts.js'
import type { JudgmentPack } from './types.js'

/** 固化脚本版本：审计必须能把一次协作结果对应回不可变的编排文本。 */
export const WORKFLOW_SCRIPT_VERSION = 'judgment-workflow-v1'

/** 与 workflow 工具支持的 schema 子集保持一致。 */
export const WORKFLOW_SCHEMAS = {
  report: {
    type: 'object',
    additionalProperties: false,
    required: ['agent', 'contextHash', 'verdict', 'keyNumbers', 'claims', 'missingPaths', 'summary', 'artifactRef'],
    properties: {
      agent: { type: 'string' },
      contextHash: { type: 'string' },
      verdict: { type: 'string', enum: ['bullish', 'bearish', 'neutral', 'unknown'] },
      keyNumbers: { type: 'object', additionalProperties: true },
      claims: { type: 'array', items: { type: 'object' } },
      missingPaths: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' },
      artifactRef: { type: 'string' },
    },
  },
  argument: {
    type: 'object',
    additionalProperties: false,
    required: ['contextHash', 'points', 'concede'],
    properties: {
      contextHash: { type: 'string' },
      points: {
        type: 'array',
        items: {
          type: 'object',
          required: ['statement', 'evidencePaths', 'invalidatedBy'],
          properties: {
            statement: { type: 'string' },
            evidencePaths: { type: 'array', items: { type: 'string' } },
            invalidatedBy: {
              type: 'object',
              required: ['statement', 'evidencePaths'],
              properties: {
                statement: { type: 'string' },
                evidencePaths: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      concede: { type: 'boolean' },
    },
  },
  risk: {
    type: 'object',
    additionalProperties: false,
    required: ['contextHash', 'disposition', 'failureModes', 'missingEvidence'],
    properties: {
      contextHash: { type: 'string' },
      disposition: { type: 'string', enum: ['proceed', 'revise', 'no_trade'] },
      failureModes: { type: 'array', items: { type: 'object' } },
      missingEvidence: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

export interface WorkflowArgs {
  readonly pack: JudgmentPack
  readonly contextHash: string
  readonly prompts: WorkflowPrompts
  readonly schemas: typeof WORKFLOW_SCHEMAS
  readonly maxRounds: number
}

export interface WorkflowArgsOptions {
  readonly maxRounds?: number
}

/** 组装脚本入参：pack 与 prompts 都是 JSON 可序列化的（函数不能跨沙箱）。 */
export function buildWorkflowArgs(pack: JudgmentPack, options: WorkflowArgsOptions = {}): WorkflowArgs {
  return {
    pack,
    contextHash: pack.contextHash,
    prompts: buildWorkflowPrompts(),
    schemas: WORKFLOW_SCHEMAS,
    // §5.4 将辩论限制为最多两轮，避免模型用重复回合制造伪共识。
    maxRounds: Math.max(0, Math.min(2, Math.floor(options.maxRounds ?? 2))),
  }
}

const SCRIPT_LINES: readonly string[] = [
  '// 由 dsh-trader 生成：冻结 pack → 证据账本 → 有限多空审议 → 单一 RiskCritic',
  'const pack = args.pack',
  "if (pack === null || pack === undefined) throw new Error('缺少 args.pack')",
  'if (args.contextHash !== pack.contextHash) {',
  "  throw new Error('context pack mismatch: ' + String(args.contextHash) + ' != ' + String(pack.contextHash))",
  '}',
  'const prompts = args.prompts',
  'const schemas = args.schemas',
  'const maxRounds = Math.max(0, Math.min(2, Math.floor(Number(args.maxRounds))))',
  '',
  'function render(prefix, parts) {',
  '  if (parts === null || parts === undefined || parts.length === 0) return prefix',
  '  const chunks = []',
  '  for (let i = 0; i < parts.length; i += 1) {',
  "    chunks.push('--- 材料 ' + (i + 1) + ' ---\\n' + JSON.stringify(parts[i], null, 2))",
  '  }',
  "  return prefix + '\\n\\n' + chunks.join('\\n\\n')",
  '}',
  '',
  '// ↓↓↓ 纯校验函数嵌入沙箱，库与真实 workflow 共用一份实现 ↓↓↓',
  ...validateEvidenceReports.toString().split('\n'),
  '',
  ...validateDebateArgument.toString().split('\n'),
  '',
  ...validateRiskAssessment.toString().split('\n'),
  '',
  ...detectFactConflicts.toString().split('\n'),
  '',
  ...collectOpenDisagreements.toString().split('\n'),
  '// ↑↑↑ 嵌入结束 ↑↑↑',
  '',
  "phase('analysts')",
  'const rawReports = await parallel([',
  "  () => agent(render(prompts.market, [pack]), { label: 'market', schema: schemas.report }),",
  "  () => agent(render(prompts.flow, [pack]), { label: 'flow', schema: schemas.report }),",
  "  () => agent(render(prompts.news, [pack]), { label: 'news', schema: schemas.report }),",
  "  () => agent(render(prompts.onchain, [pack]), { label: 'onchain', schema: schemas.report }),",
  '])',
  'const reportValidation = validateEvidenceReports(pack, rawReports)',
  'const reports = reportValidation.accepted',
  'const evidenceIssues = reportValidation.evidenceIssues.slice()',
  'const acceptedEvidencePaths = []',
  'for (let i = 0; i < reports.length; i += 1) {',
  '  const keys = Object.keys(reports[i].keyNumbers || {})',
  '  for (let k = 0; k < keys.length; k += 1) if (acceptedEvidencePaths.indexOf(keys[k]) === -1) acceptedEvidencePaths.push(keys[k])',
  '}',
  'const conflicts = detectFactConflicts(reports)',
  'for (let i = 0; i < conflicts.length; i += 1) evidenceIssues.push({ stage: "workflow", code: "value_mismatch", kind: "value_mismatch", message: "验证报告之间存在事实冲突：" + conflicts[i].key })',
  '',
  'const dossier = {',
  '  packId: pack.packId,',
  '  contextHash: pack.contextHash,',
  '  symbol: pack.symbol,',
  '  timeframe: pack.timeframe,',
  '  features: pack.features,',
  '  deskState: pack.deskState,',
  '  reports: reports,',
  '  evidenceIssues: evidenceIssues,',
  '  acceptedEvidencePaths: acceptedEvidencePaths,',
  '}',
  '',
  'let bull = null',
  'let bear = null',
  'const debateIssues = []',
  'let rounds = 0',
  "phase('debate')",
  'while (rounds < maxRounds && reports.length > 0) {',
  "  const rawBull = await agent(render(prompts.bull, [dossier, bear]), { label: 'bull', schema: schemas.argument })",
  '  const bullValidation = validateDebateArgument(pack, rawBull, acceptedEvidencePaths)',
  '  bull = bullValidation.accepted',
  '  for (let i = 0; i < bullValidation.evidenceIssues.length; i += 1) debateIssues.push(bullValidation.evidenceIssues[i])',
  "  const rawBear = await agent(render(prompts.bear, [dossier, bull]), { label: 'bear', schema: schemas.argument })",
  '  const bearValidation = validateDebateArgument(pack, rawBear, acceptedEvidencePaths)',
  '  bear = bearValidation.accepted',
  '  for (let i = 0; i < bearValidation.evidenceIssues.length; i += 1) debateIssues.push(bearValidation.evidenceIssues[i])',
  '  rounds += 1',
  '  if ((bull !== null && bull.concede === true) || (bear !== null && bear.concede === true)) break',
  '}',
  'for (let i = 0; i < debateIssues.length; i += 1) evidenceIssues.push(debateIssues[i])',
  '',
  'let risk = null',
  'const riskIssues = []',
  "if (reports.length > 0) { phase('risk')",
  "  const rawRisk = await agent(render(prompts.risk, [dossier, { bull: bull, bear: bear, rounds: rounds, evidenceIssues: debateIssues }]), { label: 'riskCritic', schema: schemas.risk })",
  '  const riskEvidencePaths = []',
  '  const featureKeys = Object.keys(pack.features || {})',
  '  for (let i = 0; i < featureKeys.length; i += 1) {',
  '    const path = featureKeys[i]',
  '    const value = pack.features[path]',
  '    if (typeof value === "number" && Number.isFinite(value)) riskEvidencePaths.push(path)',
  '  }',
  '  const riskValidation = validateRiskAssessment(pack, rawRisk, riskEvidencePaths)',
  '  risk = riskValidation.accepted',
  '  for (let i = 0; i < riskValidation.evidenceIssues.length; i += 1) { riskIssues.push(riskValidation.evidenceIssues[i]); evidenceIssues.push(riskValidation.evidenceIssues[i]) }',
  '} else {',
  '  evidenceIssues.push({ stage: "workflow", code: "no_valid_reports", kind: "no_valid_reports", message: "没有有效分析师报告" })',
  '}',
  'if (reports.length > 0 && (bull === null || bear === null)) evidenceIssues.push({ stage: "workflow", code: "no_valid_debate", kind: "no_valid_debate", message: "没有完整有效的多空辩论" })',
  'if (reports.length > 0 && risk === null) evidenceIssues.push({ stage: "workflow", code: "no_valid_risk", kind: "no_valid_risk", message: "没有有效的 RiskCritic 评估" })',
  'const debate = { bull: bull, bear: bear, rounds: rounds, evidenceIssues: debateIssues }',
  'const openDisagreements = collectOpenDisagreements(reports, evidenceIssues, debate, risk)',
  'return {',
  '  packId: pack.packId,',
  '  contextHash: pack.contextHash,',
  '  reports: reports,',
  '  evidenceIssues: evidenceIssues,',
  '  conflicts: conflicts,',
  '  debate: debate,',
  '  risk: risk,',
  '  openDisagreements: openDisagreements,',
  '}',
]

export function buildJudgmentWorkflowScript(): string {
  return SCRIPT_LINES.join('\n')
}

// ── 进程内执行（供测试与回放使用）────────────────────────────────

export interface WorkflowHooks {
  readonly agent: (
    prompt: string,
    options?: { readonly label?: string; readonly schema?: unknown },
  ) => Promise<unknown>
  readonly parallel?: (thunks: readonly (() => Promise<unknown>)[]) => Promise<readonly unknown[]>
  readonly phase?: (title: string) => void
  readonly log?: (message: string) => void
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>

export function executeWorkflowScript(script: string, args: WorkflowArgs, hooks: WorkflowHooks): Promise<unknown> {
  const parallel = hooks.parallel ?? ((thunks: readonly (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t())))
  const phase = hooks.phase ?? ((): void => {})
  const log = hooks.log ?? ((): void => {})
  const run = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', script)
  return run(args, hooks.agent, parallel, phase, log)
}
