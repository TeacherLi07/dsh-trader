import { describe, expect, it } from 'vitest'
import { htxLiveAccountScope, paperAccountScopeCandidate } from '../src/exec/account-scope.js'

describe('execution account scope', () => {
  it('HTX scope binds UID identity to the fixed V5 multi_asset/cross/USDT request mode without retaining UID', () => {
    const uid = '63628520'
    const scope = htxLiveAccountScope(uid)

    expect(scope).toMatchObject({
      mode: 'live', venue: 'htx', accountType: 'swap', assetMode: 'multi_asset',
      marginMode: 'cross', quoteCurrency: 'USDT',
    })
    expect(scope.accountIdHash).toMatch(/^htx-uid-sha256:[0-9a-f]{64}$/)
    expect(scope.accountScopeHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(scope)).not.toContain(uid)
    expect(Object.isFrozen(scope)).toBe(true)
    expect(htxLiveAccountScope(uid).accountScopeHash).toBe(scope.accountScopeHash)
    expect(htxLiveAccountScope('63628521').accountScopeHash).not.toBe(scope.accountScopeHash)
  })

  it('rejects malformed or unsafe numeric UIDs without echoing the value', () => {
    for (const value of ['', '0', '-1', '12abc', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => htxLiveAccountScope(value)).toThrow('HTX UID 响应无效')
    }
  })

  it('paper accounts get distinct candidates without reading or deriving an HTX UID', () => {
    const first = paperAccountScopeCandidate()
    const second = paperAccountScopeCandidate()
    expect(first.mode).toBe('paper')
    expect(first.venue).toBe('paper')
    expect(first.accountScopeHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.accountScopeHash).not.toBe(second.accountScopeHash)
    expect(JSON.stringify(first)).not.toContain('htx-uid')
    expect(Object.isFrozen(first)).toBe(true)
  })
})
