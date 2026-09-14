/**
 * 判断流程的 workflow 脚本（plan §5.3 / T1.1）。
 *
 * 为什么把脚本当**数据**并从 TS 生成：
 *   · `workflow` 工具的脚本跑在沙箱里（没有 import、没有文件系统），所有逻辑必须内联；
 *   · 但"冲突检测/分歧汇总"必须是**被测过的那一份** —— 于是用 `.toString()` 把
 *     `pack.ts` 里的自包含纯函数**按源码嵌入**，杜绝脚本与库两份实现漂移。
 *
 * 同时提供 `executeWorkflowScript`：用假的 `agent/parallel/phase/log` 在进程内跑这段真实脚本文本，
 * 因此 T1.1 可以在 CI 里被完整验证（不需要模型、不需要 workflow 工具）。
 */

import { collectOpenDisagreements, detectFactConflicts } from './pack.js'
import { buildWorkflowPrompts, type WorkflowPrompts } from './prompts.js'
import type { JudgmentPack } from './types.js'

/** 与 workflow 工具支持的 schema 子集保持一致（type/properties/required/additionalProperties/items/enum）。 */
export const WORKFLOW_SCHEMAS = {
  report: {
    type: 'object',
    additionalProperties: false,
    required: ['agent', 'verdict', 'keyNumbers', 'summary', 'artifactRef'],
    properties: {
      agent: { type: 'string' },
      verdict: { type: 'string', enum: ['bullish', 'bearish', 'neutral', 'unknown'] },
      keyNumbers: { type: 'object', additionalProperties: true },
      summary: { type: 'string' },
      artifactRef: { type: 'string' },
    },
  },
  argument: {
    type: 'object',
    additionalProperties: false,
    required: ['points', 'concede'],
    properties: {
      points: { type: 'array', items: { type: 'string' } },
      concede: { type: 'boolean' },
    },
  },
  risk: {
    type: 'object',
    additionalProperties: false,
    required: ['stance', 'concerns'],
    properties: {
      stance: { type: 'string', enum: ['favor', 'oppose', 'neutral'] },
      concerns: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

export interface WorkflowArgs {
  readonly pack: JudgmentPack
  readonly contextHash: string
  readonly prompts: WorkflowPrompts
  readonly schemas: typeof WORKFLOW_SCHEMAS
  readonly maxRounds: number
  readonly maxRiskRounds: number
}

export interface WorkflowArgsOptions {
  readonly maxRounds?: number
  readonly maxRiskRounds?: number
}

/** 组装脚本入参：pack 与 prompts 都是 JSON 可序列化的（函数不能跨沙箱）。 */
export function buildWorkflowArgs(
  pack: JudgmentPack,
  options: WorkflowArgsOptions = {},
): WorkflowArgs {
  return {
    pack,
    contextHash: pack.contextHash,
    prompts: buildWorkflowPrompts(),
    schemas: WORKFLOW_SCHEMAS,
    maxRounds: options.maxRounds ?? 3,
    maxRiskRounds: options.maxRiskRounds ?? 2,
  }
}

const SCRIPT_LINES: readonly string[] = [
  '// 由 dsh-trader 生成：冻结 pack 校验 → 并行分析师 → 冲突消解 → 多空辩论 → 风控三方',
  'const pack = args.pack',
  "if (pack === null || pack === undefined) throw new Error('缺少 args.pack')",
  'if (args.contextHash !== pack.contextHash) {',
  "  throw new Error('context pack mismatch: ' + String(args.contextHash) + ' != ' + String(pack.contextHash))",
  '}',
  'const prompts = args.prompts',
  'const schemas = args.schemas',
  'const maxRounds = args.maxRounds',
  'const maxRiskRounds = args.maxRiskRounds',
  '',
  '// 与 prompts.ts 的 renderPrompt 语义一致（前缀 + 逐份 JSON 材料）',
  'function render(prefix, parts) {',
  '  if (parts === null || parts === undefined || parts.length === 0) return prefix',
  '  const chunks = []',
  '  for (let i = 0; i < parts.length; i += 1) {',
  "    chunks.push('--- 材料 ' + (i + 1) + ' ---\\n' + JSON.stringify(parts[i], null, 2))",
  '  }',
  "  return prefix + '\\n\\n' + chunks.join('\\n\\n')",
  '}',
  '',
  '// ↓↓↓ 以下两个函数由 pack.ts 的源码嵌入，保证沙箱与库不漂移 ↓↓↓',
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
  'const reports = rawReports.filter(function (report) { return report !== null && report !== undefined })',
  'if (reports.length === 0) return { error: "no analyst report", contextHash: pack.contextHash }',
  '',
  'let conflicts = detectFactConflicts(reports)',
  'if (conflicts.length > 0) {',
  "  phase('reconcile')",
  '  const conflictsBefore = conflicts',
  "  const reconciled = await agent(render(prompts.reconcile, [{ reports: reports, conflicts: conflictsBefore }]), { label: 'reconcile', schema: schemas.report })",
  '  if (reconciled !== null && reconciled !== undefined) {',
  '    // 冲突键**以消解结果为准**：从其它报告中剔除这些键，否则冲突会永远存在',
  '    const resolved = []',
  '    const unresolved = []',
  '    for (let i = 0; i < conflictsBefore.length; i += 1) {',
  '      const key = conflictsBefore[i].key',
  '      const numbers = reconciled.keyNumbers || {}',
  '      if (typeof numbers[key] === "number") resolved.push(key)',
  '      else unresolved.push(key)',
  '    }',
  '    for (let i = 0; i < reports.length; i += 1) {',
  '      const original = reports[i].keyNumbers || {}',
  '      const kept = {}',
  '      const keys = Object.keys(original)',
  '      for (let k = 0; k < keys.length; k += 1) {',
  '        if (resolved.indexOf(keys[k]) === -1) kept[keys[k]] = original[keys[k]]',
  '      }',
  '      reports[i].keyNumbers = kept',
  '    }',
  '    reports.push(reconciled)',
  '  }',
  '  // 未能消解的键保留在其它报告中 ⇒ 重新检测时会再次出现（不会被静默吞掉）',
  '  conflicts = detectFactConflicts(reports)',
  '}',
  '',
  '// 辩手拿到的是**完整材料**（pack 摘要 + 全部报告 + 冲突），不是摘要',
  'const dossier = {',
  '  packId: pack.packId,',
  '  contextHash: pack.contextHash,',
  '  symbol: pack.symbol,',
  '  timeframe: pack.timeframe,',
  '  features: pack.features,',
  '  deskState: pack.deskState,',
  '  reports: reports,',
  '  conflicts: conflicts,',
  '}',
  '',
  "phase('debate')",
  'let bull = null',
  'let bear = null',
  'let rounds = 0',
  'while (rounds < maxRounds) {',
  "  bull = await agent(render(prompts.bull, [dossier, bear]), { label: 'bull', schema: schemas.argument })",
  "  bear = await agent(render(prompts.bear, [dossier, bull]), { label: 'bear', schema: schemas.argument })",
  '  rounds += 1',
  '  if ((bull !== null && bull.concede === true) || (bear !== null && bear.concede === true)) break',
  '}',
  '',
  "phase('risk')",
  'let aggressive = null',
  'let conservative = null',
  'let neutral = null',
  'let riskRounds = 0',
  'while (riskRounds < maxRiskRounds) {',
  "  aggressive = await agent(render(prompts.aggressive, [dossier, bull, bear, conservative, neutral]), { label: 'aggressive', schema: schemas.risk })",
  "  conservative = await agent(render(prompts.conservative, [dossier, bull, bear, aggressive, neutral]), { label: 'conservative', schema: schemas.risk })",
  "  neutral = await agent(render(prompts.neutral, [dossier, bull, bear, aggressive, conservative]), { label: 'neutral', schema: schemas.risk })",
  '  riskRounds += 1',
  '}',
  '',
  '// 只回「结构化字段 + 工件指针」，不回散文摘要（plan §5.3）',
  'return {',
  '  packId: pack.packId,',
  '  contextHash: pack.contextHash,',
  '  reports: reports.map(function (report) {',
  '    return {',
  '      agent: report.agent,',
  '      verdict: report.verdict,',
  '      keyNumbers: report.keyNumbers,',
  '      artifactRef: report.artifactRef,',
  '    }',
  '  }),',
  '  conflicts: conflicts,',
  '  debate: { bull: bull, bear: bear, rounds: rounds },',
  '  risk: { aggressive: aggressive, conservative: conservative, neutral: neutral, rounds: riskRounds },',
  '  openDisagreements: collectOpenDisagreements(reports, conflicts, bull, bear, aggressive, conservative),',
  '}',
]

export function buildJudgmentWorkflowScript(): string {
  return SCRIPT_LINES.join('\n')
}

// ── 进程内执行（供测试与 T1.7 的 A/B 回放使用）────────────────────────────────

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

/**
 * 用注入的钩子执行 workflow 脚本正文。脚本只允许使用 `args/agent/parallel/phase/log`
 * 与标准 JS —— 与 workflow 工具的沙箱契约一致。
 */
export function executeWorkflowScript(
  script: string,
  args: WorkflowArgs,
  hooks: WorkflowHooks,
): Promise<unknown> {
  const parallel =
    hooks.parallel ?? ((thunks: readonly (() => Promise<unknown>)[]) => Promise.all(thunks.map((t) => t())))
  const phase = hooks.phase ?? ((): void => {})
  const log = hooks.log ?? ((): void => {})
  const run = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', script)
  return run(args, hooks.agent, parallel, phase, log)
}
