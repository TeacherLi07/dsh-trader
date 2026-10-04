import Database from 'better-sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { migrate } from '../src/db/schema.js'
import { freezeDecisionContext } from '../src/agents/decision-context.js'
import { DecisionContextStore } from '../src/agents/decision-context-store.js'
import { DecisionRunStore } from '../src/agents/decision-run-store.js'

it('真实恢复入口在开始模型流程前拒绝不匹配的旧 prompt，原证据不变且不需要凭据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-replay-version-')), source = join(dir, 'source'), output = join(dir, 'output')
  mkdirSync(source, { mode: 0o700 })
  const path = join(source, 'paper.sqlite'), db = new Database(path)
  try {
    migrate(db)
    const section = { asOf: 1000, source: 'fixture', missing: [], value: null }
    const ctx = freezeDecisionContext({ symbol: 'ADA/USDT:USDT', primaryTimeframe: '1h', asOf: 1000, sections: {
      mandate: { ...section, value: { mode: 'paper' } }, market: { ...section, value: { close: 100 } },
      derivatives: section, benchmark: section, portfolio: section, activePlan: section,
      history: section, lessons: section, predictions: section,
    } })
    new DecisionContextStore(db).record(ctx)
    const runs = new DecisionRunStore(db)
    runs.start({ runId: 'saved-old-version', contextId: ctx.contextId, contextHash: ctx.contextHash,
      symbol: ctx.symbol, primaryTimeframe: '1h', triggerSource: 'W1:old-event', modelVersion: 'fixture',
      promptVersion: 'old-incompatible-prompt', createdAt: 1000 })
    runs.update('saved-old-version', { status: 'review', final: { reason: 'OUTCOME_UNKNOWN' }, finishedAt: 1001 }, 1001)
    db.close()
    writeFileSync(join(source, 'policy.json'), JSON.stringify({ strategy: 'critique' }))
    const hash = () => createHash('sha256').update(readFileSync(path)).digest('hex'), before = hash()
    const result = spawnSync(process.execPath, ['scripts/terminal-run-replay-check.mjs', source, output],
      { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH } })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('use a source-frozen checkout matching the saved prompt/schema')
    expect(result.stderr).not.toContain('terminal replay invoked provider')
    expect(hash()).toBe(before)
  } finally { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }) }
})
