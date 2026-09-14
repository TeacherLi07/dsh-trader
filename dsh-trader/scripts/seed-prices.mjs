#!/usr/bin/env node
/**
 * 价目表种子（plan §8.1 / P-1.5）。
 *
 * 用法：node scripts/seed-prices.mjs [dbPath]
 * 默认 dbPath 从 `DSH_TRADER_DB` 读，否则 `/tmp/dsh-trader-prices.db`。
 *
 * 种子值来自 `DEEPSEEK_PRICE_SEED`（从官方价目页抓取，含峰谷两档），
 * 幂等：重复运行不会重复插入，只会报告新增行数。
 */

import Database from 'better-sqlite3'
import { DEEPSEEK_PRICE_SEED, PRICING_SOURCE } from '../lib/cost.js'
import { migrate } from '../lib/db/schema.js'
import { PriceTableStore } from '../lib/cost-ledger.js'

const dbPath = process.argv[2] ?? process.env.DSH_TRADER_DB ?? '/tmp/dsh-trader-prices.db'
const db = new Database(dbPath)
migrate(db)
const prices = new PriceTableStore(db)
const added = prices.seed(DEEPSEEK_PRICE_SEED)

console.log(`db: ${dbPath}`)
console.log(`source: ${PRICING_SOURCE}`)
console.log(`新增 ${added} 行，现有 ${prices.count()} 行，版本指纹 ${prices.version()}`)
for (const price of prices.all()) {
  console.log(
    `  ${price.model.padEnd(16)} ${(price.tier ?? 'any').padEnd(9)} ` +
      `hit=${price.cachedInPerMtok ?? '-'} in=${price.inPerMtok} out=${price.outPerMtok}`,
  )
}
db.close()
