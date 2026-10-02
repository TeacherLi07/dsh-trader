/**
 * trade-commands —— 人工介入面：/halt 与 /resume。
 *
 * 命令工厂与 Cordis 适配分开：工厂只依赖明确端口，测试不需要伪造 Context；
 * 适配层只负责取得数据库、注册命令和释放注册。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Clock } from '../clock.js'
import { systemClock } from '../clock.js'
import { getDatabase } from '../db/runtime.js'
import { Statements } from '../db/statements.js'
import type { Broker } from '../exec/broker.js'
import { DecisionJournal } from '../exec/journal.js'
import { HeartbeatStore, type HeartbeatAuditEvent } from '../supervisor/heartbeat.js'
import { getExecPorts } from './exec.js'

export const name = 'trade-commands'
export const inject = ['commands']

export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

export interface CommandInvocation {
  readonly rawInput?: string
}

export interface HaltHandlerDeps {
  readonly heartbeat: Pick<HeartbeatStore, 'halt'>
  readonly clock: Clock
  /** 调用时解析，避免 apply 早于执行 runtime 时永久捕获 undefined。 */
  readonly brokerProvider?: () => Pick<Broker, 'cancelAll'> | undefined
  readonly broker?: Pick<Broker, 'cancelAll'>
  readonly audit?: (event: HeartbeatAuditEvent) => void
}

export interface ResumeHandlerDeps {
  readonly heartbeat: Pick<HeartbeatStore, 'resume'>
  readonly clock: Clock
  readonly audit?: (event: HeartbeatAuditEvent) => void
}

export type CommandHandler = (_invocation: CommandInvocation) => Promise<CommandResult>

function failureText(prefix: string, error: unknown): string {
  return prefix + String(error)
}

function auditFailure(
  audit: ((event: HeartbeatAuditEvent) => void) | undefined,
  event: HeartbeatAuditEvent,
): string | undefined {
  try {
    audit?.(event)
    return undefined
  } catch (error) {
    return String(error)
  }
}

export function makeHaltHandler(deps: HaltHandlerDeps): CommandHandler {
  return async () => {
    const at = deps.clock.now()
    try {
      // 先持久化 halted 再触碰交易所，避免撤单期间仍有新订单进入执行层。
      deps.heartbeat.halt(at)
    } catch (error) {
      return { kind: 'error', text: failureText('无法持久化 halt 状态：', error) }
    }

    // broker 必须在 halt 命令真正执行时解析：Cordis 插件 apply 顺序可能让
    // commands 先注册、exec runtime 后就绪；提前捕获空值会导致本地已熔断却
    // 永远不撤单，直到人工再次操作；当前 Docker 单进程没有外部 watchdog 兜底。
    const broker = deps.brokerProvider?.() ?? deps.broker
    if (broker === undefined) {
      const auditError = auditFailure(deps.audit, {
        actor: 'human',
        kind: 'manual.halt',
        payload: { cancelAttempted: false, cancelSucceeded: false },
        ts: at,
      })
      if (auditError !== undefined) {
        return { kind: 'error', text: '已暂停交易，但审计写入失败：' + auditError }
      }
      return {
        kind: 'error',
        text: '已暂停交易；撤单未执行，需人工核对交易所挂单后再决定是否恢复。',
      }
    }

    try {
      await broker.cancelAll()
      const auditError = auditFailure(deps.audit, {
        actor: 'human',
        kind: 'manual.halt',
        payload: { cancelAttempted: true, cancelSucceeded: true },
        ts: at,
      })
      if (auditError !== undefined) {
        return {
          kind: 'error',
          text: '已暂停交易且已尝试撤单，但审计写入失败：' + auditError,
        }
      }
      return { kind: 'success', text: '已暂停交易并撤销普通挂单，保护单保留。' }
    } catch (error) {
      const auditError = auditFailure(deps.audit, {
        actor: 'human',
        kind: 'manual.halt',
        payload: { cancelAttempted: true, cancelSucceeded: false, error: String(error) },
        ts: at,
      })
      return {
        kind: 'error',
        text:
          '已暂停交易，但撤单失败：' +
          String(error) +
          (auditError === undefined ? '' : '；审计写入失败：' + auditError) +
          '；需人工核对交易所挂单，保持 halted。',
      }
    }
  }
}

export function makeResumeHandler(deps: ResumeHandlerDeps): CommandHandler {
  return async () => {
    const at = deps.clock.now()
    try {
      // resume 只解除熔断；人工恢复后是否交易仍由后续窗口与硬闸决定。
      deps.heartbeat.resume(at)
      const auditError = auditFailure(deps.audit, {
        actor: 'human',
        kind: 'manual.resume',
        payload: { cancelAttempted: false, orderAttempted: false },
        ts: at,
      })
      if (auditError !== undefined) {
        return { kind: 'error', text: '已恢复状态，但审计写入失败：' + auditError }
      }
      return { kind: 'success', text: '已人工恢复交易资格；不会自动撤单或开仓。' }
    } catch (error) {
      return { kind: 'error', text: failureText('无法持久化 resume 状态：', error) }
    }
  }
}

interface CommandsContext extends Context {
  readonly commands: {
    register(definition: {
      readonly name: string
      readonly description: string
      readonly handler: CommandHandler
    }): () => void
  }
}

export function apply(ctx: Context): void {
  const database = getDatabase()
  const journal = new DecisionJournal(database)
  const heartbeat = new HeartbeatStore(new Statements(database))
  const audit = (event: HeartbeatAuditEvent): void => {
    journal.appendAudit(event)
  }
  const clock = systemClock()
  const halt = makeHaltHandler({
    heartbeat,
    clock,
    // 命令与执行层只读同一个组合根；调用时读取可处理 runtime 晚到与卸载。
    brokerProvider: () => getExecPorts()?.broker,
    audit,
  })
  const resume = makeResumeHandler({ heartbeat, clock, audit })

  const commands = (ctx as CommandsContext).commands
  const unregisterHalt = commands.register({
    name: 'halt',
    description: '暂停自动交易并撤销普通挂单，保留保护单',
    handler: halt,
  })
  const unregisterResume = commands.register({
    name: 'resume',
    description: '人工解除交易熔断，不自动下单',
    handler: resume,
  })

  ctx.effect(
    () => () => {
      unregisterResume()
      unregisterHalt()
    },
    'trade.commands.close',
  )
}
