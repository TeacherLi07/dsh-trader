import { describe, expect, it } from 'vitest'
import { numericClientOrderId } from '../src/util/canonical.js'

describe('numericClientOrderId（交易所只认数字 id，实测 HTX/ccxt）', () => {
  it('确定性：同一语义种子永远得到同一个 15 位数字串（回放可复现）', () => {
    const a = numericClientOrderId('co:pc-1:c-open:BTC/USDT:1700000000000')
    const b = numericClientOrderId('co:pc-1:c-open:BTC/USDT:1700000000000')
    expect(a).toBe(b)
    expect(a).toMatch(/^\d{15}$/)
    // int64 安全：18 位十进制 < 2^63
    expect(BigInt(a) < 2n ** 63n).toBe(true)
  })

  it('不同语义种子得到不同 id（非空样本）', () => {
    const seeds = [
      'co:plan-a:c1:SYM:1',
      'co:plan-a:c1:SYM:2',
      'co:plan-a:c2:SYM:1',
      'pco:plan-a:c1:SYM:1',
      'pco:plan-b:c1:SYM:1',
    ]
    const ids = seeds.map(numericClientOrderId)
    expect(new Set(ids).size).toBe(seeds.length)
    for (const id of ids) expect(id).toMatch(/^\d{15}$/)
  })
})
