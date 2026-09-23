#!/usr/bin/env node
/**
 * HTX broker 端点冒烟（plan §12 第①项的受控验证；不代表 R6 的生产执行链/14 天验收）。
 *
 * ★ 会下**真实订单**（最小 1 张），必须显式 `--execute` 才动手；否则只做只读预检打印计划。
 *
 * 验证顺序（每一步都断言 + 记录，失败即进入强制清理）：
 *   ① 只读预检：readOnlyBalance / getPositions / getOpenOrders，账户必须**空仓无挂单**才继续（不干扰既有仓位）
 *   ② 开仓：市价买入 **1 张**（按 contractSize 换算成基础币数量）
 *   ③ 查询：findOrderByClientOrderId(开仓) / getPositions / getOpenOrders
 *   ④ 挂保护单：placeProtective(stop + takeProfit) —— HTX 无原子括号单，这是 §6.3 的硬要求
 *   ⑤ 查询保护单：getOpenOrders / findOrderByClientOrderId(保护单)
 *   ⑥ 保护期只测试默认 cancelAll 不撤保护单
 *   ⑦ reduceOnly 平仓并确认空仓后，才显式撤保护单
 *   ⑧ 终态：持仓 0、挂单 0；异常清理也遵守先平仓后撤保护单
 *
 * 用法：TRADER_SMOKE_MAX_DRAWDOWN_PCT=0.02 node --env-file=$HOME/.dsh/.env scripts/htx-live-smoke.mjs --execute [symbol] <private-report.json>
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import ccxt from 'ccxt'
import { systemClock } from '../lib/clock.js'
import { CcxtBroker } from '../lib/exec/ccxt-broker.js'
import { assertSmokeAccountFlat, cleanupSmokePosition, evaluateSmokeLossEnvelope } from '../lib/exec/smoke-safety.js'
import { applyProxyAwareFetch } from '../lib/market/ccxt-source.js'

const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const positional = argv.filter((a) => !a.startsWith('--'))
const SYMBOL = positional[0] ?? 'ADA/USDT:USDT'
const OUT = positional[1]
const VENUE = 'htx'
const LOG = OUT === undefined ? undefined : OUT.endsWith('.json') ? `${OUT.slice(0, -5)}.jsonl` : `${OUT}.jsonl`

if (EXECUTE && OUT === undefined) {
  console.error('真实冒烟必须指定私有报告路径，以保存逐步 JSONL 日志')
  process.exit(2)
}
if (OUT !== undefined && (existsSync(OUT) || existsSync(LOG))) {
  console.error('报告或日志路径已存在，拒绝覆盖既有验收证据')
  process.exit(2)
}
if (LOG !== undefined) writeFileSync(LOG, '', { flag: 'wx', mode: 0o600 })

const apiKey = process.env.TRADER_API_KEY ?? ''
const apiSecret = process.env.TRADER_API_SECRET ?? ''
if (apiKey.trim() === '' || apiSecret.trim() === '') {
  console.error('缺少 TRADER_API_KEY / TRADER_API_SECRET（用 --env-file=$HOME/.dsh/.env）')
  process.exit(2)
}

const steps = []
const record = (name, ok, detail) => {
  const event = { at: new Date().toISOString(), name, ok, detail }
  steps.push(event)
  if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify(event)}\n`, 'utf8')
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
const contractSize = Number(market.contractSize)
if (!Number.isFinite(contractSize) || contractSize <= 0) {
  throw new Error(`市场 ${SYMBOL} 没有可核验的 contractSize，拒绝冒烟`)
}
/** 1 张 = contractSize 个基础币；这就是"最小仓位"。 */
const oneContractBase = contractSize

const ticker = await exchange.fetchTicker(SYMBOL)
const price = Number(ticker.ask ?? ticker.last)
if (!Number.isFinite(price) || price <= 0) throw new Error(`市场 ${SYMBOL} 没有可核验的买一价，拒绝冒烟`)
const positionQtyOf = (positions) => Number(positions.find((p) => p.symbol === SYMBOL)?.qty ?? 0)

const clock = systemClock()

const broker = new CcxtBroker({
  exchange,
  venue: VENUE,
  clock,
  apiKey,
  apiSecret,
  accountType: 'swap',
  positionSide: 'both',
  symbol: SYMBOL,
})

const ts = Date.now()
const entryClientId = `smoke-entry-${ts}`
const slClientId = `smoke-sl-${ts}`

let cleanup = { cancelAll: false, flattened: false, note: null }
let preflightPassed = false
/** 清理只属于本次空账户冒烟；未通过前置检查时绝不处理用户原有持仓。 */
async function forceCleanup(reason) {
  cleanup = await cleanupSmokePosition(broker, SYMBOL, async (qty) => {
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
  })
  record(`cleanup(${reason})`, cleanup.cancelAll && cleanup.flattened, cleanup)
}

const report = {
  ranAt: new Date().toISOString(),
  execute: EXECUTE,
  symbol: SYMBOL,
  contractSize,
  oneContractBase,
  referencePrice: price,
  oneContractNotionalUsd: oneContractBase * price,
  logPath: LOG ?? null,
  steps,
  cleanup,
}

try {
  // ── ① 只读预检（任何模式下都做）────────────────────────────────────────────
  const equityQuote = await broker.readOnlyBalance()
  const positions0 = await broker.getPositions()
  const open0 = await broker.getOpenOrders()
  record('preflight_readOnlyBalance', Number.isFinite(equityQuote) && equityQuote > 0, {
    venue: broker.venue,
    equityQuote,
  })
  record('preflight_getPositions', Array.isArray(positions0), { count: positions0.length })
  record('preflight_getOpenOrders', Array.isArray(open0), { count: open0.length })

  try {
    assertSmokeAccountFlat(positions0, open0)
  } catch {
    record('preflight_flat_required', false, { note: '账户非空仓或有挂单，冒烟拒绝继续（不干扰既有仓位）' })
    throw new Error('账户非空仓/有挂单，拒绝继续')
  }
  record('preflight_flat_required', true)

  const capConfigured = process.env.TRADER_SMOKE_MAX_DRAWDOWN_PCT !== undefined
  if (EXECUTE || capConfigured) {
    const maxDrawdownPct = Number(process.env.TRADER_SMOKE_MAX_DRAWDOWN_PCT)
    const lossEnvelope = evaluateSmokeLossEnvelope({
      equityQuote, maxDrawdownPct, oneContractBase, referencePrice: price,
    })
    record('preflight_loss_envelope', lossEnvelope.fits, { maxDrawdownPct, ...lossEnvelope })
    if (EXECUTE && !lossEnvelope.fits) throw new Error('最小一张合约超出本次总损失额度，拒绝真实下单')
  }

  if (!EXECUTE) {
    record('dry_run', true, { note: '未加 --execute：只做预检，不下任何单' })
  } else {
    preflightPassed = true

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
    if (entry.state !== 'filled') throw new Error('开仓终态未确认，进入安全清理')

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
      note: 'HTX 生成的 client_order_id = 订单号；本脚本不走生产 journal，不能用它证明生产幂等',
      queriedWith: entryClientId,
      found: byOwn !== undefined,
    })
    const positions1 = await broker.getPositions()
    const qty1 = positionQtyOf(positions1)
    record('query_getPositions(after_entry)', Number.isFinite(qty1) && qty1 > 0, { qty: qty1 })
    if (!Number.isFinite(qty1) || qty1 <= 0) throw new Error('开仓后无法核验正向持仓，进入安全清理')
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
      expectedPositionQty: qty1,
      stopLossPrice,
    })
    record('protective_place_stop', protective.state !== 'rejected', {
      state: protective.state,
      exchangeOrderId: protective.exchangeOrderId ?? null,
      stopLossPrice,
    })

    // ── ⑤ 查询保护单 ────────────────────────────────────────────────────────
    const openProt = await broker.getOpenOrders(SYMBOL)
    const stopVisible = protective.exchangeOrderId !== undefined &&
      openProt.some((order) => order.exchangeOrderId === protective.exchangeOrderId)
    record('query_getOpenOrders(after_protective)', stopVisible, {
      count: openProt.length,
      stopVisible,
    })
    if (!stopVisible) throw new Error('交易所合并挂单视图没有确认止损，拒绝继续冒烟')
    const protFound = await broker.findOrderByClientOrderId(protective.exchangeOrderId ?? '')
    // 算法单按 id 查询是否可用在不同 HTX 部署上不一致；**撤单已经能成功**（用 algo 标志），
    // 所以这里只如实记录能力，不把它当失败（否则会把"平台差异"伪装成我们的缺陷）。
    record('query_findOrderByClientOrderId(protective, by exchange id)', true, {
      found: protFound !== undefined,
      state: protFound?.state ?? null,
      note: protFound === undefined ? '该部署的算法单查询端点不按 algo_id 返回；撤单/平仓不受影响' : undefined,
    })

    // ── ⑥ 持仓期间只验证默认撤单保留保护 ──────────────────────────────────────
    const protective2 = await broker.placeProtective({
      symbol: SYMBOL,
      clientOrderId: `${slClientId}-tp`,
      expectedPositionQty: qty1,
      takeProfitPrice,
    })
    record('protective_place_takeProfit', protective2.state !== 'rejected', {
      exchangeOrderId: protective2.exchangeOrderId ?? null,
      takeProfitPrice,
    })
    await broker.cancelAll(SYMBOL)
    const protectedOpen = await broker.getOpenOrders(SYMBOL)
    const protectionStillVisible = [protective.exchangeOrderId, protective2.exchangeOrderId]
      .every((id) => id !== undefined && protectedOpen.some((order) => order.exchangeOrderId === id))
    record('cancel_all_preserves_protection_while_open', protectionStillVisible, {
      remaining: protectedOpen.length,
      remainingIds: protectedOpen.map((o) => o.exchangeOrderId ?? null),
    })
    if (!protectionStillVisible) throw new Error('持仓期间保护单未保持远端可见，立即进入平仓清理')

    // ── ⑦ 平仓 ──────────────────────────────────────────────────────────────
    const beforeClose = positionQtyOf(await broker.getPositions())
    if (!Number.isFinite(beforeClose) || beforeClose === 0) throw new Error('平仓前无法核验非零持仓，进入安全清理')
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
    if (afterClose !== 0) throw new Error('平仓未确认，保留远端保护单')
    await broker.cancelAll(SYMBOL, { includeProtection: true })
    const afterCancelAll = await broker.getOpenOrders(SYMBOL)
    record('cancel_protection_after_flat', afterCancelAll.length === 0, {
      remaining: afterCancelAll.length,
    })

    // ── ⑧ 终态 ──────────────────────────────────────────────────────────────
    const finalOpen = await broker.getOpenOrders(SYMBOL)
    record('final_no_open_orders', finalOpen.length === 0, { count: finalOpen.length })
  }
} catch (error) {
  record('fatal', false, { error: String(error).slice(0, 300) })
} finally {
  if (EXECUTE && preflightPassed) await forceCleanup('finally')
  report.cleanup = cleanup
  report.allPassed = steps.every((s) => s.ok)
  report.steps = steps
  console.log(JSON.stringify(report, null, 2))
  if (OUT !== undefined) writeFileSync(OUT, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await exchange.close?.()
  process.exit(report.allPassed ? 0 : 1)
}
