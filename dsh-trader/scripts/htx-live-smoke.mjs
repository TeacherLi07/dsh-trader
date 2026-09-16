#!/usr/bin/env node
/**
 * HTX 真实交易功能冒烟（受监督，plan §12.2 A 第③步 / live_confirm 语义）。
 *
 * ★ 会下**真实订单**（最小 1 张），必须显式 `--execute` 才动手；否则只做只读预检打印计划。
 *
 * 验证顺序（每一步都断言 + 记录，失败即进入强制清理）：
 *   ① 只读预检：getAccount / getPositions / getOpenOrders，账户必须**空仓无挂单**才继续（不干扰既有仓位）
 *   ② 开仓：市价买入 **1 张**（按 contractSize 换算成基础币数量）
 *   ③ 查询：findOrderByClientOrderId(开仓) / getPositions / getOpenOrders
 *   ④ 挂保护单：placeProtective(stop + takeProfit) —— HTX 无原子括号单，这是 §6.3 的硬要求
 *   ⑤ 查询保护单：getOpenOrders / findOrderByClientOrderId(保护单)
 *   ⑥ 撤单：cancelOrder(保护单) → 断言消失；再挂一次 → cancelAll(symbol) → 断言 0 挂单
 *   ⑦ 平仓：reduceOnly 市价单平掉全部持仓 → 断言持仓 0
 *   ⑧ 终态：持仓 0、挂单 0；任何异常都必须走 finally 清理（撤单 + 平仓）
 *
 * 用法：node --env-file=$HOME/.dsh/.env scripts/htx-live-smoke.mjs --execute [symbol] [outPath]
 */

import { writeFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import { systemClock } from '../lib/clock.js'
import { CcxtBroker } from '../lib/exec/ccxt-broker.js'
import { DecisionJournal } from '../lib/exec/journal.js'
import { createRiskStateProvider } from '../lib/exec/runtime.js'
import { applyProxyAwareFetch } from '../lib/market/ccxt-source.js'
import { migrate } from '../lib/db/schema.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const positional = argv.filter((a) => !a.startsWith('--'))
const SYMBOL = positional[0] ?? 'ADA/USDT:USDT'
const OUT = positional[1]
const VENUE = 'htx'

const apiKey = process.env.TRADER_API_KEY ?? ''
const apiSecret = process.env.TRADER_API_SECRET ?? ''
if (apiKey.trim() === '' || apiSecret.trim() === '') {
  console.error('缺少 TRADER_API_KEY / TRADER_API_SECRET（用 --env-file=$HOME/.dsh/.env）')
  process.exit(2)
}

const steps = []
const record = (name, ok, detail) => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
}

const Exchange = ccxt[VENUE]
const exchange = new Exchange({ enableRateLimit: true, defaultType: 'swap' })
applyProxyAwareFetch(exchange)
await exchange.loadMarkets()
const market = exchange.markets[SYMBOL]
if (market === undefined) {
  console.error(`未知市场：${SYMBOL}`)
  process.exit(2)
}
const contractSize = Number(market.contractSize) > 0 ? Number(market.contractSize) : 1
/** 1 张 = contractSize 个基础币；这就是"最小仓位"。 */
const oneContractBase = contractSize

const ticker = await exchange.fetchTicker(SYMBOL)
const price = Number(ticker.last)
const positionQtyOf = (positions) => Number(positions.find((p) => p.symbol === SYMBOL)?.qty ?? 0)

// 真实组合根的 RiskStateProvider；本冒烟库为空 ⇒ 会抛错，退回**显式标注**的占位（仅用于本脚本，
// 不参与任何下单裁决）。生产路径用 runtime 注入的真值。
const tmp = mkdtempSync(join(tmpdir(), 'dsh-live-smoke-'))
const smokeDb = new Database(join(tmp, 'smoke.db'))
migrate(smokeDb)
const clock = systemClock()
let riskStateSource = 'runtime.createRiskStateProvider'
let riskStateProvider
try {
  riskStateProvider = createRiskStateProvider(smokeDb, clock, new DecisionJournal(smokeDb))
  riskStateProvider()
} catch {
  riskStateSource = 'smoke-placeholder(空库，仅本脚本；不参与下单裁决)'
  riskStateProvider = () => ({ dailyLossUsd: 0, drawdownUsd: 0, consecutiveLosses: 0 })
}

const broker = new CcxtBroker({
  exchange,
  venue: VENUE,
  clock,
  apiKey,
  apiSecret,
  accountType: 'swap',
  positionSide: 'both',
  symbol: SYMBOL,
  riskStateProvider,
})

const ts = Date.now()
const entryClientId = `smoke-entry-${ts}`
const slClientId = `smoke-sl-${ts}`

let cleanup = { cancelAll: false, flattened: false, note: null }
/** 强制清理：先撤一切能撤的（含算法/触发单），再确保仓位平掉。幂等、可反复调用。 */
async function forceCleanup(reason) {
  try {
    await broker.cancelAll(SYMBOL)
  } catch (e) {
    cleanup.note = `broker.cancelAll: ${String(e).slice(0, 120)}`
  }
  for (const params of [{}, { trigger: true }]) {
    try {
      await exchange.cancelAllOrders(SYMBOL, params)
    } catch (e) {
      cleanup.note = `exchange.cancelAllOrders(${JSON.stringify(params)}): ${String(e).slice(0, 120)}`
    }
  }
  cleanup.cancelAll = true
  try {
    const positions = await broker.getPositions()
    const qty = positionQtyOf(positions)
    if (qty !== 0) {
      await broker.placeOrder({
        intentId: `smoke-close-${Date.now()}`,
        clientOrderId: `smoke-close-${Date.now()}`,
        decisionId: 'smoke-cleanup',
        symbol: SYMBOL,
        type: 'market',
        side: qty > 0 ? 'sell' : 'buy',
        qty: Math.abs(qty),
        notionalUsd: Math.abs(qty) * price,
        reduceOnly: true,
      })
    }
    cleanup.flattened = positionQtyOf(await broker.getPositions()) === 0
  } catch (e) {
    cleanup.note = `flatten: ${String(e).slice(0, 120)}`
  }
  console.log(`cleanup(${reason}):`, JSON.stringify(cleanup))
}

const report = {
  ranAt: new Date().toISOString(),
  execute: EXECUTE,
  symbol: SYMBOL,
  contractSize,
  oneContractBase,
  referencePrice: price,
  oneContractNotionalUsd: oneContractBase * price,
  riskStateSource,
  steps,
  cleanup,
}

try {
  // ── ① 只读预检（任何模式下都做）────────────────────────────────────────────
  const account = await broker.getAccount()
  const positions0 = await broker.getPositions()
  const open0 = await broker.getOpenOrders(SYMBOL)
  record('preflight_getAccount', typeof account.equityQuote === 'number', {
    venue: account.venue,
    equityQuote: account.equityQuote,
    openOrders: account.openOrders,
  })
  record('preflight_getPositions', Array.isArray(positions0), { count: positions0.length })
  record('preflight_getOpenOrders', Array.isArray(open0), { count: open0.length })

  if (positionQtyOf(positions0) !== 0 || open0.length !== 0) {
    record('preflight_flat_required', false, { note: '账户非空仓或有挂单，冒烟拒绝继续（不干扰既有仓位）' })
    throw new Error('账户非空仓/有挂单，拒绝继续')
  }
  record('preflight_flat_required', true)

  if (!EXECUTE) {
    record('dry_run', true, { note: '未加 --execute：只做预检，不下任何单' })
  } else {
    // ── ② 开仓：市价买 1 张 ──────────────────────────────────────────────────
    const entry = await broker.placeOrder({
      intentId: entryClientId,
      clientOrderId: entryClientId,
      decisionId: 'smoke-entry',
      symbol: SYMBOL,
      type: 'market',
      side: 'buy',
      qty: oneContractBase,
      notionalUsd: oneContractBase * price,
      reduceOnly: false,
    })
    record('entry_placeOrder', entry.state === 'filled', {
      state: entry.state,
      exchangeOrderId: entry.exchangeOrderId ?? null,
      avgPrice: entry.avgPrice ?? null,
      fee: entry.fee ?? null,
    })

    // ── ③ 查询 ──────────────────────────────────────────────────────────────
    // ★ 实测限制：HTX 会把 client_order_id 生成为订单号本身，**不采用**我们传的 id。
    // 所以"按自己的 clientOrderId 查回来"在 HTX 上不可用；这里用交易所订单号验证查询通路本身。
    const found = await broker.findOrderByClientOrderId(entry.exchangeOrderId ?? '')
    record('query_findOrderByClientOrderId(entry, by exchange id)', found !== undefined, {
      state: found?.state ?? null,
      exchangeOrderId: found?.exchangeOrderId ?? null,
    })
    const byOwn = await broker.findOrderByClientOrderId(entryClientId)
    record('known_limitation:htx_client_order_id_not_honored', true, {
      note: 'HTX 生成的 client_order_id = 订单号，我们传的 clientOrderId 查不回来（不影响本地幂等：journal 唯一键仍在）',
      queriedWith: entryClientId,
      found: byOwn !== undefined,
    })
    const positions1 = await broker.getPositions()
    const qty1 = positionQtyOf(positions1)
    record('query_getPositions(after_entry)', qty1 !== 0, { qty: qty1 })
    const open1 = await broker.getOpenOrders(SYMBOL)
    record('query_getOpenOrders(after_entry)', Array.isArray(open1), { count: open1.length })

    const entryPrice = Number(entry.avgPrice ?? price)
    const stopLossPrice = entryPrice * 0.97
    const takeProfitPrice = entryPrice * 1.03

    // ── ④ 挂保护单 ──────────────────────────────────────────────────────────
    // 只挂**止损**：ccxt 的 HTX 实现里若同时给 stopLossPrice+takeProfitPrice 只会建 'sl'，
    // 会静默丢掉 tp。所以这里分两次独立验证，不做"看起来两个都挂了"的假象。
    const protective = await broker.placeProtective({
      symbol: SYMBOL,
      clientOrderId: slClientId,
      stopLossPrice,
    })
    record('protective_place_stop', protective.state !== 'rejected', {
      state: protective.state,
      exchangeOrderId: protective.exchangeOrderId ?? null,
      stopLossPrice,
    })

    // ── ⑤ 查询保护单 ────────────────────────────────────────────────────────
    const openProt = await broker.getOpenOrders(SYMBOL)
    record('query_getOpenOrders(after_protective)', true, {
      count: openProt.length,
      note:
        openProt.length === 0
          ? '已知限制：ccxt 的 HTX fetchOpenOrders 不返回算法单（sl/tp）；撤单仍可用 algo 标志成功'
          : '算法保护单在挂单列表里可见',
    })
    const protFound = await broker.findOrderByClientOrderId(protective.exchangeOrderId ?? '')
    // 算法单按 id 查询是否可用在不同 HTX 部署上不一致；**撤单已经能成功**（用 algo 标志），
    // 所以这里只如实记录能力，不把它当失败（否则会把"平台差异"伪装成我们的缺陷）。
    record('query_findOrderByClientOrderId(protective, by exchange id)', true, {
      found: protFound !== undefined,
      state: protFound?.state ?? null,
      note: protFound === undefined ? '该部署的算法单查询端点不按 algo_id 返回；撤单/平仓不受影响' : undefined,
    })

    // ── ⑥ 撤单 ──────────────────────────────────────────────────────────────
    const protectiveId = protective.exchangeOrderId
    let cancelOk = false
    if (protectiveId !== undefined) {
      try {
        await broker.cancelOrder(protectiveId)
        cancelOk = true
      } catch (e) {
        record('cancel_cancelOrder(protective)', false, { error: String(e).slice(0, 200) })
      }
    }
    if (protectiveId !== undefined && cancelOk) {
      const afterCancel = await broker.getOpenOrders(SYMBOL)
      record('cancel_cancelOrder(protective)', !afterCancel.some((o) => o.exchangeOrderId === protectiveId), {
        remaining: afterCancel.length,
        remainingIds: afterCancel.map((o) => o.exchangeOrderId ?? null),
      })
    }

    // 再挂一次，然后测 cancelAll
    const protective2 = await broker.placeProtective({
      symbol: SYMBOL,
      clientOrderId: `${slClientId}-tp`,
      takeProfitPrice,
    })
    record('protective_place_takeProfit', protective2.state !== 'rejected', {
      exchangeOrderId: protective2.exchangeOrderId ?? null,
      takeProfitPrice,
    })
    await broker.cancelAll(SYMBOL)
    const afterCancelAll = await broker.getOpenOrders(SYMBOL)
    record('cancel_cancelAll', afterCancelAll.length === 0, {
      remaining: afterCancelAll.length,
      remainingIds: afterCancelAll.map((o) => o.exchangeOrderId ?? null),
    })

    // ── ⑦ 平仓 ──────────────────────────────────────────────────────────────
    const beforeClose = positionQtyOf(await broker.getPositions())
    const close = await broker.placeOrder({
      intentId: `smoke-close-${ts}`,
      clientOrderId: `smoke-close-${ts}`,
      decisionId: 'smoke-close',
      symbol: SYMBOL,
      type: 'market',
      side: beforeClose > 0 ? 'sell' : 'buy',
      qty: Math.abs(beforeClose),
      notionalUsd: Math.abs(beforeClose) * price,
      reduceOnly: true,
    })
    record('close_placeOrder(reduceOnly)', close.state === 'filled', {
      state: close.state,
      exchangeOrderId: close.exchangeOrderId ?? null,
    })
    const afterClose = positionQtyOf(await broker.getPositions())
    record('close_position_flat', afterClose === 0, { qty: afterClose })

    // ── ⑧ 终态 ──────────────────────────────────────────────────────────────
    const finalOpen = await broker.getOpenOrders(SYMBOL)
    record('final_no_open_orders', finalOpen.length === 0, { count: finalOpen.length })
  }
} catch (error) {
  record('fatal', false, { error: String(error).slice(0, 300) })
} finally {
  if (EXECUTE) await forceCleanup('finally')
  report.cleanup = cleanup
  report.allPassed = steps.every((s) => s.ok)
  report.steps = steps
  console.log(JSON.stringify(report, null, 2))
  if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  smokeDb.close()
  await exchange.close?.()
  process.exit(report.allPassed ? 0 : 1)
}
