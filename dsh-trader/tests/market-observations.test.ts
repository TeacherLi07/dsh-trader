import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { MarketObservationStore } from '../src/market/observations.js'

const EVENT = 1_700_000_000_000
const FIRST_AVAILABLE = EVENT + 1_000
const SECOND_AVAILABLE = EVENT + 2_000

let db: Database.Database
let store: MarketObservationStore

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
  store = new MarketObservationStore(db)
})

afterEach(() => db.close())

describe('MarketObservationStore', () => {
  it('PIT 查询只展示当时可取得的修订，并按唯一键幂等', () => {
    expect(store.record({
      kind: 'bar', symbol: 'BTC/USDT:USDT', timeframe: '1h', eventTime: EVENT,
      availableAt: FIRST_AVAILABLE, source: 'fixture', value: { close: 10 },
    })).toBe(true)
    expect(store.record({
      kind: 'bar', symbol: 'BTC/USDT:USDT', timeframe: '1h', eventTime: EVENT,
      availableAt: FIRST_AVAILABLE, source: 'fixture', value: { close: 10 },
    })).toBe(false)
    expect(store.record({
      kind: 'bar', symbol: 'BTC/USDT:USDT', timeframe: '1h', eventTime: EVENT,
      availableAt: SECOND_AVAILABLE, source: 'fixture', value: { close: 11 },
    })).toBe(true)

    expect(store.recent<{ close: number }>('bar', 'BTC/USDT:USDT', '1h', EVENT, 10)).toEqual([])
    const firstView = store.recent<{ close: number }>('bar', 'BTC/USDT:USDT', '1h', FIRST_AVAILABLE, 10)
    expect(firstView).toHaveLength(1)
    expect(firstView[0]).toMatchObject({ eventTime: EVENT, availableAt: FIRST_AVAILABLE, value: { close: 10 } })
    const correctedView = store.recent<{ close: number }>('bar', 'BTC/USDT:USDT', '1h', SECOND_AVAILABLE, 10)
    expect(correctedView).toHaveLength(1)
    expect(correctedView[0]).toMatchObject({ eventTime: EVENT, availableAt: SECOND_AVAILABLE, value: { close: 11 } })
  })

  it('拒绝不可能的时间顺序和空来源', () => {
    expect(() => store.record({
      kind: 'bar', symbol: 'BTC/USDT:USDT', timeframe: '1h', eventTime: EVENT,
      availableAt: EVENT - 1, source: 'fixture', value: { close: 10 },
    })).toThrow('eventTime <= availableAt')
    expect(() => store.record({
      kind: 'bar', symbol: 'BTC/USDT:USDT', timeframe: '1h', eventTime: EVENT,
      availableAt: FIRST_AVAILABLE, source: ' ', value: { close: 10 },
    })).toThrow('symbol/source 不能为空')
    expect(() => store.recent('bar', 'BTC/USDT:USDT', '1h', Number.NaN, 10)).toThrow('asOf')
  })

  it('SQLite 强制 observation 只追加', () => {
    store.record({
      kind: 'spec', symbol: 'BTC/USDT:USDT', timeframe: '', eventTime: EVENT,
      availableAt: EVENT, source: 'fixture', value: { contractSize: 1 },
    })
    expect(() => db.prepare("UPDATE market_observations SET payload_json = '{}' WHERE symbol = ?").run('BTC/USDT:USDT'))
      .toThrow('market_observations is append-only')
    expect(() => db.prepare('DELETE FROM market_observations WHERE symbol = ?').run('BTC/USDT:USDT'))
      .toThrow('market_observations is append-only')
  })
})
