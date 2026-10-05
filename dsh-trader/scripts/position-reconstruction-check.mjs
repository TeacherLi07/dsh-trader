#!/usr/bin/env node
/** 只读历史真实成交：新重建结果、平仓现金流与原文件指纹必须一致。 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { applyPositionFill } from '../lib/exec/position.js'
import { reconstructPosition } from '../lib/memory/settle.js'

const [input, directory] = process.argv.slice(2)
assert.ok(input && directory, 'usage: position-reconstruction-check.mjs source.sqlite newPrivateDirectory')
const source = resolve(input), output = resolve(directory)
assert.ok(!existsSync(output), 'refuse to overwrite earlier evidence')
mkdirSync(output, { recursive: true, mode: 0o700 })
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const files = [source, ...[source + '-wal', source + '-shm'].filter(existsSync)]
const report = { passed: false, source, sourceHashes: Object.fromEntries(files.map(path => [path, hash(path)])),
  networkRequests: 0, paidModelRequests: 0, exchangeActions: 0, accountIdentityProven: false, fundingCostKnown: false }
let db
try {
  db = new Database(source, { readonly: true, fileMustExist: true })
  const fills = db.prepare(`SELECT f.fill_id AS fillId,f.qty,f.price,f.fee,f.fee_ccy AS feeCurrency,f.ts,
    oi.side,oi.venue,oi.symbol,oi.decision_id AS decisionId,oi.reduce_only AS reduceOnly
    FROM fills f JOIN orders o ON o.order_id=f.order_id
    JOIN order_intents oi ON oi.client_order_id=o.client_order_id ORDER BY f.ts,f.fill_id`).all()
  assert.ok(fills.length > 0, 'nonempty historical fills required')
  assert.ok(fills.every(fill => fill.venue === 'htx'), 'real HTX history required')
  assert.equal(new Set(fills.map(fill => fill.symbol)).size, 1, 'one-symbol historical book required')
  let position = { qty: 0, avgPrice: 0 }, gross = 0, cashFlow = 0
  report.steps = []
  for (const [index, fill] of fills.entries()) {
    const next = applyPositionFill(position, fill)
    gross += next.realizedGrossQuote
    cashFlow -= (fill.side === 'buy' ? 1 : -1) * fill.qty * fill.price
    position = { qty: next.qty, avgPrice: next.avgPrice }
    assert.deepEqual(reconstructPosition(fills.slice(0, index + 1)), position)
    report.steps.push({ fill, ...next })
  }
  assert.equal(position.qty, 0, 'cash-flow equality requires a closed historical book')
  const scale = fills.reduce((sum, fill) => sum + Math.abs(fill.qty * fill.price), 0)
  const tolerance = Number.EPSILON * scale * fills.length * 8
  assert.ok(Math.abs(gross - cashFlow) <= tolerance)
  db.close(); db = undefined
  assert.deepEqual(Object.fromEntries(files.map(path => [path, hash(path)])), report.sourceHashes)
  Object.assign(report, { passed: true, sourceUnchanged: true, realFillCount: fills.length,
    finalPosition: position, grossQuote: gross, flatBookCashFlowQuote: cashFlow, tolerance })
} catch (error) {
  report.error = String(error)
} finally {
  db?.close()
  writeFileSync(output + '/report.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
console.log(JSON.stringify({ passed: report.passed, realFillCount: report.realFillCount,
  finalPosition: report.finalPosition, sourceUnchanged: report.sourceUnchanged }))
if (!report.passed) process.exitCode = 1
