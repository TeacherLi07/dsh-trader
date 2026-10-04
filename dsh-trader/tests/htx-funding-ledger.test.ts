import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { HtxFundingLedger, type FundingLedgerScope } from '../src/exec/htx-funding-ledger.js'

const scope: FundingLedgerScope = { accountId: 'htx-fixture-account', contractCode: 'FIL-USDT', marginMode: 'cross', quoteCurrency: 'USDT' }
const clock = new ReplayClock(10_000)
const bill = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: '31', currency: 'USDT',
  contract_code: 'FIL-USDT', margin_mode: 'cross', created_time: '5000', amount: '-0.0000123', ...extra })
const envelope = (data: unknown[]) => ({ code: 200, message: 'Success', data, ts: clock.now() })

describe('HTX V5 funding ledger', () => {
  it('uses exclusive older ID pages, preserves signed cashflow and avoids the invalid zero anchor', async () => {
    const ids = ['9007199254740999', '9007199254740998', '9007199254740997']
    const requests: Readonly<Record<string, string | number>>[] = []
    const pages = [[bill(ids[0]!), bill(ids[1]!, { type: '30', amount: '0.00001' })], [bill(ids[2]!)], []]
    const read = new HtxFundingLedger(async params => { requests.push(params); return envelope(pages.shift()!) }, clock, scope, 3, 2)
    const result = await read.read(4000, 6000)
    expect(result.payments).toHaveLength(3)
    expect(result.payments.map(p => p.id)).toEqual(ids)
    expect(result.payments.map(p => p.cashFlowQuote)).toEqual([-0.0000123, 0.00001, -0.0000123])
    expect(result).toMatchObject({ pages: 3, paginationExhausted: true, from: 4000, until: 6000 })
    expect(requests).toHaveLength(3)
    expect(requests[0]).toEqual({ contract_code: 'FIL-USDT', margin_mode: 'cross', type: '30,31',
      start_time: '4000', end_time: '5999', limit: 2, direct: 'prev' })
    expect(requests[1]?.['from']).toBe(ids[1])
    expect(result.responseHashes).toHaveLength(3)
    expect(result.evidenceHash).toMatch(/^sha256:/)
    expect('amountQuote' in result).toBe(false)
  })

  it('does not treat a short nonterminal page as complete', async () => {
    const pages = [[bill('100')], [bill('99')], []]
    let calls = 0
    const result = await new HtxFundingLedger(async () => { calls++; return envelope(pages.shift()!) }, clock, scope, 3, 100).read(4000, 6000)
    expect(result.payments).toHaveLength(2)
    expect(calls).toBe(3)
    expect(result.pages).toBe(3)
  })

  it('reports an empty received page without claiming known zero funding cost', async () => {
    const result = await new HtxFundingLedger(async () => envelope([]), clock, scope).read(4000, 6000)
    expect(result.pages).toBe(1)
    expect(result.paginationExhausted).toBe(true)
    expect(result.payments).toEqual([])
    expect(result.responseHashes).toHaveLength(1)
    expect('amountQuote' in result).toBe(false)
    expect('costKnown' in result).toBe(false)
  })

  it.each([
    { code: 401, message: 'Incorrect IP address', data: [] },
    { code: 200, message: 'Success' },
    { code: 200, data: null },
    { code: 200, data: {} },
  ])('rejects unsuccessful or missing data envelopes %j', async raw => {
    await expect(new HtxFundingLedger(async () => raw, clock, scope).read(4000, 6000)).rejects.toThrow('响应')
  })

  it.each([
    { id: '0' }, { id: 100 }, { id: 'not-an-id' }, { type: '7' },
    { currency: 'BTC' }, { contract_code: 'BTC-USDT' }, { margin_mode: 'isolated' },
    { created_time: '3999' }, { created_time: '6000' }, { created_time: 5000 },
    { created_time: '5000.5' }, { amount: 'NaN' }, { amount: '' }, { amount: null },
    { amount: '0.1' }, { type: '30', amount: '-0.1' },
  ])('rejects malformed or mis-scoped payment %j', async change => {
    await expect(new HtxFundingLedger(async () => envelope([bill('100', change)]), clock, scope).read(4000, 6000)).rejects.toThrow()
  })

  it.each([
    { rows: [bill('100'), bill('100')] },
    { rows: [bill('100'), bill('101')] },
  ])('rejects repeated or forward IDs within a page', async ({ rows }) => {
    await expect(new HtxFundingLedger(async () => envelope(rows), clock, scope).read(4000, 6000)).rejects.toThrow('推进')
  })

  it('refuses truncation and an inclusive/repeating cursor from the next page', async () => {
    const full = [bill('100'), bill('99')]
    await expect(new HtxFundingLedger(async () => envelope(full), clock, scope, 1, 2).read(4000, 6000)).rejects.toThrow('分页上限')
    let n = 0
    const reader = new HtxFundingLedger(async () => envelope(n++ === 0 ? full : [bill('99')]), clock, scope, 2, 2)
    await expect(reader.read(4000, 6000)).rejects.toThrow('推进')
    await expect(new HtxFundingLedger(async () => envelope([bill('100'), bill('99')]), clock, scope, 1, 1).read(4000, 6000)).rejects.toThrow('页上限')
  })

  it('never queries a future, zero-length or invalid interval', async () => {
    let calls = 0
    const reader = new HtxFundingLedger(async () => { calls++; return envelope([]) }, clock, scope)
    const ranges = [[4000, 10001], [4000, 4000], [-1, 6000], [4000.5, 6000]]
    expect(ranges.length).toBeGreaterThan(0)
    for (const [from, until] of ranges) await expect(reader.read(from!, until!)).rejects.toThrow('区间')
    expect(calls).toBe(0)
  })

  it('keeps the scope fixed during asynchronous pagination', async () => {
    const mutable = { ...scope }
    const reader = new HtxFundingLedger(async params => { mutable.contractCode = 'BTC-USDT'; expect(params['contract_code']).toBe('FIL-USDT'); return envelope([]) }, clock, mutable)
    const result = await reader.read(4000, 6000)
    expect(result.scope.contractCode).toBe('FIL-USDT')
    expect(Object.isFrozen(result.scope)).toBe(true)
  })

  it('rejects invalid account or unsupported currency/configuration before I/O', () => {
    expect(() => new HtxFundingLedger(async () => envelope([]), clock, { ...scope, accountId: '' })).toThrow()
    expect(() => new HtxFundingLedger(async () => envelope([]), clock, { ...scope, quoteCurrency: 'BTC' })).toThrow()
    expect(() => new HtxFundingLedger(async () => envelope([]), clock, scope, 0)).toThrow()
    expect(() => new HtxFundingLedger(async () => envelope([]), clock, scope, 100, 101)).toThrow()
  })
})
