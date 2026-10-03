import { describe, expect, it } from 'vitest'
import { marketSpecification } from '../src/market/specification.js'

describe('HTX 原生合约规格', () => {
  it.each([['ADA', 10], ['BTC', 0.001], ['FIL', 0.1]] as const)('原生 %s 元数据的最小量按一张计算，不把基础币大小当成张数', (base, contractSize) => {
    const symbol = `${base}/USDT:USDT`
    const id = `${base}-USDT`
    const spec = marketSpecification(symbol, { symbol, id, swap: true, linear: true, contractSize,
      precision: { amount: 1, price: 0.0001 }, limits: { amount: { min: contractSize }, cost: {} },
      info: { contract_code: id, contract_size: contractSize, business_type: 'swap', trade_partition: 'USDT' },
    }, 4)
    expect(spec).toMatchObject({ minAmountContracts: 1, amountStepContracts: 1, minNotionalQuote: 0, minimumRule: 'htx-whole-contracts-v1' })
  })

  it('没有可核验原生身份/合约来源时不把缺失最小额伪造为零', () => {
    const spec = marketSpecification('ADA/USDT:USDT', { linear: true, swap: true, contractSize: 10,
      precision: { amount: 1, price: 0.0001 }, limits: { amount: { min: 10 } },
    }, 4)
    expect(spec.minNotionalQuote).toBeNull()
    expect(spec.minimumRule).toBeUndefined()
    expect(spec.minAmountContracts).toBe(10)
  })

  it('缺少或错配 contract id 时不能仅凭其他相似字段冒充 HTX 原生规则', () => {
    const symbol = 'ADA/USDT:USDT'
    for (const id of [undefined, 'BTC-USDT']) {
      const spec = marketSpecification(symbol, { symbol, id, linear: true, swap: true, contractSize: 10,
        precision: { amount: 1, price: 0.0001 }, limits: { amount: { min: 10 }, cost: {} },
        info: { contract_code: id, contract_size: 10, business_type: 'swap', trade_partition: 'USDT' },
      }, 4)
      expect(spec.minNotionalQuote).toBeNull()
      expect(spec.minimumRule).toBeUndefined()
    }
  })
})
