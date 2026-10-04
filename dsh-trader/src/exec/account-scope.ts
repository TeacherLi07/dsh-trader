/**
 * 执行账户身份与账单范围。
 *
 * UID 只用于内存中的身份比对；数据库仅保存完整 scope 的 SHA-256 指纹，避免把
 * 账号标识或 API 凭据写进订单审计。paper scope 的随机 namespace 由数据库首次绑定，
 * 重启沿用已有 hash，初始资金和代码版本变化都不会把旧成交重新归属。
 */

import { randomUUID } from 'node:crypto'
import { fingerprint, sha256Hex } from '../util/canonical.js'

export const HTX_LIVE_SCOPE_FIELDS = Object.freeze({
  venue: 'htx',
  accountType: 'swap',
  assetMode: 'multi_asset',
  marginMode: 'cross',
  quoteCurrency: 'USDT',
} as const)

export interface HtxLiveAccountScope {
  readonly mode: 'live'
  readonly venue: 'htx'
  readonly accountType: 'swap'
  readonly assetMode: 'multi_asset'
  readonly marginMode: 'cross'
  readonly quoteCurrency: 'USDT'
  /** 供账单适配器关联账户使用；值是 UID 的域分离 SHA-256，不是 UID 原文。 */
  readonly accountIdHash: string
  readonly accountScopeHash: string
}

export interface PaperAccountScope {
  readonly mode: 'paper'
  readonly venue: 'paper'
  readonly accountType: 'paper'
  readonly assetMode: 'paper'
  readonly marginMode: 'paper'
  readonly quoteCurrency: 'USDT'
  readonly accountIdHash: string
  readonly accountScopeHash: string
}

export type ExecutionAccountScope = HtxLiveAccountScope | PaperAccountScope

function normalizeUid(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d{0,30}$/.test(value)) return value
  throw new Error('HTX UID 响应无效')
}

/** 将 HTX GET /v2/user/uid 的 data 值压缩为不含原 UID 的固定范围。 */
export function htxLiveAccountScope(uidValue: unknown): HtxLiveAccountScope {
  const uid = normalizeUid(uidValue)
  const accountIdHash = `htx-uid-sha256:${sha256Hex(`dsh-trader:htx-uid:v1:${uid}`)}`
  const identity = Object.freeze({
    mode: 'live' as const,
    ...HTX_LIVE_SCOPE_FIELDS,
    accountIdHash,
  })
  return Object.freeze({ ...identity, accountScopeHash: fingerprint(identity) })
}

/** 仅用于首次初始化；journal 会把所得 hash 写入独立 scope binding 行供重启复用。 */
export function paperAccountScopeCandidate(): PaperAccountScope {
  const accountIdHash = `paper-namespace-sha256:${sha256Hex(`dsh-trader:paper-namespace:v1:${randomUUID()}`)}`
  const identity = Object.freeze({
    mode: 'paper' as const,
    venue: 'paper' as const,
    accountType: 'paper' as const,
    assetMode: 'paper' as const,
    marginMode: 'paper' as const,
    quoteCurrency: 'USDT' as const,
    accountIdHash,
  })
  return Object.freeze({ ...identity, accountScopeHash: fingerprint(identity) })
}
