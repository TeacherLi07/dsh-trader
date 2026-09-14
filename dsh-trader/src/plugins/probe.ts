/**
 * `trade-probe` —— T0.9 的最小闭环探针（**默认关闭**，只用于验证机制）。
 *
 * 它验证 plan §4.6 R1/R2 两条假设的**语义行为**（不只是 API 存在）：
 *   1. 插件进程内 `ctx.agents.resume()` 能拉起**非用户创建**的持久会话，且 `followup` 能驱动回合；
 *   2. 投递消息的 `source` 标签确实被持久化并区分"非用户输入"（`form: 'notice'`）。
 *
 * ⚠️ 关键实现约束（踩过）：**不能在 `apply` 期间调用 `ctx.agents.create/resume`**。
 * agent factory 由 `dsh-agent-loop` 注册，而它的 apply 晚于插件 include 条目 —— 在 `apply` 里调用会
 * 直接抛 `no agent factory registered`，并且如果 `await` 等待它出现就会**死锁**（loader 在等我们返回）。
 * 因此这里挂 `agent/created`、以**即发即忘**的方式在 agent 生命周期开始后再操作。
 *
 * 结果写到 `resultPath`；外层脚本还会解压 session 日志做落盘层面的独立核验。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent' // 载入 cordis Events/Context 的模块增强
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { writeFileSync } from 'node:fs'

export const name = 'trade-probe'
export const inject = ['agents']

export const Config = z.object({
  enabled: z.boolean().default(false),
  sessionId: z.string().required(),
  resultPath: z.string().required(),
  marker: z.string().default('TRADE-PROBE-NOTICE'),
  timeoutMs: z.number().default(120000),
})

export interface ProbeConfig {
  enabled?: boolean
  sessionId: string
  resultPath: string
  marker?: string
  timeoutMs?: number
}

interface Observed {
  assistantBySession: Map<string, number>
  injectedSessionId: string | undefined
  injectedSource: unknown
  userMessages: number
  otherTypes: Record<string, number>
}

export function apply(ctx: Context, config: ProbeConfig): void {
  if (config.enabled !== true) return

  const marker = config.marker ?? 'TRADE-PROBE-NOTICE'
  const observed: Observed = {
    assistantBySession: new Map(),
    injectedSessionId: undefined,
    injectedSource: undefined,
    userMessages: 0,
    otherTypes: {},
  }

  const listener = ((session: { id?: string }, event: { type: string; data?: unknown }): void => {
    const sessionId = String(session.id ?? 'unknown')
    if (event.type === 'user/message') {
      observed.userMessages += 1
      const data = event.data as { source?: unknown; content?: unknown } | undefined
      if (JSON.stringify(data?.content ?? '').includes(marker)) {
        observed.injectedSource = data?.source
        observed.injectedSessionId = sessionId
      }
      return
    }
    if (event.type === 'assistant/message') {
      observed.assistantBySession.set(sessionId, (observed.assistantBySession.get(sessionId) ?? 0) + 1)
      return
    }
    observed.otherTypes[event.type] = (observed.otherTypes[event.type] ?? 0) + 1
  }) as never
  ctx.on('session/event', listener)

  let started = false
  const onCreated = ((payload: { agent: Agent }): void => {
    if (started) return
    started = true
    void runProbe(ctx, config, marker, payload.agent, observed)
  }) as never
  ctx.on('agent/created', onCreated)
}

async function runProbe(
  ctx: Context,
  config: ProbeConfig,
  marker: string,
  rootAgent: Agent,
  observed: Observed,
): Promise<void> {
  const timeoutMs = config.timeoutMs ?? 120_000
  let resumed = false
  let created = false
  let attachError: string | null = null
  let followupError: string | null = null

  // ── R1：插件进程内 attach 一个**非用户创建**的持久会话（不存在则创建）────────────
  let handle: { agent: Agent } | undefined
  try {
    handle = await ctx.agents.resume({ resumeSessionId: config.sessionId as never })
    resumed = true
  } catch (resumeError) {
    attachError = String(resumeError)
    try {
      handle = await ctx.agents.create({ sessionId: config.sessionId as never })
      created = true
      attachError = null
    } catch (createError) {
      attachError = String(createError)
    }
  }

  // ── R2：向**活着的** root agent 投递一条 notice 来源的消息，并等回合跑完 ──────────
  const notice = (): ReturnType<typeof createUserMessage> =>
    createUserMessage({
      content: [{ type: 'text', text: `${marker}: 请只回复 probe-ack，不要调用任何工具。` }],
      source: {
        kind: 'plugin',
        plugin: 'trade-probe',
        form: 'notice',
        summary: 'trade probe notice',
      },
    })

  try {
    rootAgent.followup(notice())
    await Promise.race([
      rootAgent.whenIdle(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  } catch (caught) {
    followupError = String(caught)
  }

  // attach 成功的会话也投一条（尽力而为：进程可能先退出，不作为结论依据）
  if (handle !== undefined) {
    try {
      handle.agent.followup(notice())
    } catch (caught) {
      followupError = followupError ?? String(caught)
    }
  }

  const source = observed.injectedSource as
    | { kind?: string; form?: string; plugin?: string }
    | undefined
  const injectedSessionId = observed.injectedSessionId
  const assistantInInjectedSession =
    injectedSessionId === undefined
      ? 0
      : (observed.assistantBySession.get(injectedSessionId) ?? 0)

  writeFileSync(
    config.resultPath,
    JSON.stringify(
      {
        sessionId: config.sessionId,
        resumed,
        created,
        attachError,
        followupError,
        marker,
        userMessages: observed.userMessages,
        injectedSessionId: injectedSessionId ?? null,
        assistantMessagesInInjectedSession: assistantInInjectedSession,
        assistantBySession: Object.fromEntries(observed.assistantBySession),
        injectedSource: observed.injectedSource ?? null,
        otherTypes: observed.otherTypes,
        checks: {
          plugin_can_attach_persistent_session: resumed || created,
          attach_created_session_on_first_run: created,
          attach_resumed_session_on_later_run: resumed,
          followup_produced_assistant_message: assistantInInjectedSession > 0,
          injected_message_carries_notice_form: source?.form === 'notice',
          injected_message_is_not_user_source: source !== undefined && source.kind !== 'user',
        },
      },
      null,
      2,
    ),
  )
}
