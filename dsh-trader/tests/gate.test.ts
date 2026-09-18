import { describe, expect, it } from 'vitest'
import { EXAMPLE_LIMITS } from '../src/config.js'
import type { AccountSnapshot, OrderRequest } from '../src/exec/broker.js'
import { validateIntent, type GatePolicy } from '../src/exec/gate.js'

const account: AccountSnapshot = {
  venue: 'paper',
  equityQuote: 10_000,
  totalExposureUsd: 0,
  openOrders: 0,
  leverage: 0,
  dailyLossUsd: 0,
  drawdownUsd: 0,
  consecutiveLosses: 0,
  spreadBps: 5,
  observedAt: 1,
}

const intent = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  intentId: 'i1',
  clientOrderId: 'c1',
  decisionId: 'd1',
  symbol: 'BTC/USDT:USDT',
  type: 'market',
  side: 'buy',
  qty: 0.01,
  notionalUsd: 150,
  ...over,
})

const policy = (over: Partial<GatePolicy> = {}): GatePolicy => ({
  mode: 'paper',
  limits: EXAMPLE_LIMITS,
  // 宏观时间窗**默认不启用**（plan §12.1 #22）：这里刻意不传 `tradingWindowOpen`。
  duplicateDecision: false,
  paperVenue: 'paper',
  ...over,
})

describe('validateIntent (hard gate)', () => {
  it('allows an in-limit paper order', () => {
    expect(validateIntent(intent(), account, policy())).toEqual({ kind: 'allow' })
  })

  it('always enforces mode consistency and idempotency', () => {
    expect(validateIntent(intent(), { ...account, venue: 'htx' }, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent(), account, policy({ duplicateDecision: true }))).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent(), { ...account, venue: 'htx' }, policy({ limits: null }))).toMatchObject({
      kind: 'deny',
    })
  })

  it('rejects non-positive qty and a notional that was not recomputed from live state', () => {
    expect(validateIntent(intent({ qty: 0 }), account, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent({ qty: Number.NaN }), account, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent({ notionalUsd: 0 }), account, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent({ notionalUsd: Number.POSITIVE_INFINITY }), account, policy())).toMatchObject({
      kind: 'deny',
    })
  })

  it('enforces every numeric limit for exposure-increasing orders', () => {
    expect(validateIntent(intent({ notionalUsd: 201 }), account, policy())).toMatchObject({ kind: 'deny' })
    expect(
      validateIntent(intent({ notionalUsd: 100 }), { ...account, totalExposureUsd: 1950 }, policy()),
    ).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent({ notionalUsd: 100 }), { ...account, equityQuote: 40 }, policy())).toMatchObject({
      kind: 'deny',
    })
    expect(validateIntent(intent(), { ...account, dailyLossUsd: 101 }, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent(), { ...account, drawdownUsd: 301 }, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent(), { ...account, consecutiveLosses: 4 }, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent(), { ...account, spreadBps: 26 }, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent(), { ...account, openOrders: 10 }, policy())).toMatchObject({ kind: 'deny' })
    expect(validateIntent(intent(), account, policy({ tradingWindowOpen: false }))).toMatchObject({ kind: 'deny' })
  })

  it('never blocks risk-reducing orders — you can always close', () => {
    const reduce = intent({ reduceOnly: true, notionalUsd: 9_999 })
    const stressed: AccountSnapshot = {
      ...account,
      venue: 'paper',
      dailyLossUsd: 9_999,
      drawdownUsd: 9_999,
      spreadBps: 999,
      openOrders: 999,
      totalExposureUsd: 99_999,
    }
    const tight = policy({
      limits: { ...EXAMPLE_LIMITS, dailyLossLimitUsd: 1, maxSpreadBps: 1 },
      tradingWindowOpen: false,
    })
    expect(validateIntent(reduce, stressed, tight)).toEqual({ kind: 'allow' })
  })

  it('keeps only the always-on checks when risk limits are explicitly waived', () => {
    const waived = policy({ limits: null })
    expect(validateIntent(intent({ notionalUsd: 10_000_000 }), account, waived)).toEqual({ kind: 'allow' })
    expect(validateIntent(intent(), account, policy({ limits: null, duplicateDecision: true }))).toMatchObject({
      kind: 'deny',
    })
  })

  it('账户快照含 NaN 时 fail-closed，而不是让比较运算静默放行', () => {
    const malformed = { ...account, totalExposureUsd: Number.NaN, dailyLossUsd: Number.NaN, spreadBps: Number.NaN }
    expect(validateIntent(intent(), malformed, policy()).kind).toBe('deny')
  })

  it('冻结标的禁止增加敞口，但平/减仓永远放行（plan §4.2/§6.3）', () => {
    const frozenSymbols = new Set(['BTC/USDT:USDT'])

    // 增加敞口 ⇒ 拒绝（旧实现把冻结算进 Set 却无人消费，冻结形同虚设）
    expect(validateIntent(intent(), account, policy({ frozenSymbols }))).toMatchObject({ kind: 'deny' })
    // 只影响被冻结的标的
    expect(validateIntent(intent({ symbol: 'ETH/USDT:USDT' }), account, policy({ frozenSymbols }))).toEqual({
      kind: 'allow',
    })
    // 能平仓永远比不能平仓安全
    expect(validateIntent(intent({ reduceOnly: true }), account, policy({ frozenSymbols }))).toEqual({ kind: 'allow' })
    // "永远生效"：用户放弃风控参数不等于放弃冻结
    expect(
      validateIntent(intent({ notionalUsd: 10_000_000 }), account, policy({ limits: null, frozenSymbols })),
    ).toMatchObject({ kind: 'deny' })
  })

  it('宏观时间窗默认不启用：不传 tradingWindowOpen ⇒ 不拦截；显式 false 才拦（plan §12.1 #22）', () => {
    // 默认（省略字段）＝ 该闸未启用，这是**刻意**的，不是漏配
    expect(validateIntent(intent(), account, policy())).toEqual({ kind: 'allow' })
    // 机制仍在，将来接上日历后可显式传 false 拦截
    expect(validateIntent(intent(), account, policy({ tradingWindowOpen: false }))).toMatchObject({ kind: 'deny' })
  })
})
