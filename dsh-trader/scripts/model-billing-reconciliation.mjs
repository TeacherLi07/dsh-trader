#!/usr/bin/env node
/** 先停止交易 profile；账单证据人工核对来源，文件哈希只证明其内容没有变化。 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { systemClock } from '../lib/clock.js'
import { migrate } from '../lib/db/schema.js'
import { inspectModelReconciliation, parseModelBillingReceipt, reconcileModelCall } from '../lib/agents/model-billing-reconciliation.js'

const [dbPath, receiptPath, evidencePath, operation = 'inspect', expectedPlanHash, ...reasonParts] = process.argv.slice(2)
assert.ok(dbPath && receiptPath && evidencePath,
  'usage: model-billing-reconciliation.mjs db receipt.json evidence-file [inspect|apply] [planHash] [reason]')
assert.ok(['inspect', 'apply'].includes(operation), 'invalid operation')
assert.ok(statSync(receiptPath).size <= 64 * 1024, 'receipt exceeds 64 KiB')
assert.ok(statSync(evidencePath).size <= 4 * 1024 * 1024, 'billing evidence exceeds 4 MiB')
const receipt = parseModelBillingReceipt(JSON.parse(readFileSync(receiptPath, 'utf8')))
const evidenceHash = createHash('sha256').update(readFileSync(evidencePath)).digest('hex')
assert.equal(evidenceHash, receipt.evidence.sha256, 'billing evidence hash mismatch')
const reason = reasonParts.join(' ')
if (operation === 'apply') {
  assert.match(expectedPlanHash ?? '', /^sha256:[a-f0-9]{64}$/, 'apply requires the exact inspect planHash')
  assert.ok(reason.trim(), 'apply requires a review reason')
}
const db = new Database(resolve(dbPath), { readonly: operation === 'inspect', fileMustExist: true })
try {
  if (operation === 'apply') migrate(db)
  const clock = systemClock()
  const plan = operation === 'inspect' ? inspectModelReconciliation(db, receipt, clock.now()) :
    reconcileModelCall({ db, clock, receipt, expectedPlanHash, reason })
  console.log(JSON.stringify({ operation, plan, evidenceFileHashVerified: true,
    evidenceAuthenticity: 'operator_reviewed', modelsInvoked: 0, exchangeActions: 0, terminalRunsUpdated: 0 }, null, 2))
} finally { db.close() }
