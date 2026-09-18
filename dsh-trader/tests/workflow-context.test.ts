import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { WorkflowContextStore } from '../src/supervisor/workflow-context.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  migrate(db)
})

afterEach(() => db.close())

describe('WorkflowContextStore', () => {
  it('persists only a hash, verifies binding, and expires with injected time', () => {
    const store = new WorkflowContextStore(db)
    const issued = store.issue({
      packId: 'pack-1',
      contextHash: 'sha256:ctx',
      resultHash: 'sha256:result',
      symbol: 'BTC/USDT:USDT',
      timeframe: '1h',
      scriptVersion: 'workflow-v1',
      promptVersion: 'v2',
      createdAt: 1_000,
      ttlMs: 100,
    })

    expect(issued.token).toMatch(/^[0-9a-f]{64}$/)
    expect(issued.record.tokenHash).not.toContain(issued.token)
    expect(db.prepare('SELECT COUNT(*) AS n FROM workflow_contexts WHERE token_hash = ?').get(issued.token)).toEqual({ n: 0 })
    expect(store.verify(issued.token, 1_050, { symbol: 'BTC/USDT:USDT', timeframe: '1h' })).toMatchObject({
      packId: 'pack-1',
      contextHash: 'sha256:ctx',
    })
    expect(store.verify(issued.token, 1_050, { contextHash: 'sha256:other' })).toBeUndefined()
    expect(store.verify(issued.token, 1_100)).toBeUndefined()
  })
})
