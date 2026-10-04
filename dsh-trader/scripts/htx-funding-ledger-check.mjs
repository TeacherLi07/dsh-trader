#!/usr/bin/env node
/** V5资金费来源只读检查，空页不生成FundingCost；每次使用新的私有目录保存证据。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ccxt from 'ccxt'
import { systemClock } from '../lib/clock.js'
import { HtxBroker } from '../lib/exec/ccxt-broker.js'
import { HtxFundingLedger } from '../lib/exec/htx-funding-ledger.js'
import { applyProxyAwareFetch } from '../lib/market/ccxt-source.js'

const [directory, start, end, contractCode = 'FIL-USDT'] = process.argv.slice(2)
assert.ok(directory, 'usage: htx-funding-ledger-check.mjs newPrivateDirectory fromMs untilMs [contractCode]')
const from = Number(start), until = Number(end), output = resolve(directory)
assert.ok(!existsSync(output), 'new output directory required')
assert.ok(process.env.TRADER_API_KEY && process.env.TRADER_API_SECRET, 'HTX credentials not injected')
const clock = systemClock(), exchange = new ccxt.htx({ enableRateLimit: true, timeout: 20000 })
applyProxyAwareFetch(exchange)
new HtxBroker({ exchange, clock, venue: 'htx', accountType: 'swap', positionSide: 'both',
  symbol: 'FIL/USDT:USDT', apiKey: process.env.TRADER_API_KEY, apiSecret: process.env.TRADER_API_SECRET })
const secrets = ['TRADER_API_KEY', 'TRADER_API_SECRET', 'SUB2API_KEY', 'DEEPSEEK_API_KEY'].map(k => process.env[k]).filter(Boolean)
const safe = value => {
  let text = JSON.stringify(value)
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]')
  return JSON.parse(text)
}
mkdirSync(output, { recursive: true, mode: 0o700 })
const report = { at: clock.now(), readOnly: true, exchangeActions: 0, passed: false }
try {
  const identity = await exchange.spotPrivateGetV2UserUid()
  assert.equal(identity.code, 200, 'account identity request rejected')
  const uid = identity.data
  assert.ok((typeof uid === 'number' && Number.isSafeInteger(uid) && uid > 0) ||
    (typeof uid === 'string' && /^[1-9]\d*$/.test(uid)), 'account identity unavailable')
  const accountId = 'htx:' + createHash('sha256').update(String(uid)).digest('hex')
  const reader = new HtxFundingLedger(async params => {
    const raw = await exchange.contractPrivateGetV5AccountBills(params)
    appendFileSync(output + '/responses.jsonl', JSON.stringify(safe({ params, response: raw })) + '\n', { mode: 0o600 })
    return raw
  }, clock, { accountId, contractCode, marginMode: 'cross', quoteCurrency: 'USDT' })
  report.result = await reader.read(from, until)
  report.accountIdentityBound = true
  report.knownDecisionFundingCost = false
  report.passed = true
} catch (error) {
  report.error = String(error)
} finally {
  await exchange.close()
  writeFileSync(output + '/report.json', JSON.stringify(safe(report), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
console.log(JSON.stringify(safe({ passed: report.passed, pages: report.result?.pages,
  paymentRows: report.result?.payments.length, knownDecisionFundingCost: false, error: report.error ?? null })))
if (!report.passed) process.exitCode = 1
