#!/usr/bin/env node
/**
 * HTX 只读预检（plan §12.2 A 第①步）—— **不下任何单**。
 *
 * 用法：
 *   # 凭据放 $DSH_HOME/.env（chmod 600），DSH 会自动加载；脚本本身只从进程环境读
 *   node scripts/htx-preflight.mjs [venue] [symbol] [outPath] [--require-consistent]
 *   # 例：node scripts/htx-preflight.mjs htx BTC/USDT:USDT docs/htx-preflight.json
 *
 * 环境变量：TRADER_API_KEY / TRADER_API_SECRET（必填，只读）；DSH_TRADER_DB 覆盖库路径；
 *          TRADER_PREFLIGHT_SANDBOX=1 打开 OKX sandbox（HTX 无 sandbox）。
 *
 * 它做什么：读账户权益 + 持仓 + 挂单，与本地库对账，打印 JSON 报告。
 * 它**不**做什么：不下单、不撤单、不修改任何交易所状态（报告里 `executedActions` 恒为空）。
 *
 * 退出码：0 = 读取成功（一致性见报告）；1 = 读取失败；2 = 凭据缺失（提示如何提供，不打印值）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import ccxt from 'ccxt'
import { systemClock } from '../lib/clock.js'
import { CcxtBroker } from '../lib/exec/ccxt-broker.js'
import { LocalStateReader, runReadOnlyPreflight } from '../lib/exec/preflight.js'
import { applyProxyAwareFetch } from '../lib/market/ccxt-source.js'
import { migrate } from '../lib/db/schema.js'

const argv = process.argv.slice(2)
const requireConsistent = argv.includes('--require-consistent')
const positional = argv.filter((arg) => !arg.startsWith('--'))
const venue = positional[0] ?? 'htx'
const symbol = positional[1] ?? 'BTC/USDT:USDT'
const outPath = positional[2]
/** HTX 现货与 USDT 永续账户分离；本策略跑永续，默认读 swap 账户。 */
const accountType = process.env.TRADER_ACCOUNT_TYPE ?? 'swap'

if (venue !== 'htx' && venue !== 'okx') {
  console.error(`不支持的 venue：${venue}（只允许 htx | okx）`)
  process.exit(1)
}

const apiKey = process.env.TRADER_API_KEY ?? ''
const apiSecret = process.env.TRADER_API_SECRET ?? ''
if (apiKey.trim() === '' || apiSecret.trim() === '') {
  // 只报缺失，绝不打印值。
  console.error(
    [
      '缺少凭据：TRADER_API_KEY / TRADER_API_SECRET 未注入。',
      '提供方式（推荐，不入仓库）：',
      `  install -m 600 /dev/null ${join(homedir(), '.dsh', '.env')}`,
      '  然后用编辑器写入：TRADER_API_KEY=... 与 TRADER_API_SECRET=...（各一行）',
      '  HTX key 权限最小化：只开交易、禁用提现、绑 IP 白名单。',
      '也可临时：set -a; . ~/.dsh/.env; set +a; node scripts/htx-preflight.mjs',
    ].join('\n'),
  )
  process.exit(2)
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dbPath = process.env.DSH_TRADER_DB ?? join(dshHome, 'trading', 'desk.db')
const dbExisted = existsSync(dbPath)
if (!dbExisted) mkdirSync(dirname(dbPath), { recursive: true })
const db = new Database(dbPath)
migrate(db)

const Exchange = ccxt[venue]
if (Exchange === undefined) {
  console.error(`未知交易所：${venue}`)
  process.exit(1)
}
const exchange = new Exchange({
  enableRateLimit: true,
  // ★ HTX 现货与 USDT 永续是**两个账户**：不指定 defaultType 会读写到现货账户（通常为 0），
  // 让 sizing 以为"没钱"。我们的标的是永续，因此默认 swap（可用 TRADER_ACCOUNT_TYPE 覆盖）。
  defaultType: accountType,
})
applyProxyAwareFetch(exchange)

const clock = systemClock()
const broker = new CcxtBroker({
  exchange,
  venue,
  clock,
  apiKey,
  apiSecret,
  symbol,
  accountType,
  sandbox: process.env.TRADER_PREFLIGHT_SANDBOX === '1',
})

let report
let failed = null
try {
  const local = new LocalStateReader(db)
  report = await runReadOnlyPreflight({
    broker,
    clock,
    localOrders: local.orders(),
    localPositions: local.positions(),
  })
} catch (error) {
  failed = String(error instanceof Error ? error.message : error)
}

const payload = {
  ranAt: new Date().toISOString(),
  venue,
  symbol,
  accountType,
  dbPath,
  dbExisted,
  credentials: { keyInjected: true, secretInjected: true },
  report: report ?? null,
  error: failed,
  readOnlyGuarantee:
    '本脚本只调用 getPositions/getOpenOrders/readOnlyBalance；executedActions 恒为空，绝不下单或撤单。',
}

console.log(JSON.stringify(payload, null, 2))
if (outPath !== undefined) writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8')
await exchange.close?.()
db.close()

if (failed !== null) process.exit(1)
if (requireConsistent && report !== undefined && !report.consistent) process.exit(1)
process.exit(0)
