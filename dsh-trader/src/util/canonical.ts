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

/**
 * 交易所可接受的 **数字** clientOrderId（plan §4.2 幂等键）。
 *
 * ★ 实测（HTX）：ccxt 用 `safeIntegerN` 解析 `clientOrderId`，即交易所只认**数字** id；
 * 我们原来的 `co:plan:cond:barTs` 会被**静默丢弃**（订单能成，但交易所侧没有这个 client id）——
 * 于是"按 clientOrderId 查询/恢复/对账"全部失效，交易所侧幂等也没了。
 *
 * 因此本地与交易所共用同一个**确定性数字 id**：同一语义种子永远得到同一个 15 位数字串。
 * 为什么是 **15 位**：ccxt 用 `safeIntegerN` 解析 clientOrderId（即先转成 JS Number），
 * 超过 2^53 的 18 位数字会**丢精度**，交易所存下来的 id 与我们算的对不上 —— 实测查询全部落空。
 * 同时首位固定为 1–9，避免前导零被 `Number()` 吃掉后变成另一个 id。
 */
export function numericClientOrderId(seed: string): string {
  const value = 100_000_000_000_000n + (BigInt(`0x${sha256Hex(seed).slice(0, 16)}`) % 900_000_000_000_000n)
  return value.toString()
}
