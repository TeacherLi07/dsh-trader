import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import {
  BULK_FIELDS,
  MAX_NOTICE_CHARS,
  PROTECTED_FIELDS,
  assembleContext,
  maskToolResult,
  makeNotice,
  type ContextInput,
} from '../src/agents/context.js'
import { DecisionContextStore } from '../src/agents/decision-context-store.js'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import { PROMPT_VERSION } from '../src/agents/prompts.js'

const NOW = 1_700_000_000_000

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

afterEach(() => {
  db.close()
})

function input(over: Partial<ContextInput> = {}): ContextInput {
  return {
    constitution: '纪律：不许逆势加仓。动作：open/close/reduce/hold/escalate。',
    configuration: { symbols: ['BTC/USDT'], timeframe: '1h', maxLeverage: 2, benchmark: 'BTC-INDEX' },
    state: { equityQuote: 10_000, positions: [], openOrders: 0, activePlanId: 'pc-1' },
    commitments: [{ planId: 'pc-1', when: 'close > 70000', then: 'open long' }],
    episodes: [{ decisionId: 'd1', alphaPct: 1.2 }],
    ...over,
  }
}

describe('assembleContext', () => {
  it('把 C1–C5 放进正确的 form，且 C6（原始）永不进入上下文', () => {
    const context = assembleContext(input())
    expect(context.blocks.map((block) => block.kind)).toEqual(['C1', 'C2', 'C3', 'C5'])
    expect(context.blocks.map((block) => block.form)).toEqual([
      'system',
      'instructions',
      'snapshot',
      'recall',
    ])
    // C3/C4 合并为同一条 snapshot（承诺绝不被追加式淹没）
    const snapshot = context.blocks.find((block) => block.kind === 'C3')
    expect(snapshot?.text).toContain('70000')
    expect(snapshot?.text).toContain('"merged":["C3","C4"]')
    expect(context.blocks.some((block) => block.kind === 'C6')).toBe(false)
  })

  it('组装可复现：同一入参得到同一 ctxHash', () => {
    const a = assembleContext(input())
    const b = assembleContext(input())
    expect(a.ctxHash).toBe(b.ctxHash)
    expect(a.ctxHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    // 对象键序不影响结果（canonical JSON）
    const reordered = assembleContext(
      input({ configuration: { benchmark: 'BTC-INDEX', maxLeverage: 2, timeframe: '1h', symbols: ['BTC/USDT'] } }),
    )
    expect(reordered.ctxHash).toBe(a.ctxHash)
  })

  it('提示词版本进入 C1 与总哈希，版本变化会标记 C1', () => {
    const first = assembleContext(input({ promptVersion: 'v1' }))
    const same = assembleContext(input({ promptVersion: 'v1' }))
    const changed = assembleContext(input({ promptVersion: 'v2' }), first.partHashes)

    expect(first.ctxHash).toBe(same.ctxHash)
    expect(changed.ctxHash).not.toBe(first.ctxHash)
    expect(changed.partHashes.C1).not.toBe(first.partHashes.C1)
    expect(changed.changedParts).toContain('C1')
    expect(changed.blocks.find((block) => block.kind === 'C1')?.text).toContain('v2')
  })

  it('changedParts 精确指出变化的类别', () => {
    const first = assembleContext(input())
    expect(first.changedParts).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'])

    const same = assembleContext(input(), first.partHashes)
    expect(same.changedParts).toEqual([])

    const moved = assembleContext(
      input({ state: { equityQuote: 9_000, positions: [], openOrders: 1, activePlanId: 'pc-1' } }),
      first.partHashes,
    )
    expect(moved.changedParts).toEqual(['C3'])
    expect(moved.ctxHash).not.toBe(first.ctxHash)

    const newCommitment = assembleContext(
      input({ commitments: [{ planId: 'pc-2', when: 'close < 60000', then: 'open short' }] }),
      first.partHashes,
    )
    expect(newCommitment.changedParts).toEqual(['C4'])
  })

  it('C1/C2/C4 超预算时报告 overflow，绝不静默截断', () => {
    const context = assembleContext(input({ constitution: 'x'.repeat(9_000) }), undefined)
    expect(context.overflow).toContain('C1')
    const c1 = context.blocks.find((block) => block.kind === 'C1')
    expect(c1?.compressible).toBe(false)
    // C1 现在是带版本的 canonical 对象；关键是宪法正文仍然**没有被截断**
    const parsed = JSON.parse(c1?.text ?? '{}') as { constitution?: string; version?: string }
    expect(parsed.version).toBe(PROMPT_VERSION)
    expect(parsed.constitution?.startsWith('x'.repeat(9_000))).toBe(true)
  })

  it('只有 C5 可压缩：摘要后仍保留精确数值与重取指路', () => {
    const episodes = Array.from({ length: 200 }, (_, index) => ({ decisionId: `d${index}`, alphaPct: index / 100 }))
    const context = assembleContext(input({ episodes }))
    const c5 = context.blocks.find((block) => block.kind === 'C5')
    expect(c5?.summarized).toBe(true)
    expect(c5?.text).toContain('"summarized":true')
    expect(c5?.text).toContain('trade_recall')
    expect(JSON.parse(c5?.text ?? '{}')).toMatchObject({ omitted: expect.any(Number) })
    // 数值精度未被四舍五入
    const parsed = JSON.parse(c5?.text ?? '{}') as { episodes: { decisionId: string; alphaPct: number }[] }
    expect(parsed.episodes[0]).toEqual({ decisionId: 'd0', alphaPct: 0 })
  })
})

describe('makeNotice', () => {
  it('summary 硬上限 120 字符并标记截断', () => {
    const short = makeNotice('  BTC\n 触发  when=close>70000  ')
    expect(short.summary).toBe('BTC 触发 when=close>70000')
    expect(short.truncated).toBe(false)

    const long = makeNotice('y'.repeat(400), { when: 'close>70000' })
    expect(long.summary.length).toBeLessThanOrEqual(MAX_NOTICE_CHARS)
    expect(long.truncated).toBe(true)
    expect(long.refetch).toEqual({ when: 'close>70000' })
  })
})

describe('maskToolResult', () => {
  const candles = Array.from({ length: 200 }, (_, index) => ({ openTime: index, close: 100 + index }))

  it('批量字段换成带指路的占位符，其余字段逐字保留', () => {
    const result = {
      symbol: 'BTC/USDT',
      timeframe: '15m',
      decisionId: 'd1',
      clientOrderId: 'co-1',
      candles,
    }
    const masked = maskToolResult(result, {
      tool: 'trade_market',
      args: { symbol: 'BTC/USDT', timeframe: '15m' },
    })
    expect(masked.masked).toBe(true)
    expect(masked.omitted).toEqual({ candles: 200 })
    expect(masked.payload.candles).toBeUndefined()
    expect(masked.payload.symbol).toBe('BTC/USDT')
    expect(masked.payload.decisionId).toBe('d1')
    expect(masked.payload.candles__masked).toEqual({
      omitted: 200,
      refetch: { tool: 'trade_market', args: { symbol: 'BTC/USDT', timeframe: '15m' }, field: 'candles' },
    })
  })

  it('未超预算时不遮蔽', () => {
    const masked = maskToolResult({ candles: candles.slice(0, 3), decisionId: 'd1' }, { tool: 'trade_market' })
    expect(masked.masked).toBe(false)
    expect(masked.payload.candles).toHaveLength(3)
  })

  it('keep>0 时保留尾部若干元素（最近的数据比最旧的更有用）', () => {
    const masked = maskToolResult({ candles }, { tool: 'trade_market', keep: 5 })
    expect(masked.payload.candles).toHaveLength(5)
    expect(masked.payload.candles__masked).toMatchObject({ omitted: 195 })
  })

  it('关键字段（id/数量/价位）一个都不能在遮蔽中丢失', () => {
    // orders/positions 不在 BULK_FIELDS 里：未成交订单与未平仓头寸绝不可遮蔽
    const orders = [{ orderId: 'ex-1', qty: 0.5, price: 70_000, stopPrice: 69_000 }]
    const masked = maskToolResult(
      { orders, positions: [{ qty: 1, price: 60_000 }], candles },
      { tool: 'trade_order_status' },
    )
    // candles 被遮蔽，但订单与持仓原样保留
    expect(masked.masked).toBe(true)
    expect(masked.omitted).toEqual({ candles: 200 })
    const text = JSON.stringify(masked.payload)
    expect(text).toContain('ex-1')
    expect(text).toContain('70000')
    expect(text).toContain('69000')
    expect(text).toContain('60000')
    expect(text).toContain('0.5')
  })

  it('保护字段绝不与批量字段重叠（静态不变量）', () => {
    const overlap = PROTECTED_FIELDS.filter((field) => (BULK_FIELDS as readonly string[]).includes(field))
    expect(overlap).toEqual([])
  })

  it('信封逐字保留：遮蔽前后非批量字段深度相等', () => {
    const result = {
      decisionId: 'd1',
      clientOrderId: 'co-1',
      equityQuote: 10_000,
      limit: { maxNotionalUsd: 2_000, used: 500 },
      candles,
    }
    const masked = maskToolResult(result, { tool: 'trade_market' })
    const { candles: _dropped, ...envelopeBefore } = result
    const { candles__masked: _pointer, ...envelopeAfter } = masked.payload
    expect(envelopeAfter).toEqual(envelopeBefore)
  })

  it('批量字段**内部**的逐笔价格不属于"绝不可丢"清单（会被连同载荷一起遮蔽）', () => {
    const trades = Array.from({ length: 500 }, (_, index) => ({ ts: index, price: 70_000 + index, qty: 0.01 }))
    const masked = maskToolResult({ symbol: 'BTC/USDT', trades }, { tool: 'trade_market' })
    expect(masked.masked).toBe(true)
    // 逐笔被换成指针
    expect(JSON.stringify(masked.payload)).not.toContain('70001')
    // 但信封里的标的还在
    expect(masked.payload.symbol).toBe('BTC/USDT')
  })

  it('超预算才遮蔽：低于预算的返回体保持原样', () => {
    const small = maskToolResult(
      { candles: candles.slice(0, 3), decisionId: 'd1' },
      { tool: 'trade_market' },
    )
    expect(small.masked).toBe(false)
    expect(small.payload.candles).toHaveLength(3)
  })

  it('遮蔽是覆盖而非追加：批量字段名固定，不会无限膨胀', () => {
    const many = Array.from({ length: 300 }, (_, index) => ({ a: index, padding: 'xxxxxxxxxxxxxxxx' }))
    for (const field of BULK_FIELDS) {
      const masked = maskToolResult({ [field]: many }, { tool: 'trade_market' })
      expect(masked.masked).toBe(true)
      expect(masked.payload[field]).toBeUndefined()
      expect(masked.payload[`${field}__masked`]).toBeDefined()
    }
  })

  it('规则可配：budgetChars 收紧后小返回体也会被遮蔽', () => {
    const masked = maskToolResult({ candles: candles.slice(0, 3) }, { tool: 'trade_market', budgetChars: 50 })
    expect(masked.masked).toBe(true)
    expect(masked.omitted).toEqual({ candles: 3 })
  })
})

function decisionContext() {
  const value = {
    symbol: 'BTC/USDT:USDT',
    primaryTimeframe: '1h' as const,
    asOf: NOW,
    sections: {
      mandate: { asOf: NOW, source: 'test.config', missing: [], value: { riskPct: 0.002 } },
      market: { asOf: NOW, source: 'test.market', missing: [], value: { close: 70_000 } },
      derivatives: { asOf: NOW, source: 'test.derivatives', missing: ['oi.changePct'], value: { funding: 0.001 } },
      benchmark: { asOf: NOW, source: 'test.benchmark', missing: [], value: { symbol: 'BTC/USDT:USDT' } },
      portfolio: { asOf: NOW, source: 'test.portfolio', missing: [], value: { equityQuote: 10_000, positions: [] } },
      activePlan: { asOf: NOW, source: 'test.plan', missing: [], value: { planId: 'plan-1', contentHash: 'sha256:plan' } },
      history: { asOf: NOW, source: 'test.history', missing: [], value: { decisions: [] } },
      lessons: { asOf: NOW, source: 'test.lessons', missing: [], value: [{ lessonId: 'lesson-1', text: 'x' }] },
      predictions: { asOf: null, source: 'predictions.disabled', missing: ['predictions.disabled'], value: null },
    },
  }
  return freezeDecisionContext(value)
}

describe('DecisionContextStore', () => {
  it('保存完整 canonical context，重复 hash 幂等且可重算', () => {
    const store = new DecisionContextStore(db)
    const first = decisionContext()
    expect(store.record(first, { createdAt: NOW }).inserted).toBe(true)
    expect(store.record(first, { createdAt: NOW }).inserted).toBe(false)
    expect(store.count()).toBe(1)

    const loaded = store.getByHash(first.contextHash)
    expect(loaded?.context).toEqual(first)
    expect(loaded?.canonicalJson).toContain(first.contextHash)
    expect(store.latest(first.symbol)?.contextId).toBe(first.contextId)
  })

  it('拒绝篡改分区 hash，并允许显式不可变 contentRef', () => {
    const first = decisionContext()
    expect(() => freezeDecisionContext({
      ...first,
      sections: { ...first.sections, market: { ...first.sections.market, hash: 'sha256:forged' } },
    })).toThrow(/hash 与分区内容不一致/)

    const store = new DecisionContextStore(db)
    const pointer = freezeDecisionContext({
      ...first,
      asOf: NOW + 1,
      sections: {
        ...first.sections,
        market: {
          asOf: NOW + 1,
          source: first.sections.market.source,
          missing: first.sections.market.missing,
          value: first.sections.market.value,
        },
      },
    })
    const saved = store.record(pointer, { contentRef: 's3://immutable/context-1', createdAt: NOW + 1 })
    expect(saved.record.canonicalJson).toBeNull()
    expect(saved.record.contentRef).toBe('s3://immutable/context-1')
    expect(saved.record.context).toBeNull()
  })
})
