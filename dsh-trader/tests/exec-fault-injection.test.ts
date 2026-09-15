import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { SimExchange } from '../src/exec/sim-exchange.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { CrashRecovery } from '../src/exec/recovery.js'

const NOW = 1_700_000_000_000
const SYMBOL = 'BTC/USDT'

let dir: string
let dbPath: string
let db: Database.Database
let journal: DecisionJournal
let exchange: SimExchange

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-fault-injection-'))
  dbPath = join(dir, 'state.db')
  db = new Database(dbPath)
  migrate(db)
  journal = new DecisionJournal(db)
  exchange = new SimExchange(dbPath)
})

afterEach(() => {
  exchange.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function writeIntent(clientOrderId: string, intentId: string, type: 'market' | 'limit' = 'market'): void {
  journal.recordDecision({
    decisionId: `decision-${intentId}`,
    symbol: SYMBOL,
    decidedAt: NOW,
    contextHash: `context-${intentId}`,
    action: 'open',
    executed: false,
  })
  journal.recordIntent({
    intentId,
    clientOrderId,
    decisionId: `decision-${intentId}`,
    venue: 'paper',
    symbol: SYMBOL,
    state: 'created',
    type,
    side: 'buy',
    qty: 1,
    ...(type === 'limit' ? { price: 90 } : {}),
    reduceOnly: false,
    createdAt: NOW,
  })
}

describe('P2 故障注入：进程内恢复收敛', () => {
  it('交易所已持久化成交但 ack 前中断，恢复不重新下单且孤儿口径为零', async () => {
    writeIntent('crash-client', 'crash-intent')
    exchange.onPrice(SYMBOL, 100)
    let injected = false
    exchange.close()
    exchange = new SimExchange(dbPath, {
      onStep: (step) => {
        if (!injected && step === 'after_persist_before_ack') {
          injected = true
          throw new Error('fault injected after exchange persistence')
        }
      },
    })
    await expect(
      exchange.placeOrder({
        intentId: 'crash-intent',
        clientOrderId: 'crash-client',
        decisionId: 'decision-crash-intent',
        symbol: SYMBOL,
        type: 'market',
        side: 'buy',
        qty: 1,
        notionalUsd: 100,
      }),
    ).rejects.toThrow('fault injected')

    // 添加一个本地有记录的未成交限价单，证明孤儿计算的分母不是空集。
    writeIntent('local-open-client', 'local-open-intent', 'limit')
    await exchange.placeOrder({
      intentId: 'local-open-intent',
      clientOrderId: 'local-open-client',
      decisionId: 'decision-local-open-intent',
      symbol: SYMBOL,
      type: 'limit',
      side: 'buy',
      qty: 1,
      price: 90,
      notionalUsd: 90,
    })
    const inFlightBefore = journal.inFlightIntents()
    expect(inFlightBefore.length).toBeGreaterThan(0)
    expect(exchange.openOrderCount()).toBeGreaterThan(0)
    exchange.close()
    db.close()

    db = new Database(dbPath)
    journal = new DecisionJournal(db)
    exchange = new SimExchange(dbPath)
    const recovery = new CrashRecovery({
      journal,
      broker: exchange,
      clock: new ReplayClock(NOW),
      symbols: [SYMBOL],
    })
    const first = await recovery.run()
    expect(first.scanned).toBeGreaterThan(0)
    expect(first.orphanOpenOrders.length).toBe(0)
    expect(journal.inFlightIntents()).toEqual([])
    const decisionIds = journal.decisionIds()
    const intentIds = journal.intentIds()
    const second = await recovery.run()
    expect(second.orphanOpenOrders.length).toBe(0)
    expect(journal.decisionIds()).toEqual(decisionIds)
    expect(journal.intentIds()).toEqual(intentIds)
    expect(exchange.fillCount()).toBe(1)
    expect(exchange.openOrderCount()).toBe(1)
  })
})
