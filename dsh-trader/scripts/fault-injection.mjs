#!/usr/bin/env node
/**
 * P2 ①②④ 故障注入验收。
 *
 * 用法：pnpm build && node scripts/fault-injection.mjs /tmp/fault-injection.json
 * 该脚本只把 SIGKILL 放在子进程中；模拟交易所本身只报告步骤，不携带破坏性动作。
 */

import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { migrate } from '../lib/db/schema.js'
import { ReplayClock } from '../lib/clock.js'
import { DecisionJournal } from '../lib/exec/journal.js'
import { CrashRecovery } from '../lib/exec/recovery.js'
import { SimExchange } from '../lib/exec/sim-exchange.js'

const OUT = process.argv[2]
const SYMBOL = 'BTC/USDT'
const NOW = 1_700_000_000_000
const ROUND_COUNT = 50
const IDEMPOTENT_ATTEMPTS = 10
const SCRIPT_PATH = fileURLToPath(import.meta.url)

function recordDecisionAndIntent(journal, { clientOrderId, intentId, decisionId, type = 'market', price }) {
  journal.recordDecision({
    decisionId,
    symbol: SYMBOL,
    decidedAt: NOW,
    contextHash: `ctx:${decisionId}`,
    action: type === 'protective' ? 'set_stop' : 'open',
    executed: false,
  })
  journal.recordIntent({
    intentId,
    clientOrderId,
    decisionId,
    venue: 'paper',
    symbol: SYMBOL,
    state: 'created',
    type,
    side: type === 'protective' ? 'sell' : 'buy',
    qty: 1,
    ...(price === undefined ? {} : { price }),
    reduceOnly: type === 'protective',
    createdAt: NOW,
  })
}

function placeRequest({ clientOrderId, intentId, decisionId, type = 'market', price }) {
  return {
    clientOrderId,
    intentId,
    decisionId,
    symbol: SYMBOL,
    type,
    side: 'buy',
    qty: 1,
    notionalUsd: price ?? 100,
    reduceOnly: false,
    ...(price === undefined ? {} : { price }),
  }
}

function mirrorFills(journal, exchange) {
  for (const fill of exchange.allFills()) {
    journal.recordOrder({
      orderId: fill.exchangeOrderId,
      venue: exchange.venue,
      exchangeOrderId: fill.exchangeOrderId,
      clientOrderId: fill.clientOrderId,
      symbol: fill.symbol,
      status: 'filled',
      qty: fill.qty,
      filledQty: fill.qty,
      avgPrice: fill.price,
      updatedAt: fill.ts,
    })
    journal.recordFill({
      fillId: fill.fillId,
      orderId: fill.exchangeOrderId,
      qty: fill.qty,
      price: fill.price,
      fee: fill.fee,
      feeCurrency: 'USDT',
      ts: fill.ts,
    })
  }
}

function duplicateFillCount(exchange) {
  const counts = new Map()
  for (const fill of exchange.allFills()) {
    counts.set(fill.clientOrderId, (counts.get(fill.clientOrderId) ?? 0) + 1)
  }
  let duplicateFills = 0
  for (const count of counts.values()) duplicateFills += Math.max(0, count - 1)
  return duplicateFills
}

function orphanOpenOrderCount(journal, exchange) {
  return exchange.openOrders().filter((order) => !journal.hasClientOrderId(order.clientOrderId)).length
}

function idSnapshot(journal) {
  return {
    decisions: [...journal.decisionIds()],
    intents: [...journal.intentIds()],
    clientOrderIds: [...journal.clientOrderIds()],
    fills: [...journal.fillIds()],
  }
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = fork(SCRIPT_PATH, args, {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

async function runRoundWorker(dbPath, round, crashStep) {
  const db = new Database(dbPath)
  migrate(db)
  const journal = new DecisionJournal(db)
  const exchange = new SimExchange(dbPath, {
    onStep: (step) => {
      if (crashStep !== 'none' && step === crashStep) process.kill(process.pid, 'SIGKILL')
    },
  })
  const clientOrderId = `round-client-${round}`
  const intentId = `round-intent-${round}`
  const decisionId = `round-decision-${round}`
  recordDecisionAndIntent(journal, { clientOrderId, intentId, decisionId })
  exchange.onPrice(SYMBOL, 100)
  const ack = await exchange.placeOrder(placeRequest({ clientOrderId, intentId, decisionId }))
  journal.markIntentAcked(
    clientOrderId,
    ack.state === 'filled' ? 'filled' : ack.state === 'rejected' ? 'rejected' : 'acked',
    ack.exchangeOrderId,
    NOW,
  )
  mirrorFills(journal, exchange)

  // 至少保留一个“本地有记录的交易所挂单”样本，避免孤儿=0 因交易所挂单集合为空而空跑。
  if (round === 4) {
    const openClientOrderId = `round-open-client-${round}`
    const openIntentId = `round-open-intent-${round}`
    const openDecisionId = `round-open-decision-${round}`
    recordDecisionAndIntent(journal, {
      clientOrderId: openClientOrderId,
      intentId: openIntentId,
      decisionId: openDecisionId,
      type: 'limit',
      price: 90,
    })
    const openAck = await exchange.placeOrder(
      placeRequest({
        clientOrderId: openClientOrderId,
        intentId: openIntentId,
        decisionId: openDecisionId,
        type: 'limit',
        price: 90,
      }),
    )
    journal.markIntentAcked(openClientOrderId, 'acked', openAck.exchangeOrderId, NOW)
  }
  exchange.close()
  db.close()
}

async function runIdempotentWorker(dbPath, attempt, crashStep) {
  const db = new Database(dbPath)
  migrate(db)
  const journal = new DecisionJournal(db)
  const exchange = new SimExchange(dbPath, {
    onStep: (step) => {
      if (crashStep !== 'none' && step === crashStep) process.kill(process.pid, 'SIGKILL')
    },
  })
  const clientOrderId = 'idempotent-client'
  const intentId = 'idempotent-intent'
  const decisionId = 'idempotent-decision'
  recordDecisionAndIntent(journal, { clientOrderId, intentId, decisionId })
  exchange.onPrice(SYMBOL, 100)
  const ack = await exchange.placeOrder(placeRequest({ clientOrderId, intentId, decisionId }))
  journal.markIntentAcked(
    clientOrderId,
    ack.state === 'filled' ? 'filled' : ack.state === 'rejected' ? 'rejected' : 'acked',
    ack.exchangeOrderId,
    NOW,
  )
  mirrorFills(journal, exchange)
  exchange.close()
  db.close()
  void attempt
}

async function runProtectionWorker(dbPath) {
  const db = new Database(dbPath)
  migrate(db)
  const journal = new DecisionJournal(db)
  const exchange = new SimExchange(dbPath)
  const entryClientOrderId = 'protect-entry-client'
  const entryIntentId = 'protect-entry-intent'
  const entryDecisionId = 'protect-entry-decision'
  recordDecisionAndIntent(journal, {
    clientOrderId: entryClientOrderId,
    intentId: entryIntentId,
    decisionId: entryDecisionId,
  })
  exchange.onPrice(SYMBOL, 100)
  const entryAck = await exchange.placeOrder(
    placeRequest({
      clientOrderId: entryClientOrderId,
      intentId: entryIntentId,
      decisionId: entryDecisionId,
    }),
  )
  journal.markIntentAcked(entryClientOrderId, 'filled', entryAck.exchangeOrderId, NOW)
  mirrorFills(journal, exchange)

  const stopClientOrderId = 'protect-stop-client'
  const stopIntentId = 'protect-stop-intent'
  const stopDecisionId = 'protect-stop-decision'
  recordDecisionAndIntent(journal, {
    clientOrderId: stopClientOrderId,
    intentId: stopIntentId,
    decisionId: stopDecisionId,
    type: 'protective',
  })
  const stopAck = await exchange.placeProtective({
    symbol: SYMBOL,
    clientOrderId: stopClientOrderId,
    stopLossPrice: 90,
  })
  journal.markIntentAcked(stopClientOrderId, 'acked', stopAck.exchangeOrderId, NOW)
  if (stopAck.exchangeOrderId !== undefined) {
    journal.recordOrder({
      orderId: stopAck.exchangeOrderId,
      venue: exchange.venue,
      exchangeOrderId: stopAck.exchangeOrderId,
      clientOrderId: stopClientOrderId,
      symbol: SYMBOL,
      status: stopAck.state,
      qty: 1,
      filledQty: 0,
      updatedAt: stopAck.ts,
    })
  }
  exchange.close()
  db.close()
}

async function runRoundChecks(root) {
  const crashSteps = ['after_persist_before_ack', 'before_persist', 'after_persist_before_match', 'none']
  const rounds = []
  let killDeliveredRounds = 0
  let inFlightRounds = 0
  let orphanOpenOrders = 0
  let duplicateFills = 0
  let idempotentRecoveryRounds = 0
  let openOrderRounds = 0

  for (let round = 1; round <= ROUND_COUNT; round += 1) {
    const crashStep = crashSteps[(round - 1) % crashSteps.length]
    const dbPath = join(root, `round-${round}.db`)
    const childExit = await runChild(['--worker', 'round', dbPath, String(round), crashStep])

    const db = new Database(dbPath)
    const journal = new DecisionJournal(db)
    const exchange = new SimExchange(dbPath)
    const inFlightBefore = journal.inFlightIntents().length
    const openOrdersBefore = exchange.openOrderCount()
    if (inFlightBefore > 0) inFlightRounds += 1
    if (openOrdersBefore > 0) openOrderRounds += 1
    if (childExit.signal === 'SIGKILL') killDeliveredRounds += 1

    const recovery = new CrashRecovery({
      journal,
      broker: exchange,
      clock: new ReplayClock(NOW),
      symbols: [SYMBOL],
    })
    await recovery.run()
    mirrorFills(journal, exchange)
    const afterFirst = idSnapshot(journal)
    await recovery.run()
    const afterSecond = idSnapshot(journal)
    if (sameSnapshot(afterFirst, afterSecond)) idempotentRecoveryRounds += 1

    const roundOrphans = orphanOpenOrderCount(journal, exchange)
    const roundDuplicates = duplicateFillCount(exchange)
    orphanOpenOrders += roundOrphans
    duplicateFills += roundDuplicates
    rounds.push({
      round,
      crashStep,
      signal: childExit.signal,
      inFlightBefore,
      openOrdersBefore,
      orphanOpenOrders: roundOrphans,
      duplicateFills: roundDuplicates,
    })
    exchange.close()
    db.close()
  }

  return {
    rounds,
    summary: {
      rounds: ROUND_COUNT,
      kill_delivered_rounds: killDeliveredRounds,
      in_flight_rounds: inFlightRounds,
      open_order_rounds: openOrderRounds,
      orphan_open_orders: orphanOpenOrders,
      duplicate_fills: duplicateFills,
      idempotent_recovery_rounds: idempotentRecoveryRounds,
    },
  }
}

async function runIdempotenceCheck(root) {
  const dbPath = join(root, 'idempotent.db')
  const exits = []
  for (let attempt = 1; attempt <= IDEMPOTENT_ATTEMPTS; attempt += 1) {
    const crashStep = attempt === 5 ? 'after_persist_before_ack' : 'none'
    exits.push(await runChild(['--worker', 'idempotent', dbPath, String(attempt), crashStep]))
  }

  const db = new Database(dbPath)
  const journal = new DecisionJournal(db)
  const exchange = new SimExchange(dbPath)
  mirrorFills(journal, exchange)
  const fills = exchange.allFills()
  const fillsByClient = new Map()
  for (const fill of fills) fillsByClient.set(fill.clientOrderId, (fillsByClient.get(fill.clientOrderId) ?? 0) + 1)
  const sameClientFillCount = fillsByClient.get('idempotent-client') ?? 0
  const result = {
    attempts: IDEMPOTENT_ATTEMPTS,
    kill_delivered: exits.filter((exit) => exit.signal === 'SIGKILL').length,
    fill_count: exchange.fillCount(),
    journal_intent_count: journal.clientOrderIds().filter((id) => id === 'idempotent-client').length,
    journal_fill_count: journal.fillIds().length,
    same_client_fill_count: sameClientFillCount,
    duplicate_fills: duplicateFillCount(exchange),
  }
  exchange.close()
  db.close()
  return result
}

async function runProtectionCheck(root) {
  const dbPath = join(root, 'protection.db')
  const childExit = await runChild(['--worker', 'protection', dbPath])

  // 这里不创建 journal、不跑恢复、不调用任何模型路径；父进程只推进交易所价格。
  const exchange = new SimExchange(dbPath)
  const fillsBeforePrice = exchange.fillCount()
  const protectiveAcks = exchange.onPrice(SYMBOL, 90)
  const positionsAfterPrice = await exchange.getPositions()
  const result = {
    child_signal: childExit.signal,
    fills_before_stop: fillsBeforePrice,
    fills_after_stop: exchange.fillCount(),
    protective_trigger_count: protectiveAcks.filter((ack) => ack.clientOrderId === 'protect-stop-client').length,
    positions_after_stop: positionsAfterPrice.length,
    protective_survives_without_model:
      protectiveAcks.some((ack) => ack.clientOrderId === 'protect-stop-client' && ack.state === 'filled') &&
      positionsAfterPrice.length === 0 &&
      exchange.fillCount() === fillsBeforePrice + 1,
  }
  exchange.close()
  return result
}

async function runMain() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fault-injection-'))
  try {
    const p2_1 = await runRoundChecks(root)
    const p2_2 = await runIdempotenceCheck(root)
    const p2_4 = await runProtectionCheck(root)
    const checks = {
      kill_delivered_rounds_ge_1: p2_1.summary.kill_delivered_rounds >= 1,
      in_flight_rounds_gt_0: p2_1.summary.in_flight_rounds > 0,
      open_order_sample_gt_0: p2_1.summary.open_order_rounds > 0,
      orphan_open_orders: p2_1.summary.orphan_open_orders === 0,
      duplicate_fills: p2_1.summary.duplicate_fills === 0,
      recovery_idempotent: p2_1.summary.idempotent_recovery_rounds === ROUND_COUNT,
      idempotent_fill_count: p2_2.fill_count === 1,
      idempotent_journal_intent_count: p2_2.journal_intent_count === 1,
      idempotent_journal_fill_count: p2_2.journal_fill_count === 1,
      idempotent_same_client_fill_count: p2_2.same_client_fill_count === 1,
      idempotent_duplicate_fills: p2_2.duplicate_fills === 0,
      protective_survives_without_model: p2_4.protective_survives_without_model === true,
    }
    const report = {
      ranAt: new Date().toISOString(),
      p2_1,
      p2_2,
      p2_4,
      checks,
      allPassed: Object.values(checks).every(Boolean),
      methodology: {
        orphan_open_orders:
          '每轮将 exchange.openOrders() 中 clientOrderId 不存在于 journal.clientOrderIds() 的订单计数；只统计真正孤儿，故本地有记录的挂单不算孤儿。',
        duplicate_fills:
          '按 SimExchange.allFills() 的 clientOrderId 分组，sum(max(0, groupCount - 1))；不同 clientOrderId 的各一笔成交不互相算重复。',
        recovery_idempotent:
          '第一次 CrashRecovery.run() 后与第二次 run() 后的 decisions/intents/clientOrderIds/fills 四组 id 快照完全相等。',
        in_flight_before:
          '子进程退出后、第一次恢复前 journal.inFlightIntents().length；仅在途样本大于 0 时计入非空跑统计。',
        open_order_sample:
          '第 4 轮故意保留一笔本地已有意图的未成交限价单，open_order_rounds > 0 证明孤儿=0 不是因交易所挂单集合为空。',
      },
    }
    console.log(JSON.stringify(report, null, 2))
    if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
    return report.allPassed
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--worker') {
  const task = process.argv[3]
  if (task === 'round') await runRoundWorker(process.argv[4], Number(process.argv[5]), process.argv[6])
  else if (task === 'idempotent') await runIdempotentWorker(process.argv[4], Number(process.argv[5]), process.argv[6])
  else if (task === 'protection') await runProtectionWorker(process.argv[4])
  else throw new Error(`未知 worker 任务：${task}`)
} else {
  const allPassed = await runMain()
  process.exit(allPassed ? 0 : 1)
}
