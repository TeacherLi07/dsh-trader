/**
 * 确定性序列化与指纹 —— 审计基础（plan §5.1：`ctxHash` / `data_fingerprint` 必须可复现）。
 *
 * 键排序 + 固定数字格式：同一份内容永远得到同一个字符串，因此哈希可比较、可落库、可回放。
 */

import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** `sha256:<hex>` 形式的指纹（与计划卡的 `contentHash` 同构）。 */
export function fingerprint(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}
