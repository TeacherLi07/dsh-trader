import { describe, expect, it } from 'vitest'
import { codexClientIdentity } from '../src/plugins/codex-client-identity.js'

describe('Codex 标识与 Sub2API 检测配套', () => {
  it('UA 首段、originator/version、会话头和 client_metadata 共用身份', () => {
    const identity = codexClientIdentity('session-1', '0.160.0')
    expect(identity.headers['User-Agent'].startsWith('codex_cli_rs/0.160.0 (')).toBe(true)
    expect(identity.headers.originator).toBe('codex_cli_rs')
    expect(identity.headers.version).toBe('0.160.0')
    expect(identity.headers['session-id']).toBe('session-1')
    expect(identity.headers['thread-id']).toBe('session-1')
    expect(identity.headers['x-client-request-id']).toBe('session-1')
    expect(identity.body).toEqual({ prompt_cache_key: 'session-1', client_metadata: { session_id: 'session-1', thread_id: 'session-1' } })
    expect(JSON.stringify(identity)).not.toContain('Authorization')
  })
  it('独立调用创建非空 UUID，会话已给定时不改身份', () => {
    const first = codexClientIdentity()
    const second = codexClientIdentity()
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(codexClientIdentity('fixed').body.prompt_cache_key).toBe('fixed')
  })
  it.each(['0.160.0\r\nInjected: true', 'bad', '1'.repeat(65)])('拒绝非法版本 %s', (version) => {
    expect(() => codexClientIdentity('session', version)).toThrow('version')
  })
  it.each(['', 'bad\r\nOriginator: evil', 'x'.repeat(129)])('拒绝非法会话 %s', (session) => {
    expect(() => codexClientIdentity(session)).toThrow('session')
  })
})
