/** --import 预加载：用 TRADER_TEST_HTTP_LOG 指定私有日志，仅记录脱敏请求/响应，不记录认证头和签名查询值。 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { sanitizeModelTrace } from '../lib/agents/decision-runtime.js'
import { fingerprint } from '../lib/util/canonical.js'

const path = process.env.TRADER_TEST_HTTP_LOG
if (path) {
  if (existsSync(path)) throw new Error('HTTP trace exists; use a new path to preserve evidence')
  writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
  const secrets = [process.env.TRADER_API_KEY, process.env.TRADER_API_SECRET, process.env.DEEPSEEK_API_KEY, process.env.SUB2API_KEY].filter(Boolean)
  const safe = (value) => {
    let text = JSON.stringify(sanitizeModelTrace(value))
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]')
    return JSON.parse(text)
  }
  const log = (value) => appendFileSync(path, JSON.stringify(safe({ at: Date.now(), ...value })) + '\n')
  const realFetch = globalThis.fetch
  let sequence = 0
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    const id = ++sequence
    const startedAt = Date.now()
    const request = { id, method: options?.method ?? 'GET', origin: url.origin, path: url.pathname,
      queryKeys: [...url.searchParams.keys()],
      body: typeof options?.body === 'string' ? options.body : null }
    log({ kind: 'request', ...request })
    try {
      const response = await realFetch(input, options)
      const json = response.headers.get('content-type')?.includes('json')
      const body = json ? await response.clone().text() : null
      log({ kind: 'response', id, status: response.status, durationMs: Date.now() - startedAt,
        requestId: response.headers.get('x-request-id') ?? response.headers.get('request-id'),
        body, bodyHash: body === null ? null : fingerprint(body) })
      return response
    } catch (error) {
      log({ kind: 'failure', id, durationMs: Date.now() - startedAt, error: String(error) })
      throw error
    }
  }
}
