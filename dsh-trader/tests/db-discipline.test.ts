import Database from 'better-sqlite3'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Statements } from '../src/db/statements.js'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/**
 * `db.prepare()` 每次调用都会在 Database 上留下一个 Statement，
 * 实测 5 万次调用泄漏 ~139MB（缓存后 0.3MB）。因此热路径里**只允许**经 `Statements` 取语句。
 */
const GUARDED_DIRS = ['market', 'trigger', 'exec', 'plan', 'predictions'].map((name) =>
  join(SRC, name),
)

function collect(target: string): string[] {
  if (statSync(target).isFile()) return [target]
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? collect(join(target, entry.name)) : [join(target, entry.name)],
  )
}

describe('database discipline', () => {
  it('never calls prepare() directly in the hot paths', () => {
    const offenders = GUARDED_DIRS.flatMap(collect)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /\.prepare\(/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1))

    expect(offenders).toEqual([])
  })

  it('Statements returns one cached statement per distinct SQL text', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE t(x INTEGER)')
    const statements = new Statements(db)

    const first = statements.get('INSERT INTO t(x) VALUES (?)')
    const second = statements.get('INSERT INTO t(x) VALUES (?)')
    const other = statements.get('SELECT COUNT(*) AS n FROM t')

    expect(second).toBe(first)
    expect(other).not.toBe(first)
    expect(statements.size).toBe(2)

    first.run(1)
    first.run(2)
    expect((other.get() as { n: number }).n).toBe(2)
    db.close()
  })
})
