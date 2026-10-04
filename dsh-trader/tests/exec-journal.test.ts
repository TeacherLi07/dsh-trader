import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { DecisionJournal, type DecisionRecord } from '../src/exec/journal.js'

const NOW = 1_700_000_000_000

let db: Database.Database
let journal: DecisionJournal

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  journal = new DecisionJournal(db)
})

afterEach(() => {
  db.close()
})

const decision = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  decisionId: 'd1',
  symbol: 'BTC/USDT',
  planId: 'pc-1',
  decidedAt: NOW,
  contextHash: 'sha256:ctx',
  action: 'open',
  sizeQty: 1,
  executed: true,
  ...over,
})

describe('DecisionJournal', () => {
  it('persists an immutable account binding; paper reuses its DB namespace across restart', () => {
    const paperA = `sha256:${'a'.repeat(64)}`
    const paperB = `sha256:${'b'.repeat(64)}`
    const first = new DecisionJournal(db)
    expect(first.bindExecutionScopeHash({ mode: 'paper', candidateHash: paperA, at: NOW })).toBe(paperA)
    expect(first.bindExecutionScopeHash({ mode: 'paper', candidateHash: paperB, at: NOW + 1 })).toBe(paperA)

    const restarted = new DecisionJournal(db)
    expect(restarted.bindExecutionScopeHash({ mode: 'paper', candidateHash: paperB, at: NOW + 2 })).toBe(paperA)
    expect(restarted.executionScopeHash).toBe(paperA)
    expect(() => restarted.bindExecutionScopeHash({ mode: 'live', candidateHash: paperA, at: NOW + 3 }))
      .toThrow(/不可换绑/)

    const otherDb = new Database(':memory:')
    migrate(otherDb)
    try {
      const other = new DecisionJournal(otherDb)
      expect(other.bindExecutionScopeHash({ mode: 'paper', candidateHash: paperB, at: NOW })).toBe(paperB)
      expect(other.executionScopeHash).not.toBe(restarted.executionScopeHash)
    } finally {
      otherDb.close()
    }
  })

  it('live UID scope changes and post-write rebinding are rejected', () => {
    const hashA = `sha256:${'a'.repeat(64)}`
    const hashB = `sha256:${'b'.repeat(64)}`
    const scoped = new DecisionJournal(db)
    expect(scoped.bindExecutionScopeHash({ mode: 'live', candidateHash: hashA, at: NOW })).toBe(hashA)
    expect(scoped.bindExecutionScopeHash({ mode: 'live', candidateHash: hashA, at: NOW + 1 })).toBe(hashA)
    expect(() => scoped.bindExecutionScopeHash({ mode: 'live', candidateHash: hashB, at: NOW + 2 }))
      .toThrow(/不可换绑/)

    const restarted = new DecisionJournal(db)
    expect(() => restarted.bindExecutionScopeHash({ mode: 'live', candidateHash: hashB, at: NOW + 3 }))
      .toThrow(/数据库已绑定其他执行账户 scope/)

    const unboundDb = new Database(':memory:')
    migrate(unboundDb)
    const unbound = new DecisionJournal(unboundDb)
    unbound.recordDecision(decision({ decisionId: 'd-unbound' }))
    unbound.recordIntent({
      intentId: 'unscoped-before-bind', clientOrderId: 'unscoped-before-bind', decisionId: 'd-unbound',
      venue: 'paper', symbol: 'BTC/USDT', state: 'canceled', type: 'market', side: 'buy', qty: 1,
      reduceOnly: false, createdAt: NOW,
    })
    expect(() => unbound.bindExecutionScopeHash({ mode: 'live', candidateHash: hashA, at: NOW + 4 }))
      .toThrow(/未绑定 scope 的意图写入/)
    unboundDb.close()
    expect(() => new DecisionJournal(db).recordIntent({
      intentId: 'unvalidated', clientOrderId: 'unvalidated', decisionId: 'd1',
      venue: 'htx', symbol: 'BTC/USDT:USDT', state: 'created', type: 'market', side: 'buy',
      qty: 1, reduceOnly: false, createdAt: NOW,
    })).toThrow(/必须校验并绑定/)
  })

  it('records scope by the shared journal entry and rejects cross-account idempotency collisions', () => {
    const hashA = `sha256:${'c'.repeat(64)}`
    const hashB = `sha256:${'d'.repeat(64)}`
    const scoped = new DecisionJournal(db)
    scoped.bindExecutionScopeHash({ mode: 'live', candidateHash: hashA, at: NOW })
    scoped.recordDecision(decision())
    const intent = {
      intentId: 'scoped-i1', clientOrderId: 'scoped-co1', decisionId: 'd1', venue: 'htx',
      symbol: 'BTC/USDT:USDT', state: 'filled' as const, type: 'market', side: 'buy', qty: 1,
      reduceOnly: false, createdAt: NOW,
    }
    expect(scoped.recordIntent(intent)).toBe(true)
    expect(db.prepare('SELECT account_scope_hash FROM order_intents WHERE client_order_id = ?').get('scoped-co1'))
      .toEqual({ account_scope_hash: hashA })
    expect(scoped.recordIntent({ ...intent, intentId: 'scoped-i2' })).toBe(false)
    expect(() => scoped.recordIntent({ ...intent, intentId: 'scoped-i3', clientOrderId: 'scoped-co2', accountScopeHash: hashB }))
      .toThrow(/不匹配/)
    expect(() => scoped.recordIntent({ ...intent, intentId: 'scoped-paper', clientOrderId: 'scoped-paper', venue: 'paper' }))
      .toThrow(/venue 与已绑定执行账户模式不匹配/)

    db.prepare(`INSERT INTO order_intents
      (intent_id, client_order_id, decision_id, venue, symbol, state, type, side, qty, reduce_only, created_at, account_scope_hash)
      VALUES ('foreign-i', 'scoped-co-foreign', 'd1', 'htx', 'BTC/USDT:USDT', 'filled', 'market', 'buy', 1, 0, ?, ?)`)
      .run(NOW, hashB)
    expect(() => scoped.recordIntent({ ...intent, intentId: 'local-i', clientOrderId: 'scoped-co-foreign' }))
      .toThrow(/其他账户 scope/)
  })

  it('exposes decision and account scope on nonempty fills and rejects NULL/mixed scope history', () => {
    const hashA = `sha256:${'e'.repeat(64)}`
    const hashB = `sha256:${'f'.repeat(64)}`
    // 真正的旧NULL成交必须早于数据库scope绑定；新helper不能继续写未知来源。
    const legacy = new DecisionJournal(db)
    legacy.recordDecision(decision({ decisionId: 'd-legacy' }))
    legacy.recordIntent({
      intentId: 'legacy-fill-i', clientOrderId: 'legacy-fill-co', decisionId: 'd-legacy', venue: 'paper',
      symbol: 'BTC/USDT', state: 'filled', type: 'market', side: 'buy', qty: 1,
      reduceOnly: false, createdAt: NOW,
    })
    legacy.recordOrder({ orderId: 'legacy-fill-o', venue: 'paper', exchangeOrderId: 'legacy-fill-ex',
      clientOrderId: 'legacy-fill-co', symbol: 'BTC/USDT', status: 'filled', qty: 1, filledQty: 1,
      avgPrice: 100, updatedAt: NOW })
    legacy.recordFill({ fillId: 'legacy-fill-f', orderId: 'legacy-fill-o', qty: 1, price: 100,
      fee: 0.05, feeCurrency: 'USDT', ts: NOW })
    const scoped = new DecisionJournal(db)
    scoped.bindExecutionScopeHash({ mode: 'paper', candidateHash: hashA, at: NOW })
    scoped.recordDecision(decision())
    scoped.recordIntent({
      intentId: 'fill-scope-i', clientOrderId: 'fill-scope-co', decisionId: 'd1', venue: 'paper',
      symbol: 'BTC/USDT', state: 'filled', type: 'market', side: 'buy', qty: 1,
      reduceOnly: false, createdAt: NOW,
    })
    scoped.recordOrder({ orderId: 'fill-scope-o', venue: 'paper', exchangeOrderId: 'fill-scope-ex',
      clientOrderId: 'fill-scope-co', symbol: 'BTC/USDT', status: 'filled', qty: 1, filledQty: 1,
      avgPrice: 100, updatedAt: NOW })
    scoped.recordFill({ fillId: 'fill-scope-f', orderId: 'fill-scope-o', qty: 1, price: 100,
      fee: 0.05, feeCurrency: 'USDT', ts: NOW })

    const fills = scoped.fillsForDecision('d1')
    expect(fills).toHaveLength(1)
    expect(fills[0]).toMatchObject({ decisionId: 'd1', accountScopeHash: hashA })
    expect(() => scoped.fillsForSymbolBefore('BTC/USDT', NOW + 1, 'paper')).toThrow(/NULL 或不同账户 scope/)
    expect(() => scoped.fillsForSymbolBefore('BTC/USDT', NOW + 1, 'paper', hashB))
      .toThrow(/不同账户 scope/)

    expect(db.prepare('SELECT account_scope_hash FROM order_intents WHERE client_order_id = ?').get('legacy-fill-co'))
      .toEqual({ account_scope_hash: null })
    expect(() => scoped.fillsForDecision('d-legacy')).toThrow(/NULL 或不同账户 scope/)
  })

  it('records a decision and reports it once', () => {
    expect(journal.recordDecision(decision())).toBe(true)
    expect(journal.recordDecision(decision())).toBe(false)
    expect(journal.decisionIds()).toEqual(['d1'])
  })

  it('pendingSettlements 按 tf 过滤；缺 tf 的决策不会被任何 scheduler 误领（plan §5.3）', () => {
    journal.recordDecision(decision({ decisionId: 'd-1h', timeframe: '1h', reflectionDueAt: NOW }))
    journal.recordDecision(decision({ decisionId: 'd-4h', timeframe: '4h', reflectionDueAt: NOW }))
    journal.recordDecision(decision({ decisionId: 'd-null', reflectionDueAt: NOW }))

    expect(journal.pendingSettlements(NOW, 10, '1h').map((row) => row.decisionId)).toEqual(['d-1h'])
    expect(journal.pendingSettlements(NOW, 10, '4h').map((row) => row.decisionId)).toEqual(['d-4h'])
    // 不传 tf = 不过滤（旧调用方/运维排查用）
    expect(
      journal
        .pendingSettlements(NOW, 10)
        .map((row) => row.decisionId)
        .sort(),
    ).toEqual(['d-1h', 'd-4h', 'd-null'])
    // 缺 tf 的决策不会被"猜"成某个 tf：宁可不结算，也不用错的 bar 窗口结算
    expect(journal.pendingSettlements(NOW, 10, '1h').some((row) => row.decisionId === 'd-null')).toBe(false)
  })

  it('dedupes identical content and refuses to rewrite the same decision id', () => {
    expect(journal.recordDecision(decision())).toBe(true)
    expect(journal.recordDecision(decision())).toBe(false)
    // `executed` 是结果而非内容，不进入幂等根
    expect(journal.recordDecision({ ...decision(), executed: false })).toBe(false)
    expect(journal.decisionIds()).toEqual(['d1'])
    // 同一 decisionId 改内容 = 事后改写 → 主键冲突，必须报错而不是悄悄写第三条
    expect(() => journal.recordDecision({ ...decision(), sizeQty: 999 })).toThrow()
    expect(journal.recordDecision(decision({ decisionId: 'd2', action: 'close' }))).toBe(true)
    expect(journal.decisionIds()).toEqual(['d1', 'd2'])
  })

  it('rejects an action outside the closed vocabulary instead of silently dropping it', () => {
    expect(() => journal.recordDecision(decision({ action: 'teleport' as never }))).toThrow()
  })

  it('is idempotent per client_order_id and never duplicates an order', () => {
    journal.recordDecision(decision()) // order_intents.decision_id 有外键
    const intent = {
      intentId: 'i1',
      clientOrderId: 'co-1',
      decisionId: 'd1',
      venue: 'paper',
      symbol: 'BTC/USDT',
      state: 'filled' as const,
      type: 'market',
      side: 'buy',
      qty: 1,
      notionalUsd: 100,
      reduceOnly: false,
      createdAt: NOW,
    }
    expect(journal.recordIntent(intent)).toBe(true)
    expect(journal.recordIntent({ ...intent, intentId: 'i2' })).toBe(false)
    expect(journal.intentIds()).toEqual(['i1'])
    expect(journal.duplicateClientOrderIds()).toBe(0)
    expect(journal.hasClientOrderId('co-1')).toBe(true)
    expect(journal.hasClientOrderId('co-2')).toBe(false)
  })

  it('records orders and fills idempotently', () => {
    journal.recordDecision(decision())
    journal.recordIntent({
      intentId: 'i1',
      clientOrderId: 'co-1',
      decisionId: 'd1',
      venue: 'paper',
      symbol: 'BTC/USDT',
      state: 'filled',
      type: 'market',
      side: 'buy',
      qty: 1,
      reduceOnly: false,
      createdAt: NOW,
    })
    const order = {
      orderId: 'o1',
      venue: 'paper',
      exchangeOrderId: 'o1',
      clientOrderId: 'co-1',
      symbol: 'BTC/USDT',
      status: 'filled',
      qty: 1,
      filledQty: 1,
      avgPrice: 100,
      updatedAt: NOW,
    }
    const fill = { fillId: 'f1', orderId: 'o1', qty: 1, price: 100, fee: 0.05, feeCurrency: 'USDT', ts: NOW }

    expect(journal.recordOrder(order)).toBe(true)
    expect(journal.recordOrder(order)).toBe(false)
    expect(journal.recordFill(fill)).toBe(true)
    expect(journal.recordFill(fill)).toBe(false)
    expect(journal.fillIds()).toEqual(['f1'])
  })

  it('refuses a fill for an order that was never recorded (FK enforced)', () => {
    expect(() =>
      journal.recordFill({
        fillId: 'f9',
        orderId: 'missing',
        qty: 1,
        price: 1,
        fee: 0,
        feeCurrency: 'USDT',
        ts: NOW,
      }),
    ).toThrow()
  })

  it('decision + intent 是原子幂等根，unknown ack 不会变成 acked', () => {
    const result = journal.recordDecisionAndIntent(
      decision({ executed: false }),
      {
        intentId: 'atomic-i',
        clientOrderId: 'atomic-c',
        decisionId: 'd1',
        venue: 'htx',
        symbol: 'BTC/USDT',
        state: 'created',
        type: 'market',
        side: 'buy',
        qty: 1,
        notionalUsd: 100,
        reduceOnly: false,
        createdAt: NOW,
      },
    )
    expect(result).toEqual({ decisionInserted: true, intentInserted: true })
    const ack = journal.applyOrderAck(
      { intentId: 'atomic-i', clientOrderId: 'atomic-c', state: 'unknown', exchangeOrderId: 'ex-1', ts: NOW },
      NOW,
    )
    expect(ack.unknown).toBe(true)
    expect(journal.inFlightIntents()[0]?.state).toBe('unknown')
  })

  it('filled ack 缺少真实成交量或均价时保留 unknown，不用请求值伪造成交', () => {
    journal.recordDecisionAndIntent(
      decision({ executed: false }),
      {
        intentId: 'missing-fill-i', clientOrderId: 'missing-fill-c', decisionId: 'd1',
        venue: 'paper', symbol: 'BTC/USDT', state: 'created', type: 'market', side: 'buy',
        qty: 2, notionalUsd: 200, reduceOnly: false, createdAt: NOW,
      },
    )
    const result = journal.applyOrderAck({
      intentId: 'missing-fill-i', clientOrderId: 'missing-fill-c', exchangeOrderId: 'missing-fill-ex',
      state: 'filled', avgPrice: 100, ts: NOW,
    }, NOW)
    expect(result).toMatchObject({ state: 'unknown', filled: false, unknown: true })
    expect(journal.fillIds()).toEqual([])
    expect(journal.inFlightIntents()[0]?.state).toBe('unknown')

    journal.recordDecision(decision({ decisionId: 'missing-average', executed: false }))
    journal.recordIntent({
      intentId: 'missing-average-i', clientOrderId: 'missing-average-c', decisionId: 'missing-average',
      venue: 'paper', symbol: 'BTC/USDT', state: 'created', type: 'market', side: 'buy',
      qty: 1, notionalUsd: 100, reduceOnly: false, createdAt: NOW,
    })
    expect(journal.applyOrderAck({
      intentId: 'missing-average-i', clientOrderId: 'missing-average-c', exchangeOrderId: 'missing-average-ex',
      state: 'filled', filledQty: 1, ts: NOW,
    }, NOW)).toMatchObject({ state: 'unknown', filled: false, unknown: true })
    expect(journal.fillIds()).toEqual([])
  })

  it('累积保存部分成交量，终态撤单只结算一次实际部分成交', () => {
    journal.recordDecisionAndIntent(
      decision({ executed: false }),
      {
        intentId: 'partial-i', clientOrderId: 'partial-c', decisionId: 'd1',
        venue: 'paper', symbol: 'BTC/USDT', state: 'created', type: 'market', side: 'buy',
        qty: 2, notionalUsd: 200, reduceOnly: false, createdAt: NOW,
      },
    )
    const partial = journal.applyOrderAck({
      intentId: 'partial-i', clientOrderId: 'partial-c', exchangeOrderId: 'partial-ex',
      state: 'acked', filledQty: 0.5, avgPrice: 99, ts: NOW,
    }, NOW)
    expect(partial).toMatchObject({ state: 'acked', filled: false, unknown: false })
    expect(db.prepare('SELECT filled_qty, avg_price FROM orders WHERE order_id = ?').get('partial-ex')).toMatchObject({
      filled_qty: 0.5,
      avg_price: 99,
    })
    expect(db.prepare('SELECT executed, reflection_due_at FROM decisions WHERE decision_id = ?').get('d1'))
      .toMatchObject({ executed: 1, reflection_due_at: null })
    expect(journal.fillIds()).toEqual([])
    expect(journal.pendingSettlements(NOW + 24 * 3_600_000, 10)).toEqual([])

    const canceled = journal.applyOrderAck({
      intentId: 'partial-i', clientOrderId: 'partial-c', exchangeOrderId: 'partial-ex',
      state: 'canceled', filledQty: 0.75, avgPrice: 100, ts: NOW + 1,
    }, NOW + 1)
    expect(canceled).toMatchObject({ state: 'canceled', filled: true, unknown: false })
    expect(journal.fillsForDecision('d1')).toMatchObject([{ qty: 0.75, price: 100 }])
    expect(db.prepare('SELECT reflection_due_at FROM decisions WHERE decision_id = ?').get('d1'))
      .toMatchObject({ reflection_due_at: NOW + 1 + 4 * 3_600_000 })
    expect(journal.pollableIntents()).toMatchObject([{ clientOrderId: 'partial-c', state: 'canceled', feePending: true }])

    journal.applyOrderAck({
      intentId: 'partial-i', clientOrderId: 'partial-c', exchangeOrderId: 'partial-ex',
      state: 'canceled', filledQty: 0.75, avgPrice: 100, fee: 0.03, ts: NOW + 2,
    }, NOW + 2)
    expect(journal.fillIds()).toEqual(['fill:partial-ex:terminal'])
    expect(journal.fillsForDecision('d1')).toMatchObject([{ fee: 0.03 }])
    expect(journal.pollableIntents()).toEqual([])
  })
})
