import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { recallLessons } from '../src/memory/recall.js'

const NOW = 1_700_000_000_000
const DAY = 24 * 3_600_000

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

let seq = 0

function lesson(over: {
  readonly symbol: string
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly regimeBucket?: string
  readonly text?: string
}): string {
  seq += 1
  const decisionId = `d${seq}`
  journal.recordDecision({
    decisionId,
    symbol: over.symbol,
    decidedAt: over.createdAt,
    contextHash: `ctx:${decisionId}`,
    action: 'open',
    executed: true,
  })
  journal.recordLesson({
    lessonId: `l${seq}`,
    decisionId,
    text: over.text ?? `lesson ${seq}`,
    evidenceRefs: [`decision:${decisionId}`],
    createdAt: over.createdAt,
    ...(over.regimeBucket === undefined ? {} : { regimeBucket: over.regimeBucket }),
    ...(over.expiresAt === null ? {} : { expiresAt: over.expiresAt }),
  })
  return decisionId
}

describe('recallLessons', () => {
  it('剔除过期教训并计数 —— TTL 不是只写不读的装饰', () => {
    lesson({ symbol: 'BTC/USDT', createdAt: NOW - 2 * DAY, expiresAt: NOW - DAY, text: '过期教训' })
    lesson({ symbol: 'BTC/USDT', createdAt: NOW - DAY, expiresAt: NOW + DAY, text: '仍然有效' })

    const result = recallLessons(journal, { now: NOW })
    expect(result.expired).toBe(1)
    expect(result.lessons.map((item) => item.text)).toEqual(['仍然有效'])
  })

  it('解释后的证据指针随教训一起返回（可推翻）', () => {
    lesson({ symbol: 'BTC/USDT', createdAt: NOW, expiresAt: NOW + DAY })
    const [first] = recallLessons(journal, { now: NOW }).lessons
    expect(first?.evidenceRefs).toHaveLength(1)
    expect(first?.evidenceRefs[0]).toMatch(/^decision:d\d+$/)
  })

  it('无 expires_at 的旧教训不因缺 TTL 而被丢弃', () => {
    lesson({ symbol: 'BTC/USDT', createdAt: NOW - 10 * DAY, expiresAt: null })
    const result = recallLessons(journal, { now: NOW })
    expect(result.expired).toBe(0)
    expect(result.lessons).toHaveLength(1)
  })

  it('按标的过滤', () => {
    lesson({ symbol: 'BTC/USDT', createdAt: NOW, expiresAt: NOW + DAY, text: 'btc' })
    lesson({ symbol: 'ETH/USDT', createdAt: NOW, expiresAt: NOW + DAY, text: 'eth' })
    const result = recallLessons(journal, { now: NOW, symbol: 'ETH/USDT' })
    expect(result.lessons.map((item) => item.text)).toEqual(['eth'])
  })

  it('同 regime 桶优先，其内按新鲜度降序', () => {
    lesson({ symbol: 'BTC/USDT', createdAt: NOW - 1000, expiresAt: NOW + DAY, regimeBucket: 'range', text: 'old-range' })
    lesson({ symbol: 'BTC/USDT', createdAt: NOW, expiresAt: NOW + DAY, regimeBucket: 'trend', text: 'new-trend' })
    lesson({ symbol: 'BTC/USDT', createdAt: NOW - 500, expiresAt: NOW + DAY, regimeBucket: 'range', text: 'new-range' })

    const result = recallLessons(journal, { now: NOW, regimeBucket: 'range' })
    expect(result.lessons.map((item) => item.text)).toEqual(['new-range', 'old-range', 'new-trend'])
    expect(result.lessons[0]?.regimeMatch).toBe(true)
  })

  it('遵守 limit', () => {
    for (let i = 0; i < 8; i += 1) {
      lesson({ symbol: 'BTC/USDT', createdAt: NOW + i, expiresAt: NOW + DAY })
    }
    expect(recallLessons(journal, { now: NOW, limit: 3 }).lessons).toHaveLength(3)
  })
})
