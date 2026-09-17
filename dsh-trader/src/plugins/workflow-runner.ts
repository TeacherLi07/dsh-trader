/**
 * 固化判断 workflow 的生产工具（plan §5.4 / T2.9）。
 *
 * 这个入口故意不放进通用 agents/tools.ts：它不是一个普通的只读查询，而是
 * 一个带子 agent 生命周期、结构化输出和审计边界的组合工具。模型只能给出
 * symbol/timeframe，pack、脚本、子 agent 权限和结果校验全部由这里决定。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRuntime, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { WORKFLOW_TOOL_NAME } from '../agents/tool-roster.js'
import { featureValues } from '../market/context.js'
import type { FeatureSnapshot } from '../market/features.js'
import { recallLessons } from '../memory/recall.js'
import { freezeContextPack } from '../agents/pack.js'
import {
  buildJudgmentWorkflowScript,
  buildWorkflowArgs,
  executeWorkflowScript,
  WORKFLOW_SCRIPT_VERSION,
} from '../agents/workflow.js'
import { PROMPT_VERSION } from '../agents/prompts.js'
import type { JudgmentPack, JudgmentResult } from '../agents/types.js'
import type { TradePorts } from '../exec/ports.js'

const WORKFLOW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const

const WORKFLOW_PARAMETERS = {
  symbol: { type: 'string', required: true },
  timeframe: { type: 'string', required: true },
} as const

interface WorkflowRecord {
  readonly [key: string]: unknown
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function isRecord(value: unknown): value is WorkflowRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 生成完整规范路径表。与 DSL 上下文不同，pack 要保留缺失字段为 null，
 * 否则分析师无法区分“暖机/数据缺口”和“代码忘了提供这个字段”。
 */
export function workflowFeatureMap(snapshot: FeatureSnapshot | undefined, asOf: number): Readonly<Record<string, number | null>> {
  const values = snapshot?.values
  const mapped = featureValues(
    values ?? {
      open: Number.NaN,
      high: Number.NaN,
      low: Number.NaN,
      close: Number.NaN,
      volume: Number.NaN,
      ema20: null,
      ema50: null,
      rsi14: null,
      atr14: null,
      adx14: null,
      vwap20: null,
      zscore20: null,
      volRealized20: null,
      fundingRate: null,
      oiChangePct: null,
      liqNotional: null,
      basisBps: null,
    },
  )

  const paths = [
    'bar.open',
    'bar.high',
    'bar.low',
    'bar.close',
    'bar.volume',
    'ema20',
    'ema50',
    'rsi14',
    'atr14',
    'adx14',
    'vwap20',
    'zscore20',
    'volRealized20',
    'funding.rate',
    'oi.changePct',
    'liq.notional',
    'basis.bps',
  ] as const
  const out: Record<string, number | null> = {}
  for (const path of paths) out[path] = finiteOrNull(mapped[path] as number | undefined)

  // 新鲜度也是证据的一部分，必须使用同一份注入时钟，不能让模型猜测“现在”。
  out['data.snapshotOpenTime'] = finiteOrNull(snapshot?.openTime)
  out['data.snapshotCloseTime'] = finiteOrNull(snapshot?.closeTime)
  out['data.ageMs'] =
    snapshot !== undefined && Number.isFinite(snapshot.closeTime)
      ? Math.max(0, asOf - snapshot.closeTime)
      : null
  return out
}

export async function buildJudgmentPack(
  ports: TradePorts,
  symbol: string,
  timeframe: string,
): Promise<JudgmentPack> {
  if (!ports.symbols.includes(symbol)) throw new Error(`symbol 不在配置标的池中：${symbol}`)
  if (!ports.timeframes.includes(timeframe)) throw new Error(`timeframe 不在配置时间框中：${timeframe}`)

  const [account, positions] = await Promise.all([
    ports.broker.getAccount(),
    ports.broker.getPositions(),
  ])
  const snapshot = ports.features.latest(symbol, timeframe)
  // 先完成私有状态读取，再冻结唯一 asOf；pack 内所有年龄/TTL 都共享这个时点。
  const asOf = ports.clock.now()
  const active = ports.plans.active(symbol)
  const recall = recallLessons(ports.journal, { now: asOf, symbol, limit: 5 })
  const currentPosition = positions.find((position) => position.symbol === symbol)
  const features = {
    ...workflowFeatureMap(snapshot, asOf),
    // 风险批评者需要能引用账户/当前标的状态；这些值同样来自本轮冻结快照，
    // 不允许它在 workflow 内自行重取或用 analyst 报告间接猜测。
    'equity.quote': finiteOrNull(account.equityQuote),
    // 本轮已经成功重取全部持仓；找不到当前标的是可验证的空仓，
    // 不是“持仓数据缺失”。用 0 保留两者的语义区分。
    'position.qty': finiteOrNull(currentPosition?.qty ?? 0),
    'position.avgPrice': finiteOrNull(currentPosition?.avgPrice ?? 0),
    'position.unrealizedPnl': finiteOrNull(currentPosition?.unrealizedPnlUsd ?? 0),
    'account.openOrders': finiteOrNull(account.openOrders),
    'account.totalExposureUsd': finiteOrNull(account.totalExposureUsd),
    'account.leverage': finiteOrNull(account.leverage),
    'account.dailyLossUsd': finiteOrNull(account.dailyLossUsd),
    'account.drawdownUsd': finiteOrNull(account.drawdownUsd),
    'account.consecutiveLosses': finiteOrNull(account.consecutiveLosses),
    'account.spreadBps': finiteOrNull(account.spreadBps),
  }

  return freezeContextPack({
    symbol,
    timeframe,
    asOf,
    features,
    featureFingerprint: snapshot?.fingerprint ?? null,
    deskState: {
      equityQuote: account.equityQuote,
      positions: positions.map((position) => ({
        symbol: position.symbol,
        qty: position.qty,
        avgPrice: position.avgPrice,
      })),
      openOrders: account.openOrders,
    },
    ...(active === undefined
      ? {}
      : { plan: { planId: active.planId, contentHash: active.contentHash } }),
    lessons: recall.lessons
      .map((lesson) => lesson.lessonId)
      .filter((lessonId): lessonId is string => typeof lessonId === 'string' && lessonId.trim().length > 0)
      .map((lessonId) => ({ lessonId })),
  })
}

function assertJudgmentResult(value: unknown, pack: JudgmentPack): asserts value is JudgmentResult {
  if (!isRecord(value)) throw new Error('workflow 返回值不是对象')
  if (value.packId !== pack.packId || value.contextHash !== pack.contextHash) {
    throw new Error('workflow 返回值与冻结 pack/contextHash 不一致')
  }
  for (const key of ['reports', 'evidenceIssues', 'conflicts', 'openDisagreements'] as const) {
    if (!Array.isArray(value[key])) throw new Error(`workflow 返回值缺少数组字段：${key}`)
  }
  const debate = value.debate
  if (!isRecord(debate) || !Array.isArray(debate.evidenceIssues) || typeof debate.rounds !== 'number') {
    throw new Error('workflow 返回值的 debate 形状无效')
  }
  if (debate.bull !== null && !isRecord(debate.bull)) throw new Error('workflow 返回值的 bull 形状无效')
  if (debate.bear !== null && !isRecord(debate.bear)) throw new Error('workflow 返回值的 bear 形状无效')
  if (value.risk !== null && !isRecord(value.risk)) throw new Error('workflow 返回值的 risk 形状无效')
}

export interface WorkflowRunnerDeps {
  readonly subagents: Pick<SubagentRuntime, 'start'>
  readonly parent: Agent
  readonly signal: AbortSignal
}

/** 运行固定 workflow；单测可以注入 fake subagents，不需要启动完整 DSH。 */
export async function runJudgmentWorkflow(
  ports: TradePorts,
  symbol: string,
  timeframe: string,
  deps: WorkflowRunnerDeps,
): Promise<JudgmentResult> {
  const pack = await buildJudgmentPack(ports, symbol, timeframe)
  const script = buildJudgmentWorkflowScript()
  let childCount = 0
  const result = await executeWorkflowScript(script, buildWorkflowArgs(pack), {
    agent: async (prompt, options) => {
      childCount += 1
      let run: SubagentRun | undefined
      try {
        run = await deps.subagents.start('spawn', {
          label: options?.label,
          prompt: [{ type: 'text', text: prompt }],
          parent: deps.parent,
          signal: deps.signal,
          outputSchema: options?.schema as ObjectJsonSchema,
          maxDepth: 1,
          // DSH 明确说明 child 不继承 parent restriction；在这里重新建立零工具面。
          toolFilter: { allow: [] },
        })
        const settled = await run.result
        return settled.stopReason === 'completed' ? settled.structured ?? null : null
      } finally {
        // start 成功后所有权已转给调用方，即使模型失败也必须收敛 child。
        if (run !== undefined) await run.dispose()
      }
    },
  })

  assertJudgmentResult(result, pack)
  ports.journal.appendAudit({
    actor: 'system',
    kind: 'judgment_workflow_result',
    payload: {
      packId: pack.packId,
      contextHash: pack.contextHash,
      scriptVersion: WORKFLOW_SCRIPT_VERSION,
      promptVersion: PROMPT_VERSION,
      agentsCount: childCount,
      evidenceIssueCount: result.evidenceIssues.length,
      result,
      pack: {
        symbol: pack.symbol,
        timeframe: pack.timeframe,
        asOf: pack.asOf,
        contextHash: pack.contextHash,
        features: pack.features,
        featureFingerprint: pack.featureFingerprint ?? null,
      },
    },
    ts: pack.asOf,
  })
  return result
}

export function createWorkflowTool(
  portsProvider: () => TradePorts | undefined,
  subagents: Pick<SubagentRuntime, 'start'>,
) {
  return defineTool({
    name: WORKFLOW_TOOL_NAME,
    description: '固定协作判断：冻结证据 pack，运行分析师/多空/RiskCritic workflow，返回结构化证据工件。',
    parameters: WORKFLOW_PARAMETERS,
    output: {
      schema: WORKFLOW_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) ?? 'null' }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const ports = portsProvider()
      if (ports === undefined) throw new Error('交易组合根尚未就绪，请稍后重试')
      if (!isRecord(args) || typeof args.symbol !== 'string' || typeof args.timeframe !== 'string') {
        throw new Error('trade_workflow_run 只接受 symbol 与 timeframe')
      }
      try {
        if (exec.agent === undefined) throw new Error('trade_workflow_run 必须由 desk agent 调用')
        return (await runJudgmentWorkflow(ports, args.symbol, args.timeframe, {
          subagents,
          parent: exec.agent,
          signal: exec.signal,
        })) as unknown as Record<string, JsonValue>
      } catch (error) {
        ports.journal.appendAudit({
          actor: 'system',
          kind: 'judgment_workflow_failed',
          payload: {
            symbol: args.symbol,
            timeframe: args.timeframe,
            scriptVersion: WORKFLOW_SCRIPT_VERSION,
            promptVersion: PROMPT_VERSION,
            reason: String(error),
          },
          ts: ports.clock.now(),
        })
        throw error
      }
    },
  })
}

export { WORKFLOW_TOOL_NAME }

/** tools-desk 的 effect 只注册这一件特殊工具，卸载时必须同步撤销。 */
export function registerWorkflowTool(
  ctx: Context,
  portsProvider: () => TradePorts | undefined,
  label = 'trade.tools-desk.workflow.close',
): void {
  ctx.effect(() => {
    const dispose = ctx.tools.register(createWorkflowTool(portsProvider, ctx.subagents))
    return dispose
  }, label)
}
