/**
 * trade-supervisor —— 无人值守的发动机：W1 窗口唤醒 + 心跳。
 *
 * 职责边界（plan §2）：
 *   · **W1**：审议窗到点 ⇒ 用 `notice` 唤醒 desk agent，让它产出/刷新计划卡；
 *   · **机械执行**不在本插件：由 `live-engine` 在每根已收盘 bar 上匹配计划卡并执行（market 插件驱动）；
 *   · **W2/W3** 的路由是纯函数（`supervisor/windows.ts` 的 `decideWake`），预算/限流都走代码。
 *
 * ⚠️ 两条实测约束（plan §2 ★、`plugins/probe.ts`）：
 *   1. **不能在 `apply` 期间调用 `ctx.agents.create/resume`** —— agent factory 由 `dsh-agent-loop`
 *      注册，若在 apply 里 await 等待会死锁 plugin loader。这里只在**窗口触发时**（定时器回调，
 *      早已脱离 apply）才 attach。
 *   2. 心跳的撤单动作不能只放在进程内：进程死亡时本插件自己也死了；真正的撤单由**进程外** watchdog
 *      或交易所原生 dead-man 执行（plan §6.3）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentOptions,
  AgentSetup,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent' // 载入 cordis Events/Context 的模块增强
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { systemClock } from '../clock.js'
import { dayKey, PriceTableStore, priceTableStaleAlert } from '../cost-ledger.js'
import { getDatabase } from '../db/runtime.js'
import { Statements } from '../db/statements.js'
import { DecisionJournal } from '../exec/journal.js'
import { RUNTIME_IMPLEMENTED_TOOL_NAMES } from '../agents/tool-roster.js'
import type { TradePorts } from '../exec/ports.js'
import { HeartbeatStore } from '../supervisor/heartbeat.js'
import { dueWindows, validateWindowSpec, windowDedupKey, type WindowFire, type WindowSpec } from '../supervisor/windows.js'
import { getExecPorts } from './exec.js'
import { assertWiredSupervisorConfig } from '../supervisor/config-guard.js'
import { setupRoleToolRestriction } from './tools-adapter.js'

export const name = 'trade-supervisor'
/** 需要 agents 服务才能唤醒 desk；心跳与行情不依赖它。 */
export const inject = ['agents']

export const Config = z.object({
  deskSessionId: z.string().required(),
  l2: z.object({ provider: z.string(), model: z.string() }),
  l3: z.object({ provider: z.string(), model: z.string() }),
  l3MinIntervalMs: z.number(),
  dailyBudgetUsd: z.number(),
  heartbeatMs: z.number(),
  windows: z.array(z.object({ id: z.string(), at: z.string(), everyMs: z.number() })),
  windowScanMs: z.number(),
  wakeTimeoutMs: z.number(),
  /** desk 会话的 cwd；系统提示的 `{{cwd}}` 变量（persona-suffix）需要它，缺了会直接报错。 */
  deskCwd: z.string(),
})

export interface SupervisorConfig {
  deskSessionId: string
  l2?: { provider?: string; model?: string }
  l3?: { provider?: string; model?: string }
  l3MinIntervalMs?: number
  dailyBudgetUsd?: number
  heartbeatMs?: number
  /** W1 审议窗；`at` 为 UTC 时刻，`everyMs` 为间隔（`at` 优先）。 */
  windows?: readonly WindowSpec[]
  windowScanMs?: number
  wakeTimeoutMs?: number
  /** 默认取 dsh 进程的 cwd；必须是**绝对路径**（会话元数据会校验）。 */
  deskCwd?: string
}

const DEFAULT_WINDOWS: readonly WindowSpec[] = [
  { id: 'pre_session', at: '00:30Z' },
  { id: 'midday', everyMs: 14_400_000 },
  { id: 'post_session', at: '23:30Z' },
]

const MAX_NOTICE_SUMMARY = 120

export interface DeskAgentLifecycleInput {
  readonly sessionId: string
  readonly agentOptions: AgentOptions
  readonly deskCwd: string
  /** 当前已注册且允许作为 judge 候选的工具；workflow 专用工具由调用方追加。 */
  readonly availableToolNames: readonly string[]
}

export interface DeskAgentLifecycleOptions {
  readonly setup: AgentSetup
  readonly create: CreateAgentOptions
  readonly resume: ResumeAgentOptions
}

/**
 * 生成 desk 的两条真实生命周期 options。
 *
 * DSH 的 resume 同样会重新创建 scoped context；只给 create 安装限制会让崩溃恢复
 * 后的 desk 回到全局工具面，因此 create/resume 明确共享同一份 judge setup。
 */
export function deskAgentLifecycleOptions(
  input: DeskAgentLifecycleInput,
): DeskAgentLifecycleOptions {
  // 当前生产路径只有 supervisor → desk judge；analyst/research/risk 子 agent 尚未由
  // supervisor 创建，因此这里只给通用 helper 留角色参数，不伪造不存在的生命周期路径。
  const setup = setupRoleToolRestriction('judge', input.availableToolNames)
  return {
    setup,
    create: {
      sessionId: input.sessionId as never,
      agentOptions: input.agentOptions,
      meta: { cwd: input.deskCwd },
      setup,
    },
    resume: {
      resumeSessionId: input.sessionId as never,
      agentOptions: input.agentOptions,
      setup,
    },
  }
}

/**
 * W1 事件包 + notice 文案（plan §5.1：`summary` ≤ 120 字符硬上限）。
 *
 * 数字只用于**理解**，不用于计算：真正的仓位/权益由工具在下单前重新向交易所重取（§6.2）。
 */
export function buildWindowNotice(
  fire: WindowFire,
  ports: TradePorts | undefined,
): { readonly summary: string; readonly text: string } {
  const lines: string[] = [`W1 审议窗 ${fire.id}（${new Date(fire.fireTs).toISOString()}）。`]
  if (ports === undefined) {
    lines.push('执行组合根尚未就绪：本轮只做判断，不要调用下单类工具。')
  } else {
    try {
      const active = ports.plans.active(ports.symbols[0] ?? '')
      lines.push(
        `标的 ${ports.symbols.join(', ')}；时间框 ${ports.timeframes.join(', ')}；` +
          `active 计划卡 ${active === undefined ? '无' : active.planId}。`,
      )
    } catch (error) {
      lines.push(`读取本地计划卡失败：${String(error)}。`)
    }
  }
  lines.push(
    '请按你的角色判断本窗口是否有值得执行的机会：',
    '1) 对每个配置标的/时间框先调用 trade_workflow_run；不得跳过协作直接提交开仓计划。',
    '2) 阅读 workflow 返回的 evidenceIssues、openDisagreements 与 risk，再决定下一步；',
    '3) 只有证据收敛且风险允许时才调用 trade_plan_card；否则记录 NO_TRADE 或 REVIEW；',
    '4) 数量/价位由代码推导，拿不准时不要硬凑方向。',
  )
  return {
    summary: `W1 ${fire.id}: 交易窗口到点，请复核并决定是否更新计划卡`.slice(0, MAX_NOTICE_SUMMARY),
    text: lines.join('\n'),
  }
}

export function apply(ctx: Context, config: SupervisorConfig): void {
  // `l2` / `l3MinIntervalMs` / `dailyBudgetUsd` 目前不生效（W2/W3 未接线）：配了就拒绝启动。
  assertWiredSupervisorConfig({
    l2: config.l2,
    l3MinIntervalMs: config.l3MinIntervalMs,
    dailyBudgetUsd: config.dailyBudgetUsd,
  })
  const logger = ctx.logger('trade-supervisor')
  const clock = systemClock()
  const database = getDatabase()
  const journal = new DecisionJournal(database)
  const heartbeat = new HeartbeatStore(new Statements(database), (event) => {
    journal.appendAudit(event)
  })
  const heartbeatMs = config.heartbeatMs ?? 15_000

  // 显式声明 W2/W3 的状态（审计 S7）。旧实现是"不接线"的静默状态：配置和纯函数都在，
  // 看起来逃逸通道在工作，实际 `decideWake`/`claim` 都没有调用方。把关闭写成可审计的事实。
  logger.info('W2/W3 判断通道未启用（P1.5 判定：关闭；decideWake/claim 未接线）；本进程只驱动 W1 审议窗')
  journal.appendAudit({
    actor: 'system',
    kind: 'w2w3_disabled',
    payload: {
      reason: 'P1.5 闸门判定关闭 W2/W3；decideWake 与 TriggerQueue.claim 在生产路径未接线',
      windows: (config.windows ?? DEFAULT_WINDOWS).map((window) => window.id),
    },
    ts: clock.now(),
  })

  // 价目表年龄检查（plan §12 #19）：>90 天 ⇒ P2 告警，**不阻塞**。
  // 按天节流：15s 心跳若每次都写审计会把 append-only 表刷爆，而价目表天级才变化。
  const prices = new PriceTableStore(database)
  let lastStaleDay: string | null = null
  const checkPriceTableAge = (): void => {
    const now = clock.now()
    const alert = priceTableStaleAlert(prices.ageDays(now), now)
    if (alert === null) {
      lastStaleDay = null
      return
    }
    const day = dayKey(now)
    if (day === lastStaleDay) return
    lastStaleDay = day
    journal.appendAudit({
      actor: 'system',
      kind: 'price_table_stale',
      payload: { alert, ageDays: prices.ageDays(now) },
      ts: now,
    })
  }

  // 先写一条初始心跳，避免刚启动时 watchdog 把"尚未开始循环"误判成数据库缺失。
  heartbeat.beat(clock.now())
  checkPriceTableAge()
  const stopHeartbeat = clock.setInterval(() => {
    heartbeat.beat(clock.now())
    checkPriceTableAge()
  }, heartbeatMs)

  // ── W1 审议窗 ───────────────────────────────────────────────────────────────
  const specs = config.windows ?? DEFAULT_WINDOWS
  for (const spec of specs) {
    const errors = validateWindowSpec(spec)
    if (errors.length > 0) throw new Error(`W1 窗口配置非法：${errors.join('；')}`)
  }

  let deskAgent: Agent | undefined
  let attaching: Promise<Agent | undefined> | undefined
  let busy = false

  // 诊断：统计 desk 会话上的事件类型。用来回答"followup 到底有没有开出回合"，
  // 而不是靠"没看到计划卡"反推（实测：idleMs=9ms、会话只有 header）。
  const deskEventCounts: Record<string, number> = {}
  ctx.on(
    'session/event',
    ((session: { id?: string }, event: { type?: string }): void => {
      if (session?.id !== config.deskSessionId) return
      const type = String(event?.type ?? 'unknown')
      deskEventCounts[type] = (deskEventCounts[type] ?? 0) + 1
    }) as never,
  )
  const resetDeskEvents = (): void => {
    for (const key of Object.keys(deskEventCounts)) delete deskEventCounts[key]
  }

  // desk 回合若在模型调用处失败，错误经 `agent/error` 广播并被 kick 吞掉（不落会话）。
  // 必须显式接住它，否则"回合没产出"将永远不可诊断。
  ctx.on(
    'agent/error',
    ((payload: { agent?: { id?: string }; error?: unknown }): void => {
      if (payload?.agent?.id !== config.deskSessionId) return
      const message = String((payload.error as { message?: string } | undefined)?.message ?? payload.error)
      logger.error(`desk agent error：${message}`)
      journal.appendAudit({
        actor: 'system',
        kind: 'desk_agent_error',
        payload: { message },
        ts: clock.now(),
      })
    }) as never,
  )

  const ensureDeskAgent = async (): Promise<Agent | undefined> => {
    if (deskAgent !== undefined) return deskAgent
    if (attaching !== undefined) return attaching
    const agentOptions: { provider?: string; model?: string } = {}
    if (config.l3?.provider !== undefined) agentOptions.provider = config.l3.provider
    if (config.l3?.model !== undefined) agentOptions.model = config.l3.model
    // ★ 必须给 cwd：系统提示的 persona-suffix 段含 `{{cwd}}`，缺值会直接抛
    // `prompt variable "{{cwd}}" has no value for this assembly`，回合在模型调用前就失败
    // （实测：turn/start→step/end 6ms、零 assistant/message）。cwd 是**持久会话元数据**，
    // resume 时沿用会话里的值，因此只有在 create 时必须给对。
    const deskCwd = config.deskCwd ?? process.cwd()
    const lifecycle = deskAgentLifecycleOptions({
      sessionId: config.deskSessionId,
      agentOptions,
      deskCwd,
      availableToolNames: RUNTIME_IMPLEMENTED_TOOL_NAMES,
    })
    attaching = (async () => {
      // 首次 resume 失败（会话还不存在）即 create；两次都失败就本轮放弃并告警，不阻塞心跳。
      try {
        const handle = await ctx.agents.resume(lifecycle.resume)
        deskAgent = handle.agent
        return handle.agent
      } catch (resumeError) {
        try {
          const handle = await ctx.agents.create(lifecycle.create)
          deskAgent = handle.agent
          return handle.agent
        } catch (createError) {
          logger.error(`desk agent attach 失败：resume=${String(resumeError)} create=${String(createError)}`)
          return undefined
        }
      }
    })()
    try {
      return await attaching
    } finally {
      attaching = undefined
    }
  }

  const driveWindow = async (fire: WindowFire): Promise<void> => {
    const now = clock.now()
    if (busy) {
      // agent 忙时不打断，只入队/留痕（plan §2：仅 P0 持仓风险允许 steer）
      journal.appendAudit({
        actor: 'system',
        kind: 'w1_skipped_busy',
        payload: { windowId: fire.id, fireTs: fire.fireTs },
        ts: now,
      })
      return
    }
    busy = true
    try {
      const agent = await ensureDeskAgent()
      if (agent === undefined) {
        journal.appendAudit({
          actor: 'system',
          kind: 'w1_wake_failed',
          payload: { windowId: fire.id, fireTs: fire.fireTs, reason: 'desk agent 不可用' },
          ts: clock.now(),
        })
        return
      }
      const { summary, text } = buildWindowNotice(fire, getExecPorts())
      // 诊断：把"followup 到底有没有驱动出回合"变成可读证据，而不是靠猜。
      // （实测：会话只写了 header，w1_wake 在触发后 39ms 就落库 ⇒ 回合没跑。）
      const probe = agent as unknown as {
        readonly id?: string
        readonly status?: string
        followup?: (message: unknown) => unknown
        whenIdle?: () => Promise<void>
      }
      const hasFollowup = typeof probe.followup === 'function'
      const hasWhenIdle = typeof probe.whenIdle === 'function'
      let followupError: string | null = null
      // 必须在 followup **之前**清零：wakeDriver 会立刻开跑，事件可能在 followup 返回前就发出。
      resetDeskEvents()
      try {
        probe.followup?.(
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: 'trade-supervisor', form: 'notice', summary },
          }),
        )
      } catch (error) {
        followupError = String(error)
      }
      const idleStart = clock.now()
      const timeoutMs = config.wakeTimeoutMs ?? 300_000
      if (hasWhenIdle) {
        await Promise.race([
          probe.whenIdle?.(),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ])
      }
      journal.appendAudit({
        actor: 'system',
        kind: 'w1_wake',
        payload: {
          windowId: fire.id,
          fireTs: fire.fireTs,
          dedupKey: windowDedupKey(fire.id, fire.fireTs),
          agentId: probe.id ?? null,
          agentStatus: probe.status ?? null,
          hasFollowup,
          hasWhenIdle,
          followupError,
          idleMs: clock.now() - idleStart,
          deskEvents: { ...deskEventCounts },
        },
        ts: clock.now(),
      })
      logger.info(
        `W1 ${fire.id}: agent=${String(probe.id)} followup=${String(hasFollowup)} ` +
          `whenIdle=${String(hasWhenIdle)} idleMs=${String(clock.now() - idleStart)} err=${String(followupError)}`,
      )
    } catch (error) {
      logger.error(`W1 唤醒失败：${String(error)}`)
      journal.appendAudit({
        actor: 'system',
        kind: 'w1_wake_failed',
        payload: { windowId: fire.id, fireTs: fire.fireTs, reason: String(error) },
        ts: clock.now(),
      })
    } finally {
      busy = false
    }
  }

  // 游标 = **上一次已触发的窗口时刻**（不是"上一次扫描时刻"）。
  //
  // ★ 这是一个只有真跑才会暴露的 bug：`dueWindows(specs, since, now)` 的 `everyMs` 语义是
  // "从 since 起算下一发"，因此若每轮把 since 更新成 now，`since + everyMs` 永远在未来 ⇒
  // W1 **永远不会触发**（agent 永远不被唤醒，看起来在跑、实际零判断）。实测：启动 11 分钟
  // 无任何 w1_wake 审计。正确做法是只在**真的触发**之后把游标推进到该 fireTs；
  // 重启后以启动时刻为起点、历史窗口不补跑（判断必须发生在敞口打开之前）。
  let windowCursor = clock.now()
  const windowScanMs = config.windowScanMs ?? 60_000
  const stopWindows = clock.setInterval(() => {
    const now = clock.now()
    const fires = dueWindows([...specs], windowCursor, now)
    if (fires.length > 0) {
      let latest = windowCursor
      for (const fire of fires) if (fire.fireTs > latest) latest = fire.fireTs
      windowCursor = latest
    }
    for (const fire of fires) void driveWindow(fire)
  }, windowScanMs)

  ctx.effect(
    () => () => {
      stopHeartbeat()
      stopWindows()
      /* 解除会话绑定由 agent handle 的 owner（本插件的 fiber）负责 */
    },
    'trade.supervisor.close',
  )
}
