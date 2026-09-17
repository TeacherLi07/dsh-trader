#!/usr/bin/env node
/**
 * 历史 watchdog 脚本（当前硬禁用）。
 *
 * 项目改为 Docker 单进程后，dsh 退出由容器 restart policy 处理，启动恢复由
 * CrashRecovery + reconcile 处理；此脚本保留供历史审计/迁移识别，但任何调用都只返回
 * disabled，不读库、不读凭据、不触碰交易所。
 */

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import { systemClock } from '../lib/clock.js'
import { migrate } from '../lib/db/schema.js'
import { applyProxyAwareFetch } from '../lib/market/ccxt-source.js'
import { CcxtBroker } from '../lib/exec/ccxt-broker.js'
import { DecisionJournal } from '../lib/exec/journal.js'
import { HeartbeatStore } from '../lib/supervisor/heartbeat.js'
import {
  ExternalWatchdog,
  WATCHDOG_DISABLED_REASON,
  WATCHDOG_ENABLED,
} from '../lib/supervisor/watchdog.js'

const DEFAULT_INTERVAL_MS = 5_000
const DEFAULT_MULTIPLE = 3

function emit(record) {
  // JSON.stringify 会把错误文本中的换行编码掉，保证一条检查永远只占一行。
  process.stdout.write(JSON.stringify(record) + '\n')
}

function hasCredential(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function safeError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) message = message.replaceAll(secret, '[REDACTED]')
  }
  return message.length > 0 ? message : 'watchdog 操作失败'
}

function numericOption(name, raw, { integer = false } = {}) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name} 必须是有限正数${integer ? '整数' : ''}`)
  }
  return value
}

function parseArgs(argv) {
  const options = {
    once: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    multiple: DEFAULT_MULTIPLE,
    dbPath: process.env.DSH_TRADER_DB ??
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'trading', 'desk.db'),
    maxChecks: undefined,
    help: false,
  }

  for (const arg of argv) {
    if (arg === '--once') {
      options.once = true
      continue
    }
    if (arg === '--help') {
      options.help = true
      continue
    }
    if (arg.startsWith('--interval-ms=')) {
      options.intervalMs = numericOption('--interval-ms', arg.slice('--interval-ms='.length), { integer: true })
      continue
    }
    if (arg.startsWith('--multiple=')) {
      options.multiple = numericOption('--multiple', arg.slice('--multiple='.length))
      continue
    }
    if (arg.startsWith('--db=')) {
      const value = arg.slice('--db='.length)
      if (value.length === 0) throw new Error('--db 不能为空')
      options.dbPath = value
      continue
    }
    if (arg.startsWith('--max-checks=')) {
      options.maxChecks = numericOption('--max-checks', arg.slice('--max-checks='.length), { integer: true })
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }

  return options
}

function emitArgumentError(error) {
  emit({
    at: Date.now(),
    action: 'error',
    reason: 'invalid_arguments',
    openOrders: null,
    error: safeError(error, [process.env.TRADER_API_KEY ?? '', process.env.TRADER_API_SECRET ?? '']),
  })
}

async function readOpenOrderCount(exchange, secrets) {
  try {
    // CcxtBroker 仍负责实际撤单；这里直接数原始 CCXT 数组，避免缺少 clientOrderId 的
    // 交易所挂单被统一 Broker 为了安全而跳过后，观察值错误地显示成 0。
    const orders = await exchange.fetchOpenOrders()
    return { count: Array.isArray(orders) ? orders.length : null, error: undefined }
  } catch (error) {
    return { count: null, error: safeError(error, secrets) }
  }
}

async function closeExchange(exchange) {
  if (exchange === undefined) return
  const closable = exchange
  await closable.close?.()
}

async function main(options) {
  if (options.help) {
    emit({
      at: Date.now(),
      action: 'help',
      reason: 'usage',
      openOrders: null,
      usage:
        'node scripts/watchdog-daemon.mjs [--once] [--interval-ms=5000] ' +
        '[--multiple=3] [--db=path] [--max-checks=N]',
    })
    return 0
  }

  if (!WATCHDOG_ENABLED) {
    emit({
      at: Date.now(),
      action: 'disabled',
      reason: 'docker_single_process',
      watchdogEnabled: false,
      error: WATCHDOG_DISABLED_REASON,
    })
    return 78
  }

  const apiKey = process.env.TRADER_API_KEY ?? ''
  const apiSecret = process.env.TRADER_API_SECRET ?? ''
  const credentials = {
    keyInjected: hasCredential(apiKey),
    secretInjected: hasCredential(apiSecret),
  }
  const common = {
    venue: process.env.TRADER_VENUE ?? 'htx',
    accountType: process.env.TRADER_ACCOUNT_TYPE ?? 'swap',
    credentials,
  }

  if (!credentials.keyInjected || !credentials.secretInjected) {
    emit({
      at: Date.now(),
      ...common,
      action: 'error',
      reason: 'missing_credentials',
      openOrders: null,
      error: '缺少 TRADER_API_KEY 或 TRADER_API_SECRET；凭据只从环境注入。',
    })
    return 2
  }

  if (common.venue !== 'htx' && common.venue !== 'okx') {
    emit({
      at: Date.now(),
      ...common,
      action: 'error',
      reason: 'unsupported_venue',
      openOrders: null,
      error: 'TRADER_VENUE 只允许 htx 或 okx。',
    })
    return 1
  }

  let db
  let exchange
  let stopTimer
  let activeCheck
  let stopRequested = false
  let resolveStop
  let checkCount = 0
  let checkFailures = 0

  const clock = systemClock()
  const secrets = [apiKey, apiSecret]

  const requestStop = (reason) => {
    if (stopRequested) return
    stopRequested = true
    if (stopTimer !== undefined) {
      clearInterval(stopTimer)
      stopTimer = undefined
    }
    emit({
      at: clock.now(),
      ...common,
      action: 'stopping',
      reason,
      openOrders: null,
      checks: checkCount,
    })
    resolveStop?.()
  }

  try {
    if (options.dbPath !== ':memory:') mkdirSync(dirname(options.dbPath), { recursive: true })
    db = new Database(options.dbPath)
    db.pragma('busy_timeout = 5000')
    migrate(db)

    const journal = new DecisionJournal(db)
    const audit = (event) => journal.appendAudit(event)
    const heartbeat = new HeartbeatStore(db, audit)

    const Exchange = ccxt[common.venue]
    if (Exchange === undefined) throw new Error(`未知交易所：${common.venue}`)
    exchange = new Exchange({ enableRateLimit: true, defaultType: common.accountType })
    applyProxyAwareFetch(exchange)

    const broker = new CcxtBroker({
      exchange,
      venue: common.venue,
      clock,
      apiKey,
      apiSecret,
      accountType: common.accountType,
    })
    const watchdog = new ExternalWatchdog({
      heartbeat,
      broker,
      clock,
      intervalMs: options.intervalMs,
      multiple: options.multiple,
      audit,
    })

    const check = async () => {
      if (stopRequested) return true
      if (activeCheck !== undefined) return await activeCheck

      const operation = (async () => {
        checkCount += 1
        const before = await readOpenOrderCount(exchange, secrets)
        const beforeAuditError = before.error === undefined
          ? undefined
          : (() => {
              try {
                audit({
                  actor: 'system',
                  kind: 'watchdog.open_orders_read_failed',
                  payload: { phase: 'before', error: before.error },
                  ts: clock.now(),
                })
                return undefined
              } catch (error) {
                return safeError(error, secrets)
              }
            })()
        let result
        try {
          result = await watchdog.checkOnce()
        } catch (error) {
          const message = safeError(error, secrets)
          try {
            audit({
              actor: 'system',
              kind: 'watchdog.check_failed',
              payload: { error: message },
              ts: clock.now(),
            })
          } catch {
            // 审计自身失败也要进入 JSON 输出；不能用第二次异常覆盖原始失败。
          }
          checkFailures += 1
          emit({
            at: clock.now(),
            ...common,
            action: 'error',
            reason: 'check_failed',
            openOrders: before.count,
            openOrdersBefore: before.count,
            openOrdersAfter: null,
            cancelAttempted: false,
            cancelSucceeded: false,
            halted: heartbeat.read()?.halted ?? false,
            error: message,
            ...(before.error === undefined ? {} : { openOrdersError: before.error }),
          })
          if (options.maxChecks !== undefined && checkCount >= options.maxChecks) requestStop('max_checks')
          return false
        }

        let after = { count: undefined, error: undefined }
        if (result.cancelSucceeded) after = await readOpenOrderCount(exchange, secrets)
        const afterAuditError = after.error === undefined
          ? undefined
          : (() => {
              try {
                audit({
                  actor: 'system',
                  kind: 'watchdog.open_orders_read_failed',
                  payload: { phase: 'after', error: after.error },
                  ts: clock.now(),
                })
                return undefined
              } catch (error) {
                return safeError(error, secrets)
              }
            })()
        const observedCount = result.cancelSucceeded ? after.count : before.count
        const observationError = after.error ?? before.error
        const auditError = afterAuditError ?? beforeAuditError

        emit({
          at: clock.now(),
          ...common,
          action: result.decision.action,
          reason: result.decision.reason,
          openOrders: observedCount,
          openOrdersBefore: before.count,
          openOrdersAfter: result.cancelSucceeded ? after.count : null,
          cancelAttempted: result.cancelAttempted,
          cancelSucceeded: result.cancelSucceeded,
          halted: result.halted,
          checks: checkCount,
          ...(observationError === undefined ? {} : { openOrdersError: observationError }),
          ...(auditError === undefined ? {} : { auditError }),
        })

        const completed = observationError === undefined && auditError === undefined &&
          (result.decision.action === 'none' || result.cancelSucceeded)
        if (!completed) checkFailures += 1
        if (options.maxChecks !== undefined && checkCount >= options.maxChecks) requestStop('max_checks')
        return completed
      })()

      activeCheck = operation
      try {
        return await operation
      } finally {
        if (activeCheck === operation) activeCheck = undefined
      }
    }

    const onSignal = (signal) => requestStop(signal)
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)

    let exitCode = 0
    try {
      if (options.once) {
        exitCode = (await check()) ? 0 : 1
      } else {
        await check()
        if (!stopRequested) {
          await new Promise((resolve) => {
            resolveStop = resolve
            stopTimer = setInterval(() => {
              void check()
            }, options.intervalMs)
          })
          if (activeCheck !== undefined) await activeCheck
        }
        exitCode = checkFailures === 0 ? 0 : 1
      }
    } finally {
      process.removeListener('SIGTERM', onSignal)
      process.removeListener('SIGINT', onSignal)
    }
    return exitCode
  } catch (error) {
    emit({
      at: clock.now(),
      ...common,
      action: 'error',
      reason: 'initialization_failed',
      openOrders: null,
      error: safeError(error, secrets),
    })
    return 1
  } finally {
    try {
      await closeExchange(exchange)
    } catch (error) {
      emit({
        at: clock.now(),
        ...common,
        action: 'error',
        reason: 'exchange_close_failed',
        openOrders: null,
        error: safeError(error, secrets),
      })
    }
    try {
      db?.close()
    } catch (error) {
      emit({
        at: clock.now(),
        ...common,
        action: 'error',
        reason: 'db_close_failed',
        openOrders: null,
        error: safeError(error, secrets),
      })
    }
  }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  emitArgumentError(error)
  process.exitCode = 1
}

if (options !== undefined) {
  try {
    process.exitCode = await main(options)
  } catch (error) {
    emit({
      at: Date.now(),
      action: 'error',
      reason: 'uncaught_failure',
      openOrders: null,
      error: safeError(error, [process.env.TRADER_API_KEY ?? '', process.env.TRADER_API_SECRET ?? '']),
    })
    process.exitCode = 1
  }
}
