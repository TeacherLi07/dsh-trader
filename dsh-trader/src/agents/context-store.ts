/**
 * 上下文快照落库（plan §5.1 / T1.5）：`ctxHash` 可复现、`changedParts` 可审计。
 *
 * 落库的意义：决策记录里的 `context_hash` 必须指得回**当时到底注入了什么**，
 * 否则"同一 contextHash"只是一句口号，回放与事故复盘都无从对拍。
 */

import type Database from 'better-sqlite3'
import { canonicalJson } from '../util/canonical.js'
import { Statements } from '../db/statements.js'
import type { AssembledContext, ContextKind, PartHashes } from './context.js'

export interface ContextSnapshot {
  readonly ctxHash: string
  readonly createdAt: number
  readonly symbol: string | null
  readonly partHashes: Readonly<Record<string, string>>
  readonly changedParts: readonly ContextKind[]
  readonly charCounts: Readonly<Record<string, number>>
  readonly overflow: readonly ContextKind[]
}

interface SnapshotRow {
  ctx_hash: string
  created_at: number
  symbol: string | null
  part_hashes_json: string
  changed_parts_json: string
  char_counts_json: string
  overflow_json: string
}

export class ContextSnapshotStore {
  readonly #statements: Statements

  constructor(db: Database.Database) {
    this.#statements = new Statements(db)
  }

  /** 写入一次组装结果。`ctx_hash` 主键 ⇒ 同内容重复组装不产生新行。 */
  record(context: AssembledContext, meta: { readonly createdAt: number; readonly symbol?: string }): boolean {
    const result = this.#statements
      .get(
        `INSERT INTO context_snapshots
           (ctx_hash, created_at, symbol, part_hashes_json, changed_parts_json, char_counts_json, overflow_json)
         VALUES (@ctxHash, @createdAt, @symbol, @partHashesJson, @changedPartsJson, @charCountsJson, @overflowJson)
         ON CONFLICT (ctx_hash) DO NOTHING`,
      )
      .run({
        ctxHash: context.ctxHash,
        createdAt: meta.createdAt,
        symbol: meta.symbol ?? null,
        partHashesJson: canonicalJson(context.partHashes),
        changedPartsJson: canonicalJson(context.changedParts),
        charCountsJson: canonicalJson(
          Object.fromEntries(context.blocks.map((block) => [block.kind, block.chars])),
        ),
        overflowJson: canonicalJson(context.overflow),
      })
    return Number(result.changes) > 0
  }

  get(ctxHash: string): ContextSnapshot | undefined {
    const row = this.#statements
      .get('SELECT * FROM context_snapshots WHERE ctx_hash = ?')
      .get(ctxHash) as SnapshotRow | undefined
    if (row === undefined) return undefined
    return {
      ctxHash: row.ctx_hash,
      createdAt: row.created_at,
      symbol: row.symbol,
      partHashes: JSON.parse(row.part_hashes_json) as Record<string, string>,
      changedParts: JSON.parse(row.changed_parts_json) as ContextKind[],
      charCounts: JSON.parse(row.char_counts_json) as Record<string, number>,
      overflow: JSON.parse(row.overflow_json) as ContextKind[],
    }
  }

  /** 最近一次组装的各类别哈希 —— 下一次组装据此算 `changedParts`。 */
  latestPartHashes(symbol?: string): PartHashes | undefined {
    const row = (
      symbol === undefined
        ? this.#statements.get('SELECT * FROM context_snapshots ORDER BY created_at DESC, rowid DESC LIMIT 1').get()
        : this.#statements
            .get(
              'SELECT * FROM context_snapshots WHERE symbol = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
            )
            .get(symbol)
    ) as SnapshotRow | undefined
    return row === undefined ? undefined : (JSON.parse(row.part_hashes_json) as PartHashes)
  }

  count(): number {
    return (this.#statements.get('SELECT COUNT(*) AS n FROM context_snapshots').get() as { n: number }).n
  }
}
