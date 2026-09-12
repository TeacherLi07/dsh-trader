import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * plan.md §7：`Clock` 必须可注入，这是"回放两遍结果完全一致"的前提。
 * 因此这些层里不允许直接读墙钟；由本测试强制（T0.3 的验收项）。
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const GUARDED = [
  join(SRC, 'market'),
  join(SRC, 'trigger'),
  join(SRC, 'supervisor'),
  join(SRC, 'exec', 'gate.ts'),
]
const FORBIDDEN = /\bDate\.now\s*\(|\bnew\s+Date\s*\(/

function collect(target: string): string[] {
  if (statSync(target).isFile()) return [target]
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? collect(join(target, entry.name)) : [join(target, entry.name)],
  )
}

describe('clock discipline', () => {
  it('forbids direct wall-clock reads in the timed layers', () => {
    const offenders = GUARDED.flatMap(collect)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1))

    expect(offenders).toEqual([])
  })
})
