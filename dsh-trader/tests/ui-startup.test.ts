import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ReplayClock } from '../src/clock.js'
import { migrate } from '../src/db/schema.js'
import { DecisionJournal } from '../src/exec/journal.js'
import { StartupTracker } from '../src/exec/startup.js'
import { readStartupState } from '../src/ui/startup.js'

const NOW = 1_700_000_000_000

function finishStartup(tracker: StartupTracker): void {
  tracker.start('database')
  tracker.succeed('database')
  tracker.start('exchange')
  tracker.succeed('exchange')
  tracker.start('recovery')
  tracker.succeed('recovery')
  tracker.start('reconcile')
  tracker.succeed('reconcile')
  tracker.start('ready')
  tracker.succeed('ready')
}

describe('Trade Console startup projection', () => {
  it('persists the current run, preserves failed history, and counts non-empty restart windows', () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    const journal = new DecisionJournal(db)
    try {
      const failed = new StartupTracker(journal, clock)
      failed.start('database')
      clock.advanceTo(NOW + 100)
      failed.fail('database', 'database unavailable')

      clock.advanceTo(NOW + 10_000)
      const ready = new StartupTracker(journal, clock)
      finishStartup(ready)

      const projection = readStartupState(db, NOW + 10_000)
      expect(projection).not.toBeNull()
      if (projection === null) return
      expect(projection.phase).toBe('ready')
      expect(projection.currentStep).toBeNull()
      expect(projection.uptimeMs).toBe(0)
      expect(projection.restartCount1h).toBeGreaterThan(0)
      expect(projection.restartCount24h).toBeGreaterThan(0)
      expect(projection.restartCount1h).toBe(2)
      expect(projection.restartCount24h).toBe(2)
      expect(projection.lastFailure).toBe('database unavailable')
      expect(projection.steps.every((step) => step.status === 'succeeded')).toBe(true)
      const database = projection.steps.find((step) => step.id === 'database')
      expect(database?.startedAt).toBe(NOW + 10_000)
      expect(database?.finishedAt).toBe(NOW + 10_000)
    } finally {
      db.close()
    }
  })

  it('does not announce ready while the latest run is still rebuilding', () => {
    const db = new Database(':memory:')
    migrate(db)
    const clock = new ReplayClock(NOW)
    const journal = new DecisionJournal(db)
    try {
      const tracker = new StartupTracker(journal, clock)
      tracker.start('database')
      const projection = readStartupState(db, NOW)
      expect(projection).not.toBeNull()
      if (projection === null) return
      expect(projection.phase).toBe('rebuilding')
      expect(projection.currentStep).toBe('database')
      expect(projection.steps.find((step) => step.id === 'database')).toMatchObject({ status: 'running' })
    } finally {
      db.close()
    }
  })
})
